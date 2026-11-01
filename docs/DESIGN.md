# kpm（Kuikly Package Manager）方案设计 RFC

> 状态：**Draft v0.1（待评审）**
> 日期：2026-10-30
> 前置阅读：[RESEARCH.md](./RESEARCH.md)（调研结论：生态空白确认 + 各框架方案对比）
> 评审要点：§5 注册表协议、§10 开放问题（需要拍板）

---

## 1. 目标与非目标

### 1.1 目标

让 Kuikly 业务开发者用**一份清单、一条命令**完成多端第三方组件接入：

```bash
kpm add kuikly-app-icon
```

等价替代今天 10 步手工接线中的 ②声明 + ③构建接线（自动），并对 ④注册代码/宿主预置配置给出**指引与校验**（半自动）。

### 1.2 非目标

- **不替代任何端内构建系统**：Gradle / CocoaPods / hvigor+OHPM / npm 继续各司其职，kpm 只做坐标解析与依赖注入。
- **不自建产物仓库**：产物继续存于 Maven Central / CocoaPods trunk / OHPM / npm，kpm 不存二进制。
- **不管理 Kuikly 框架本身**的版本（那是工程模板的职责）。
- **MVP 不做源码集成模式**（git clone + 模块 include），不做 Js 端（H5/小程序）——均为后续版本。

### 1.3 MVP 范围（已与作者确认）

| 维度 | 取值 |
|---|---|
| 平台 | Android + iOS + 鸿蒙 |
| 依赖形态 | **产物坐标优先**（已发布到 public registry 的产物） |
| 首个验证组件 | kuikly-app-icon 0.1.0（三端产物已发布，坐标已知） |

---

## 2. 总体架构

三层结构（对齐 Flutter pub 的验证过的架构，见 RESEARCH §3.1/§4）：

```
┌─────────────────────────────────────────────────────────────┐
│ 清单层   kuikly.pkg.json（业务工程，声明"我要什么"）          │
│          + kuikly.lock（解析结果锁定）                        │
├─────────────────────────────────────────────────────────────┤
│ 解析层   kpm CLI                                              │
│          componentName ──► githubUrl（官方市场索引，只读）     │
│          githubUrl/tag ──► 各端坐标（组件仓库元数据）          │
│          semver 约束 ──► 精确版本                              │
│          平台裁剪：项目 platforms ∩ 组件支持 ──► 有效注入集    │
├─────────────────────────────────────────────────────────────┤
│ 注入层   三端写入器（幂等，标记区间）                           │
│          gradle 写入器 / Podfile 写入器 / oh-package 写入器    │
│          + 注册指引输出器 / kpm doctor 校验器                  │
└─────────────────────────────────────────────────────────────┘
          ▼ 产物始终来自 ▼
   Maven Central / CocoaPods trunk / OHPM（后置依赖，非 kpm 职责）
```

关键设计约束：**kpm 对官方资产零侵入**（官方索引只读）、**对宿主文件的修改全部落在标记区间内**（可幂等、可完整卸载）。

---

## 3. 工具形态

### 3.1 CLI 命令集（MVP）

| 命令 | 行为 |
|---|---|
| `kpm init` | 探测工程结构与目标端，生成 `kuikly.pkg.json`（`platforms` 自动检测，见 §6.0） |
| `kpm add <name>[@^1.2.0]` | 校验平台交集 → 解析坐标 → 预览**启用端**文件 diff → 注入 → 更新 lock → 输出启用端的注册与预置指引 |
| `kpm remove <name>` | 移除标记区间与 lock 记录 |
| `kpm install` | 按 `kuikly.pkg.json` 幂等同步（对齐 lock；CI 可用 `--frozen`） |
| `kpm list` | 列出已装组件与各端实际坐标 |
| `kpm doctor` | 校验接线完整性：标记区间与 lock 一致、注册代码是否已粘贴、`pod install` 是否需要重跑（仅检查启用端） |
| `kpm config get/set` | 查看/调整工程级配置：`platforms.*`、`paths.*` |
| `kpm upgrade`（M2+） | 升级约束内新版本 |

### 3.2 实现语言与分发（已定稿，2026-10-31 评审）

