/**
 * 解析链路（DESIGN.md §5）：
 *   ① 私有索引（manifest.registries） → ② 官方市场索引（只读） → ③ 组件仓库 kuikly.component.json
 *   → semver 范围求最大满足版本 → 平台裁剪（§6.0）→ {version} 坐标替换
 * 带磁盘缓存（~/.kpm/cache），支持 --refresh / --offline。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import JSON5 from 'json5';
import semver from 'semver';
import type {
  ComponentMeta,
  Ctx,
  Fetcher,
  Manifest,
  OfficialIndexEntry,
  PrivateRegistry,
  Resolved,
  ResolvedCoordinates,
} from './types.js';

export const OFFICIAL_INDEX_REPO = 'Tencent-TDS/KuiklyUI-third-party';
const OFFICIAL_INDEX_URL = `https://raw.githubusercontent.com/${OFFICIAL_INDEX_REPO}/main/KuiklyUI-Libraries.json`;
const INDEX_TTL_MS = 60 * 60 * 1000;
const META_TTL_MS = 15 * 60 * 1000;

export class ResolveError extends Error {}

/** 默认 fetcher：全局 fetch 的薄封装（Node >= 18） */
export const defaultFetcher: Fetcher = async (url, headers) => {
  const res = await fetch(url, { headers, redirect: 'follow' });
  return { status: res.status, text: await res.text() };
};

function getFetcher(ctx: Ctx): Fetcher {
  return ctx.fetcher ?? defaultFetcher;
}

async function fetchJson<T>(ctx: Ctx, url: string, api = false): Promise<T | null> {
  if (ctx.offline) throw new ResolveError(`kpm: --offline 模式但缓存未命中（${url}）`);
  const headers: Record<string, string> = {};
  if (api && ctx.githubToken) headers.Authorization = `Bearer ${ctx.githubToken}`;
  if (api) headers.Accept = 'application/vnd.github+json';
  const res = await getFetcher(ctx)(url, headers);
  if (res.status === 404) return null;
  if (res.status === 403 || res.status === 429) {
    throw new ResolveError(`kpm: GitHub API 限流（${res.status}），可稍后重试或设置 KPM_GITHUB_TOKEN`);
  }
  if (res.status >= 400) throw new ResolveError(`kpm: 请求失败 ${res.status} ${url}`);
  return JSON.parse(res.text) as T;
}

// ---------- 缓存 ----------

interface CacheEnvelope<T> {
  fetchedAt: number;
  body: T;
}

async function readCache<T>(file: string, ttlMs: number): Promise<T | null> {
  try {
    const raw = await fs.readFile(file, 'utf-8');
    const env = JSON.parse(raw) as CacheEnvelope<T>;
    if (Date.now() - env.fetchedAt > ttlMs) return null;
    return env.body;
  } catch {
    return null;
  }
}

async function writeCache<T>(file: string, body: T): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const env: CacheEnvelope<T> = { fetchedAt: Date.now(), body };
  await fs.writeFile(file, JSON.stringify(env, null, 2), 'utf-8');
}

async function readStaleCache<T>(file: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(file, 'utf-8');
    return (JSON.parse(raw) as CacheEnvelope<T>).body;
  } catch {
    return null;
  }
}

// ---------- ① 官方索引（含私有索引回退链） ----------

interface IndexHit {
  githubUrl: string | null;
  source: 'official' | 'private' | 'direct';
  indexSha?: string | null;
}

