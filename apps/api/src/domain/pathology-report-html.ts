/**
 * pathology-report-html.ts — domain 모듈 구성요소.
 *
 * 제공: renderPathologyReportHtml.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { escapeHtml } from '@lis/shared';
/**
 * 병리 보고서 HTML 렌더러(PP4, 순수 함수) — 인쇄/포털 배포용 자체완결 문서.
 * 외부 리소스 없음(인라인 CSS). XSS 방지 위해 모든 값 escape.
 */
// 이스케이프 정본은 @lis/shared(보고서 XSS 방어의 유일한 지점).
const esc = escapeHtml;

const dt = (d: Date | string | null | undefined): string => {
  if (!d) return '-';
  const s = typeof d === 'string' ? d : d.toISOString();
  return esc(s.replace('T', ' ').slice(0, 16));
};

type CaseWithAll = {
  spNo: string; caseType?: string | null; specimenSite?: string | null; receivedDate?: string | null;
  clinicalInfo?: string | null; requestingProvider?: string | null; grossDesc?: string | null;
  grossedBy?: string | null; grossedDt?: Date | null; status?: string | null;
  patient?: { patientId: string; name?: string | null; sex?: string | null; birthDate?: string | null } | null;
  specimens?: Array<{ partLabel: string; specimenType?: string | null; site?: string | null; description?: string | null }>;
  ihcResults?: Array<{ marker: string; result?: string | null; intensity?: string | null; percentPos?: number | null; score?: string | null; interpretation?: string | null }>;
  cytology?: { specimenType: string; adequacy?: string | null; adequacyNote?: string | null; category?: string | null; diagnosis?: string | null; signer?: string | null; signedDt?: Date | null; status?: string } | null;
  molecular?: Array<{ target: string; panelCode?: string | null; detection: string; ct?: number | null; quantValue?: string | null; interpretation?: string | null }>;
  somatic?: Array<{ category: string; gene?: string | null; alteration?: string | null; vaf?: number | null; tier?: string | null; therapy?: string | null; runQcFlag?: string | null }>;
  report?: {
    findings?: string | null; diagnosis?: string | null; snomed?: string | null; status?: string | null;
    signer?: string | null; signedDt?: Date | null; accessionNo?: string | null; version?: number;
    amendReason?: string | null; synoptic?: string | null; synopticProtocol?: string | null;
    frozenDx?: string | null; frozenConcordance?: string | null;
    pT?: string | null; pN?: string | null; pM?: string | null; stageGroup?: string | null; icdoTopo?: string | null; icdoMorph?: string | null;
    addenda?: Array<{ seq: number; content: string; addedBy?: string | null; addedDt?: Date | null }>;
  } | null;
};

function row(label: string, value: string): string {
  return `<tr><th>${esc(label)}</th><td>${value}</td></tr>`;
}

function synopticBlock(json?: string | null, protocol?: string | null): string {
  if (!json) return '';
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(json); } catch { return ''; }
  const rows = Object.entries(obj).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('');
  return `<section><h2>구조화 보고(Synoptic${protocol ? ` · ${esc(protocol)}` : ''})</h2><table class="kv">${rows}</table></section>`;
}

