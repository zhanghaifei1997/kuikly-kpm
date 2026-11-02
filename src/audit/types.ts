/** kpm audit —— Kuikly 工程发布前体检（对标 flutter_auditor，适配三端工程结构） */
import type { Manifest } from '../types.js';

export type Severity = 'error' | 'warn' | 'info';
export type AuditDomain = 'android' | 'ios' | 'ohos' | 'common' | 'kpm';

export interface AuditFinding {
  /** 检查项 id，如 manifest-debuggable */
  id: string;
  domain: AuditDomain;
  severity: Severity;
  title: string;
  detail?: string;
  /** 工程内相对路径 */
  file?: string;
  line?: number;
}

export interface AuditContext {
  root: string;
  /** 相对路径（来自 manifest.paths，缺省用约定名） */
  shared: string;
  androidApp: string;
  iosApp: string;
  ohosApp: string;
  /** kpm 清单（存在时附加一致性检查） */
  manifest: Manifest | null;
}

export interface CheckerResult {
  findings: AuditFinding[];
  /** 该 checker 实际执行了什么检查（无发现也要在汇总里计数） */
  performed: number;
}

export type Checker = (ctx: AuditContext) => Promise<CheckerResult>;

const DOMAINS: Array<AuditDomain> = ['android', 'ios', 'ohos', 'common', 'kpm'];
export const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warn: 1, info: 2 };

export function sortFindings(list: AuditFinding[]): AuditFinding[] {
  return [...list].sort((a, b) => {
    const d = DOMAINS.indexOf(a.domain) - DOMAINS.indexOf(b.domain);
    if (d !== 0) return d;
    const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (s !== 0) return s;
    return a.id.localeCompare(b.id);
  });
}

/** 汇总行（含检查数），报告与 --json 共用 */
export interface AuditSummary {
  performed: number;
  errors: number;
  warns: number;
  infos: number;
  ok: boolean;
}

export function summarize(performed: number, findings: AuditFinding[]): AuditSummary {
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warns = findings.filter((f) => f.severity === 'warn').length;
  const infos = findings.filter((f) => f.severity === 'info').length;
  return { performed, errors, warns, infos, ok: errors === 0 };
}

export function renderReport(performed: number, findings: AuditFinding[]): string {
  const lines: string[] = [];
  const sorted = sortFindings(findings);
  if (sorted.length === 0) {
    lines.push(`✅ ${performed} 项检查完成，未发现问题`);
    return lines.join('\n');
  }
  for (const f of sorted) {
    const icon = f.severity === 'error' ? '❌' : f.severity === 'warn' ? '⚠️ ' : 'ℹ️ ';
    const loc = f.file ? `（${f.file}${f.line != null ? `:${f.line}` : ''}）` : '';
    lines.push(`${icon} [${f.domain}] ${f.title}${loc}`);
    if (f.detail) lines.push(`     ${f.detail}`);
  }
  const s = summarize(performed, findings);
  lines.push('');
  lines.push(
    `体检汇总：${performed} 项检查 · ${s.errors} error / ${s.warns} warn / ${s.infos} info` +
      (s.ok ? '' : '（存在 error 项，请处理后再次体检）'),
  );
  return lines.join('\n');
}
