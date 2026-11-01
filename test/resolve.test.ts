import { describe, expect, it } from 'vitest';
import type { ComponentMeta, Ctx, Fetcher, Manifest, OfficialIndexEntry } from '../src/types.js';
import { resolveDependency } from '../src/resolve.js';

const OFFICIAL_INDEX: OfficialIndexEntry[] = [
  {
    githubUrl: 'https://github.com/zhanghaifei1997/kuikly-app-icon',
    componentName: 'kuikly-app-icon',
    componentType: 'KuiklyModule',
    Android: true,
    iOS: true,
    Ohos: true,
  },
  {
    githubUrl: 'https://github.com/someone/ios-only-comp',
    componentName: 'ios-only-comp',
    componentType: 'KuiklyModule',
    iOS: true,
  },
  {
    githubUrl: 'https://github.com/someone/partial-comp',
    componentName: 'partial-comp',
    componentType: 'KuiklyModule',
    Android: true,
    iOS: true,
  },
];

const APP_ICON_META: ComponentMeta = {
  schemaVersion: 1,
  componentName: 'kuikly-app-icon',
  componentType: 'KuiklyModule',
  versions: {
    '0.0.9': { platforms: { android: { shared: 'g:a:{version}' } } },
    '0.1.0': {
      kuikly: '>=2.30.0-2.0.21',
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
        ohos: 'app.json5 预置 alternateIcons（API 26+）',
      },
    },
  },
};

const IOS_ONLY_META: ComponentMeta = {
  schemaVersion: 1,
  componentName: 'ios-only-comp',
  componentType: 'KuiklyModule',
  versions: {
    '1.0.0': { platforms: { ios: { pods: ['IOSOnly {version}'] } } },
  },
};

const PARTIAL_META: ComponentMeta = {
  schemaVersion: 1,
  componentName: 'partial-comp',
  componentType: 'KuiklyModule',
  versions: {
    '1.0.0': {
      platforms: {
        android: { app: 'g:partial-android:{version}' },
        ios: { pods: ['Partial {version}'] },
      },
    },
  },
};

function makeMockFetcher(): Fetcher {
  return async (url) => {
    // 注意：API 的 commits URL 也包含 "KuiklyUI-Libraries.json"（query 参数），必须先判 API 域
    if (url.startsWith('https://api.github.com/repos/Tencent-TDS')) {
      return { status: 200, text: JSON.stringify([{ sha: 'indexsha' }]) };
    }
    if (url.startsWith('https://api.github.com/repos/zhanghaifei1997/kuikly-app-icon')) {
      return { status: 200, text: JSON.stringify({ sha: 'metasha' }) };
    }
    if (url.includes('KuiklyUI-Libraries.json')) {
      return { status: 200, text: JSON.stringify(OFFICIAL_INDEX) };
    }
    if (url.includes('raw.githubusercontent.com/zhanghaifei1997/kuikly-app-icon')) {
      return { status: 200, text: JSON.stringify(APP_ICON_META) };
    }
    if (url.includes('raw.githubusercontent.com/someone/ios-only-comp')) {
      return { status: 200, text: JSON.stringify(IOS_ONLY_META) };
    }
    if (url.includes('raw.githubusercontent.com/someone/partial-comp')) {
      return { status: 200, text: JSON.stringify(PARTIAL_META) };
    }
    return { status: 404, text: '' };
  };
}

async function makeCtx(): Promise<Ctx> {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'kpm-test-cache-'));
  return { root: '/unused', cacheDir, fetcher: makeMockFetcher() };
}

function manifest(platforms: { android?: boolean; ios?: boolean; ohos?: boolean }): Manifest {
  return {
    schemaVersion: 1,
    name: 't',
    platforms: { android: !!platforms.android, ios: !!platforms.ios, ohos: !!platforms.ohos },
    dependencies: {},
    registries: [],
    paths: { shared: 'shared', androidApp: 'androidApp', iosApp: 'iosApp', ohosApp: 'ohosApp' },
  };
}

