/** 鸿蒙端检查器：签名材料入库 + module.json5 权限清单 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import JSON5 from 'json5';
import type { AuditFinding, AuditContext, Checker } from './types.js';
import { collectFiles, readTextIfExists, resolveWithinRoot } from './util.js';

/** 11-12：签名材料（p12/cer/p7b 实际入库）+ 权限清单 */
export const ohosChecker: Checker = async (ctx: AuditContext) => {
  const findings: AuditFinding[] = [];
  let performed = 0;
  const appDir = resolveWithinRoot(ctx.root, ctx.ohosApp);

  const mats = (await collectFiles(appDir, appDir, ['.p12', '.cer', '.p7b', '.csr'])).filter(
    (f) => !f.includes(`${path.sep}build${path.sep}`) && !f.includes(`${path.sep}oh_modules${path.sep}`),
  );
  performed += 1;
  for (const m of mats) {
    findings.push({
      id: 'ohos-signing-material-in-repo',
      domain: 'ohos',
      severity: 'error',
      title: `鸿蒙签名材料入库：${path.basename(m)}`,
      detail: '发布证书/私钥不应进版本库，立即移除并轮换（DevEco → Project Structure → Signing Configs 重新生成）',
      file: path.relative(resolveWithinRoot(ctx.root, '.'), m),
    });
  }

  // module.json5 权限清单（info 级，供人工确认收敛）
  const modules = await collectFiles(appDir, appDir, ['module.json5']);
  performed += modules.length > 0 ? 1 : 0;
  for (const mod of modules) {
    const text = await readTextIfExists(mod);
    if (text == null) continue;
    try {
      const json = JSON5.parse(text) as {
        requestPermissions?: Array<{ name: string; reason?: string }>;
        module?: { requestPermissions?: Array<{ name: string; reason?: string }> };
      };
      const perms = (json.requestPermissions ?? json.module?.requestPermissions ?? []).map((p) => p.name);
      if (perms.length > 0) {
        findings.push({
          id: 'ohos-permissions-inventory',
          domain: 'ohos',
          severity: 'info',
          title: `声明了 ${perms.length} 项权限，请确认最小必要`,
          detail: perms.join(', '),
          file: path.relative(resolveWithinRoot(ctx.root, '.'), mod),
        });
      }
    } catch {
      findings.push({
        id: 'ohos-module-json5-parse-error',
        domain: 'ohos',
        severity: 'warn',
        title: 'module.json5 解析失败',
        detail: '请人工检查该文件格式',
        file: path.relative(resolveWithinRoot(ctx.root, '.'), mod),
      });
    }
  }

  return { findings, performed };
};
