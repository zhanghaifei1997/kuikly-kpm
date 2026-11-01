# Kuikly 第三方组件依赖管理调研报告

> 状态：v1.0（待评审）
> 日期：2026-10-30
> 范围：Kuikly 官方组件市场消费侧机制现状 + 主流跨端框架依赖管理方案横向对比
> 后续：方案设计见 [DESIGN.md](./DESIGN.md)

---

## 1. 问题定义

### 1.1 一个多端 Kuikly 组件的真实接入成本

以本地已发布组件 `kuikly-app-icon` 0.1.0（KMP 共享模块 + 三端原生实现，产物已发布 Maven Central / CocoaPods / OHPM）为例，宿主工程接入它需要完成以下全部工作（实录来自 `kuikly-plugins/kuikly-app-icon/docs/INTEGRATION.md`）：

| # | 端 | 操作 | 涉及文件 |
|---|---|---|---|
| 1 | 共享 | `settings.gradle.kts` include 两个模块 | `settings.gradle.kts` |
| 2 | 共享 | commonMain 加 `implementation(project(":kuiklyAppIcon"))` 或 maven 坐标 | `shared/build.gradle.kts` |
| 3 | Android | androidApp 加 `kuiklyAppIconAndroid` 依赖 | `androidApp/build.gradle.kts` |
| 4 | Android | `registerExternalModule` 中 `moduleExport(...)` 注册 Module | Kotlin 源码 |
| 5 | Android | Manifest 预置 activity-alias 图标别名 | `AndroidManifest.xml` |
| 6 | iOS | Podfile 加 `pod 'kuiklyAppIconIOS'` + `pod install` | `iosApp/Podfile` |
| 7 | iOS | Info.plist 预置 `CFBundleAlternateIcons` | `Info.plist` |
| 8 | 鸿蒙 | oh-package.json5 加依赖 + 根 build-profile.json5 登记 modules | 两个 json5 文件 |
| 9 | 鸿蒙 | `KuiklyViewDelegate` 注册 Module creator | ArkTS 源码 |
| 10 | 鸿蒙 | app.json5 预置 `alternateIcons` | `app.json5` |

**10 步操作、跨 3 个构建系统、2 类源码注册、3 份平台预置配置**——而这一切发生的前提是开发者已经知道：组件叫什么、在哪个仓库、各端产物坐标分别是什么。

### 1.2 把接入工作分层

上述成本可以归纳为四层：

| 层 | 内容 | 现状 |
|---|---|---|
| ① 发现 | 找到组件：名称、仓库、平台支持、文档 | ✅ 官方组件市场（元数据索引） |
| ② 声明 | 在项目中以一份清单表达"我依赖 X@版本" | ❌ 无 |
| ③ 构建接线 | 把依赖写入各端构建系统（gradle / Podfile / oh-package） | ❌ 全手工 |
| ④ 注册与预置 | 注册代码（Module/View）+ 宿主平台预置配置 | ❌ 全手工，靠读文档 |

**②③ 是纯机械劳动，最适合工具化；④ 半机械（代码位置因宿主而异），可先做"指引 + 校验"。**

npm/pnpm 解决的正是 ②③（④ 在纯 JS 生态不存在）；Flutter pub/RN autolinking 连 ③④ 都覆盖了。Kuikly 目前 ②③④ 全部空白。

---

## 2. Kuikly 生态现状盘点

### 2.1 官方组件市场 = 纯元数据索引，无安装环节

- 市场页面：<https://kuikly.tds.qq.com/third-party?tab=component>，数据源是 [Tencent-TDS/KuiklyUI-third-party](https://github.com/Tencent-TDS/KuiklyUI-third-party) 仓库根目录的 `KuiklyUI-Libraries.json`（PR 收录制，约 100 条）。
- 实测核实（raw 文件，2026-10-30）：顶层 JSON 数组，条目字段为 `githubUrl` → `examples` → `componentName` → `componentDescription` → `componentType` → `developer` → 平台布尔值（`Android`/`iOS`/`Ohos`/`Js`/`Macos`/`Linux`/`Windows`/`Tvos`）→ `sDynamic`。
- **没有任何结构化的版本号、Maven 坐标、pod 名、ohpm 包名字段**。版本信息只零星嵌在 URL（如 `tree/3.9.1-ohos`）或描述文本里，机器不可读。
- 结论：市场只解决了 ① 发现，且发现质量依赖人读 README。

### 2.2 官方指引的接入方式：三端手工接线

