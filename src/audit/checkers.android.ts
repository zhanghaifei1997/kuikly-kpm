/** Android 端检查器：Manifest 安全配置 + 发布签名（对标 flutter_auditor Android 部分） */
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type { AuditFinding, AuditContext, Checker } from './types.js';
import { collectFiles, findFile, lineOf, readTextIfExists, resolveWithinRoot } from './util.js';

/** 1-4：AndroidManifest.xml 安全配置 */
export const androidManifestChecker: Checker = async (ctx: AuditContext) => {
  const findings: AuditFinding[] = [];
  let performed = 0;
  const manifest = await findFile(ctx, ctx.androidApp, 'AndroidManifest.xml');
  if (!manifest) return { findings, performed };

  const text = await readTextIfExists(manifest.abs);
  if (text == null) return { findings, performed };
  performed = 4;

  const flag = (attr: string): number | undefined => lineOf(text, (l) => l.includes(`${attr}="true"`));

  const debuggable = flag('android:debuggable');
  if (debuggable != null) {
    findings.push({
      id: 'manifest-debuggable',
      domain: 'android',
      severity: 'error',
      title: 'AndroidManifest 显式开启 debuggable',
      detail: '发布包绝不应保留 debuggable=true，可被任意调试附加',
      file: manifest.rel,
      line: debuggable,
    });
  }

  const allowBackup = flag('android:allowBackup');
  if (allowBackup != null) {
    findings.push({
      id: 'manifest-allowbackup',
      domain: 'android',
      severity: 'warn',
      title: 'android:allowBackup=true',
      detail: '应用数据会随 adb backup 导出，含敏感数据的应用建议关闭并评估 fullBackupContent',
      file: manifest.rel,
      line: allowBackup,
    });
  }

  const cleartext = flag('android:usesCleartextTraffic');
  if (cleartext != null) {
    findings.push({
      id: 'manifest-cleartext',
      domain: 'android',
      severity: 'warn',
      title: 'android:usesCleartextTraffic=true',
      detail: '允许明文 HTTP 流量，建议改用 HTTPS 或 Network Security Config 白名单',
      file: manifest.rel,
      line: cleartext,
    });
  }

  // exported=true 且未声明 permission 的组件（按标签块解析，块截止到自闭合或闭合标签）
  const blockRe = /<(activity|service|receiver|provider)\b[\s\S]*?(?:\/>|<\/\1\s*>)/g;
  for (const m of text.matchAll(blockRe)) {
    const block = m[0]!;
    if (!/android:exported\s*=\s*"true"/.test(block)) continue;
    if (/android:permission\s*=\s*"/.test(block)) continue;
    if (block.includes('<intent-filter')) continue;
    const name = block.match(/android:name\s*=\s*"([^"]+)"/)?.[1] ?? '(未命名)';
    const lineNo = text.slice(0, m.index ?? 0).split('\n').length;
    findings.push({
      id: 'manifest-exported-no-permission',
      domain: 'android',
      severity: 'warn',
      title: `组件 exported 且未声明 permission：${name}`,
      detail: '确认该组件确需对外暴露；非必要请移除 android:exported="true" 或补 android:permission',
      file: manifest.rel,
      line: lineNo,
    });
  }

  return { findings, performed };
};

/** 5-7：发布签名三连（debug 签名 / 硬编码密码 / 密钥库文件入库） */
export const androidSigningChecker: Checker = async (ctx: AuditContext) => {
  const findings: AuditFinding[] = [];
  let performed = 0;
  const appDir = resolveWithinRoot(ctx.root, ctx.androidApp);

  const gradles = (await collectFiles(appDir, appDir, ['.gradle.kts', '.gradle'])).filter(
    (f) => !f.includes(`${path.sep}build${path.sep}`),
  );
  performed = 3;

  for (const g of gradles) {
    const rel = path.relative(resolveWithinRoot(ctx.root, '.'), g);
    const text = await readTextIfExists(g);
    if (text == null) continue;

    // release 块内使用 debug 签名配置（覆盖 signingConfigs.debug 与 getByName("debug") 两种写法）
    const releaseBlock = text.match(/(?:^|\W)release\s*\{[\s\S]*?\n\s*\}/);
    if (
      releaseBlock &&
      /signingConfigs\s*(?:\.\s*debug|\.\s*getByName\(\s*"debug"\s*\))/.test(releaseBlock[0])
    ) {
      findings.push({
        id: 'signing-debug-in-release',
        domain: 'android',
        severity: 'error',
        title: 'Release buildType 使用 debug 签名',
        detail: 'release 块引用了 signingConfigs.debug，发布包将无法上架/不可信',
        file: rel,
      });
    }

    // 硬编码 keystore 密码（字面量赋值；环境变量/属性引用不报）
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      const m = l.match(/(storePassword|keyPassword)\s*(?:\(|=\s*)\s*"([^"]{3,})"/);
      if (m) {
        findings.push({
          id: 'signing-hardcoded-password',
          domain: 'android',
          severity: 'error',
          title: '构建脚本硬编码 keystore 密码',
          detail: '改用环境变量、~/.gradle/gradle.properties（不入库）或 CI secret 注入',
          file: rel,
          line: i + 1,
        });
        break;
      }
    }
  }

  // 密钥库文件入库
  const keyFiles = (await collectFiles(appDir, appDir, ['.jks', '.keystore'])).filter(
    (f) => !f.includes(`${path.sep}build${path.sep}`),
  );
  for (const k of keyFiles) {
    findings.push({
      id: 'keystore-in-repo',
      domain: 'android',
      severity: 'error',
      title: `签名密钥库入库：${path.basename(k)}`,
      detail: '私钥文件不应进版本库，立即移除并轮换密钥（git 历史也要清理）',
      file: path.relative(resolveWithinRoot(ctx.root, '.'), k),
    });
  }

  return { findings, performed };
};
