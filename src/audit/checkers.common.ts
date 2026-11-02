/** 跨端检查器：硬编码密钥 + 资源（未引用/超大） */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AuditFinding, AuditContext, Checker } from './types.js';
import { collectFiles, resolveWithinRoot } from './util.js';

const SOURCE_SUFFIXES = ['.kt', '.kts', '.ets', '.ts', '.swift', '.m', '.h', '.mm', '.xml', '.json5', '.properties', '.json'];
const PLACEHOLDER_WORDS = [
  'your_', 'xxx', 'placeholder', 'change_me', 'changeme', 'example', 'dummy', 'sample',
  'todo', 'fixme', '<', '${', 'test_', 'aaaa', '12345678', 'password"', 'secret"',
];

/** 云厂商/平台密钥的确定性形态（命中即高危） */
const KEY_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /AKIA[0-9A-Z]{16}/, label: 'AWS AccessKeyId' },
  { re: /AIza[0-9A-Za-z_-]{35}/, label: 'Google API Key' },
  { re: /sk-[A-Za-z0-9]{20,}/, label: 'OpenAI/兼容网关 API Key' },
  { re: /ghp_[A-Za-z0-9]{36}/, label: 'GitHub Personal Token' },
  { re: /gho_[A-Za-z0-9]{36}/, label: 'GitHub OAuth Token' },
];

/** 赋值形态：apiKey/secret/token/password = "长字符串"（warn，需人工确认） */
const ASSIGN_PATTERN = /(api[_-]?key|app[_-]?key|secret|access[_-]?token|password|passwd)["']?\s*[:=]\s*["']([^"']{12,})["']/i;

function isPlaceholder(v: string): boolean {
  const lower = v.toLowerCase();
  return PLACEHOLDER_WORDS.some((w) => lower.includes(w));
}

/** 13：硬编码 secrets 扫描（error：确定性密钥形态；warn：可疑赋值） */
export const secretsChecker: Checker = async (ctx: AuditContext) => {
  const findings: AuditFinding[] = [];
  const rootAbs = resolveWithinRoot(ctx.root, '.');
  const files = await collectFiles(rootAbs, rootAbs, SOURCE_SUFFIXES);
  const relRoot = rootAbs;
  let scanned = 0;

  for (const f of files) {
    const rel = path.relative(relRoot, f);
    // 排除：测试、构建产物、kpm 自身文件、锁文件与 IDE 目录
    if (rel.split(path.sep).some((seg) => ['test', 'androidTest', 'iosTests', '.kpm', 'Pods', 'oh_modules', 'node_modules'].includes(seg))) continue;
    if (/(package-lock\.json|kuikly\.lock|gradle\.properties)$/.test(f) && !f.includes('gradle.properties')) continue;
    if (f.endsWith('gradle.properties') && !f.endsWith(`${path.sep}gradle.properties`)) continue;

    let text: string;
    try {
      text = await fs.readFile(f, 'utf-8');
    } catch {
      continue;
    }
    if (text.length === 0) continue;
    scanned++;
    const lines = text.split('\n');

    for (const { re, label } of KEY_PATTERNS) {
      const idx = lines.findIndex((l) => re.test(l));
      if (idx >= 0) {
        findings.push({
          id: 'hardcoded-key',
          domain: 'common',
          severity: 'error',
          title: `疑似硬编码${label}`,
          detail: '密钥进入版本库属于高危泄漏，立即吊销并轮换，改由环境变量/CI secret 注入',
          file: rel,
          line: idx + 1,
        });
      }
    }

    for (let i = 0; i < lines.length; i++) {
      const m = lines[i]!.match(ASSIGN_PATTERN);
      if (m && !isPlaceholder(m[2]!)) {
        findings.push({
          id: 'hardcoded-secret-assignment',
          domain: 'common',
          severity: 'warn',
          title: `可疑的明文凭据赋值（${m[1]}）`,
          detail: '请人工确认是否为真实凭据；真实凭据应改为环境变量/CI secret',
          file: rel,
          line: i + 1,
        });
        break; // 每文件最多报一条赋值形态，避免噪音
      }
    }
  }

  return { findings, performed: scanned > 0 ? 1 : 0 };
};

const ASSET_SUFFIXES = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.mp4'];
const OVERSIZE_BYTES = 500 * 1024;

async function assetDirs(ctx: AuditContext): Promise<string[]> {
  const sharedAbs = resolveWithinRoot(ctx.root, ctx.shared);
  const candidates = [
    path.join(sharedAbs, 'src', 'commonMain', 'kresources'),
    path.join(sharedAbs, 'src', 'commonMain', 'assets'),
    path.join(sharedAbs, 'assets'),
    path.join(sharedAbs, 'kresources'),
  ];
  const out: string[] = [];
  for (const c of candidates) {
    try {
      const st = await fs.stat(c);
      if (st.isDirectory()) out.push(c);
    } catch {
      /* 不存在跳过 */
    }
  }
  return out;
}

/** 14-15：资源体检（未引用 + 超大） */
export const assetsChecker: Checker = async (ctx: AuditContext) => {
  const findings: AuditFinding[] = [];
  const dirs = await assetDirs(ctx);
  if (dirs.length === 0) return { findings, performed: 0 };

  const rootAbs = resolveWithinRoot(ctx.root, '.');
  const assets: string[] = [];
  for (const d of dirs) await collectFiles(rootAbs, d, ASSET_SUFFIXES, assets);
  if (assets.length === 0) return { findings, performed: 0 };

  // 源码全集（含三端与 shared），资源名在其中出现即视为已引用
  const sourceFiles = await collectFiles(rootAbs, resolveWithinRoot(ctx.root, ctx.shared), ['.kt', '.ets', '.ts', '.swift', '.m', '.xml', '.json5']);
  for (const base of [ctx.androidApp, ctx.iosApp, ctx.ohosApp]) {
    await collectFiles(rootAbs, resolveWithinRoot(ctx.root, base), ['.kt', '.ets', '.ts', '.swift', '.m', '.xml', '.json5'], sourceFiles);
  }
  let corpus = '';
  for (const s of sourceFiles) {
    try {
      corpus += await fs.readFile(s, 'utf-8');
    } catch {
      /* ignore */
    }
  }

  for (const a of assets) {
    const rel = path.relative(rootAbs, a);
    const name = path.basename(a);
    const stem = name.replace(/\.[^.]+$/, '');
    const st = await fs.stat(a).catch(() => null);

    if (st != null && st.size > OVERSIZE_BYTES) {
      findings.push({
        id: 'oversized-asset',
        domain: 'common',
        severity: 'warn',
        title: `超大资源 ${(st.size / 1024 / 1024).toFixed(1)}MB：${name}`,
        detail: '超过 500KB，考虑压缩、换 WebP 或改远程下发',
        file: rel,
      });
    }
    if (!corpus.includes(name) && !corpus.includes(stem)) {
      findings.push({
        id: 'unused-asset',
        domain: 'common',
        severity: 'warn',
        title: `疑似未引用资源：${name}`,
        detail: '文件名/去后缀名未在任何源码出现（动态拼接名字会误报，删除前请确认）',
        file: rel,
      });
    }
  }

  return { findings, performed: 2 };
};
