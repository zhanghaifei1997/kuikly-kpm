import { describe, expect, it } from 'vitest';
import { findBlock, listBlockIds, removeBlock, upsertBlock } from '../src/marker.js';

const SHARED_GRADLE = `kotlin {
    sourceSets {
        val commonMain by getting {
            dependencies {
                implementation(project(":shared"))
            }
        }
    }
}
`;

describe('marker 标记区间', () => {
  it('按锚点插入（commonMain 后的 dependencies 块内）', () => {
    const anchor = (lines: string[]) => {
      const cm = lines.findIndex((l) => l.includes('commonMain'));
      for (let i = cm; i < lines.length; i++) {
        if (lines[i]!.includes('dependencies') && lines[i]!.includes('{')) return i;
      }
      return -1;
    };
    const { content, mode } = upsertBlock(SHARED_GRADLE, {
      id: 'kuikly-app-icon',
      comment: '//',
      body: ['implementation("io.github.z:kuiklyAppIcon:0.1.0")'],
      anchor,
    });
    expect(mode).toBe('inserted');
    expect(content).toContain('                // kpm:begin kuikly-app-icon');
    expect(content).toContain('                implementation("io.github.z:kuiklyAppIcon:0.1.0")');
    expect(content).toContain('                // kpm:end kuikly-app-icon');
    // 区间外原内容保持不变（行数只增加 3 行）
    expect(content.split('\n').length).toBe(SHARED_GRADLE.split('\n').length + 3);
  });

  it('幂等：重复 upsert 为原位替换，内容不变', () => {
    const once = upsertBlock(SHARED_GRADLE, {
      id: 'x',
      comment: '//',
      body: ['implementation("a:b:1.0")'],
      anchor: (ls) => ls.findIndex((l) => l.includes('dependencies') && l.includes('{')),
    }).content;
    const twice = upsertBlock(once, {
      id: 'x',
      comment: '//',
      body: ['implementation("a:b:1.0")'],
      anchor: (ls) => ls.findIndex((l) => l.includes('dependencies') && l.includes('{')),
    });
    expect(twice.mode).toBe('replaced');
    expect(twice.content).toBe(once);
  });

  it('替换时保留区间标记的既有缩进，body 归一到标记缩进', () => {
    const custom = `dependencies {
    // kpm:begin demo
      implementation("a:b:1")
    // kpm:end demo
}`;
    const { content } = upsertBlock(custom, {
      id: 'demo',
      comment: '//',
      body: ['implementation("a:b:2")'],
    });
    expect(content).toContain('    // kpm:begin demo');
    expect(content).toContain('    implementation("a:b:2")');
  });

  it('卸载可完整还原（remove 删除区间及紧邻空行）', () => {
    const withBlock = upsertBlock(SHARED_GRADLE, {
      id: 'y',
      comment: '//',
      body: ['implementation("c:d:1")'],
      anchor: (ls) => ls.findIndex((l) => l.includes('dependencies') && l.includes('{')),
    }).content;
    const { content, removed } = removeBlock(withBlock, 'y', '//');
    expect(removed).toBe(true);
    expect(content).toBe(SHARED_GRADLE);
  });

  it('Ruby 注释（Podfile）与 json5 注释都能识别', () => {
    const podfile = `target 'iosApp' do
  platform :ios, '13.0'
end
`;
    const withPod = upsertBlock(podfile, {
      id: 'p1',
      comment: '#',
      body: ["pod 'kuiklyAppIconIOS', '0.1.0'"],
      anchor: (ls) => ls.findIndex((l) => l.trimStart().startsWith('target ')),
      indent: '  ',
    }).content;
    expect(withPod).toContain('  # kpm:begin p1');
    const json5 = `{
  "name": "entry",
  "dependencies": {
    "@kuikly-open/render": "*"
  }
}`;
    const withOh = upsertBlock(json5, {
      id: 'o1',
      comment: '//',
      body: ['"kuikly-app-icon-ohos": "0.1.0"'],
      anchor: (ls) => ls.findIndex((l) => l.trimStart().startsWith('"dependencies"')),
      indent: '  ',
    }).content;
    expect(withOh).toContain('  // kpm:begin o1');
    expect(findBlock(withOh, 'o1', '//')).not.toBeNull();
  });

  it('未闭合区间抛错；listBlockIds 收集 id', () => {
    const broken = 'dependencies {\n// kpm:begin bad\nimplementation("x")\n}';
    expect(() => findBlock(broken, 'bad', '//')).toThrow(/未闭合/);
    expect(listBlockIds('// kpm:begin a\n// kpm:end a\n# kpm:begin b\n', '//')).toEqual(['a']);
    // 不同注释前缀互不误识别
    expect(listBlockIds('// kpm:begin a\n// kpm:end a\n', '#')).toEqual([]);
  });
});
