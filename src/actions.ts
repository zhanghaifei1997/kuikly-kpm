/** actions：CLI 与测试共用的编排层 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import type { AppliedResult, Ctx, LockEntry, Manifest, Resolved } from './types.js';
import {
  enabledPlatforms,
  getConfigValue,
  LOCK_FILE,
  MANIFEST_FILE,
  readLock,
  readManifest,
  requireManifest,
  setConfigValue,
  writeLock,
  writeManifest,
} from './manifest.js';
import { allInjectionTargets, applyPlans, planInjections, removePlans } from './injectors.js';
import { findBlock, removeBlock } from './marker.js';
import { resolveDependency, ResolveError } from './resolve.js';
import { buildSteps, renderStepsConsole, writePending } from './guide.js';
import { renderDiff } from './diff.js';
import { detectProject } from './detect.js';
import { runDoctor } from './doctor.js';

/** 解析工程内相对路径并校验不越出工程根目录（防路径穿越） */
function resolveWithinRoot(root: string, rel: string): string {
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, rel);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw new Error(`kpm: 目标路径越出工程根目录（${rel}），已拒绝访问`);
  }
  return abs;
}

export function makeCtx(root: string, opts: { refresh?: boolean; offline?: boolean; cacheDir?: string } = {}): Ctx {
  return {
    root,
    cacheDir: opts.cacheDir ?? path.join(os.homedir(), '.kpm', 'cache'),
    refresh: opts.refresh,
    offline: opts.offline,
    githubToken: process.env.KPM_GITHUB_TOKEN,
  };
}

export interface InitOptions {
  force?: boolean;
}

export async function runInit(ctx: Ctx, opts: InitOptions = {}): Promise<Manifest> {
  const existing = await readManifest(ctx.root);
  if (existing && !opts.force) {
    process.stdout.write(`${MANIFEST_FILE} 已存在（--force 可覆盖重探测）\n`);
    return existing;
  }
  const detected = await detectProject(ctx.root);
  const name = path.basename(path.resolve(ctx.root));
  const manifest: Manifest = {
    schemaVersion: 1,
    name,
    platforms: detected.platforms,
    dependencies: existing?.dependencies ?? {},
    registries: existing?.registries ?? [],
    paths: detected.paths,
  };
  await writeManifest(ctx.root, manifest);
  process.stdout.write(
    `✅ 已生成 ${MANIFEST_FILE}：平台 ${enabledPlatforms(manifest).join('/') || '（未探测到，请手工配置）'}\n`,
  );
  for (const n of detected.notes) process.stdout.write(`⚠️  ${n}\n`);
  return manifest;
}

export interface AddOptions {
  yes?: boolean;
  dryRun?: boolean;
}

