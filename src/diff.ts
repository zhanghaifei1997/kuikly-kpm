/** 轻量行级 diff（LCS），用于写入前的变更预览。仅展示 +/- 行与少量上下文。 */

export interface DiffLine {
  kind: ' ' | '-' | '+';
  text: string;
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;
  // LCS DP 表（构建文件都很小，O(n*m) 足够）
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: ' ', text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ kind: '-', text: a[i]! });
      i++;
    } else {
      out.push({ kind: '+', text: b[j]! });
      j++;
    }
  }
  while (i < n) out.push({ kind: '-', text: a[i++]! });
  while (j < m) out.push({ kind: '+', text: b[j++]! });
  return out;
}

/** 渲染 diff，只保留变更行 ±context 行上下文 */
export function renderDiff(before: string, after: string, context = 2): string {
  const lines = diffLines(before, after);
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, idx) => {
    if (l.kind !== ' ') {
      for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) {
        keep[k] = true;
      }
    }
  });
  const out: string[] = [];
  let lastKept = -2;
  lines.forEach((l, idx) => {
    if (keep[idx]) {
      if (idx > lastKept + 1) out.push('  ⋯');
      out.push(`${l.kind} ${l.text}`);
      lastKept = idx;
    }
  });
  return out.join('\n');
}
