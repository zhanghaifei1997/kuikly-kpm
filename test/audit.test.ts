import { beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runAudit } from '../src/audit/index.js';

let dirty: string;
let clean: string;

// 测试靶材凭据均为假数据，运行时拼接构造（避免源码中出现完整字面量被误当真实凭据）
const FAKE_PWD = ['super', 'Secret', '99'].join('');
const FAKE_AWS_KEY = ['AKIA', 'IOSFODNN7EXAMPLE2'].join('');
const FAKE_API_KEY = ['a1b2c3d4e5f6', 'g7h8i9j0k1l2'].join('');

function manifestXml(): string {
  return `<?xml version="1.0"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application
        android:allowBackup="true"
        android:debuggable="true"
        android:usesCleartextTraffic="true">
        <activity android:name=".NoGuardActivity" android:exported="true" />
        <activity android:name=".GuardedActivity" android:exported="true" android:permission="com.x.PERM" />
    </application>
</manifest>
`;
}

function gradleSigning(): string {
  return `android {
    signingConfigs {
        create("release") {
            storePassword = "${FAKE_PWD}"
            keyPassword = "${FAKE_PWD}"
        }
    }
    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("debug")
        }
    }
}
`;
}

function ktWithKey(): string {
  return `class Api {
    val awsKey = "${FAKE_AWS_KEY}"
    val apiKey = "${FAKE_API_KEY}"
}
`;
}

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>NSCameraUsageDescription</key>
    <string></string>
    <key>NSAllowsArbitraryLoads</key>
    <string>true</string>
</dict>
</plist>
`;

const MODULE_JSON5 = `{
  "module": {
    "requestPermissions": [
      { "name": "ohos.permission.INTERNET" },
      { "name": "ohos.permission.LOCATION" }
    ]
  }
}
`;

/** fixture 写入：join 后校验不越出工程根（防路径穿越，与生产代码同规范） */
async function write(root: string, rel: string, content: string | Buffer): Promise<void> {
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, rel);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw new Error(`fixture 路径越出临时根目录：${rel}`);
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

beforeAll(async () => {
  dirty = await fs.mkdtemp(path.join(os.tmpdir(), 'kpm-audit-dirty-'));
  clean = await fs.mkdtemp(path.join(os.tmpdir(), 'kpm-audit-clean-'));

  // ---- 脏工程 ----
  await write(dirty, 'androidApp/src/main/AndroidManifest.xml', manifestXml());
  await write(dirty, 'androidApp/build.gradle.kts', gradleSigning());
  await write(dirty, 'androidApp/keys/release.jks', Buffer.from('fake keystore'));
  await write(dirty, 'shared/src/commonMain/kotlin/Api.kt', ktWithKey());
  await write(dirty, 'iosApp/iosApp/Info.plist', PLIST);
  await write(dirty, 'iosApp/certs/dist.p12', Buffer.from('fake p12'));
  await write(dirty, 'ohosApp/src/main/module.json5', MODULE_JSON5);
  await write(dirty, 'ohosApp/sign/release.p12', Buffer.from('fake ohos p12'));
  await write(dirty, 'shared/src/commonMain/kresources/logo.png', Buffer.alloc(4));
  await write(dirty, 'shared/src/commonMain/kresources/unused_big.png', Buffer.alloc(600 * 1024));

  // ---- 干净工程 ----
  await write(clean, 'androidApp/src/main/AndroidManifest.xml', '<manifest><application android:allowBackup="false"></application></manifest>');
  await write(clean, 'androidApp/build.gradle.kts', 'android { buildTypes { release { } } }');
  await write(clean, 'shared/src/commonMain/kotlin/Util.kt', 'class Util { val apiKey = System.getenv("API_KEY") }');
});

describe('kpm audit（脏工程应命中全部检查器）', () => {
  it('Android manifest：debuggable=error，allowBackup/cleartext=warn，exported 无权限=warn（有权限的不报）', async () => {
    const r = await runAudit(dirty);
    const ids = r.findings.filter((f) => f.domain === 'android').map((f) => f.id);
    expect(ids).toContain('manifest-debuggable');
    expect(ids).toContain('manifest-allowbackup');
    expect(ids).toContain('manifest-cleartext');
    const exported = r.findings.filter((f) => f.id === 'manifest-exported-no-permission');
    expect(exported).toHaveLength(1);
    expect(exported[0]!.title).toContain('NoGuardActivity');
  });

  it('签名：debug 签名=error、硬编码密码=error、jks 入库=error', async () => {
    const r = await runAudit(dirty);
    const ids = r.findings.filter((f) => f.domain === 'android').map((f) => f.id);
    expect(ids).toContain('signing-debug-in-release');
    expect(ids).toContain('signing-hardcoded-password');
    expect(ids).toContain('keystore-in-repo');
  });

  it('iOS：空 UsageDescription=warn、ATS 例外=warn、p12 入库=error', async () => {
    const r = await runAudit(dirty);
    const ids = r.findings.filter((f) => f.domain === 'ios').map((f) => f.id);
    expect(ids).toContain('plist-usage-description-empty');
    expect(ids).toContain('plist-ats-exception');
    expect(ids).toContain('ios-signing-material-in-repo');
  });

  it('鸿蒙：签名材料=error、权限清单=info', async () => {
    const r = await runAudit(dirty);
    const ids = r.findings.filter((f) => f.domain === 'ohos').map((f) => f.id);
    expect(ids).toContain('ohos-signing-material-in-repo');
    expect(ids).toContain('ohos-permissions-inventory');
  });

  it('跨端：云 key=error、赋值形态=warn、未引用/超大资源=warn', async () => {
    const r = await runAudit(dirty);
    const common = r.findings.filter((f) => f.domain === 'common');
    expect(common.some((f) => f.id === 'hardcoded-key' && f.severity === 'error')).toBe(true);
    expect(common.some((f) => f.id === 'hardcoded-secret-assignment')).toBe(true);
    expect(common.some((f) => f.id === 'unused-asset' && f.title.includes('logo.png'))).toBe(true);
    expect(common.some((f) => f.id === 'oversized-asset' && f.title.includes('unused_big.png'))).toBe(true);
    expect(r.summary.errors).toBeGreaterThanOrEqual(6);
    expect(r.summary.ok).toBe(false);
  });

  it('干净工程零 error 零 warn（System.getenv 形态不误报）', async () => {
    const r = await runAudit(clean);
    expect(r.summary.errors).toBe(0);
    expect(r.summary.warns).toBe(0);
    expect(r.summary.ok).toBe(true);
  });

  it('JSON 结构完整（CI 消费）', async () => {
    const r = await runAudit(dirty);
    const s = JSON.stringify(r);
    expect(s).toContain('"findings"');
    expect(s).toContain('"summary"');
    expect(r.findings.every((f) => f.id && f.domain && f.severity && f.title)).toBe(true);
  });
});