**Node.js + TypeScript**（用户确认），npm 分发，支持 `npx kuikly-kpm` 免安装使用。完整技术选型对比（Node/Kotlin JVM/Kotlin Gradle 插件/Go 四方案矩阵）见评审记录，结论：MVP 用 Node/TS 独立 CLI；M2+ 视需要增量加 Kotlin Gradle 插件（gradle 端钩子式注入），二者是配合而非替代（Flutter/RN 均为 CLI + 构建侧钩子双件套）。

理由：① 注册表数据源是 GitHub raw + JSON，处理即 CLI 全部逻辑；② Js 端支持（M3）天然衔接 npm；③ `create-kuikly-app` 已让 Kuikly 开发者建立 npx 使用习惯；④ 依赖库成熟（commander、node-semver、json5 解析）。
风险：iOS/Android 纯原生开发者机器可能无 node——但 Kuikly 工程由 create-kuikly-app 创建、本身已依赖 node 环境，可接受。

### 3.3 命名（已定稿，2026-10-31，开放问题 #1 关闭）

- 代号 **kpm**（Kuikly Package Manager）。
- npm 裸名 `kpm` 已被废弃包占用（Kibana Plugin Manager，11 年未更新，约 16 周下载，见 RESEARCH §参考资料）；KCL 生态另有 cargo/brew 分发的 `kpm`（kcl-lang），存在搜索混淆但无 npm 冲突。
- **定稿**：npm 包名 `kuikly-kpm`（与工作区 `kuikly-plugins/kuikly-<name>` 命名约定一致），bin 名注册 `kpm`（`"bin": {"kpm": "..."}`）。

---

## 4. 数据格式

### 4.1 项目清单 `kuikly.pkg.json`（业务工程根）

```json
{
  "schemaVersion": 1,
  "name": "my-kuikly-app",
  "kuikly": ">=2.30.0",
  "platforms": { "android": true, "ios": true, "ohos": true },
  "dependencies": {
    "kuikly-app-icon": "^0.1.0"
  },
  "registries": []
}
```

- `platforms`：**项目目标端集合，是注入层的权威过滤器（§6.0）**。`kpm init` 依据工程结构自动检测（是否存在 androidApp/iosApp/ohosApp 子工程及对应构建目标），可手工调整（`kpm config set platforms.ios true`）。
- `dependencies`：`componentName`（与官方市场索引同名）→ semver 范围（node-semver 语法）；依赖级平台过滤（某组件只在部分端引入）是 M2 特性，语法见 §6.0。
- `registries`：私有索引 URL 覆盖（见 §5.1），空数组 = 只用公共链路。
- 工程结构探测结果（shared/androidApp/iosApp/ohosApp 路径）存在同文件 `paths` 字段（`kpm init` 自动填写，可手工修正）。

**单端应用示例**——纯鸿蒙应用只启用一端，kpm 只执行鸿蒙写入器、lock 只记录鸿蒙坐标：

```json
{
  "schemaVersion": 1,
  "name": "my-ohos-only-app",
  "kuikly": ">=2.30.0",
  "platforms": { "android": false, "ios": false, "ohos": true },
  "dependencies": {
    "kuikly-app-icon": "^0.1.0"
  },
  "registries": []
}
```

### 4.2 锁文件 `kuikly.lock`

```json
{
  "lockfileVersion": 1,
  "kuikly-app-icon": {
    "resolved": "0.1.0",
    "source": {
      "index": "official:KuiklyUI-Libraries.json@<git-commit>",
      "metadata": "github:zhanghaifei1997/kuikly-app-icon@<tag-commit>"
    },
    "coordinates": {
      "android": {
        "shared": "io.github.zhanghaifei1997:kuiklyAppIcon:0.1.0",
        "app": "io.github.zhanghaifei1997:kuiklyAppIconAndroid:0.1.0"
      },
      "ios": { "pods": ["kuiklyAppIconIOS = 0.1.0"] },
      "ohos": { "packages": ["kuikly-app-icon-ohos@0.1.0"] }
    }
  }
}
```

lock 同时记录索引/元数据的 git commit，保证可复现与供应链可审计。**实现修正（M1，2026-10-31）**：`coordinates` 记录该版本组件**全部支持端**的坐标（完整接线说明书，端开关切换后 `kpm install` 可据此还原各端注入）；实际写哪些文件由注入层按 `manifest.platforms` 裁剪——单端工程只会产生单端写入。

### 4.3 组件元数据 `kuikly.component.json`（组件仓库根，组件作者维护）

