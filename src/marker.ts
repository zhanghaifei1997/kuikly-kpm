/**
 * 标记区间文本手术 —— kpm 对宿主文件的全部修改都落在
 * `<comment> kpm:begin <id>` … `<comment> kpm:end <id>` 区间内（含区间行自身）。
 *
 * 设计约束（DESIGN.md §6）：
 * - 区间外一个字符都不碰
 * - upsert 幂等：已存在则原位替换（保留原缩进），不存在则按锚点插入
 * - remove 删除整个区间，可完整卸载
 *
 * 实现说明：行解析为纯字符串处理（无正则），id 只做全等比对。
 */

const BEGIN = 'kpm:begin';
const END = 'kpm:end';

export interface FoundBlock {
  begin: number;
  end: number;
  indent: string;
}

/** 取行首空白（空格/制表符） */
function leadingWhitespace(s: string): string {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  return s.slice(0, i);
}

/** 按任意空白切分为 token */
function tokenize(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (const ch of s) {
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      if (cur.length > 0) {
        out.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * 解析一行标记行。期望形态：`<indent><comment> <keyword> <id>`（token 恰好 3 段）。
 * 匹配返回 id 与缩进，不匹配返回 null。
 */
function parseMarkerLine(line: string, comment: string, keyword: string): { id: string; indent: string } | null {
  const indent = leadingWhitespace(line);
  const parts = tokenize(line.slice(indent.length));
  if (parts.length !== 3) return null;
  if (parts[0] !== comment || parts[1] !== keyword) return null;
  return { id: parts[2]!, indent };
}

/** 定位 id 对应的标记区间（行号含头含尾）。有 begin 无 end 视为损坏，抛错。 */
export function findBlock(content: string, id: string, comment: string): FoundBlock | null {
  const lines = content.split('\n');
  let begin = -1;
  let indent = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (begin < 0) {
      const parsed = parseMarkerLine(line, comment, BEGIN);
      if (parsed && parsed.id === id) {
        begin = i;
        indent = parsed.indent;
      }
    } else {
      const endParsed = parseMarkerLine(line, comment, END);
      if (endParsed && endParsed.id === id) {
        return { begin, end: i, indent };
      }
    }
  }
  if (begin >= 0) {
    throw new Error(`kpm: 检测到未闭合的标记区间 kpm:begin ${id}（第 ${begin + 1} 行起），请手工修复后重试`);
  }
  return null;
}

export interface UpsertOptions {
  id: string;
  comment: string;
  body: string[];
  /** 新插入时的缩进（替换时沿用既有区间缩进） */
  indent?: string;
  /** 区间不存在时的插入锚点：返回"在此行之后插入"的行号；返回 -1 表示找不到 */
  anchor?: (lines: string[]) => number;
}

export interface UpsertResult {
  content: string;
  mode: 'inserted' | 'replaced';
}

export function upsertBlock(content: string, opts: UpsertOptions): UpsertResult {
  // body 行自动继承标记缩进（body 可自带相对缩进，如嵌套场景）
  const build = (indent: string): string[] => [
    `${indent}${opts.comment} ${BEGIN} ${opts.id}`,
    ...opts.body.map((l) => (l.length > 0 ? indent + l : l)),
    `${indent}${opts.comment} ${END} ${opts.id}`,
  ];

  const found = findBlock(content, opts.id, opts.comment);
  const lines = content.split('\n');

  if (found) {
    lines.splice(found.begin, found.end - found.begin + 1, ...build(found.indent));
    return { content: lines.join('\n'), mode: 'replaced' };
  }

  let at: number;
  if (opts.anchor) {
    const idx = opts.anchor(lines);
    if (idx == null || idx < 0 || idx >= lines.length) {
      throw new Error(
        `kpm: 在目标文件中找不到 ${opts.id} 的插入锚点（dependencies/target 块）。` +
          `请手工添加标记区间，或用 kpm config 调整 paths`,
      );
    }
    at = idx + 1;
  } else {
    at = lines.length;
  }

  const anchorIndent = leadingWhitespace(lines[at - 1] ?? '');
  const indent = opts.indent ?? `${anchorIndent}    `;
  lines.splice(at, 0, ...build(indent));
  return { content: lines.join('\n'), mode: 'inserted' };
}

export interface RemoveResult {
  content: string;
  removed: boolean;
}

export function removeBlock(content: string, id: string, comment: string): RemoveResult {
  const found = findBlock(content, id, comment);
  if (!found) return { content, removed: false };
  const lines = content.split('\n');
  // 顺手吃掉区间前紧邻的空行，卸载后不留悬空空行
  let start = found.begin;
  if (start > 0 && (lines[start - 1] ?? '').trim() === '') start -= 1;
  lines.splice(start, found.end - start + 1);
  return { content: lines.join('\n'), removed: true };
}

/** 列出文件中全部 kpm 标记区间的 id（doctor 检查孤儿区间用） */
export function listBlockIds(content: string, comment: string): string[] {
  const ids: string[] = [];
  for (const line of content.split('\n')) {
    const parsed = parseMarkerLine(line, comment, BEGIN);
    if (parsed) ids.push(parsed.id);
  }
  return ids;
}
