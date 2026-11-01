/** 注册代码与宿主预置配置的指引输出（DESIGN.md §6.4：不自动改源码，输出指引 + doctor 校验） */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AppliedResult, Manifest, Resolved } from './types.js';
import { PENDING_FILE } from './manifest.js';

function resolveWithinRoot(root: string, rel: string): string {
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, rel);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw new Error(`kpm: 目标路径越出工程根目录（${rel}），已拒绝写入`);
  }
  return abs;
}

export interface GuideStep {
  platform: string;
  text: string;
  /** doctor 校验用的 snippet（去除全部空白后在宿主源码中搜索） */
  verifySnippet?: string;
}

const PLATFORM_LABEL: Record<string, string> = { android: 'Android', ios: 'iOS', ohos: '鸿蒙' };

export function buildSteps(manifest: Manifest, resolved: Resolved, applied: AppliedResult[]): GuideStep[] {
  const steps: GuideStep[] = [];
  const { platforms } = manifest;

  for (const r of applied) {
    if (r.mode === 'missing-file') {
      steps.push({ platform: PLATFORM_LABEL[r.plan.platform] ?? r.plan.platform, text: `目标文件不存在：${r.plan.file}（请修正 kpm config paths.* 或手工接线）` });
    }
  }

  if (platforms.android) {
    const reg = resolved.registration?.android;
    if (reg?.snippet) {
      steps.push({
        platform: 'Android',
        text: `在 ${reg.anchor ?? 'registerExternalModule（KuiklyRenderViewBaseDelegatorDelegate 实现类）'} 中添加：\n    ${reg.snippet}`,
        verifySnippet: reg.snippet,
      });
    }
    const pre = resolved.hostPrerequisites?.android;
    if (pre) steps.push({ platform: 'Android', text: `宿主预置：${pre}` });
    const repos = resolved.coordinates.android?.repositories;
    if (repos?.length) steps.push({ platform: 'Android', text: `settings.gradle.kts 手工添加仓库：${repos.join(', ')}` });
  }

  if (platforms.ios) {
    const reg = resolved.registration?.ios;
    if (reg?.snippet) {
      steps.push({
        platform: 'iOS',
        text: `${reg.anchor ?? '注册位置'} 中添加：\n    ${reg.snippet}`,
        verifySnippet: reg.snippet,
      });
    }
    const pre = resolved.hostPrerequisites?.ios;
    if (pre) steps.push({ platform: 'iOS', text: `宿主预置：${pre}` });
    if (resolved.coordinates.ios?.pods?.length) {
      steps.push({ platform: 'iOS', text: `在 ${manifest.paths.iosApp}/ 执行 pod install` });
    }
  }

  if (platforms.ohos) {
    const reg = resolved.registration?.ohos;
    if (reg?.snippet) {
      steps.push({
        platform: '鸿蒙',
        text: `在 ${reg.anchor ?? 'KuiklyViewDelegate 的注册 map'} 中添加：\n    ${reg.snippet}`,
        verifySnippet: reg.snippet,
      });
    }
    const pre = resolved.hostPrerequisites?.ohos;
    if (pre) steps.push({ platform: '鸿蒙', text: `宿主预置：${pre}` });
    const ohosShared = resolved.coordinates.ohos?.shared;
    if (ohosShared) {
      steps.push({
        platform: '鸿蒙',
        text: `KMP 共享模块的鸿蒙变体依赖（${ohosShared}）：按宿主 ohos 变体构建机制（settings.ohos.gradle.kts）手工接线；OHPM 实现包已自动注入 oh-package.json5`,
      });
    }
  }

  return steps;
}

export function renderStepsConsole(name: string, version: string, steps: GuideStep[]): string[] {
  const lines: string[] = [];
  if (steps.length === 0) {
    lines.push(`📎 ${name}@${version}：无需手工步骤`);
    return lines;
  }
  lines.push(`📎 ${name}@${version} 还需手工（详见 .kpm/pending.md，kpm doctor 可校验）：`);
  steps.forEach((s, i) => {
    lines.push(`  ${i + 1}. [${s.platform}] ${s.text.split('\n').join('\n     ')}`);
  });
  return lines;
}

export async function writePending(root: string, name: string, version: string, steps: GuideStep[]): Promise<void> {
  const abs = resolveWithinRoot(root, PENDING_FILE);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const now = new Date().toISOString();
  const body = [
    `# kpm 待办（手工步骤）`,
    `> 组件：${name}@${version} · 生成于 ${now} · kpm doctor 可校验完成度`,
    '',
    ...steps.map((s, i) => `- [ ] **[${s.platform}]** ${s.text.split('\n').join('<br>')}`),
    '',
  ].join('\n');
  await fs.writeFile(abs, body, 'utf-8');
}