**kpm 生态的核心新约定**：一份声明式文件描述"一个版本在各端的坐标与接线要求"（角色类比 pubspec 的 `flutter.plugin.platforms`）。以 kuikly-app-icon 0.1.0 真实数据填充的完整示例：

```json
{
  "schemaVersion": 1,
  "componentName": "kuikly-app-icon",
  "componentType": "KuiklyModule",
  "versions": {
    "0.1.0": {
      "kuikly": ">=2.30.0-2.0.21",
      "platforms": {
        "android": {
          "shared": "io.github.zhanghaifei1997:kuiklyAppIcon:{version}",
          "app": "io.github.zhanghaifei1997:kuiklyAppIconAndroid:{version}",
          "repositories": []
        },
        "ios": {
          "pods": ["kuiklyAppIconIOS {version}"],
          "sharedNote": "KMP 框架 pod 未发布，shared 部分暂需源码依赖（见开放问题 #2）"
        },
        "ohos": {
          "shared": "io.github.zhanghaifei1997:kuiklyAppIcon:{version}-ohos",
          "packages": ["kuikly-app-icon-ohos@{version}"]
        }
      },
      "registration": {
        "android": {
          "kind": "module",
          "snippet": "moduleExport(KRAppIconModule.MODULE_NAME) { KRAppIconModule() }",
          "anchor": "registerExternalModule"
        },
        "ios": null,
        "ohos": {
          "kind": "module",
          "snippet": "map.set(KRAppIconModule.MODULE_NAME, () => new KRAppIconModule());",
          "anchor": "getCustomRenderModuleCreatorRegisterMap"
        }
      },
      "hostPrerequisites": {
        "android": "AndroidManifest.xml 预置 activity-alias（.icon.<name>，默认别名 enabled）",
        "ios": "Info.plist 预置 CFBundleAlternateIcons（1024x1024 PNG）",
        "ohos": "app.json5 预置 alternateIcons（API 26+，仅 bundleType=app）"
      }
    }
  }
}
```

要点：

- **`{version}` 占位符**：坐标与版本解耦，新增版本只需加一个 `versions` 条目；纯字符串替换，鸿蒙 maven 变体的 `-ohos` 版本后缀直接写成 `{version}-ohos`。
- **shared/app 双写入点（Android 与鸿蒙同构）**：`shared`（KMP 模块，写入 shared 模块依赖；鸿蒙变体消费 `-ohos` 后缀版本的 maven 产物）与 `app`/`packages`（平台实现产物，写入各端 app 工程）——这是 KMP 组件区别于 RN/Flutter 插件的固有结构（RESEARCH §4 必须差异化 #1）。
- **`registration` 按组件类型定制**：`kind: module | view`，MVP 支持 KuiklyModule；KuiklyView 的 `registerExternalRenderView` 形态 M2 补充。
- **`hostPrerequisites` 只是指引文本**：平台预置配置无法安全自动化（RESEARCH §4），由 `kpm add` 终端输出 + `kpm doctor` 人工确认勾选。

---

## 5. 注册表协议

### 5.1 解析链路与优先级

```
① 项目私有索引（kuikly.pkg.json → registries[] 指定的 JSON，内网/私用组件）
        │ 未命中
② 官方市场索引 KuiklyUI-Libraries.json（GitHub raw，本地 TTL 缓存）
        │ 命中 → 得到 componentName → githubUrl / 平台布尔值 / sDynamic
③ 组件仓库 kuikly.component.json（按候选 tag 拉取 raw，本地缓存）
        │ 命中 → 得到 版本列表 + 各端坐标 + 注册 snippet + 预置指引
④ 本地缓存兜底（~/.kpm/cache，网络不可用时降级只读）
```

- **官方索引只读使用**：kpm 不要求官方 JSON 做任何改动即可工作（`componentName → githubUrl` 映射已够用）；未收录官方市场的组件可直接写进 ① 私有索引或由 `kpm add <github-url>` 显式指定仓库。
- 缓存策略：官方索引 TTL 1h；组件元数据按 tag 内容寻址，永缓存。

### 5.2 版本解析

- **MVP：静态列表解析**——版本列表来自组件元数据 `versions` 键（组件作者发版时同步更新，发版流程本来就要改 CHANGELOG，增量成本极低）；semver 范围用 node-semver 求最大满足版本。
- **M4：registry API 直查**（消除对静态列表的依赖）：
  - Maven Central：`search.maven.org/solrsearch/select?q=g:...+AND+a:...&core=gav`
  - CocoaPods：CDN specs 查询
  - OHPM：公开 API 待确认（开放问题 #4）
  - 查询结果与静态声明冲突时以 registry 为准并告警。

