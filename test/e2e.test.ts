import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Ctx, Fetcher, OfficialIndexEntry, ComponentMeta } from '../src/types.js';
import { runAdd, runDoctorAction, runInit, runInstall, runList, runRemove } from '../src/actions.js';
import { readLock, readManifest } from '../src/manifest.js';

const SHARED_GRADLE = `kotlin {
    sourceSets {
        val commonMain by getting {
            dependencies {
                implementation(project(":shared"))
            }
        }
    }
}
`;
const ANDROID_GRADLE = `plugins { id("com.android.application") }

dependencies {
    implementation(project(":shared"))
}
`;
const PODFILE = `platform :ios, '13.0'
target 'iosApp' do
end
`;
const OH_PACKAGE = `{
  "name": "entry",
  "version": "1.0.0",
  "dependencies": {
    "@kuikly-open/render": "*"
  }
}
`;

const META: ComponentMeta = {
  schemaVersion: 1,
  componentName: 'kuikly-app-icon',
  componentType: 'KuiklyModule',
  versions: {
    '0.1.0': {
      platforms: {
        android: {
          shared: 'io.github.zhanghaifei1997:kuiklyAppIcon:{version}',
          app: 'io.github.zhanghaifei1997:kuiklyAppIconAndroid:{version}',
        },
        ios: { pods: ['kuiklyAppIconIOS {version}'] },
        ohos: { shared: 'io.github.zhanghaifei1997:kuiklyAppIcon:{version}-ohos', packages: ['kuikly-app-icon-ohos@{version}'] },
      },
      registration: {
        android: { kind: 'module', snippet: 'moduleExport(KRAppIconModule.MODULE_NAME) { KRAppIconModule() }' },
        ios: null,
        ohos: { kind: 'module', snippet: 'map.set(KRAppIconModule.MODULE_NAME, () => new KRAppIconModule());' },
      },
      hostPrerequisites: {
        android: 'AndroidManifest.xml 预置 activity-alias',
        ios: 'Info.plist 预置 CFBundleAlternateIcons',
        ohos: 'app.json5 预置 alternateIcons',
      },
    },
  },
};

const fetcher: Fetcher = async (url) => {
  if (url.startsWith('https://api.github.com/')) return { status: 200, text: JSON.stringify({ sha: 'deadbeef' }) };
  if (url.includes('KuiklyUI-Libraries.json')) {
    const entries: OfficialIndexEntry[] = [
      { githubUrl: 'https://github.com/zhanghaifei1997/kuikly-app-icon', componentName: 'kuikly-app-icon' },
    ];
    return { status: 200, text: JSON.stringify(entries) };
  }
  if (url.includes('raw.githubusercontent.com/zhanghaifei1997/kuikly-app-icon')) {
    return { status: 200, text: JSON.stringify(META) };
  }
  return { status: 404, text: '' };
};

let root: string;
let cacheDir: string;
let ctx: Ctx;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'kpm-e2e-'));
  cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kpm-e2e-cache-'));
  ctx = { root, cacheDir, fetcher };
  await fs.mkdir(path.join(root, 'shared'), { recursive: true });
  await fs.mkdir(path.join(root, 'androidApp'), { recursive: true });
  await fs.mkdir(path.join(root, 'iosApp'), { recursive: true });
  await fs.mkdir(path.join(root, 'ohosApp'), { recursive: true });
  await fs.writeFile(path.join(root, 'shared', 'build.gradle.kts'), SHARED_GRADLE);
  await fs.writeFile(path.join(root, 'androidApp', 'build.gradle.kts'), ANDROID_GRADLE);
  await fs.writeFile(path.join(root, 'iosApp', 'Podfile'), PODFILE);
  await fs.writeFile(path.join(root, 'ohosApp', 'oh-package.json5'), OH_PACKAGE);
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(cacheDir, { recursive: true, force: true });
});

