/** iOS 端检查器：Info.plist 隐私声明 + ATS + 签名材料入库 */
import * as path from 'node:path';
import type { AuditFinding, AuditContext, Checker } from './types.js';
import { collectFiles, findFile, readTextIfExists, resolveWithinRoot } from './util.js';

/** plist 文本抽取：返回 key → value 字符串（相邻 <key>/<string> 对） */
function plistPairs(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /<key>([^<]+)<\/key>\s*<(?:string|false|true)\/?>([^<]*)</g;
  for (const m of text.matchAll(re)) {
    out.set(m[1]!.trim(), (m[2] ?? '').trim());
  }
  return out;
}

const KNOWN_USAGE_KEYS = [
  'NSCameraUsageDescription',
  'NSPhotoLibraryUsageDescription',
  'NSPhotoLibraryAddUsageDescription',
  'NSMicrophoneUsageDescription',
  'NSLocationWhenInUseUsageDescription',
  'NSLocationAlwaysAndWhenInUseUsageDescription',
  'NSContactsUsageDescription',
  'NSCalendarsUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSMotionUsageDescription',
  'NSSpeechRecognitionUsageDescription',
  'NSLocalNetworkUsageDescription',
  'NSUserTrackingUsageDescription',
  'NSFaceIDUsageDescription',
];

/** 8-10：Info.plist 隐私与 ATS + 签名材料 */
export const iosChecker: Checker = async (ctx: AuditContext) => {
  const findings: AuditFinding[] = [];
  let performed = 0;
  const plist = await findFile(ctx, ctx.iosApp, 'Info.plist');
  if (plist) {
    performed = 2;
    const text = await readTextIfExists(plist.abs);
    if (text != null) {
      const pairs = plistPairs(text);
      for (const key of KNOWN_USAGE_KEYS) {
        if (!pairs.has(key)) continue;
        const value = pairs.get(key) ?? '';
        if (value.length < 8) {
          findings.push({
            id: 'plist-usage-description-empty',
            domain: 'ios',
            severity: 'warn',
            title: `${key} 声明存在但说明过短（${value.length} 字符）`,
            detail: 'App Store 审核要求向用户明确说明用途；空值/占位文案是常见被拒原因',
            file: plist.rel,
          });
        }
      }
      if ((pairs.get('NSAllowsArbitraryLoads') ?? '') === 'true') {
        findings.push({
          id: 'plist-ats-exception',
          domain: 'ios',
          severity: 'warn',
          title: 'ATS 例外 NSAllowsArbitraryLoads=true',
          detail: '放行全部明文 HTTP，审核需说明理由；建议改为 NSExceptionDomains 白名单',
          file: plist.rel,
        });
      }
    }
  }

  // 签名材料入库
  const appDir = resolveWithinRoot(ctx.root, ctx.iosApp);
  const mats = (await collectFiles(appDir, appDir, ['.p12', '.mobileprovision', '.cer'])).filter(
    (f) => !f.includes(`${path.sep}Pods${path.sep}`) && !f.includes(`${path.sep}build${path.sep}`),
  );
  for (const m of mats) {
    findings.push({
      id: 'ios-signing-material-in-repo',
      domain: 'ios',
      severity: 'error',
      title: `iOS 签名材料入库：${path.basename(m)}`,
      detail: '私钥/描述文件不应进版本库，立即移除并轮换证书',
      file: path.relative(resolveWithinRoot(ctx.root, '.'), m),
    });
  }
  if (plist) performed += 1;
  return { findings, performed };
};