### 5.3 与官方 KuiklyUI-Libraries.json 的关系（三阶段路线）

| 阶段 | 做法 | 对官方的侵入 |
|---|---|---|
| **一（MVP）** | 官方索引只读提供 `componentName → githubUrl`；坐标全部放组件仓库自己的 `kuikly.component.json` | **零** |
| **二** | 建社区聚合索引仓库（如 `kuikly-community/kpm-registry`，机器人聚合各组件元数据，免逐仓库拉取、加速解析） | 零 |
| **三（成熟后）** | 向官方提 PR：在 `KuiklyUI-Libraries.json` 条目内增加**可选** `kpm` 字段（如 `"kpm": "zhanghaifei1997/kuikly-app-icon"`，指向元数据位置），向后兼容现有审核格式；推动官方市场页面直接展示"复制 kpm add 命令" | 一个可选字段 |

设计原则：**kpm 的可用性永远不依赖官方采纳**；官方采纳只是推广加速器。

---

## 6. 各端注入策略（MVP 核心）

### 6.0 平台裁剪（注入的前置规则）

**项目 `platforms` 是注入层的权威过滤器**——不是"装全部、用不用随你"：

1. **有效端 = 项目 platforms**。`kpm init` 自动探测（是否存在 androidApp/iosApp/ohosApp 子工程及对应构建目标）；单端应用（纯 iOS、纯鸿蒙）只启用一端：只运行该端写入器、lock 只记录该端坐标、注册指引与 `doctor` 只覆盖该端。后续增加端（如鸿蒙应用扩展到三端）改 `platforms` 后执行 `kpm install` 即补齐其余端注入。
2. **`kpm add` 时校验交集**：组件支持端 ∩ 项目启用端 = ∅ → 拒绝安装；组件不支持项目的某些启用端 → 警告并明确列出（该端无对应实现，运行时降级依赖组件自身的 `isSupported` 类约定）。
3. **组件元数据始终声明全部支持端**（§4.3），裁剪只发生在消费侧——同一份 `kuikly.component.json` 同时服务全端项目与单端项目。
4. **依赖级裁剪（M2）**：`"some-dep": { "version": "^1.0", "platforms": ["ios"] }` 表示某组件只在部分端引入；gradle 侧需对接 KMP 源集落点（commonMain vs iosMain），见开放问题 #9。

通用机制：所有自动写入都落在**标记区间**内，区间外一个字符都不碰：

```
// kpm:begin kuikly-app-icon
implementation("io.github.zhanghaifei1997:kuiklyAppIcon:0.1.0")
// kpm:end kuikly-app-icon
```

`add` = 替换/插入区间；`remove` = 删除区间；区间缺失时新建；同名区间重复时报错。写入前显示 diff 预览（`--yes` 跳过），写入后 `git diff` 友好。

### 6.1 Android / 共享 KMP

| 写入点 | 文件 | 内容 |
|---|---|---|
| shared 模块 | `shared/build.gradle.kts` 的 commonMain dependencies | `implementation("<shared 坐标>")` |
| app 模块 | `androidApp/build.gradle.kts` dependencies | `implementation("<app 坐标>")` |
| 仓库 | `settings.gradle.kts` | 仅当 `repositories` 非空时注入对应 `maven { url }`（kuikly-app-icon 在 Central，无需注入） |

写入点定位：`kpm init` 探测官方模板工程结构（shared/androidApp/iosApp/ohosApp，与 KuiklyLibGallery 同构），结果存 `kuikly.pkg.json → paths`；探测失败则要求手工指定一次。

> 演进方向（非 MVP，见开放问题 #5）：改为生成 `gradle/kpm.deps.toml` version catalog 或 RN 式 settings 钩子，把"改构建脚本"降级为"改数据文件"。

### 6.2 iOS

| 写入点 | 文件 | 内容 |
|---|---|---|
| 依赖 | `iosApp/Podfile` | 标记区间内 `pod 'kuiklyAppIconIOS', '0.1.0', :source => 'https://cdn.cocoapods.cn/'`（trunk 发布走主 CDN 源；`:source` 仅在非默认源需要时写入） |
| 安装 | 提示执行 `pod install`（`--auto` 时代跑） | — |
| shared 部分 | ⚠️ KMP 框架 pod 未发布时的降级：输出指引"shared 模块暂需源码依赖"，`kpm doctor` 标记为已知缺口 | 见开放问题 #2 |

