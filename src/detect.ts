/** 工程结构探测（kpm init）：识别 shared/androidApp/iosApp/ohosApp 并推导目标端 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ManifestPaths, Platforms } from './types.js';

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function hasFile(dir: string, file: string): Promise<boolean> {
  return exists(path.join(dir, file));
}

async function hasGlob(dir: string, suffix: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.some((e) => e.name.endsWith(suffix));
  } catch {
    return false;
  }
}

const SHARED_CANDIDATES = ['shared', 'common', 'kmm'];

export interface DetectResult {
  platforms: Platforms;
  paths: ManifestPaths;
  notes: string[];
}

export async function detectProject(root: string): Promise<DetectResult> {
  const notes: string[] = [];

  let shared = 'shared';
  let sharedFound = false;
  for (const c of SHARED_CANDIDATES) {
    if (await hasFile(path.join(root, c), 'build.gradle.kts')) {
      shared = c;
      sharedFound = true;
      break;
    }
  }
  if (!sharedFound) notes.push(`未找到共享模块目录（尝试过 ${SHARED_CANDIDATES.join('/')}），paths.shared 默认为 "shared"，请按需 kpm config 修正`);

  const androidApp = 'androidApp';
  const androidOk = await hasFile(path.join(root, androidApp), 'build.gradle.kts');

  const iosApp = 'iosApp';
  const iosOk = (await hasFile(path.join(root, iosApp), 'Podfile')) || (await hasGlob(path.join(root, iosApp), '.xcodeproj'));

  const ohosApp = 'ohosApp';
  const ohosOk =
    (await hasFile(path.join(root, ohosApp), 'oh-package.json5')) ||
    (await hasFile(path.join(root, ohosApp), 'build-profile.json5'));

  const any = androidOk || iosOk || ohosOk;
  if (!any) notes.push('未探测到任何端工程目录，platforms 需手工配置（kpm config set platforms.<端> true）');

  return {
    platforms: { android: androidOk, ios: iosOk, ohos: ohosOk },
    paths: { shared, androidApp, iosApp, ohosApp },
    notes,
  };
}
