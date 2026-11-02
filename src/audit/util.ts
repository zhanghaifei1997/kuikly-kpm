/** audit 内部共享工具：安全路径解析、文件收集与文本定位 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AuditContext } from './types.js';

export function resolveWithinRoot(root: string, rel: string): string {
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, rel);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw new Error(`kpm: 目标路径越出工程根目录（${rel}），已拒绝访问`);
  }
  return abs;
}

export async function readTextIfExists(abs: string): Promise<string | null> {
  try {
    return await fs.readFile(abs, 'utf-8');
  } catch {
    return null;
  }
}

/** 找到 manifest（AndroidManifest.xml / Info.plist 等可能位于子目录），返回相对路径+绝对路径 */
export async function findFile(ctx: AuditContext, baseDir: string, fileName: string): Promise<{ rel: string; abs: string } | null> {
  const start = resolveWithinRoot(ctx.root, baseDir);
  const queue = [start];
  const SKIP = new Set(['build', '.gradle', 'node_modules', 'oh_modules', 'Pods', '.git']);
  let steps = 0;
  while (queue.length > 0 && steps < 500) {
    steps++;
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) queue.push(full);
      } else if (e.name === fileName) {
        return { rel: path.relative(resolveWithinRoot(ctx.root, '.'), full), abs: full };
      }
    }
  }
  return null;
}

export async function collectFiles(
  rootAbs: string,
  dir: string,
  suffixes: string[],
  out: string[] = [],
): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  const SKIP = new Set(['build', '.gradle', 'node_modules', 'oh_modules', 'Pods', '.git', '.idea']);
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) await collectFiles(rootAbs, full, suffixes, out);
    } else if (suffixes.some((s) => e.name.endsWith(s))) {
      out.push(full);
    }
  }
  return out;
}

/** 返回首个匹配行的行号（1-based），未命中返回 undefined */
export function lineOf(content: string, predicate: (line: string) => boolean): number | undefined {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (predicate(lines[i]!)) return i + 1;
  }
  return undefined;
}

/** XML/JSON 属性抽取：android:debuggable="true" → 值；不存在返回 null */
export function attrValue(lineOrText: string, attr: string): string | null {
  const m = lineOrText.match(new RegExp(`${attr}\\s*=\\s*"([^"]*)"`));
  return m ? m[1]! : null;
}
