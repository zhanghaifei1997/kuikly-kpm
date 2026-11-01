/**
 * 三端注入器：把解析出的坐标转成对各端构建文件的标记区间写入计划。
 * 只做文本手术，不拉起任何子进程（DESIGN.md §9：不执行任意脚本）。
 */
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type { AppliedResult, InjectPlan, Manifest, Platform, Resolved } from './types.js';
import { removeBlock, upsertBlock } from './marker.js';

function lineOf(lines: string[], predicate: (line: string) => boolean, from = 0): number {
  for (let i = from; i < lines.length; i++) {
    if (predicate(lines[i]!)) return i;
  }
  return -1;
}

/** 解析 manifest 相对路径并校验不越出工程根目录（防路径穿越） */
function resolveWithinRoot(root: string, rel: string): string {
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, rel);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw new Error(`kpm: 目标路径越出工程根目录（${rel}），已拒绝写入`);
  }
  return abs;
}

/** shared/build.gradle.kts：commonMain（若声明）之后第一个 dependencies 块 */
function sharedGradleAnchor(lines: string[]): number {
  const commonMain = lineOf(lines, (l) => l.includes('commonMain'));
  const from = commonMain >= 0 ? commonMain : 0;
  return lineOf(lines, (l) => l.includes('dependencies') && l.includes('{'), from);
}

/** androidApp/build.gradle.kts：顶层 dependencies 块（回退到任意 dependencies） */
function appGradleAnchor(lines: string[]): number {
  const top = lineOf(lines, (l) => /^dependencies\s*\{/.test(l));
  if (top >= 0) return top;
  return lineOf(lines, (l) => l.includes('dependencies') && l.includes('{'));
}

/** Podfile：第一个 target 块内 */
function podfileAnchor(lines: string[]): number {
  return lineOf(lines, (l) => /^\s*target\s+/.test(l));
}

/** oh-package.json5：dependencies 对象（"dependencies": { 同行，或下一行 {） */
function ohPackageAnchor(lines: string[]): number {
  const depKey = lineOf(lines, (l) => l.trimStart().startsWith('"dependencies"'));
  if (depKey < 0) return -1;
  if (lines[depKey]!.includes('{')) return depKey;
  const open = lineOf(lines, (l) => l.trim() === '{', depKey);
  return open >= 0 ? open : depKey;
}

function gradleDep(coord: string): string {
  return `implementation("${coord}")`;
}

/** 元数据条目 "PodName 0.1.0" → pod 'PodName', '0.1.0' */
function podLine(podSpec: string): string {
  const sp = podSpec.lastIndexOf(' ');
  if (sp < 0) return `pod '${podSpec}'`;
  const name = podSpec.slice(0, sp);
  const version = podSpec.slice(sp + 1);
  return `pod '${name}', '${version}'`;
}

/** 元数据条目 "pkg-name@0.1.0" → "pkg-name": "0.1.0" */
function ohPackageEntry(pkgSpec: string): string {
  const at = pkgSpec.lastIndexOf('@');
  if (at < 0) return `"${pkgSpec}": "*"`;
  return `"${pkgSpec.slice(0, at)}": "${pkgSpec.slice(at + 1)}"`;
}

/** 依据 manifest（启用端）与解析结果生成写入计划；文件不存在的目标在 apply 阶段降级为指引。 */
export function planInjections(manifest: Manifest, resolved: Resolved): InjectPlan[] {
  const plans: InjectPlan[] = [];
  const id = resolved.name;
  const { platforms } = manifest;
  const c = resolved.coordinates;

  if (platforms.android && (c.android?.shared || c.android?.app)) {
    if (c.android?.shared) {
      plans.push({
        platform: 'android',
        file: path.join(manifest.paths.shared, 'build.gradle.kts'),
        id,
        comment: '//',
        body: [gradleDep(c.android.shared)],
        anchor: sharedGradleAnchor,
      });
    }
    if (c.android?.app) {
      plans.push({
        platform: 'android',
        file: path.join(manifest.paths.androidApp, 'build.gradle.kts'),
        id,
        comment: '//',
        body: [gradleDep(c.android.app)],
        anchor: appGradleAnchor,
      });
    }
  }

  if (platforms.ios && c.ios?.pods?.length) {
    plans.push({
      platform: 'ios',
      file: path.join(manifest.paths.iosApp, 'Podfile'),
      id,
      comment: '#',
      body: c.ios.pods.map(podLine),
      anchor: podfileAnchor,
      indent: '  ',
    });
  }

  if (platforms.ohos && c.ohos?.packages?.length) {
    plans.push({
      platform: 'ohos',
      file: path.join(manifest.paths.ohosApp, 'oh-package.json5'),
      id,
      comment: '//',
      body: c.ohos.packages.map(ohPackageEntry),
      anchor: ohPackageAnchor,
      indent: '  ',
    });
  }

  return plans;
}

export interface ApplyOptions {
  dryRun?: boolean;
}

/** 应用（或预演）写入计划；返回每个目标的处理结果。 */
export async function applyPlans(
  root: string,
  plans: InjectPlan[],
  opts: ApplyOptions = {},
): Promise<AppliedResult[]> {
  const results: AppliedResult[] = [];
  for (const plan of plans) {
    const abs = resolveWithinRoot(root, plan.file);
    let before: string;
    try {
      before = await fs.readFile(abs, 'utf-8');
    } catch {
      results.push({ plan, mode: 'missing-file' });
      continue;
    }
    const { content: after, mode } = upsertBlock(before, {
      id: plan.id,
      comment: plan.comment,
      body: plan.body,
      anchor: plan.anchor,
      indent: plan.indent,
    });
    if (!opts.dryRun && after !== before) {
      await fs.writeFile(abs, after, 'utf-8');
    }
    results.push({ plan, mode, before, after });
  }
  return results;
}

function pseudoPlan(rel: string): InjectPlan {
  return { platform: 'android' as Platform, file: rel, id: '', comment: '//', body: [] };
}

/** 所有可能的注入目标文件（含未启用端，用于卸载与平台变更后的清理） */
export function allInjectionTargets(manifest: Manifest): string[] {
  return [
    path.join(manifest.paths.shared, 'build.gradle.kts'),
    path.join(manifest.paths.androidApp, 'build.gradle.kts'),
    path.join(manifest.paths.iosApp, 'Podfile'),
    path.join(manifest.paths.ohosApp, 'oh-package.json5'),
  ];
}

/** 卸载：删除各端目标文件中该组件的标记区间。 */
export async function removePlans(root: string, manifest: Manifest, name: string): Promise<AppliedResult[]> {
  const results: AppliedResult[] = [];
  for (const rel of allInjectionTargets(manifest)) {
    const abs = resolveWithinRoot(root, rel);
    let before: string;
    try {
      before = await fs.readFile(abs, 'utf-8');
    } catch {
      continue;
    }
    const comment = rel.endsWith('Podfile') ? '#' : '//';
    const { content: after, removed } = removeBlock(before, name, comment);
    if (removed) {
      await fs.writeFile(abs, after, 'utf-8');
      results.push({ plan: pseudoPlan(rel), mode: 'removed', before, after });
    }
  }
  return results;
}
