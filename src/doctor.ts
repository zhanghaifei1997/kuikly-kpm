/** kpm doctor：接线完整性体检（DESIGN.md §3.1） */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Lock, Manifest, Platform } from './types.js';
import { enabledPlatforms, LOCK_FILE, MANIFEST_FILE, PENDING_FILE, readLock, requireManifest } from './manifest.js';
import { allInjectionTargets } from './injectors.js';
import { findBlock, listBlockIds } from './marker.js';

function resolveWithinRoot(root: string, rel: string): string {
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, rel);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw new Error(`kpm: 目标路径越出工程根目录（${rel}），已拒绝访问`);
  }
  return abs;
}

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  status: CheckStatus;
  message: string;
}

/** 归一化（去除全部空白），用于注册 snippet 是否已粘贴的宽松比对 */
function normalizeCode(s: string): string {
  return s.split(/\s+/).join('');
}

/** 递归收集目录下指定扩展名的文件（限制在 root 内） */
async function collectFiles(rootAbs: string, dir: string, exts: string[], out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'build' || e.name === 'Pods') continue;
      await collectFiles(rootAbs, full, exts, out);
    } else if (exts.some((x) => e.name.endsWith(x))) {
      out.push(full);
    }
  }
  return out;
}

async function snippetExists(root: string, baseDir: string, exts: string[], snippet: string): Promise<boolean> {
  const rootAbs = resolveWithinRoot(root, baseDir);
  const target = normalizeCode(snippet);
  const files = await collectFiles(rootAbs, rootAbs, exts);
  for (const f of files) {
    let content: string;
    try {
      content = await fs.readFile(f, 'utf-8');
    } catch {
      continue;
    }
    if (normalizeCode(content).includes(target)) return true;
  }
  return false;
}

const REG_EXTS: Partial<Record<Platform, string[]>> = {
  android: ['.kt', '.kts'],
  ios: ['.swift', '.h', '.m', '.mm'],
  ohos: ['.ets', '.ts'],
};

export async function runDoctor(root: string): Promise<{ results: CheckResult[]; ok: boolean; manifest: Manifest; lock: Lock }> {
  const results: CheckResult[] = [];
  const manifest = await requireManifest(root);
  const lock = (await readLock(root)) ?? { lockfileVersion: 1, dependencies: {} };
  const enabled = enabledPlatforms(manifest);

  results.push({
    status: manifest ? 'ok' : 'fail',
    message: `${MANIFEST_FILE}：平台 ${enabled.join('/') || '（无）'}，依赖 ${Object.keys(manifest.dependencies).length} 个`,
  });

  // 1) manifest ↔ lock 一致性
  for (const name of Object.keys(manifest.dependencies)) {
    if (!lock.dependencies[name]) {
      results.push({ status: 'fail', message: `${name} 在 manifest 中但 lock 缺失 —— 执行 kpm install` });
    }
  }
  for (const name of Object.keys(lock.dependencies)) {
    if (!manifest.dependencies[name]) {
      results.push({ status: 'warn', message: `${name} 在 lock 中但 manifest 已移除 —— 执行 kpm remove ${name} 清理` });
    }
  }

  // 2) 标记区间存在性（启用端的目标文件）
  for (const rel of allInjectionTargets(manifest)) {
    let content: string;
    try {
      content = await fs.readFile(resolveWithinRoot(root, rel), 'utf-8');
    } catch {
      continue; // 目标端未启用或文件本来不存在
    }
    const comment = rel.endsWith('Podfile') ? '#' : '//';
    const ids = listBlockIds(content, comment);
    for (const name of Object.keys(lock.dependencies)) {
      const c = lock.dependencies[name]!.coordinates;
      const isTargetOf = (rel.includes(manifest.paths.shared) && !!c.android?.shared) ||
        (rel.includes(manifest.paths.androidApp) && !!c.android?.app) ||
        (rel.includes(manifest.paths.iosApp) && !!c.ios?.pods?.length) ||
        (rel.includes(manifest.paths.ohosApp) && !!c.ohos?.packages?.length);
      if (!isTargetOf) continue;
      try {
        const found = findBlock(content, name, comment);
        results.push({ status: found ? 'ok' : 'fail', message: `${rel}：${name} 标记区间${found ? '就绪' : '缺失 —— 执行 kpm install'}` });
      } catch (e) {
        results.push({ status: 'fail', message: `${rel}：${(e as Error).message}` });
      }
    }
    for (const id of ids) {
      if (!lock.dependencies[id]) {
        results.push({ status: 'warn', message: `${rel}：孤儿标记区间 ${id}（对应依赖已不在 lock）—— 手工清理或 kpm remove ${id}` });
      }
    }
  }

  // 3) 注册代码已粘贴
  for (const [name, entry] of Object.entries(lock.dependencies)) {
    for (const p of enabled) {
      const reg = entry.registration?.[p];
      if (reg?.snippet) {
        const baseDir =
          p === 'android' ? manifest.paths.androidApp : p === 'ios' ? manifest.paths.iosApp : manifest.paths.ohosApp;
        const exts = REG_EXTS[p]!;
        const exists = await snippetExists(root, baseDir, exts, reg.snippet);
        results.push({
          status: exists ? 'ok' : 'warn',
          message: `[${p}] ${name} 注册代码${exists ? '已就位' : '未检测到 —— 粘贴后重跑 doctor（见 .kpm/pending.md）'}`,
        });
      }
    }
  }

  // 4) pending.md 提醒
  try {
    await fs.access(resolveWithinRoot(root, PENDING_FILE));
    results.push({ status: 'warn', message: `${PENDING_FILE} 存在未确认的手工步骤清单，完成后可删除` });
  } catch {
    /* 无 pending 属正常 */
  }

  const ok = !results.some((r) => r.status === 'fail');
  return { results, ok, manifest, lock };
}