describe('e2e：init → add → doctor → install → 平台裁剪 → remove', () => {
  it('init 探测三端', async () => {
    const m = await runInit(ctx);
    expect(m.platforms).toEqual({ android: true, ios: true, ohos: true });
    expect(m.paths.shared).toBe('shared');
  });

  it('add：三端注入 + manifest/lock + 指引落盘', async () => {
    const r = await runAdd(ctx, 'kuikly-app-icon@^0.1.0', { yes: true });
    expect(r.version).toBe('0.1.0');

    const shared = await fs.readFile(path.join(root, 'shared', 'build.gradle.kts'), 'utf-8');
    expect(shared).toContain('implementation("io.github.zhanghaifei1997:kuiklyAppIcon:0.1.0")');
    const android = await fs.readFile(path.join(root, 'androidApp', 'build.gradle.kts'), 'utf-8');
    expect(android).toContain('implementation("io.github.zhanghaifei1997:kuiklyAppIconAndroid:0.1.0")');
    const podfile = await fs.readFile(path.join(root, 'iosApp', 'Podfile'), 'utf-8');
    expect(podfile).toContain("pod 'kuiklyAppIconIOS', '0.1.0'");
    const ohpkg = await fs.readFile(path.join(root, 'ohosApp', 'oh-package.json5'), 'utf-8');
    expect(ohpkg).toContain('"kuikly-app-icon-ohos": "0.1.0"');
    expect(ohpkg).toContain('"@kuikly-open/render": "*"'); // 原有内容不动

    const manifest = await readManifest(root);
    expect(manifest!.dependencies['kuikly-app-icon']).toBe('^0.1.0');
    const lock = await readLock(root);
    expect(lock!.dependencies['kuikly-app-icon']!.resolved).toBe('0.1.0');

    const pending = await fs.readFile(path.join(root, '.kpm', 'pending.md'), 'utf-8');
    expect(pending).toContain('moduleExport(KRAppIconModule.MODULE_NAME)');
    expect(pending).toContain('activity-alias');
    expect(pending).toContain('-ohos'); // 鸿蒙 shared 手工接线指引
  });

  it('doctor：注册代码未粘贴 → warn；粘贴后 → ok', async () => {
    const before = await runDoctorAction(ctx);
    expect(before).toBe(true); // 无 fail 项（注册未粘贴是 warn）

    await fs.mkdir(path.join(root, 'androidApp', 'src'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'androidApp', 'src', 'Delegate.kt'),
      'class D { fun reg() { moduleExport(KRAppIconModule.MODULE_NAME) { KRAppIconModule() } } }',
    );
    await fs.mkdir(path.join(root, 'ohosApp', 'src'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'ohosApp', 'src', 'KuiklyViewDelegate.ets'),
      'const map = new Map(); map.set(KRAppIconModule.MODULE_NAME, () => new KRAppIconModule());',
    );
    const after = await runDoctorAction(ctx);
    expect(after).toBe(true);
  });

  it('install 幂等：重复执行文件内容不变', async () => {
    const before = await fs.readFile(path.join(root, 'shared', 'build.gradle.kts'), 'utf-8');
    await runInstall(ctx, { frozen: true });
    const after = await fs.readFile(path.join(root, 'shared', 'build.gradle.kts'), 'utf-8');
    expect(after).toBe(before);
  });

  it('平台裁剪：config 关掉 android/ios 后 install 清理残留区间', async () => {
    const m = await readManifest(root);
    m!.platforms.android = false;
    m!.platforms.ios = false;
    const { writeManifest } = await import('../src/manifest.js');
    await writeManifest(root, m!);
    await runInstall(ctx);

    const shared = await fs.readFile(path.join(root, 'shared', 'build.gradle.kts'), 'utf-8');
    expect(shared).not.toContain('kpm:begin');
    const podfile = await fs.readFile(path.join(root, 'iosApp', 'Podfile'), 'utf-8');
    expect(podfile).not.toContain('kpm:begin');
    const ohpkg = await fs.readFile(path.join(root, 'ohosApp', 'oh-package.json5'), 'utf-8');
    expect(ohpkg).toContain('"kuikly-app-icon-ohos": "0.1.0"'); // 鸿蒙仍在

    // 恢复三端并重装
    m!.platforms.android = true;
    m!.platforms.ios = true;
    await writeManifest(root, m!);
    await runInstall(ctx, { frozen: true });
    expect(await fs.readFile(path.join(root, 'iosApp', 'Podfile'), 'utf-8')).toContain("pod 'kuiklyAppIconIOS', '0.1.0'");
  });

  it('list 输出各端坐标', async () => {
    await runList(ctx);
  });

  it('remove：完整还原三端文件', async () => {
    await runRemove(ctx, 'kuikly-app-icon');
    expect(await fs.readFile(path.join(root, 'shared', 'build.gradle.kts'), 'utf-8')).toBe(SHARED_GRADLE);
    expect(await fs.readFile(path.join(root, 'androidApp', 'build.gradle.kts'), 'utf-8')).toBe(ANDROID_GRADLE);
    expect(await fs.readFile(path.join(root, 'iosApp', 'Podfile'), 'utf-8')).toBe(PODFILE);
    expect(await fs.readFile(path.join(root, 'ohosApp', 'oh-package.json5'), 'utf-8')).toBe(OH_PACKAGE);
    const lock = await readLock(root);
    expect(lock!.dependencies['kuikly-app-icon']).toBeUndefined();
  });
});

describe('e2e：单端（纯鸿蒙）工程', () => {
  it('只有 ohosApp 时只注入鸿蒙端', async () => {
    const single = await fs.mkdtemp(path.join(os.tmpdir(), 'kpm-ohos-only-'));
    try {
      await fs.mkdir(path.join(single, 'shared'), { recursive: true });
      await fs.mkdir(path.join(single, 'ohosApp'), { recursive: true });
      await fs.writeFile(path.join(single, 'shared', 'build.gradle.kts'), SHARED_GRADLE);
      await fs.writeFile(path.join(single, 'ohosApp', 'oh-package.json5'), OH_PACKAGE);
      const sctx: Ctx = { root: single, cacheDir, fetcher };

      const m = await runInit(sctx);
      expect(m.platforms).toEqual({ android: false, ios: false, ohos: true });

      const r = await runAdd(sctx, 'kuikly-app-icon', { yes: true });
      // lock/坐标记录全部支持端（说明书），注入只写启用端
      expect(r.coordinates).toMatchObject({
        ohos: { shared: 'io.github.zhanghaifei1997:kuiklyAppIcon:0.1.0-ohos', packages: ['kuikly-app-icon-ohos@0.1.0'] },
      });
      // shared/androidApp/iOS 均未被触碰
      expect(await fs.readFile(path.join(single, 'shared', 'build.gradle.kts'), 'utf-8')).toBe(SHARED_GRADLE);
      expect(await fs.readdir(path.join(single))).not.toContain('iosApp');
      const ohpkg = await fs.readFile(path.join(single, 'ohosApp', 'oh-package.json5'), 'utf-8');
      expect(ohpkg).toContain('"kuikly-app-icon-ohos": "0.1.0"');
      // pending.md 只含鸿蒙条目
      const pending = await fs.readFile(path.join(single, '.kpm', 'pending.md'), 'utf-8');
      expect(pending).not.toContain('[Android]');
      expect(pending).not.toContain('[iOS]');
      expect(pending).toContain('鸿蒙');
    } finally {
      await fs.rm(single, { recursive: true, force: true });
    }
  });
});