### 6.3 鸿蒙

| 写入点 | 文件 | 内容 |
|---|---|---|
| 依赖 | `ohosApp/oh-package.json5` dependencies | `"kuikly-app-icon-ohos": "0.1.0"`（OHPM 远程坐标） |
| shared 依赖 | shared 模块（ohos 变体构建） | maven ohos 变体坐标（版本带 `-ohos` 后缀）；与宿主 `settings.ohos.gradle.kts` 变体机制的对齐在 M1 实现时敲定 |
| 模块登记 | **不需要** | 与源码模式的关键差异：`file:` 本地模块才需要 build-profile.json5 `modules` 登记；OHPM 远程包 + maven 变体坐标只写依赖即可（这正是产物坐标模式对鸿蒙端的收益） |

### 6.4 注册代码与宿主预置配置（半自动）

`kpm add` 完成注入后，终端输出（并写入 `.kpm/pending.md` 供后续查阅；**仅输出项目启用端的条目**，单端应用只看到自己那一端）：

```
✅ 已完成：gradle ×2 / Podfile ×1 / oh-package.json5 ×1 注入
📎 还需手工（kpm doctor 可校验）：
  1. [Android] 在 registerExternalModule 中添加：
     moduleExport(KRAppIconModule.MODULE_NAME) { KRAppIconModule() }
  2. [鸿蒙] 在 KuiklyViewDelegate.getCustomRenderModuleCreatorRegisterMap 的 map 中添加：
     map.set(KRAppIconModule.MODULE_NAME, () => new KRAppIconModule());
  3. [Android] AndroidManifest.xml 预置 activity-alias（详见组件 README §宿主预置）
  4. [iOS] Info.plist 预置 CFBundleAlternateIcons
  5. [鸿蒙] app.json5 预置 alternateIcons
  6. 执行 pod install
```

不自动改 Kotlin/ArkTS/Manifest/plist 源码的理由：各宿主注册类结构差异大、平台预置配置涉及资源与业务决策，误改风险远大于收益（RESEARCH §4）。`kpm doctor` 通过在注册锚点（`anchor` 字段）附近搜索 snippet 是否存在来校验完成度。

---

## 7. 端到端演示：`kpm add kuikly-app-icon`

以 KuiklyLibGallery 同构的模板工程为宿主，各文件 before → after：

**`shared/build.gradle.kts`**
```kotlin
sourceSets {
    val commonMain by getting {
        dependencies {
            implementation(project(":shared"))
            // kpm:begin kuikly-app-icon
            implementation("io.github.zhanghaifei1997:kuiklyAppIcon:0.1.0")
            // kpm:end kuikly-app-icon
        }
    }
}
```

**`androidApp/build.gradle.kts`**
```kotlin
dependencies {
    // kpm:begin kuikly-app-icon
    implementation("io.github.zhanghaifei1997:kuiklyAppIconAndroid:0.1.0")
    // kpm:end kuikly-app-icon
}
```

**`iosApp/Podfile`**
```ruby
target 'iosApp' do
  # kpm:begin kuikly-app-icon
  pod 'kuiklyAppIconIOS', '0.1.0'
  # kpm:end kuikly-app-icon
end
```

**`ohosApp/oh-package.json5`**
```json5
"dependencies": {
  // kpm:begin kuikly-app-icon
  "kuikly-app-icon-ohos": "0.1.0"
  // kpm:end kuikly-app-icon
}
```

随后按 §6.4 输出的 6 条指引完成注册与预置 → `kpm doctor` 全绿 → 三端编译运行。

> 鸿蒙变体构建时，shared 模块实际解析到的是 `-ohos` 后缀版本的 maven 变体（§6.3），由写入器按宿主变体机制处理。本演示为三端全开项目；单端项目只会看到对应端的注入块。

---