官方[《Kuikly 扩展库创建指引》](https://kuikly.tds.qq.com/Community/kuikly_extension_lib_guide.html)（以 kLottieView 为例）确认的接入矩阵：

| 端 | 构建接线 | 注册代码 |
|---|---|---|
| Android | `implementation(project(":xxxAndroid"))` 或产物坐标 | `registerExternalRenderView` 注册 View creator |
| iOS | Podfile `pod 'xxxIOS', :path => '../'` + `pod install` | 运行时按类名自动暴露，无需手动注册 |
| 鸿蒙 | oh-package.json5 `file:` 依赖 + 根 build-profile.json5 `modules.srcPath` 登记 | `KuiklyViewDelegate` 的 map 注册 View/Module creator |

指引中没有任何自动化安装工具；提到的脚本仅限**发布侧**（`./gradlew :xxx:publish`）。

### 2.3 发布侧基础设施已经齐备（这是做包管理器的前提）

`kuikly-app-icon` 0.1.0 已实测打通三条公开 registry（详见 `docs/PUBLISH.md`）：

| 端 | Registry | 坐标 | 状态 |
|---|---|---|---|
| Android + KMP | Maven Central（Central Portal API） | `io.github.zhanghaifei1997:kuiklyAppIcon` / `:kuiklyAppIconAndroid` @ 0.1.0（鸿蒙变体版本带 `-ohos` 后缀） | ✅ 已发布 |
| iOS | CocoaPods trunk | `kuiklyAppIconIOS` @ 0.1.0（依赖 `OpenKuiklyIOSRender`） | ✅ 已发布 |
| 鸿蒙 | OHPM | `kuikly-app-icon-ohos` @ 0.1.0 | ✅ 已发布（审核通过可检索） |

> ⚠️ 缺口：KMP 共享模块的 **iOS 产物**（cocoapods 插件生成的框架 pod `kuiklyAppIcon`）尚未 push 到 trunk——目前 iOS 端消费 shared 部分仍需源码/本地 podspec。这是 DESIGN.md 中的开放问题 #2。

即：**"包仓库"这一层（相当于 npmjs.com）三端都已经存在且可用，缺的是站在它们之上的"统一清单 + 解析 + 注入"层（相当于 npm/pnpm CLI + package.json）。**

### 2.4 现有工具盘点

| 工具 | 定位 | 与依赖管理的关系 |
|---|---|---|
| `npx create-kuikly-app` | 项目脚手架（≈ create-react-app） | 仅初始化工程，不管依赖 |
| `KuiklyComponentTemplete` | 官方组件开发模板（组件市场 Tools） | 含 publish 脚本（发布侧），无消费侧 |
| [KuiklyLibGallery](https://github.com/Kuikly-contrib/KuiklyLibGallery) | 第三方组件 Demo 宿主（17 个组件示例） | 展示"正确接线后的结果"，本身即手工接线的活样本；唯一脚本是鸿蒙 `runOhosApp.sh` |
| Gradle / CocoaPods / OHPM / npm | 各端原生包管理器 | 各管一端，无跨端视角 |

### 2.5 sDynamic（动态模式）组件是特例

官方索引中 `sDynamic: true` 的组件（纯 JS 产物、不依赖协程/浏览器接口）支持动态直接引用——**这类组件本质是 npm 生态一员，可以直接复用 npm/pnpm**，不是本方案的主要矛盾。真正缺工具的是带原生实现的三端组件（`sDynamic: false`）。

---

## 3. 横向对比：其他跨端框架怎么做

统一对比维度：**清单文件**（开发者声明什么）、**注册表**（元数据与产物放哪）、**平台注入机制**（谁在什么时机把依赖写进各端构建系统）、**版本管理**（约束解析 / lock）。

### 3.1 Flutter pub —— 最接近目标形态的范本

**清单**：项目根 `pubspec.yaml`，依赖声明一行（`dependencies: lottie: ^3.1.0`），支持 semver 范围。

**注册表**：pub.dev 中心化仓库，包内同样是 `pubspec.yaml`。插件通过声明式字段描述各端原生入口：

```yaml
flutter:
  plugin:
    platforms:
      android:
        package: com.example.my_plugin
        pluginClass: MyPlugin
      ios:
        pluginClass: MyPlugin
```

联合插件（federated plugins）还支持 `default_package` 让某平台直接复用另一个 pub 包的实现。

**平台注入**：`flutter pub get` 只解析 Dart 依赖，写入 `.dart_tool/package_config.json` 与 `.flutter-plugins-dependencies`；真正的原生接线发生在**构建期**——宿主 `android/settings.gradle` 通过 flutter-plugin-loader 读取 `.flutter-plugins-dependencies` 自动 include 各插件的 Android 模块；iOS 侧由 podhelper 把各插件 podspec 整合进 Podfile 执行 `pod install`。**开发者永远只编辑 pubspec.yaml，构建文件由工具生成/驱动。**

**版本管理**：`pubspec.lock` 锁定精确版本，约束语法 `^1.2.3`。

**评价**：架构上就是"清单 + 注册表 + 构建期注入"三层，且把各端差异全部吸收在工具层。**对 Kuikly 最直接的借鉴对象。**

### 3.2 React Native autolinking —— 复用 npm 清单 + 配置式注入点

**清单**：直接复用 `package.json` 的 `dependencies`（只有 dependencies 下的包会被扫描），组件在自己 package.json 里声明 `codegenConfig` 等原生描述字段。

**注册表**：npm registry 本身。

**平台注入**：RN CLI 扫描依赖生成 `react-native config` JSON；iOS 侧 Podfile 里一行 `use_native_modules!` 读取该配置、自动追加 pod 条目；Android 侧 settings.gradle 里 apply `native_modules.gradle` / `autolinkLibraries(settings)` 自动 include 原生模块。**注入点是一次性预置在构建文件里的"钩子"，之后每次加减依赖不需要再改构建文件**——这是比文本注入更稳的思路。

**版本管理**：npm 的 package-lock + semver。

**评价**：「构建文件里预置动态加载钩子」的思路非常值得借鉴：kpm 可以在 gradle/Podfile 里预置一个 `kpmApply()` 钩子读取生成的依赖描述文件，把"改构建文件"变成"改数据文件"。但它依赖 RN 原生模块"运行时动态链接"的性质——KMP 组件是**编译期静态依赖**，更接近 Flutter 的构建期生成模式。

### 3.3 uni-app uni_modules —— IDE 驱动、目录约定，无真正版本解析（反面教材）

**清单/注册表**：DCloud 插件市场（ext.dcloud.net.cn），无项目级依赖清单文件；插件安装为目录约定 `uni_modules/<插件ID>/`，插件 package.json 内嵌 `uni_modules` 元数据（id、版本、依赖）。

**注入**：HBuilderX「导入插件」自动落盘并**自动安装插件声明的三方依赖**（UTS 插件的原生 framework/pod/aar 依赖声明在插件 config.json 中）；更新靠 IDE 手动右键。

**版本管理**：**无 semver 范围解析、无 lock**，版本选择靠插件市场页面手点。

**评价**：验证了"平台预置配置也能随插件分发"（UTS 插件的各端原生依赖是声明式的），但 IDE 绑定 + 无版本解析是要避免的路线。

### 3.4 微信小程序 npm —— Js 端的现成通路（简述）

小程序生态直接复用 npm：组件库发 npm 包，开发者 package.json 声明依赖后，通过 IDE「构建 npm」或 `miniprogram-ci` 的 packNpm 生成 `miniprogram_npm/` 目录。**Kuikly 的 Js 端（H5/小程序、sDynamic 组件）将来可直接映射为 npm 依赖写入 package.json，不必自造。**

### 3.5 对比总表

| | 清单 | 注册表 | 注入机制 | 版本/lock | 对 Kuikly 的可移植性 |
|---|---|---|---|---|---|
| **Flutter pub** | pubspec.yaml | pub.dev（中心化） | pub get 产出描述文件，构建期自动 include/pod install | pubspec.lock | ⭐⭐⭐⭐⭐ 架构同构 |
| **RN autolinking** | package.json（复用 npm） | npm | 构建文件预置 `use_native_modules!` 钩子读配置 | package-lock | ⭐⭐⭐⭐ 钩子式注入思路 |
| **uni_modules** | 无（IDE 导入） | DCloud 市场 | IDE 落盘 + 自动装三方依赖 | 无 | ⭐⭐ 仅"原生依赖声明式分发"可参考 |
| **小程序 npm** | package.json | npm | 构建 npm 生成 miniprogram_npm | npm lock | ⭐⭐⭐⭐ Js 端直接复用 |
| **Kuikly 现状** | 无 | 仅元数据索引（无坐标） | 无 | 无 | — |

### 3.6 底层 registry 版本语义差异（kpm 骑在其上，而非替代）

| Registry | 版本查询能力 | 备注 |
|---|---|---|
| Maven Central | `search.maven.org` solrsearch API（按 g:a 查版本列表） | 公开、稳定 |
| CocoaPods | CDN（cdn.cocoapods.org）可查 specs；`pod trunk info` | trunk 是唯一公共源 |
| OHPM | ohpm.openharmony.cn（有 Web 检索，公开 API 待确认） | 见开放问题 |
| npm | registry API 完备 | Js 端用 |

三端各自已有成熟的版本存储，kpm 不存任何产物，只做**坐标解析与注入**——这让工具保持"薄"。

---

## 4. 对 Kuikly 的启示

**可借鉴**
1. **pub 的三层架构**：一份清单（≈pubspec）+ 组件侧声明式元数据（≈flutter.plugin.platforms）+ 构建期注入。Kuikly 组件的三端结构（KMP 模块 + Android impl + iOS pod + Ohos HAR）完全可以用一份声明式元数据描述。
2. **RN 的钩子式注入点**：比起每次文本改写构建文件，在 gradle/Podfile 预置一次 `kpm` 钩子、之后只更新数据文件，更幂等更安全（MVP 可先做标记区间文本注入，钩子式作为演进方向）。
3. **uni_modules 的原生依赖声明式分发**：宿主预置配置（Manifest/plist/app.json5）没法全自动，但可以作为元数据的一部分**随组件分发指引**。
4. **复用而非替代**：Maven/CocoaPods/OHPM/npm 继续做产物存储，kpm 只做统一解析与注入，工具逻辑薄、维护面小。

**必须差异化（Kuikly/KMP 特有）**
1. **编译期静态依赖**：KMP 组件不是运行时动态链接，无法像 RN 扫 node_modules；注入必须发生在各端构建文件里，且要区分 shared 模块依赖（KMP 坐标）与 app 模块依赖（Android impl 坐标）两个写入点。
2. **一组件多产物坐标**：同一组件在三个 registry 里名字/版本形态不同（如鸿蒙 maven 变体版本带 `-ohos` 后缀、OHPM 包名连字符风格），元数据必须支持"一个版本 → 各端坐标映射"。
3. **注册代码差异大**：Android 显式注册、iOS 运行时自动、鸿蒙 Delegate map 注册——注入策略只能按端、按组件类型（KuiklyModule/KuiklyView）定制。

**应避免**
1. uni_modules 式的 IDE 绑定与无版本解析。
2. npm 式的任意 postinstall 脚本执行（供应链风险，Kuikly 组件也不需要）。
3. 自建产物仓库（三端 public registry 已够用，MVP 不引入存储成本）。

---

## 5. 结论

1. **生态空白确认**：Kuikly 官方市场只做"发现"，无清单、无坐标索引、无注入工具；`create-kuikly-app` 是脚手架；三端 public registry（Maven Central/CocoaPods/OHPM）基础已齐备且经本地组件实测可用。
2. **问题可以薄工具化解决**：缺的是一个"骑在三端 registry 之上"的 CLI——一份项目清单 + 一份组件元数据约定 + 三端构建文件注入器。Flutter pub 已验证该架构，RN 提供了更稳的钩子式注入思路。
3. **MVP 边界建议**：Android + iOS + 鸿蒙、产物坐标优先（已发布产物直接消费）；源码集成与 Js 端列为后续版本；注册代码与宿主预置配置 MVP 阶段做"指引输出 + 完整性校验"而非自动改源码。
4. 具体方案（工具形态、manifest/元数据格式、注册表协议、与官方 `KuiklyUI-Libraries.json` 的兼容扩展路线）见 **[DESIGN.md](./DESIGN.md)**。

---

## 参考资料

**Kuikly 官方**
- 组件市场：<https://kuikly.tds.qq.com/third-party?tab=component>
- 市场收录仓库（KuiklyUI-Libraries.json）：<https://github.com/Tencent-TDS/KuiklyUI-third-party>
- 扩展库创建指引：<https://kuikly.tds.qq.com/Community/kuikly_extension_lib_guide.html>
- KuiklyLibGallery（第三方组件 Demo 宿主）：<https://github.com/Kuikly-contrib/KuiklyLibGallery>

**对比框架**
- Flutter 使用包（官方文档中文镜像）：<https://docs.fluttercn.cn>
- pubspec 依赖与 flutter.plugin.platforms 实践：<https://juejin.cn/post/7192611190051176506>
- Flutter Android 工程结构与 Gradle 集成机制分析：<https://cloud.tencent.com/developer/column>
- React Native autolinking / codegenConfig（官方文档）：<https://reactnative.dev>
- autolinking 依赖识别说明：<https://stackoverflow.com/questions/72834130/react-native-autolink-dependencies-used-in-custom-library>
- uni_modules 插件配置（DCloud 官方）：<https://uniapp.dcloud.net.cn/uni_modules>
- UTS 插件（原生依赖声明式分发）：<https://uniapp.dcloud.net.cn>

**命名占用核查**
- npm 已存在的 `kpm` 包（Kibana Plugin Manager，11 年未更新）：<https://www.npmjs.com/package/kpm>

**本地实测素材**（本仓库）
- `kuikly-plugins/kuikly-app-icon/docs/INTEGRATION.md` —— 三端接线实录
- `kuikly-plugins/kuikly-app-icon/docs/PUBLISH.md` —— 三端 registry 发布坐标与流程
- `kuikly-plugins/kuikly-app-icon/docs/MARKET_SUBMISSION.md` —— 官方市场收录条目（PR #47）