function ihcBlock(ihc?: CaseWithAll['ihcResults']): string {
  if (!ihc?.length) return '';
  const rows = ihc.map((i) => `<tr><td>${esc(i.marker)}</td><td>${esc(i.result ?? '-')}</td><td>${esc(i.intensity ?? '-')}</td><td>${i.percentPos != null ? esc(i.percentPos) + '%' : '-'}</td><td>${esc(i.score ?? '-')}</td><td>${esc(i.interpretation ?? '-')}</td></tr>`).join('');
  return `<section><h2>면역/특수염색(IHC)</h2><table class="grid"><thead><tr><th>Marker</th><th>결과</th><th>강도</th><th>양성%</th><th>Score</th><th>해석</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function cytoBlock(c: CaseWithAll['cytology']): string {
  if (!c) return '';
  return `<section><h2>세포병리 소견</h2><table class="kv">${row('검체', esc(c.specimenType))}${row('검체 적정성', esc(c.adequacy ?? '-') + (c.adequacyNote ? ` (${esc(c.adequacyNote)})` : ''))}${row('분류', esc(c.category ?? '-'))}${row('진단', esc(c.diagnosis ?? '-'))}</table></section>`;
}

function specimenBlock(sp?: CaseWithAll['specimens']): string {
  if (!sp?.length) return '';
  const rows = sp.map((s) => `<tr><td>${esc(s.partLabel)}</td><td>${esc(s.specimenType ?? '-')}</td><td>${esc(s.site ?? '-')}</td><td>${esc(s.description ?? '-')}</td></tr>`).join('');
  return `<section><h2>검체(다부위)</h2><table class="grid"><thead><tr><th>Part</th><th>종류</th><th>부위</th><th>설명</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function molecularBlock(m?: CaseWithAll['molecular'], s?: CaseWithAll['somatic']): string {
  const mo = m?.length ? `<table class="grid"><thead><tr><th>타깃</th><th>패널</th><th>검출</th><th>Ct</th><th>정량</th><th>해석</th></tr></thead><tbody>${m.map((x) => `<tr><td>${esc(x.target)}</td><td>${esc(x.panelCode ?? '-')}</td><td>${esc(x.detection)}</td><td>${x.ct != null ? esc(x.ct) : '-'}</td><td>${esc(x.quantValue ?? '-')}</td><td>${esc(x.interpretation ?? '-')}</td></tr>`).join('')}</tbody></table>` : '';
  const so = s?.length ? `<table class="grid"><thead><tr><th>유형</th><th>유전자</th><th>변이</th><th>VAF</th><th>Tier</th><th>연관치료</th><th>QC</th></tr></thead><tbody>${s.map((x) => `<tr><td>${esc(x.category)}</td><td>${esc(x.gene ?? '-')}</td><td>${esc(x.alteration ?? '-')}</td><td>${x.vaf != null ? esc(x.vaf) + '%' : '-'}</td><td>${esc(x.tier ?? '-')}</td><td>${esc(x.therapy ?? '-')}</td><td>${x.runQcFlag ? '⚠ ' + esc(x.runQcFlag) : '-'}</td></tr>`).join('')}</tbody></table>` : '';
  if (!mo && !so) return '';
  return `<section><h2>분자병리 소견</h2>${mo}${so}</section>`;
}

function addendaBlock(add?: NonNullable<CaseWithAll['report']>['addenda']): string {
  if (!add?.length) return '';
  const items = add.map((a) => `<li><b>#${esc(a.seq)}</b> (${dt(a.addedDt)}, ${esc(a.addedBy ?? '-')}) — ${esc(a.content)}</li>`).join('');
  return `<section><h2>추가보고(Addendum)</h2><ul class="add">${items}</ul></section>`;
}

/** 병리 케이스 → 배포용 HTML 문자열. getCase(include 전체)의 반환을 그대로 받는다. */
export function renderPathologyReportHtml(c: CaseWithAll): string {
  const r = c.report;
  const isCyto = (c.caseType ?? '').toUpperCase() === 'CYTOLOGY' || !!c.cytology;
  const title = isCyto ? '세포병리 검사 보고서' : '조직병리 검사 보고서';
  const statusBadge = r?.status ?? c.cytology?.status ?? c.status ?? '작성중';
  const amended = (r?.version ?? 1) > 1 || statusBadge === '개정';
  const signer = r?.signer ?? c.cytology?.signer ?? '-';
  const signedDt = r?.signedDt ?? c.cytology?.signedDt ?? null;

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} ${esc(c.spNo)}</title>
<style>
  :root{--ink:#1a1f2b;--muted:#5b6472;--line:#d7dce4;--accent:#7a1f2b}
  *{box-sizing:border-box} body{margin:0;font-family:'Malgun Gothic',-apple-system,'Apple SD Gothic Neo',sans-serif;color:var(--ink);background:#fff;font-size:13px;line-height:1.55}
  .page{max-width:800px;margin:0 auto;padding:28px}
  header{border-bottom:3px double var(--accent);padding-bottom:12px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:flex-end}
  h1{font-size:19px;margin:0;letter-spacing:1px}
  .hosp{font-size:12px;color:var(--muted)}
  .badge{display:inline-block;padding:2px 9px;border-radius:3px;font-size:11px;font-weight:700;border:1px solid var(--line)}
  .badge.final{background:#eef6ee;color:#256029;border-color:#bcd9bc}
  .badge.amend{background:#fbecec;color:var(--accent);border-color:#e6c1c1}
  section{margin:14px 0} h2{font-size:13px;color:var(--accent);border-left:3px solid var(--accent);padding-left:7px;margin:0 0 7px}
  table{width:100%;border-collapse:collapse} table.kv th{width:130px;text-align:left;color:var(--muted);font-weight:600;vertical-align:top;padding:3px 8px 3px 0}
  table.kv td{padding:3px 0;vertical-align:top}
  table.grid th,table.grid td{border:1px solid var(--line);padding:4px 7px;text-align:left;font-size:12px}
  table.grid thead th{background:#f5f6f9}
  .dx{white-space:pre-wrap;background:#fafbfc;border:1px solid var(--line);border-radius:4px;padding:10px}
  ul.add{margin:0;padding-left:18px} ul.add li{margin:3px 0}
  footer{margin-top:22px;border-top:1px solid var(--line);padding-top:10px;display:flex;justify-content:space-between;font-size:12px;color:var(--muted)}
  .sign b{color:var(--ink)}
  @media print{.page{padding:0}}
</style></head><body><div class="page">
<header>
  <div><h1>${esc(title)}</h1><div class="hosp">Laboratory Information System · 병리과</div></div>
  <div><span class="badge ${amended ? 'amend' : statusBadge === '최종' ? 'final' : ''}">${esc(statusBadge)}${amended ? ` · v${esc(r?.version ?? 1)}` : ''}</span></div>
</header>
<section><h2>기본 정보</h2><table class="kv">
  ${row('검사번호', esc(c.spNo))}
  ${row('환자', `${esc(c.patient?.name ?? '-')} (${esc(c.patient?.patientId ?? '-')}, ${esc(c.patient?.sex ?? '-')}/${esc(c.patient?.birthDate ?? '-')})`)}
  ${row('검체 부위', esc(c.specimenSite ?? '-'))}
  ${row('의뢰의', esc(c.requestingProvider ?? '-'))}
  ${row('접수일', esc(c.receivedDate ?? '-'))}
  ${row('임상 정보', esc(c.clinicalInfo ?? '-'))}
</table></section>
${specimenBlock(c.specimens)}
${c.grossDesc ? `<section><h2>육안 소견(Gross)</h2><div class="dx">${esc(c.grossDesc)}</div></section>` : ''}
${cytoBlock(c.cytology)}
${r?.findings ? `<section><h2>현미경 소견(Microscopic)</h2><div class="dx">${esc(r.findings)}</div></section>` : ''}
${synopticBlock(r?.synoptic, r?.synopticProtocol)}
${ihcBlock(c.ihcResults)}
${molecularBlock(c.molecular, c.somatic)}
${(r?.diagnosis || c.cytology?.diagnosis) ? `<section><h2>병리 진단(Diagnosis)</h2><div class="dx">${esc(r?.diagnosis ?? c.cytology?.diagnosis)}</div>${r?.snomed ? `<div class="hosp">SNOMED: ${esc(r.snomed)}</div>` : ''}</section>` : ''}
${(r?.pT || r?.stageGroup || r?.icdoMorph) ? `<section><h2>병기·분류(TNM · ICD-O)</h2><table class="kv">${row('TNM', esc([r.pT, r.pN, r.pM].filter(Boolean).join(' ') || '-'))}${row('병기군(AJCC)', esc(r.stageGroup ?? '-'))}${row('ICD-O 국소부위', esc(r.icdoTopo ?? '-'))}${row('ICD-O 형태', esc(r.icdoMorph ?? '-'))}</table></section>` : ''}
${r?.frozenDx ? `<section><h2>동결절편</h2><table class="kv">${row('동결진단', esc(r.frozenDx))}${row('영구 일치도', esc(r.frozenConcordance ?? '-'))}</table></section>` : ''}
${addendaBlock(r?.addenda)}
${amended && r?.amendReason ? `<section><h2>개정 사유</h2><div class="dx">${esc(r.amendReason)}</div></section>` : ''}
<footer>
  <div class="sign">판독: <b>${esc(signer)}</b> · ${dt(signedDt)}${r?.accessionNo ? ` · Accession ${esc(r.accessionNo)}` : ''}</div>
  <div>출력: ${dt(new Date())}</div>
</footer>
</div></body></html>`;
}