## 8. 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M1（MVP）** | init/add/remove/install/list/doctor/config；解析链路 ①②③；平台裁剪（§6.0）；三端标记区间注入（按启用端）；lock；注册指引 | kuikly-app-icon 在模板工程上"一条命令 + 6 条指引"完成接入，三端编译通过；单端（纯鸿蒙）宿主只产生鸿蒙注入 |
| **M2** | 源码集成模式（git 拉取、模块 include、`file:` 依赖 + build-profile 登记）；KuiklyView 类型注册；依赖级平台过滤（含 KMP 源集落点）；upgrade/outdated | 覆盖官方市场未发布产物的纯源码组件与单端专用依赖 |
| **M3** | Js 端（package.json 映射 + sDynamic 组件）；Windows/Macos 等其余平台 | 五端清单统一 |
| **M4** | registry API 直查版本；聚合索引仓库（阶段二）；CI 模式（--frozen） | 摆脱静态版本列表 |

---

## 9. 安全考量

- **不执行任意脚本**：无 postinstall 概念，kpm 只读写文本文件（明确吸取 npm 供应链教训）。
- **写入范围受控**：仅标记区间；写入前 diff 预览；`kuikly.lock` 记录索引与元数据的 git commit，可审计坐标来源。
- **坐标信任链**：官方索引（人审 PR 制）→ 组件仓库元数据（git tag 内容寻址）。私有索引需开发者显式声明 `registries`。
- **产物本身的安全**（混淆、漏洞）仍由三端 registry 与组件作者负责，kpm 在 `doctor` 中预留 `--audit` 钩子（M4，映射 OSV 查询）。

---

## 10. 开放问题（评审请逐项拍板）

| # | 问题 | 选项与倾向 |
|---|---|---|
| 1 | ~~**命名与分发**~~ **已关闭（2026-10-31）** | 定稿：npm 包名 `kuikly-kpm` + bin `kpm`，与工作区命名约定一致 |
| 2 | **KMP 模块 iOS 产物消费形态**：kuikly-app-icon 0.1.0 未 push KMP 框架 pod，iOS 端 shared 部分消费不完整 | 倾向：约定组件作者用 cocoapods 插件把框架 pod 也 push 到 trunk（`podInstall`/`publishCocoaPodsPublication` 任务），kpm 注入两条 pod；备选：XCFramework + SPM。**建议作为 kuikly-app-icon 0.1.1 的发布补项验证** |
| 3 | **版本列表维护责任**：静态 `versions` vs registry API 直查 | MVP 静态（作者负担小、离线可用），M4 直查兜底 |
| 4 | **OHPM 公开 API**：ohpm.openharmony.cn 是否有稳定版本查询接口 | M4 前实测确认 |
| 5 | **gradle 注入形态**：标记区间文本注入 vs 生成 version catalog（`kpm.deps.toml` + `libs.kpm.xxx`）vs settings 钩子 | MVP 文本注入（零前提）；catalog 作为 M2 可选项（业务显式 opt-in） |
| 6 | **私有组件/内网 registry**：私有 maven、私有 pod spec repo 的声明格式 | M2 设计，MVP 仅预留 `registries` 字段 |
| 7 | **官方共建时机**：何时启动阶段三（官方 JSON 加可选字段 PR） | 建议 M1 跑通 + 3~5 个组件接入后再提，附带数据佐证 |
| 8 | **多 flavor / monorepo 宿主**：paths 探测失败的人工指定粒度 | M1 支持 `kpm config set paths.shared <path>` 级别的手工覆盖 |
| 9 | **依赖级平台过滤的源集落点**：`platforms: ["ios"]` 的依赖在 gradle 侧落入 iosMain 还是仍进 commonMain（commonMain 会拖入未启用端的解析开销） | M2 设计；涉及 KMP 源集依赖语义与 ohos 变体机制的交互 |

---

## 11. 工作区落地

- **M1 已落地（2026-10-31）**：工具位于 `kuikly-plugins/kuikly-kpm/`（Node/TS，已登记 kuikly-plugins/README.md 目录清单），`src/` + `test/`（21 个用例全绿）+ `docs/`（本 RFC 与调研报告）。尚未 git init / npm publish，待评审后进行。
- 首批元数据：`kuikly-app-icon` 仓库根已补写 `kuikly.component.json`（本地，待随 0.1.1 提交推送）+ 补推 KMP 框架 pod（开放问题 #2）。
- 验证宿主：复用 `~/KuiklyDebug/` 下三端真机宿主（KuiklyDebug/KuiklyUI），与 kuikly-app-icon 已验证的调试环境一致；真实链路验证（官方索引 → GitHub 元数据 → 宿主注入）需先推送 `kuikly.component.json`。