/** 从 GitHub 仓库 URL 提取 owner/repo；返回 null 表示不是 GitHub 仓库地址 */
export function parseGithubRepo(url: string): { owner: string; repo: string } | null {
  const m = url.match(/github\.com[/:]([^/]+)\/([^/#?]+)/i);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]!.replace(/\.git$/, '') };
}

async function lookupIndex(ctx: Ctx, manifest: Manifest, name: string): Promise<IndexHit> {
  // ① 私有索引优先
  for (const regUrl of manifest.registries ?? []) {
    const reg = await fetchJson<PrivateRegistry>(ctx, regUrl);
    if (reg?.components?.[name]) {
      const comp = reg.components[name]!;
      // 内联 metadata 的私有索引：githubUrl 可省略
      return { githubUrl: comp.githubUrl ?? null, source: 'private' };
    }
  }

  // ② 官方市场索引（磁盘缓存 + TTL）
  const cacheFile = path.join(ctx.cacheDir, 'official-index.json');
  if (!ctx.refresh) {
    const cached = await readCache<OfficialIndexEntry[]>(cacheFile, INDEX_TTL_MS);
    if (cached) {
      const hit = cached.find((e) => e.componentName === name);
      if (hit) return { githubUrl: hit.githubUrl, source: 'official' };
    }
  }
  const entries = await fetchJson<OfficialIndexEntry[]>(ctx, OFFICIAL_INDEX_URL);
  if (!entries) throw new ResolveError(`kpm: 官方市场索引拉取失败（${OFFICIAL_INDEX_URL}）`);
  await writeCache(cacheFile, entries);
  const hit = entries.find((e) => e.componentName === name);
  if (hit) {
    // best-effort 记录索引 commit（供应链审计用，失败不阻塞）
    let sha: string | null = null;
    try {
      const commits = await fetchJson<Array<{ sha: string }>>(
        ctx,
        `https://api.github.com/repos/${OFFICIAL_INDEX_REPO}/commits?path=KuiklyUI-Libraries.json&per_page=1`,
        true,
      );
      sha = commits?.[0]?.sha ?? null;
    } catch {
      /* 限流等场景降级 */
    }
    return { githubUrl: hit.githubUrl, source: 'official', indexSha: sha };
  }
  return { githubUrl: null, source: 'official' };
}

// ---------- ③ 组件元数据 ----------

async function fetchComponentMeta(ctx: Ctx, repo: string): Promise<{ meta: ComponentMeta; sha: string | null }> {
  const cacheFile = path.join(ctx.cacheDir, 'meta', `${repo.replace('/', '__')}.json`);
  if (!ctx.refresh) {
    const cached = await readCache<{ meta: ComponentMeta; sha: string | null }>(cacheFile, META_TTL_MS);
    if (cached) return cached;
  }
  if (ctx.offline) {
    const stale = await readStaleCache<{ meta: ComponentMeta; sha: string | null }>(cacheFile);
    if (stale) return stale;
    throw new ResolveError(`kpm: --offline 模式但元数据缓存未命中（${repo}）`);
  }

  const rawUrl = `https://raw.githubusercontent.com/${repo}/HEAD/kuikly.component.json`;
  const res = await getFetcher(ctx)(rawUrl);
  if (res.status === 404) {
    throw new ResolveError(
      `kpm: 组件仓库 ${repo} 缺少 kuikly.component.json（组件作者接入指引见 kuikly-kpm README）`,
    );
  }
  if (res.status >= 400) throw new ResolveError(`kpm: 拉取组件元数据失败 ${res.status} ${rawUrl}`);

  let meta: ComponentMeta;
  try {
    meta = JSON5.parse(res.text) as ComponentMeta;
  } catch (e) {
    throw new ResolveError(`kpm: ${repo} 的 kuikly.component.json 解析失败：${(e as Error).message}`);
  }
  if (!meta.versions || typeof meta.versions !== 'object') {
    throw new ResolveError(`kpm: ${repo} 的 kuikly.component.json 缺少 versions 字段`);
  }

  // best-effort 记录 HEAD commit
  let sha: string | null = null;
  try {
    const commit = await fetchJson<{ sha: string }>(ctx, `https://api.github.com/repos/${repo}/commits/HEAD`, true);
    sha = commit?.sha ?? null;
  } catch {
    /* 降级 */
  }

  const payload = { meta, sha };
  await writeCache(cacheFile, payload);
  return payload;
}

// ---------- 平台裁剪 + 版本解析 ----------

function enabledPlatforms(manifest: Manifest): Array<'android' | 'ios' | 'ohos'> {
  const out: Array<'android' | 'ios' | 'ohos'> = [];
  if (manifest.platforms.android) out.push('android');
  if (manifest.platforms.ios) out.push('ios');
  if (manifest.platforms.ohos) out.push('ohos');
  return out;
}

function substitute(coord: string, version: string): string {
  return coord.split('{version}').join(version);
}

/** 核心入口：解析一个依赖。name 可以是组件名或 GitHub 仓库 URL。 */
export async function resolveDependency(ctx: Ctx, manifest: Manifest, name: string, range: string): Promise<Resolved> {
  const warnings: string[] = [];

  const isUrl = /^https?:\/\//i.test(name);
  let repo: string;
  let source: Resolved['source'];
  let indexSha: string | null = null;

  if (isUrl) {
    const parsed = parseGithubRepo(name);
    if (!parsed) throw new ResolveError(`kpm: 无法识别的 GitHub 仓库地址：${name}`);
    repo = `${parsed.owner}/${parsed.repo}`;
    source = { index: 'direct', repo, indexSha: null };
  } else {
    const hit = await lookupIndex(ctx, manifest, name);
    if (!hit.githubUrl) {
      // 私有索引可能内联 metadata（githubUrl 为空）——M1 暂不支持，明确报错
      throw new ResolveError(
        `kpm: 组件「${name}」未在官方市场索引中收录（或仅收录为私有条目）。` +
          `可用 kpm add <github-url> 直接指定仓库`,
      );
    }
    const parsed = parseGithubRepo(hit.githubUrl);
    if (!parsed) throw new ResolveError(`kpm: 索引中的 githubUrl 无法解析：${hit.githubUrl}`);
    repo = `${parsed.owner}/${parsed.repo}`;
    source = { index: hit.source, repo, indexSha: hit.indexSha ?? null };
    indexSha = hit.indexSha ?? null;
  }

  const { meta, sha } = await fetchComponentMeta(ctx, repo);
  if (meta.componentName && isUrl && meta.componentName !== name) {
    warnings.push(`仓库 ${repo} 的 componentName 为 ${meta.componentName}，与命令行输入 ${name} 不同，已按仓库为准`);
    name = meta.componentName;
  }

  // semver：取满足 range 的最大版本
  const versions = Object.keys(meta.versions).filter((v) => semver.valid(v));
  if (versions.length === 0) throw new ResolveError(`kpm: ${repo} 的 kuikly.component.json 没有合法版本号`);
  const version = semver.maxSatisfying(versions, range) ?? undefined;
  if (!version) {
    throw new ResolveError(`kpm: ${repo} 没有 satisfy「${range}」的版本（可用：${versions.sort(semver.compare).join(', ')}）`);
  }
  const vmeta = meta.versions[version]!;

  // 平台裁剪（§6.0）
  const enabled = enabledPlatforms(manifest);
  if (enabled.length === 0) throw new ResolveError('kpm: 工程未启用任何平台（kuikly.pkg.json platforms 全为 false）');
  const supported = Object.keys(vmeta.platforms ?? {}).filter(
    (p) => (vmeta.platforms as Record<string, unknown>)?.[p] != null,
  ) as Array<'android' | 'ios' | 'ohos'>;
  const intersection = enabled.filter((p) => supported.includes(p));
  if (intersection.length === 0) {
    throw new ResolveError(
      `kpm: 组件 ${name} 支持的平台（${supported.join('/') || '无'}）与工程启用平台（${enabled.join('/')}）没有交集`,
    );
  }
  for (const p of enabled) {
    if (!supported.includes(p)) {
      warnings.push(`组件 ${name} 不支持 ${p}，该端不会注入（运行时能力请依赖组件自身 isSupported 约定）`);
    }
  }

  // 坐标替换：记录组件在该版本「全部支持端」的坐标（lock 是完整接线说明书）。
  // 注入时的平台裁剪由 planInjections 按 manifest.platforms 过滤——这样端开关切换后
  // 重新 install（含 --frozen）可以完整还原各端注入。
  const coordinates: ResolvedCoordinates = {};
  const pa = vmeta.platforms.android;
  if (pa) {
    coordinates.android = {
      shared: pa.shared ? substitute(pa.shared, version) : undefined,
      app: pa.app ? substitute(pa.app, version) : undefined,
      repositories: pa.repositories,
    };
    if (enabled.includes('android') && pa.repositories?.length) {
      warnings.push(`组件 ${name} 需要额外 maven 仓库：${pa.repositories.join(', ')}（M1 需手工配置 settings.gradle.kts）`);
    }
  }
  const pi = vmeta.platforms.ios;
  if (pi) {
    coordinates.ios = {
      pods: pi.pods?.map((p) => substitute(p, version)),
      sharedNote: pi.sharedNote,
    };
    if (enabled.includes('ios') && pi.sharedNote) warnings.push(`${name} iOS：${pi.sharedNote}`);
  }
  const po = vmeta.platforms.ohos;
  if (po) {
    coordinates.ohos = {
      // -ohos 变体 shared 坐标 M1 以指引输出（pending.md），不自动注入
      shared: po.shared ? substitute(po.shared, version) : undefined,
      packages: po.packages?.map((p) => substitute(p, version)),
    };
  }

  return {
    name,
    range,
    version,
    componentType: meta.componentType,
    coordinates,
    registration: vmeta.registration,
    hostPrerequisites: vmeta.hostPrerequisites,
    source: { ...source, indexSha, metaSha: sha },
    warnings,
  };
}

/** 私有索引 + 内联元数据的支持预留（M1 未启用：githubUrl 为空的私有条目报错） */
export function describePrivateRegistry(reg: PrivateRegistry): string {
  return Object.keys(reg.components ?? {}).join(', ');
}
