/** kuikly.pkg.json / kuikly.lock 读写与校验 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Lock, Manifest, Platform } from './types.js';

export const MANIFEST_FILE = 'kuikly.pkg.json';
export const LOCK_FILE = 'kuikly.lock';
export const PENDING_FILE = path.join('.kpm', 'pending.md');

/** 解析工程内相对路径并校验不越出工程根目录（防路径穿越） */
function resolveWithinRoot(root: string, rel: string): string {
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, rel);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw new Error(`kpm: 目标路径越出工程根目录（${rel}），已拒绝写入`);
  }
  return abs;
}

export async function readManifest(root: string): Promise<Manifest | null> {
  try {
    const raw = await fs.readFile(resolveWithinRoot(root, MANIFEST_FILE), 'utf-8');
    const m = JSON.parse(raw) as Manifest;
    if (m.schemaVersion !== 1) throw new Error(`不支持的 schemaVersion：${m.schemaVersion}`);
    m.registries ??= [];
    m.dependencies ??= {};
    m.platforms ??= { android: false, ios: false, ohos: false };
    m.paths ??= { shared: 'shared', androidApp: 'androidApp', iosApp: 'iosApp', ohosApp: 'ohosApp' };
    return m;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`kpm: ${MANIFEST_FILE} 解析失败：${(e as Error).message}`);
  }
}

export async function requireManifest(root: string): Promise<Manifest> {
  const m = await readManifest(root);
  if (!m) throw new Error(`kpm: 未找到 ${MANIFEST_FILE}，请先在工程根执行 kpm init`);
  return m;
}

export async function writeManifest(root: string, manifest: Manifest): Promise<void> {
  const abs = resolveWithinRoot(root, MANIFEST_FILE);
  await fs.writeFile(abs, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
}

export async function readLock(root: string): Promise<Lock | null> {
  try {
    const raw = await fs.readFile(resolveWithinRoot(root, LOCK_FILE), 'utf-8');
    const l = JSON.parse(raw) as Lock;
    if (l.lockfileVersion !== 1) throw new Error(`不支持的 lockfileVersion：${l.lockfileVersion}`);
    l.dependencies ??= {};
    return l;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`kpm: ${LOCK_FILE} 解析失败：${(e as Error).message}`);
  }
}

export async function writeLock(root: string, lock: Lock): Promise<void> {
  const abs = resolveWithinRoot(root, LOCK_FILE);
  await fs.writeFile(abs, JSON.stringify(lock, null, 2) + '\n', 'utf-8');
}

export function enabledPlatforms(m: Manifest): Platform[] {
  return (Object.keys(m.platforms) as Platform[]).filter((p) => m.platforms[p]);
}

/** kpm config get <key>：点路径读取 */
export function getConfigValue(m: Manifest, key: string): unknown {
  const parts = key.split('.');
  let cur: unknown = m;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** kpm config set <key> <value>：仅支持 platforms.* 与 paths.*；返回是否发生变化 */
export function setConfigValue(m: Manifest, key: string, value: string): boolean {
  const parts = key.split('.');
  if (parts.length !== 2) throw new Error(`kpm: 仅支持两级配置键（如 platforms.ios / paths.shared），收到：${key}`);
  const [group, field] = parts as [string, string];
  if (group === 'platforms') {
    if (!(field in m.platforms)) throw new Error(`kpm: 未知平台 ${field}（可选 android/ios/ohos）`);
    const plat = m.platforms as unknown as Record<string, boolean>;
    const next = value === 'true';
    const changed = plat[field] !== next;
    plat[field] = next;
    return changed;
  }
  if (group === 'paths') {
    if (!(field in m.paths)) throw new Error(`kpm: 未知路径键 ${field}（可选 shared/androidApp/iosApp/ohosApp）`);
    const p = m.paths as unknown as Record<string, string>;
    const changed = p[field] !== value;
    p[field] = value;
    return changed;
  }
  throw new Error(`kpm: 未知配置组 ${group}（可选 platforms / paths）`);
}