describe('resolve 解析链路', () => {
  it('官方索引 → 组件元数据 → semver 最大满足 → 坐标替换', async () => {
    const ctx = await makeCtx();
    const r = await resolveDependency(ctx, manifest({ android: true, ios: true, ohos: true }), 'kuikly-app-icon', '^0.1.0');
    expect(r.version).toBe('0.1.0');
    expect(r.coordinates.android?.shared).toBe('io.github.zhanghaifei1997:kuiklyAppIcon:0.1.0');
    expect(r.coordinates.android?.app).toBe('io.github.zhanghaifei1997:kuiklyAppIconAndroid:0.1.0');
    expect(r.coordinates.ios?.pods).toEqual(['kuiklyAppIconIOS 0.1.0']);
    expect(r.coordinates.ohos?.packages).toEqual(['kuikly-app-icon-ohos@0.1.0']);
    expect(r.coordinates.ohos?.shared).toBe('io.github.zhanghaifei1997:kuiklyAppIcon:0.1.0-ohos');
    expect(r.source).toMatchObject({ index: 'official', repo: 'zhanghaifei1997/kuikly-app-icon', indexSha: 'indexsha', metaSha: 'metasha' });
    expect(r.warnings).toEqual([]);
  });

  it('平台裁剪：lock 记录全部支持端坐标（说明书），注入由 manifest 裁剪', async () => {
    const ctx = await makeCtx();
    const r = await resolveDependency(ctx, manifest({ ohos: true }), 'kuikly-app-icon', '*');
    // 坐标完整记录三端（供端开关切换后还原）；实际写哪些文件由 planInjections 按 platforms 过滤（见 e2e）
    expect(r.coordinates).toMatchObject({
      ohos: { shared: 'io.github.zhanghaifei1997:kuiklyAppIcon:0.1.0-ohos', packages: ['kuikly-app-icon-ohos@0.1.0'] },
    });
    expect(r.coordinates.android?.app).toBeDefined();
    expect(r.coordinates.ios?.pods).toBeDefined();
    expect(r.warnings).toEqual([]);
  });

  it('平台裁剪：组件不支持部分启用端 → 警告；完全无交集 → 拒绝', async () => {
    const ctx = await makeCtx();
    const r = await resolveDependency(ctx, manifest({ android: true, ios: true, ohos: true }), 'partial-comp', '*');
    expect(r.coordinates.ohos).toBeUndefined(); // 组件本身不支持鸿蒙
    expect(r.warnings.join(' ')).toContain('不支持 ohos');

    await expect(
      resolveDependency(ctx, manifest({ android: true }), 'ios-only-comp', '*'),
    ).rejects.toThrow(/没有交集/);
  });

  it('semver：0.0.9 与 0.1.0 并存时 ^0.1.0 选 0.1.0，无满足版本报可用列表', async () => {
    const ctx = await makeCtx();
    const r = await resolveDependency(ctx, manifest({ ohos: true }), 'kuikly-app-icon', '^0.1.0');
    expect(r.version).toBe('0.1.0');
    await expect(
      resolveDependency(ctx, manifest({ ohos: true }), 'kuikly-app-icon', '^1.0.0'),
    ).rejects.toThrow(/没有 satisfy/);
  });

  it('未收录组件报错并提示 github-url 直连', async () => {
    const ctx = await makeCtx();
    await expect(resolveDependency(ctx, manifest({ ohos: true }), 'not-exist', '*')).rejects.toThrow(/github-url/);
  });

  it('GitHub URL 直连：跳过官方索引', async () => {
    const ctx = await makeCtx();
    const r = await resolveDependency(
      ctx,
      manifest({ android: true }),
      'https://github.com/zhanghaifei1997/kuikly-app-icon/tree/main/demo',
      '0.1.x',
    );
    expect(r.source.index).toBe('direct');
    expect(r.version).toBe('0.1.0');
  });

  it('磁盘缓存生效：第二次解析不再访问网络', async () => {
    const ctx = await makeCtx();
    await resolveDependency(ctx, manifest({ ohos: true }), 'kuikly-app-icon', '*');
    // 换成"必 404"的 fetcher，若仍能解析成功则说明命中缓存
    const offline: Fetcher = async () => ({ status: 404, text: '' });
    const r = await resolveDependency({ ...ctx, fetcher: offline }, manifest({ ohos: true }), 'kuikly-app-icon', '*');
    expect(r.version).toBe('0.1.0');
  });
});
