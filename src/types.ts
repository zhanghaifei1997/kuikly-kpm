/** 平台集合（M1 范围：Android / iOS / 鸿蒙） */
export interface Platforms {
  android: boolean;
  ios: boolean;
  ohos: boolean;
}

export type Platform = keyof Platforms;

export const ALL_PLATFORMS: Platform[] = ['android', 'ios', 'ohos'];

/** 工程结构路径（相对工程根目录） */
export interface ManifestPaths {
  shared: string;
  androidApp: string;
  iosApp: string;
  ohosApp: string;
}

/** 业务工程清单 kuikly.pkg.json */
export interface Manifest {
  schemaVersion: number;
  name: string;
  kuikly?: string;
  platforms: Platforms;
  dependencies: Record<string, string>;
  registries: string[];
  paths: ManifestPaths;
}

/** 注册代码声明（来自组件元数据） */
export interface RegistrationItem {
  kind: string;
  snippet: string;
  anchor?: string;
}

export type RegistrationMap = Partial<Record<Platform, RegistrationItem | null>>;

/** 组件元数据 kuikly.component.json 中单个版本的内容 */
export interface ComponentVersionMeta {
  kuikly?: string;
  platforms: {
    android?: {
      /** KMP 共享模块 maven 坐标，如 "io.github.x:foo:{version}" */
      shared?: string;
      /** Android 实现模块 maven 坐标 */
      app?: string;
      /** 需要额外声明的 maven 仓库（M1 仅提示，不自动注入） */
      repositories?: string[];
    };
    ios?: {
      /** CocoaPods 依赖，条目格式 "PodName {version}" */
      pods?: string[];
      sharedNote?: string;
    };
    ohos?: {
      /** KMP 模块鸿蒙变体 maven 坐标（版本通常带 -ohos 后缀）；M1 以指引输出，不自动注入 */
      shared?: string;
      /** OHPM 包，条目格式 "pkg-name@{version}" */
      packages?: string[];
    };
  };
  registration?: RegistrationMap;
  hostPrerequisites?: Partial<Record<Platform, string>>;
}

/** 组件元数据 kuikly.component.json */
export interface ComponentMeta {
  schemaVersion: number;
  componentName: string;
  componentType?: string;
  versions: Record<string, ComponentVersionMeta>;
}

/** 官方市场索引条目（KuiklyUI-Libraries.json） */
export interface OfficialIndexEntry {
  githubUrl: string;
  componentName: string;
  componentType?: string;
  sDynamic?: boolean;
  [key: string]: unknown;
}

/** 私有索引文件格式 */
export interface PrivateRegistry {
  schemaVersion: number;
  components: Record<string, { githubUrl?: string; metadata?: ComponentMeta }>;
}

/** 解析结果中各端的实际坐标（{version} 已替换） */
export interface ResolvedCoordinates {
  android?: { shared?: string; app?: string; repositories?: string[] };
  ios?: { pods?: string[]; sharedNote?: string };
  ohos?: { shared?: string; packages?: string[] };
}

export interface Resolved {
  name: string;
  range: string;
  version: string;
  componentType?: string;
  coordinates: ResolvedCoordinates;
  registration?: RegistrationMap;
  hostPrerequisites?: Partial<Record<Platform, string>>;
  source: {
    index: 'official' | 'private' | 'direct';
    repo: string;
    indexSha?: string | null;
    metaSha?: string | null;
  };
  warnings: string[];
}

/** 锁文件 kuikly.lock */
export interface LockEntry {
  range: string;
  resolved: string;
  source: Resolved['source'];
  coordinates: ResolvedCoordinates;
  registration?: RegistrationMap;
  hostPrerequisites?: Partial<Record<Platform, string>>;
}

export interface Lock {
  lockfileVersion: number;
  dependencies: Record<string, LockEntry>;
}

/** 注入计划（一个目标文件一个） */
export interface InjectPlan {
  platform: Platform;
  file: string;
  id: string;
  comment: string;
  body: string[];
  anchor?: (lines: string[]) => number;
  indent?: string;
}

export interface AppliedResult {
  plan: InjectPlan;
  mode: 'inserted' | 'replaced' | 'removed' | 'missing-file' | 'skipped';
  before?: string;
  after?: string;
}

/** 所有 action 共享的上下文 */
export interface Ctx {
  root: string;
  cacheDir: string;
  refresh?: boolean;
  offline?: boolean;
  /** 可注入的 fetch 实现（测试用） */
  fetcher?: Fetcher;
  githubToken?: string;
}

export type Fetcher = (url: string, headers?: Record<string, string>) => Promise<{ status: number; text: string }>;
