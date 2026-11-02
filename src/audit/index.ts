/** kpm audit 入口：组装 checker、附加 kpm 一致性检查 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AuditFinding, AuditContext, Checker } from './types.js';
import { readManifest } from '../manifest.js';
import { allInjectionTargets } from '../injectors.js';
import { findBlock, listBlockIds } from '../marker.js';
import { androidManifestChecker, androidSigningChecker } from './checkers.android.js';
import { iosChecker } from './checkers.ios.js';
import { ohosChecker } from './checkers.ohos.js';
import { assetsChecker, secretsChecker } from './checkers.common.js';

function resolveWithinRoot(root: string, rel: string): string {
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, rel);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw new Error(`kpm: 目标路径越出工程根目录（${rel}），已拒绝访问`);
  }
  return abs;
}

/** 16：kpm 接线一致性（manifest↔lock↔标记区间；轻量版，doctor 是完整版） */
const kpmConsistencyChecker: Checker = async (ctx: AuditContext) => {
  const findings: AuditFinding[] = [];
  if (!ctx.manifest) return { findings, performed: 0 };
  const { readLock } = await import('../manifest.js');
  const lock = await readLock(ctx.root);

  for (const name of Object.keys(ctx.manifest.dependencies)) {
    if (!lock?.dependencies[name]) {
      findings.push({
        id: 'kpm-lock-missing',
        domain: 'kpm',
        severity: 'warn',
        title: `${name} 在 kuikly.pkg.json 中但 lock 缺失`,
        detail: '执行 kpm install 生成完整 lock 后再发布',
      });
    }
  }

  for (const rel of allInjectionTargets(ctx.manifest)) {
    let text: string;
    try {
      text = await fs.readFile(resolveWithinRoot(ctx.root, rel), 'utf-8');
    } catch {
      continue;
    }
    const comment = rel.endsWith('Podfile') ? '#' : '//';
    for (const id of listBlockIds(text, comment)) {
      if (!ctx.manifest.dependencies[id]) {
        findings.push({
          id: 'kpm-orphan-block',
          domain: 'kpm',
          severity: 'warn',
          title: `孤儿标记区间：${rel}（${id}）`,
          detail: '对应依赖已不在清单中，执行 kpm remove 清理或手工删除标记区间',
          file: rel,
        });
      }
    }
    for (const name of Object.keys(lock?.dependencies ?? {})) {
      try {
        findBlock(text, name, comment);
      } catch (e) {
        findings.push({
          id: 'kpm-unclosed-block',
          domain: 'kpm',
          severity: 'error',
          title: `标记区间未闭合：${rel}（${name}）`,
          detail: (e as Error).message,
          file: rel,
        });
      }
    }
  }

  return { findings, performed: 1 };
};

export const ALL_CHECKERS: Array<{ name: string; checker: Checker }> = [
  { name: 'android-manifest', checker: androidManifestChecker },
  { name: 'android-signing', checker: androidSigningChecker },
  { name: 'ios', checker: iosChecker },
  { name: 'ohos', checker: ohosChecker },
  { name: 'secrets', checker: secretsChecker },
  { name: 'assets', checker: assetsChecker },
  { name: 'kpm-consistency', checker: kpmConsistencyChecker },
];

export interface AuditReport {
  performed: number;
  findings: AuditFinding[];
  summary: { errors: number; warns: number; infos: number; ok: boolean };
}

export async function runAudit(root: string): Promise<AuditReport> {
  const manifest = await readManifest(root);
  const ctx: AuditContext = {
    root,
    shared: manifest?.paths.shared ?? 'shared',
    androidApp: manifest?.paths.androidApp ?? 'androidApp',
    iosApp: manifest?.paths.iosApp ?? 'iosApp',
    ohosApp: manifest?.paths.ohosApp ?? 'ohosApp',
    manifest,
  };

  let performed = 0;
  const findings: AuditFinding[] = [];
  for (const { checker } of ALL_CHECKERS) {
    const r = await checker(ctx);
    performed += r.performed;
    findings.push(...r.findings);
  }

  const errors = findings.filter((f) => f.severity === 'error').length;
  const warns = findings.filter((f) => f.severity === 'warn').length;
  const infos = findings.filter((f) => f.severity === 'info').length;
  return { performed, findings, summary: { errors, warns, infos, ok: errors === 0 } };
}