/** 解析 <name>|<github-url>[@range] */
export function parseSpec(spec: string): { name: string; range: string } {
  if (/^https?:\/\//i.test(spec)) return { name: spec, range: '*' };
  const at = spec.lastIndexOf('@');
  if (at > 0 && /^[\^~><=*\d]/.test(spec.slice(at + 1))) {
    return { name: spec.slice(0, at), range: spec.slice(at + 1) };
  }
  return { name: spec, range: '*' };
}

function printApplied(name: string, version: string, applied: AppliedResult[]): void {
  for (const r of applied) {
    if (r.mode === 'missing-file') {
      process.stdout.write(`⚠️  跳过（文件不存在）：${r.plan.file}\n`);
      continue;
    }
    if (r.before !== undefined && r.after !== undefined && r.before !== r.after) {
      process.stdout.write(`\n--- ${r.plan.file} ---\n${renderDiff(r.before, r.after)}\n`);
    }
  }
  const touched = applied.filter((r) => r.mode === 'inserted' || r.mode === 'replaced').length;
  process.stdout.write(`\n✅ ${name}@${version}：已注入 ${touched} 处（标记区间内）\n`);
}

export async function runAdd(ctx: Ctx, spec: string, opts: AddOptions = {}): Promise<Resolved> {
  const manifest = await requireManifest(ctx.root);
  const { name, range } = parseSpec(spec);
  const resolved = await resolveDependency(ctx, manifest, name, range);
  for (const w of resolved.warnings) process.stdout.write(`⚠️  ${w}\n`);

  const plans = planInjections(manifest, resolved);
  if (plans.length === 0) {
    throw new ResolveError(`kpm: ${resolved.name} 在启用平台上没有可注入的坐标（检查组件元数据 platforms 字段）`);
  }

  // 预演 → 展示 diff → 确认
  const preview = await applyPlans(ctx.root, plans, { dryRun: true });
  printApplied(resolved.name, resolved.version, preview);

  if (opts.dryRun) {
    process.stdout.write('（--dry-run：未写入任何文件）\n');
    return resolved;
  }
  if (!opts.yes && process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('应用以上修改？[y/N] ');
    rl.close();
    if (!/^\s*y(es)?\s*$/i.test(answer)) {
      process.stdout.write('已取消\n');
      return resolved;
    }
  }

  const applied = await applyPlans(ctx.root, plans);
  printApplied(resolved.name, resolved.version, applied);

  // manifest + lock
  manifest.dependencies[resolved.name] = range;
  await writeManifest(ctx.root, manifest);
  const lock = (await readLock(ctx.root)) ?? { lockfileVersion: 1, dependencies: {} };
  lock.dependencies[resolved.name] = toLockEntry(resolved);
  await writeLock(ctx.root, lock);

  // 指引
  const steps = buildSteps(manifest, resolved, applied);
  for (const line of renderStepsConsole(resolved.name, resolved.version, steps)) process.stdout.write(`${line}\n`);
  if (steps.length > 0) await writePending(ctx.root, resolved.name, resolved.version, steps);

  return resolved;
}

function toLockEntry(r: Resolved): LockEntry {
  return {
    range: r.range,
    resolved: r.version,
    source: r.source,
    coordinates: r.coordinates,
    registration: r.registration,
    hostPrerequisites: r.hostPrerequisites,
  };
}

function fromLockEntry(name: string, e: LockEntry): Resolved {
  return {
    name,
    range: e.range,
    version: e.resolved,
    coordinates: e.coordinates,
    registration: e.registration,
    hostPrerequisites: e.hostPrerequisites,
    source: e.source,
    warnings: [],
  };
}

export async function runRemove(ctx: Ctx, name: string): Promise<void> {
  const manifest = await requireManifest(ctx.root);
  if (!(name in manifest.dependencies)) {
    throw new ResolveError(`kpm: ${name} 不在 ${MANIFEST_FILE} 依赖中`);
  }
  const results = await removePlans(ctx.root, manifest, name);
  delete manifest.dependencies[name];
  await writeManifest(ctx.root, manifest);
  const lock = await readLock(ctx.root);
  if (lock) {
    delete lock.dependencies[name];
    await writeLock(ctx.root, lock);
  }
  for (const r of results) process.stdout.write(`🗑️  已移除 ${r.plan.file} 的标记区间\n`);
  process.stdout.write(`✅ ${name} 已卸载（${results.length} 处）\n`);
}

export interface InstallOptions {
  frozen?: boolean;
}

export async function runInstall(ctx: Ctx, opts: InstallOptions = {}): Promise<void> {
  const manifest = await requireManifest(ctx.root);
  const lock = (await readLock(ctx.root)) ?? { lockfileVersion: 1, dependencies: {} };
  const names = Object.keys(manifest.dependencies);

  if (names.length === 0) {
    process.stdout.write('依赖为空，无需安装\n');
    return;
  }
  if (opts.frozen) {
    const missing = names.filter((n) => !lock.dependencies[n]);
    if (missing.length > 0) {
      throw new ResolveError(`kpm: --frozen 但 lock 缺少 ${missing.join(', ')}（先跑一次 kpm install 生成 lock）`);
    }
  }

  for (const name of names) {
    const range = manifest.dependencies[name]!;
    let resolved: Resolved;
    if (opts.frozen) {
      resolved = fromLockEntry(name, lock.dependencies[name]!);
    } else {
      try {
        resolved = await resolveDependency(ctx, manifest, name, range);
      } catch (e) {
        // 网络失败但 lock 有记录 → 降级用 lock
        if (lock.dependencies[name] && e instanceof ResolveError) {
          process.stdout.write(
            `⚠️  ${name} 解析失败（${(e as Error).message.split('\n')[0]}），降级使用 lock@${lock.dependencies[name]!.resolved}\n`,
          );
          resolved = fromLockEntry(name, lock.dependencies[name]!);
        } else {
          throw e;
        }
      }
    }
    const plans = planInjections(manifest, resolved);
    const applied = await applyPlans(ctx.root, plans);
    printApplied(name, resolved.version, applied);
    lock.dependencies[name] = toLockEntry(resolved);
  }

  await writeLock(ctx.root, lock);
  await syncDisabledPlatforms(ctx.root, manifest, lock);
  process.stdout.write(`✅ ${LOCK_FILE} 已同步（${names.length} 个依赖）\n`);
}

/** 平台裁剪同步：清理"已禁用端/该端无坐标"的残留标记区间 */
async function syncDisabledPlatforms(
  root: string,
  manifest: Manifest,
  lock: { dependencies: Record<string, LockEntry> },
): Promise<void> {
  for (const rel of allInjectionTargets(manifest)) {
    const abs = resolveWithinRoot(root, rel);
    let content: string;
    try {
      content = await fs.readFile(abs, 'utf-8');
    } catch {
      continue;
    }
    const comment = rel.endsWith('Podfile') ? '#' : '//';
    const isShared = rel === path.join(manifest.paths.shared, 'build.gradle.kts');
    const isAndroidApp = rel === path.join(manifest.paths.androidApp, 'build.gradle.kts');
    const isIos = rel === path.join(manifest.paths.iosApp, 'Podfile');
    const isOhos = rel === path.join(manifest.paths.ohosApp, 'oh-package.json5');

    let changed = false;
    for (const [name, entry] of Object.entries(lock.dependencies)) {
      const needHere =
        (isShared && manifest.platforms.android && !!entry.coordinates.android?.shared) ||
        (isAndroidApp && manifest.platforms.android && !!entry.coordinates.android?.app) ||
        (isIos && manifest.platforms.ios && !!entry.coordinates.ios?.pods?.length) ||
        (isOhos && manifest.platforms.ohos && !!entry.coordinates.ohos?.packages?.length);
      if (!needHere && findBlock(content, name, comment)) {
        content = removeBlock(content, name, comment).content;
        changed = true;
        process.stdout.write(`🧹 清理已禁用端的残留区间：${rel}（${name}）\n`);
      }
    }
    if (changed) await fs.writeFile(abs, content, 'utf-8');
  }
}

export async function runList(ctx: Ctx): Promise<void> {
  const manifest = await requireManifest(ctx.root);
  const lock = await readLock(ctx.root);
  const names = Object.keys(manifest.dependencies);
  if (names.length === 0) {
    process.stdout.write('（无依赖）\n');
    return;
  }
  process.stdout.write(`工程 ${manifest.name} · 平台 ${enabledPlatforms(manifest).join('/') || '（无）'}\n\n`);
  for (const name of names) {
    const range = manifest.dependencies[name]!;
    const entry = lock?.dependencies[name];
    if (!entry) {
      process.stdout.write(`${name}@${range} →（未安装，执行 kpm install）\n`);
      continue;
    }
    process.stdout.write(
      `${name}@${entry.resolved}（约束 ${range} · 来源 ${entry.source.repo}${entry.source.index !== 'direct' ? ` via ${entry.source.index}` : ''}）\n`,
    );
    const c = entry.coordinates;
    if (c.android?.shared) process.stdout.write(`  Android shared : ${c.android.shared}\n`);
    if (c.android?.app) process.stdout.write(`  Android app    : ${c.android.app}\n`);
    if (c.ios?.pods?.length) process.stdout.write(`  iOS pods       : ${c.ios.pods.join(', ')}\n`);
    if (c.ohos?.shared) process.stdout.write(`  鸿蒙 shared    : ${c.ohos.shared}（手工接线，见 pending.md）\n`);
    if (c.ohos?.packages?.length) process.stdout.write(`  鸿蒙 OHPM      : ${c.ohos.packages.join(', ')}\n`);
    process.stdout.write('\n');
  }
}

export async function runConfig(ctx: Ctx, args: string[]): Promise<void> {
  const manifest = await requireManifest(ctx.root);
  const [action, key, value] = args;
  if (action === 'get') {
    if (!key) throw new Error('用法：kpm config get <key>（如 platforms.ios）');
    process.stdout.write(`${JSON.stringify(getConfigValue(manifest, key))}\n`);
    return;
  }
  if (action === 'set') {
    if (!key || value === undefined) throw new Error('用法：kpm config set <key> <value>');
    const changed = setConfigValue(manifest, key, value);
    await writeManifest(ctx.root, manifest);
    process.stdout.write(changed ? `✅ ${key} = ${value}\n` : `${key} 已是 ${value}（无变化）\n`);
    process.stdout.write('提示：platforms 变更后执行 kpm install 同步注入\n');
    return;
  }
  throw new Error('用法：kpm config get <key> | kpm config set <key> <value>');
}

export async function runDoctorAction(ctx: Ctx): Promise<boolean> {
  const { results, ok } = await runDoctor(ctx.root);
  for (const r of results) {
    const icon = r.status === 'ok' ? '✅' : r.status === 'warn' ? '⚠️ ' : '❌';
    process.stdout.write(`${icon} ${r.message}\n`);
  }
  process.stdout.write(ok ? '\ndoctor：无失败项\n' : '\ndoctor：存在失败项，请按提示处理\n');
  return ok;
}
