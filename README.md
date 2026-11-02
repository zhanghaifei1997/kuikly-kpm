# kuikly-kpm — Kuikly Package Manager

> `kpm add kuikly-app-icon` 一条命令，把多端 Kuikly 组件的已发布产物坐标（Maven Central / CocoaPods / OHPM）注入 Android / iOS / 鸿蒙三端构建文件。

- 设计文档：[docs/DESIGN.md](./docs/DESIGN.md)（RFC，含数据格式与注册表协议）
- 调研报告：[docs/RESEARCH.md](./docs/RESEARCH.md)（生态现状 + Flutter pub / RN autolinking / uni_modules 对比）

## 是什么

Kuikly 官方组件市场只负责"发现"组件；接入一个多端组件要在 gradle、Podfile、oh-package.json5 里分别手工接线，还要粘贴注册代码。kpm 补上缺失的"安装"层：

```bash
# 方式一：GitHub 直跑（无需 npm 账号）
npx github:zhanghaifei1997/kuikly-kpm init
npx github:zhanghaifei1997/kuikly-kpm add kuikly-app-icon

# 方式二：npm（发布后可用）
npx kuikly-kpm init
npx kuikly-kpm add kuikly-app-icon       # 解析坐标 → 预览 diff → 注入三端 → 更新 lock → 输出注册指引
npx kuikly-kpm doctor                    # 校验接线完整性（含注册代码是否已粘贴）
```

### 特性

- **一份清单**：`kuikly.pkg.json` + `kuikly.lock`（可复现、可审计）
- **平台裁剪**：单端应用（纯 iOS / 纯鸿蒙）只注入/锁定/校验启用端
- **幂等注入**：所有写入落在 `// kpm:begin <name>` … `// kpm:end <name>` 标记区间内，区间外一个字符不碰，`remove` 可完整卸载
- **注册指引**：Module/View 注册代码与宿主预置配置（Manifest/plist/app.json5）不自动改源码，输出指引 + doctor 校验
- **发布前体检（0.2.0，对标 flutter_auditor 适配三端）**：`kpm audit` 一条命令扫描 Android 安全配置（debuggable/allowBackup/cleartext/exported）、发布签名（debug 签名/硬编码密码/jks·p12·p7b 材料入库，含鸿蒙）、iOS 隐私声明与 ATS、硬编码密钥（云厂商 key 形态 + 赋值形态）、无用/超大资源、kpm 接线一致性；`--json` 供 CI，error 级发现退出码 1
- **零侵入官方生态**：官方 `KuiklyUI-Libraries.json` 只读使用；组件坐标由组件仓库根的 `kuikly.component.json` 声明

### 组件侧接入（作者）

在组件仓库根添加 `kuikly.component.json`（格式见 DESIGN.md §4.3），声明各端产物坐标与注册 snippet，随发版更新 `versions`。

## 命令

| 命令 | 说明 |
| --- | --- |
| `kpm init` | 探测 shared/androidApp/iosApp/ohosApp，生成 `kuikly.pkg.json` |
| `kpm add <name>\|<github-url>[@^1.0.0]` | 安装组件（`--dry-run` 只预览，`--yes` 跳过确认，`--refresh` 刷新缓存，`--offline` 仅用缓存） |
| `kpm remove <name>` | 移除标记区间与 lock 记录 |
| `kpm install` | 按 manifest 幂等同步（`--frozen` 严格按 lock，CI 用） |
| `kpm list` | 列出依赖与各端坐标 |
| `kpm config get/set <key> <value>` | 调整 `platforms.*` / `paths.*` |
| `kpm doctor` | 接线完整性体检 |
| `kpm audit` | 工程发布前体检：三端安全配置/签名材料/硬编码密钥/资源/kpm 一致性（`--json` 供 CI） |

环境变量 `KPM_GITHUB_TOKEN`（可选）用于提升 GitHub API 匿名限额（元数据 commit sha 查询）。

## 状态

M1（MVP）：产物坐标模式 + 三端注入 + 平台裁剪 + lock + doctor。源码集成、Js 端、registry API 版本直查见 DESIGN.md §8 里程碑。

## License

MIT
