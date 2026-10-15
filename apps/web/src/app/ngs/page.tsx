'use client';

/**
 * 종양 NGS 화면 (`/ngs`).
 *
 * 사이드바 노출 역할: GEN, ADM.
 * ⚠ 노출 역할과 화면이 호출하는 API 권한이 어긋나면 전부 403인 죽은 화면이 된다 —
 *   역할을 바꿀 때는 `Sidebar.tsx`(정본)와 API 권한 매트릭스를 함께 본다.
 * 데이터는 `lib/api.ts`의 `apiFetch`로만 가져온다(HTTP 호출 정본).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, getToken } from '@/lib/api';
import { EmptyState, ErrorText, TableSkeleton, BTN } from '@/components/ui';
import { useToast } from '@/components/toast';
import { maskName } from '@/lib/privacy';
import { useConfirm } from '@/components/confirm';
import { IconWarn } from '@/components/Icon';

/**
 * 종양 NGS — 런 관리·QC 게이트·체세포(somatic) 소견.
 *
 * ★생식세포(germline ACMG)와 **분리된 경로**다. 여기 tier는 AMP/ASCO 체세포 등급(Tier I~IV)이며
 *   ACMG 병원성 분류나 2차 발견(SF)과 혼동하면 안 된다(모델 주석의 설계 의도).
 * QC 임계값은 패널별로 등록한다(미등록 패널은 기본 임계 Q30 80%·coverage 100x·uniformity 90%).
 *   미달은 **경고이지 하드블록이 아니다** — 재검·판독은 사람이 판단한다.
 */
interface RunPatient { specimenNo: string; patientId: string; patientName: string }
interface NgsPanel { panelCode: string; name: string; platform: string | null; q30Min: number | null; meanCoverageMin: number | null; uniformityMin: number | null; note: string | null }
interface NgsRun {
  runId: string; runName: string; flowcell: string | null; status: string;
  specimenNos?: string | null; primarySpecimenNo?: string | null; panelCode?: string | null;
  q30: number | null; totalReads: number | null; meanCoverage: number | null; uniformityPct: number | null;
  startedDt: string; completedDt: string | null; note: string | null;
}
interface NgsRunSummary {
  runId: string; runName: string; flowcell: string | null; panelCode: string | null; status: string;
  startedDt: string; completedDt: string | null; specimenCount: number; primaryPatient: string | null;
  findingCount: number; qcVerdict: string | null;
}
interface Finding {
  findingId: string; category: string; gene: string | null; alteration: string | null;
  vaf: number | null; tier: string | null; therapy: string | null; note: string | null; reportedDt: string;
  runQcFlag?: string | null; caseSpNo?: string | null;
}
interface RunDetail extends NgsRun { findings: Finding[] }
interface QcResult {
  runId: string; runName: string; status: string;
  metrics: { q30: number | null; meanCoverage: number | null; uniformityPct: number | null };
  verdict: 'PASS' | 'WARN' | 'FAIL'; failed: string[];
  thresholds: { q30: number; meanCoverage: number; uniformityPct: number };
}

const CATEGORIES = ['VARIANT', 'FUSION', 'CNV', 'TMB', 'MSI'] as const;
const CATEGORY_LABEL: Record<string, string> = { VARIANT: '변이', FUSION: '융합', CNV: 'CNV', TMB: 'TMB', MSI: 'MSI' };
const TIERS = ['TIER_I', 'TIER_II', 'TIER_III', 'TIER_IV'] as const;
const TIER_LABEL: Record<string, string> = {
  TIER_I: 'Tier I (임상적 유의)', TIER_II: 'Tier II (잠재적 유의)',
  TIER_III: 'Tier III (의의불명)', TIER_IV: 'Tier IV (양성·의의없음)',
};
const tierTone: Record<string, string> = {
  TIER_I: 'bg-warn/20 text-warn', TIER_II: 'bg-indigo/15 text-indigo',
  TIER_III: 'bg-bg text-ink-2', TIER_IV: 'bg-bg text-ink-3',
};
const statusTone: Record<string, string> = { RUNNING: 'bg-indigo/15 text-indigo', COMPLETE: 'bg-good/15 text-good', FAILED: 'bg-warn/20 text-warn' };
const statusLabel: Record<string, string> = { RUNNING: '진행중', COMPLETE: '완료', FAILED: '실패' };

export default function NgsPage() {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [err, setErr] = useState('');

  const [runs, setRuns] = useState<NgsRunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState<RunDetail | null>(null);
  const [qc, setQc] = useState<QcResult | null>(null);
  const [pts, setPts] = useState<RunPatient[]>([]);

  const [newRun, setNewRun] = useState({ runName: '', flowcell: '', note: '', panelCode: '', specimenNos: '' });
  const [qcForm, setQcForm] = useState({ q30: '', totalReads: '', meanCoverage: '', uniformityPct: '' });
  const [fForm, setFForm] = useState({ category: 'VARIANT', gene: '', alteration: '', vaf: '', tier: '', therapy: '', note: '' });
  const [tierSug, setTierSug] = useState<{ tier: string; basis: string; citation: string | null; caution: string | null; therapy: string | null } | null>(null);
  const [vcf, setVcf] = useState('');
  const [vcfBusy, setVcfBusy] = useState(false);
  async function ingestVcf() {
    if (!sel || !vcf.trim()) { toast('VCF를 붙여넣으세요', 'info'); return; }
    setVcfBusy(true);
    try {
      const r = await apiFetch<{ created: number; skipped: number; withGene: number; parsed: number }>(`/api/v1/ngs/runs/${encodeURIComponent(sel.runId)}/vcf`, { method: 'POST', body: JSON.stringify({ vcf }) });
      toast(`소견 ${r.created}건 등록${r.skipped ? ` · 중복 ${r.skipped}` : ''}${r.parsed - r.withGene ? ` · GENE 없음 ${r.parsed - r.withGene}` : ''}`, r.created ? 'success' : 'info');
      setVcf(''); await openRun(sel.runId);
    } catch (e) { toast(e instanceof Error ? e.message : 'VCF 등록 실패', 'error'); }
    finally { setVcfBusy(false); }
  }
  async function suggestTier() {
    if (!fForm.gene.trim() && !fForm.alteration.trim()) { toast('유전자 또는 변경 내용을 먼저 입력하세요', 'info'); return; }
    try {
      const r = await apiFetch<{ suggestion: { tier: string; basis: string; citation: string | null; caution: string | null; therapy: string | null } | null; evidenceFound: boolean }>('/api/v1/ngs/tier-suggest', {
        method: 'POST', body: JSON.stringify({ gene: fForm.gene.trim() || undefined, alteration: fForm.alteration.trim() || undefined }),
      });
      setTierSug(r.suggestion);
      if (!r.suggestion) { toast(r.evidenceFound ? '근거는 있으나 tier 매핑 불가' : '근거 DB에 없음(수기 판정)', 'info'); return; }
      // tier·therapy 자동 채움(검토 후 확정)
      setFForm((f) => ({ ...f, tier: r.suggestion!.tier, therapy: f.therapy || r.suggestion!.therapy || '' }));
    } catch (e) { toast(e instanceof Error ? e.message : '제안 실패', 'error'); }
  }
  // 패널 마스터 — 임계가 코드 상수 하나였다(타깃 패널과 WES는 요구 coverage가 자릿수로 다르다)
  const [panels, setPanels] = useState<NgsPanel[]>([]);
  const [pForm, setPForm] = useState({ panelCode: '', name: '', platform: '', q30Min: '', meanCoverageMin: '', uniformityMin: '', note: '' });
  const [pOpen, setPOpen] = useState(false);
  // 병리 케이스 결속 대상(소견 id) — 조직 기반 NGS 소견은 병리 보고서에 함께 실려야 한다
  const [linkFor, setLinkFor] = useState<string | null>(null);
  const [linkSp, setLinkSp] = useState('');

  const loadRuns = useCallback(async () => {
    setLoading(true);
    try { setRuns(await apiFetch<NgsRunSummary[]>('/api/v1/ngs/runs')); setErr(''); }
    catch (e) { setErr(e instanceof Error ? e.message : '런 목록 조회 실패'); }
    finally { setLoading(false); }
  }, []);

  const loadPanels = useCallback(async () => {
    try { setPanels(await apiFetch<NgsPanel[]>('/api/v1/ngs/panels')); } catch { /* 패널 없이도 런 관리는 가능 */ }
  }, []);

  useEffect(() => { if (!getToken()) router.push('/'); else { void loadRuns(); void loadPanels(); } }, [router, loadRuns, loadPanels]);

  /** 소견 ↔ 병리 케이스 결속(PP5) — API는 있었는데 화면이 없어 결속할 방법이 없었다. */
  async function linkToCase() {
    if (!linkFor || !linkSp.trim() || !sel) return;
    try {
      await apiFetch(`/api/v1/pathology/somatic/${encodeURIComponent(linkFor)}/link`, { method: 'POST', body: JSON.stringify({ caseSpNo: linkSp.trim() }) });
      toast('병리 케이스에 결속됨'); setLinkFor(null); setLinkSp(''); await openRun(sel.runId);
    } catch (e) { setErr(e instanceof Error ? e.message : '결속 실패'); }
  }

  async function savePanel() {
    const num = (v: string) => (v.trim() === '' ? null : Number(v));
    if (!pForm.panelCode.trim() || !pForm.name.trim()) { setErr('패널 코드와 이름은 필수입니다'); return; }
    try {
      await apiFetch('/api/v1/ngs/panels', {
        method: 'POST',
        body: JSON.stringify({
          panelCode: pForm.panelCode.trim(), name: pForm.name.trim(), platform: pForm.platform.trim() || undefined,
          q30Min: num(pForm.q30Min), meanCoverageMin: num(pForm.meanCoverageMin), uniformityMin: num(pForm.uniformityMin),
          note: pForm.note.trim() || undefined,
        }),
      });
      toast('패널 저장됨'); setPForm({ panelCode: '', name: '', platform: '', q30Min: '', meanCoverageMin: '', uniformityMin: '', note: '' });
      await loadPanels(); setErr('');
    } catch (e) { setErr(e instanceof Error ? e.message : '패널 저장 실패'); }
  }

  async function openRun(runId: string) {
    setErr(''); setQc(null);
    try {
      const d = await apiFetch<RunDetail>(`/api/v1/ngs/runs/${encodeURIComponent(runId)}`);
      setSel(d);
      setQcForm({
        q30: d.q30?.toString() ?? '', totalReads: d.totalReads?.toString() ?? '',
        meanCoverage: d.meanCoverage?.toString() ?? '', uniformityPct: d.uniformityPct?.toString() ?? '',
      });
      // QC 판정은 별도 게이트 API(생식세포 모듈과 임계 공유)
      try { setQc(await apiFetch<QcResult>(`/api/v1/genomic/runs/${encodeURIComponent(runId)}/qc`)); } catch { setQc(null); }
      try { setPts(await apiFetch<RunPatient[]>(`/api/v1/ngs/runs/${encodeURIComponent(runId)}/patients`)); } catch { setPts([]); }
    } catch (e) { setErr(e instanceof Error ? e.message : '런 조회 실패'); }
  }

  async function createRun() {
    if (!newRun.runName.trim()) { setErr('런 이름을 입력하세요'); return; }
    try {
      const r = await apiFetch<NgsRun>('/api/v1/ngs/runs', {
        method: 'POST',
        body: JSON.stringify({
          runName: newRun.runName.trim(),
          flowcell: newRun.flowcell.trim() || undefined,
          note: newRun.note.trim() || undefined,
          panelCode: newRun.panelCode.trim() || undefined,
          // 검체가 없으면 소견을 환자에 연결할 수 없다 — 쉼표로 여러 건(pooling)
          specimenNos: newRun.specimenNos.split(',').map((x) => x.trim()).filter(Boolean),
        }),
      });
      toast(`런 생성 — ${r.runName}`, 'success');
      setNewRun({ runName: '', flowcell: '', note: '', panelCode: '', specimenNos: '' });
      await loadRuns(); await openRun(r.runId);
    } catch (e) { setErr(e instanceof Error ? e.message : '런 생성 실패'); }
  }

  async function completeRun(status: 'COMPLETE' | 'FAILED') {
    if (!sel) return;
    const ok = await confirm({
      title: status === 'COMPLETE' ? 'QC 확정 — 완료' : 'QC 확정 — 실패',
      message: status === 'COMPLETE'
        ? '입력한 QC 지표로 런을 완료 처리합니다. 임계 미달이면 경고가 남습니다(보고 차단은 하지 않습니다).'
        : '런을 실패로 처리합니다. 이 런의 소견은 판독에 쓰지 마세요.',
      detail: [
        { label: 'Q30', value: qcForm.q30 || '—' },
        { label: '평균 coverage', value: qcForm.meanCoverage || '—' },
        { label: 'uniformity', value: qcForm.uniformityPct || '—' },
      ],
      danger: status === 'FAILED',
      confirmLabel: status === 'COMPLETE' ? '완료 처리' : '실패 처리',
    });
    if (!ok) return;
    try {
      await apiFetch(`/api/v1/ngs/runs/${encodeURIComponent(sel.runId)}/complete`, {
        method: 'POST',
        body: JSON.stringify({
          status,
          q30: qcForm.q30 ? Number(qcForm.q30) : undefined,
          totalReads: qcForm.totalReads ? Number(qcForm.totalReads) : undefined,
          meanCoverage: qcForm.meanCoverage ? Number(qcForm.meanCoverage) : undefined,
          uniformityPct: qcForm.uniformityPct ? Number(qcForm.uniformityPct) : undefined,
        }),
      });
      toast(status === 'COMPLETE' ? 'QC 확정 — 완료' : '런 실패 처리됨', status === 'COMPLETE' ? 'success' : 'info');
      await loadRuns(); await openRun(sel.runId);
    } catch (e) { setErr(e instanceof Error ? e.message : 'QC 확정 실패'); }
  }

  async function addFinding() {
    if (!sel) return;
    if (fForm.category === 'VARIANT' && !fForm.gene.trim()) { setErr('변이는 유전자를 입력하세요'); return; }
    if (!fForm.alteration.trim()) { setErr('변경 내용(alteration)을 입력하세요'); return; }
    try {
      const r = await apiFetch<{ finding: Finding; qcWarning: string | null }>('/api/v1/ngs/findings', {
        method: 'POST',
        body: JSON.stringify({
          runId: sel.runId, category: fForm.category,
          gene: fForm.gene.trim() || undefined, alteration: fForm.alteration.trim(),
          vaf: fForm.vaf ? Number(fForm.vaf) : undefined,
          tier: fForm.tier || undefined, therapy: fForm.therapy.trim() || undefined, note: fForm.note.trim() || undefined,
        }),
      });
      if (r.qcWarning) toast(r.qcWarning, 'info');
      else toast('소견 등록됨', 'success');
      setFForm({ ...fForm, gene: '', alteration: '', vaf: '', therapy: '', note: '' }); setTierSug(null);
      await openRun(sel.runId);
    } catch (e) { setErr(e instanceof Error ? e.message : '소견 등록 실패'); }
  }

  const inp = 'px-2 py-1.5 r-ctl border border-line bg-bg text-sm';

  return (
    <main className="page">
      <h1 className="t-page">종양 NGS</h1>
      <p className="t-meta mb-3">
        시퀀싱 런의 QC(Q30·coverage·uniformity)를 확정하고 체세포 소견을 기록합니다.
        여기 tier는 <b>AMP/ASCO 체세포 등급</b>으로, 생식세포(ACMG)·2차 발견과는 별개 경로입니다.
      </p>
      <ErrorText message={err} />

      <div className="grid lg:grid-cols-[320px_1fr] gap-4">
        {/* 런 목록·생성 */}
        <div className="flex flex-col gap-4">
          <section className="card">
            <h2 className="t-section mb-2">런 목록 <span className="t-meta">({runs.length})</span></h2>
            {loading ? <TableSkeleton rows={4} cols={2} /> : runs.length === 0 ? (
              <EmptyState title="등록된 런이 없습니다" hint="아래에서 새 런을 만드세요." />
            ) : (
              <ul className="flex flex-col gap-1 max-h-96 overflow-y-auto">
                {runs.map((r) => (
                  <li key={r.runId}>
                    <button onClick={() => openRun(r.runId)}
                      className={`w-full text-left px-2 py-1.5 r-ctl border m-hover ${sel?.runId === r.runId ? 'border-teal bg-teal/5' : 'border-line hover:border-teal'}`}>
                      <span className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold truncate">{r.runName}</span>
                        <span className="flex items-center gap-1 shrink-0">
                          {r.qcVerdict && <span className={`px-1.5 py-0.5 r-chip t-micro ${r.qcVerdict === 'PASS' ? 'bg-good/15 text-good' : r.qcVerdict === 'FAIL' ? 'bg-crit/15 text-crit' : 'bg-warn/15 text-warn'}`}>QC {r.qcVerdict}</span>}
                          <span className={`px-1.5 py-0.5 r-chip t-micro ${statusTone[r.status] ?? ''}`}>{statusLabel[r.status] ?? r.status}</span>
                        </span>
                      </span>
                      <span className="block t-micro">
                        <span className="mono">{r.startedDt.slice(0, 10)}</span>
                        {r.panelCode ? ` · ${r.panelCode}` : ''}
                        {r.primaryPatient ? ` · ${r.primaryPatient}` : ''}
                        {r.specimenCount > 1 ? ` 외 ${r.specimenCount - 1}` : ''}
                        {r.findingCount > 0 ? <span className="text-indigo font-semibold"> · 소견 {r.findingCount}</span> : ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card">
            <h2 className="t-section mb-2">새 런</h2>
            <div className="flex flex-col gap-2">
              <div>
                <label htmlFor="ngs-name" className="block t-micro mb-0.5">런 이름 *</label>
                <input id="ngs-name" value={newRun.runName} onChange={(e) => setNewRun({ ...newRun, runName: e.target.value })} placeholder="예: RUN-2026-07-23-A" className={`${inp} w-full mono`} />
              </div>
              <div>
                <label htmlFor="ngs-fc" className="block t-micro mb-0.5">Flowcell</label>
                <input id="ngs-fc" value={newRun.flowcell} onChange={(e) => setNewRun({ ...newRun, flowcell: e.target.value })} className={`${inp} w-full mono`} />
              </div>
              <div>
                <label htmlFor="ngs-panel" className="block t-micro mb-0.5">패널 코드</label>
                <input id="ngs-panel" list="ngs-panel-list" value={newRun.panelCode} onChange={(e) => setNewRun({ ...newRun, panelCode: e.target.value })} className={`${inp} w-full`} />
                <datalist id="ngs-panel-list">{panels.map((p) => <option key={p.panelCode} value={p.panelCode}>{p.name}</option>)}</datalist>
                <span className="t-micro">등록된 패널이면 그 패널의 QC 임계로 판정합니다</span>
              </div>
              <div>
                <label htmlFor="ngs-sp" className="block t-micro mb-0.5">검체번호 <span className="text-ink-3">(쉼표 구분·pooling)</span></label>
                <input id="ngs-sp" value={newRun.specimenNos} onChange={(e) => setNewRun({ ...newRun, specimenNos: e.target.value })}
                  placeholder="S2607230001, S2607230002" className={`${inp} w-full mono`} />
                <span className="t-micro">검체가 없으면 소견을 환자에 연결할 수 없습니다</span>
              </div>
              <button onClick={createRun} className={BTN.primary}>런 생성</button>
            </div>
          </section>

          {/* 패널별 QC 임계 — 임계가 코드 상수 하나였다. 패널이 둘 이상이면 맞지 않는다. */}
          <section className="card">
            <div className="flex items-center justify-between mb-2">
              <h2 className="t-section">패널 QC 임계</h2>
              <button onClick={() => setPOpen(!pOpen)} className="t-micro text-teal underline">{pOpen ? '닫기' : '패널 등록'}</button>
            </div>
            {panels.length === 0 ? (
              <p className="t-micro text-ink-3">등록된 패널이 없습니다 — 기본 임계(Q30 80% · coverage 100x · uniformity 90%)로 판정합니다.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {panels.map((p) => (
                  <li key={p.panelCode} className="t-micro flex flex-wrap gap-x-2">
                    <span className="mono font-semibold">{p.panelCode}</span>
                    <span>{p.name}{p.platform ? ` · ${p.platform}` : ''}</span>
                    <span className="text-ink-3">
                      Q30 {p.q30Min ?? 80}% · coverage {p.meanCoverageMin ?? 100}x · uniformity {p.uniformityMin ?? 90}%
                      {(p.q30Min == null || p.meanCoverageMin == null || p.uniformityMin == null) && ' (일부 기본값)'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {pOpen && (
              <div className="flex flex-col gap-2 mt-2 border-t border-line pt-2">
                <div className="flex gap-2">
                  <input aria-label="패널 코드" placeholder="패널 코드 *" value={pForm.panelCode} onChange={(e) => setPForm({ ...pForm, panelCode: e.target.value })} className={`${inp} w-28 mono`} />
                  <input aria-label="패널 이름" placeholder="이름 *" value={pForm.name} onChange={(e) => setPForm({ ...pForm, name: e.target.value })} className={`${inp} flex-1`} />
                </div>
                <input aria-label="플랫폼" placeholder="플랫폼(예: NextSeq 550)" value={pForm.platform} onChange={(e) => setPForm({ ...pForm, platform: e.target.value })} className={`${inp} w-full`} />
                <div className="flex gap-2">
                  <input aria-label="Q30 임계(%)" placeholder="Q30 %" inputMode="decimal" value={pForm.q30Min} onChange={(e) => setPForm({ ...pForm, q30Min: e.target.value })} className={`${inp} w-20`} />
                  <input aria-label="평균 coverage 임계(x)" placeholder="coverage x" inputMode="decimal" value={pForm.meanCoverageMin} onChange={(e) => setPForm({ ...pForm, meanCoverageMin: e.target.value })} className={`${inp} w-24`} />
                  <input aria-label="uniformity 임계(%)" placeholder="unif. %" inputMode="decimal" value={pForm.uniformityMin} onChange={(e) => setPForm({ ...pForm, uniformityMin: e.target.value })} className={`${inp} w-20`} />
                </div>
                <span className="t-micro text-ink-3">비워 두면 기본값을 씁니다. 타깃 패널과 WES는 요구 coverage가 자릿수로 다릅니다.</span>
                <button onClick={savePanel} className={BTN.primary}>패널 저장</button>
              </div>
            )}
          </section>
        </div>

        {/* 런 상세: QC + 소견 */}
        <div className="flex flex-col gap-4">
          {!sel ? (
            <section className="card"><EmptyState title="런을 선택하세요" hint="왼쪽 목록에서 런을 고르면 QC와 소견을 관리할 수 있습니다." /></section>
          ) : (
            <>
              <section className="card">
                <div className="flex items-start justify-between gap-2 flex-wrap mb-2">
                  <div>
                    <h2 className="t-section">{sel.runName}</h2>
                    <p className="t-meta mono">{sel.runId.slice(0, 12)}… · 시작 {sel.startedDt.slice(0, 16).replace('T', ' ')}{sel.completedDt ? ` · 완료 ${sel.completedDt.slice(0, 16).replace('T', ' ')}` : ''}{sel.flowcell ? ` · 플로우셀 ${sel.flowcell}` : ''}</p>
                    {sel.note && <p className="t-meta text-ink-3">{sel.note}</p>}
                  </div>
                  <span className={`px-2 py-0.5 r-chip t-micro ${statusTone[sel.status] ?? ''}`}>{statusLabel[sel.status] ?? sel.status}</span>
                </div>

                {/* 이 런이 누구의 검체인지 — 없으면 소견을 환자 보고에 쓸 수 없다 */}
                <div className="mb-3">
                  <span className="t-micro">대상 검체·환자</span>
                  {pts.length === 0 ? (
                    <p className="t-meta text-warn"><IconWarn className="mr-1" />연결된 검체가 없습니다 — 이 런의 소견은 환자에 귀속되지 않습니다(런 생성 시 검체번호 입력)</p>
                  ) : (
                    <ul className="flex flex-wrap gap-2 mt-0.5">
                      {pts.map((p) => (
                        <li key={p.specimenNo} className="t-meta">
                          <span className="mono">{p.specimenNo}</span> · {maskName(p.patientName)} <span className="mono text-ink-3">{p.patientId}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* QC 판정 — 임계값을 함께 보여줘야 사용자가 값을 판단할 수 있다 */}
                {qc && (
                  <div className={`r-ctl p-2 mb-3 ${qc.verdict === 'FAIL' ? 'bg-warn/10' : qc.verdict === 'PASS' ? 'bg-good/10' : 'bg-bg'}`}>
                    <p className="text-sm font-semibold">
                      QC 판정: {qc.verdict === 'PASS' ? '통과' : qc.verdict === 'FAIL' ? '임계 미달' : '— 미평가(지표 없음)'}
                    </p>
                    {qc.failed.length > 0 && <ul className="t-meta mt-1">{qc.failed.map((f) => <li key={f}>· {f}</li>)}</ul>}
                    <p className="t-micro mt-1">
                      임계(검사실 확정 대기): Q30 ≥ {qc.thresholds.q30}% · coverage ≥ {qc.thresholds.meanCoverage}x · uniformity ≥ {qc.thresholds.uniformityPct}%
                      {qc.verdict === 'FAIL' && ' — 미달은 경고이며 보고를 막지 않습니다(재검·판독은 판단 사항)'}
                    </p>
                  </div>
                )}

                <div className="grid sm:grid-cols-4 gap-2">
                  <div>
                    <label htmlFor="qc-q30" className="block t-micro mb-0.5">Q30 (%)</label>
                    <input id="qc-q30" value={qcForm.q30} onChange={(e) => setQcForm({ ...qcForm, q30: e.target.value })} inputMode="decimal" className={`${inp} w-full mono`} />
                  </div>
                  <div>
                    <label htmlFor="qc-reads" className="block t-micro mb-0.5">Total reads</label>
                    <input id="qc-reads" value={qcForm.totalReads} onChange={(e) => setQcForm({ ...qcForm, totalReads: e.target.value })} inputMode="numeric" className={`${inp} w-full mono`} />
                  </div>
                  <div>
                    <label htmlFor="qc-cov" className="block t-micro mb-0.5">평균 coverage (x)</label>
                    <input id="qc-cov" value={qcForm.meanCoverage} onChange={(e) => setQcForm({ ...qcForm, meanCoverage: e.target.value })} inputMode="decimal" className={`${inp} w-full mono`} />
                  </div>
                  <div>
                    <label htmlFor="qc-uni" className="block t-micro mb-0.5">Uniformity (%)</label>
                    <input id="qc-uni" value={qcForm.uniformityPct} onChange={(e) => setQcForm({ ...qcForm, uniformityPct: e.target.value })} inputMode="decimal" className={`${inp} w-full mono`} />
                  </div>
                </div>
                <div className="flex gap-2 mt-3">
                  <button onClick={() => completeRun('COMPLETE')} className={BTN.primary}>QC 확정 — 완료</button>
                  <button onClick={() => completeRun('FAILED')} className={BTN.danger}>런 실패 처리</button>
                </div>
              </section>

              <section className="card">
                <h2 className="t-section mb-1">체세포 소견 <span className="t-meta">({sel.findings.length})</span></h2>
                <p className="t-meta mb-2">AMP/ASCO Tier — 생식세포(ACMG) 분류와 다릅니다. Tier I·II가 임상 조치 대상입니다.</p>

                {/* VCF 자동 등록 — 수기 대신 파이프라인 VCF 붙여넣기(GENE·AF만 사용, HGVS·tier는 정련) */}
                <details className="mb-3 border border-line rounded-lg p-2">
                  <summary className="t-micro text-teal cursor-pointer">VCF 소견 자동 등록</summary>
                  <textarea value={vcf} onChange={(e) => setVcf(e.target.value)} rows={3} placeholder="#CHROM POS ID REF ALT QUAL FILTER INFO(GENE=,AF=) ..." className={`${inp} w-full mono text-xs mt-2`} />
                  <div className="flex items-center gap-2 mt-1">
                    <button type="button" onClick={ingestVcf} disabled={vcfBusy} className={BTN.neutral}>{vcfBusy ? '등록 중…' : 'VCF 등록'}</button>
                    <span className="t-micro">INFO의 GENE·AF로 VARIANT 소견 생성 · HGVS·tier는 등록 후 ‘근거 제안’으로 정련</span>
                  </div>
                </details>
                {sel.findings.length === 0 ? (
                  <EmptyState title="등록된 소견이 없습니다" hint="아래에서 변이·융합·CNV·TMB·MSI를 등록하세요." />
                ) : (
                  <div className="overflow-x-auto mb-3">
                    <table className="w-full text-sm">
                      <thead><tr className="text-left t-micro border-b border-line"><th className="py-2">유형</th><th>유전자</th><th>변경</th><th>VAF</th><th>Tier</th><th>연관 치료</th><th></th></tr></thead>
                      <tbody>
                        {sel.findings.map((f) => (
                          <tr key={f.findingId} className="border-b border-line last:border-0">
                            <td className="py-1.5 t-micro">
                              {CATEGORY_LABEL[f.category] ?? f.category}
                              {/* runQcFlag: QC 미달 run에서 생성된 소견의 영구 경고(토스트 유실 방지용 필드) — 판독 사용 주의 */}
                              {f.runQcFlag && <span className="block mt-0.5 px-1 py-0.5 r-chip t-micro bg-crit/15 text-crit font-bold" title={f.runQcFlag}><IconWarn className="mr-1" />QC</span>}
                            </td>
                            <td className="font-bold text-xs italic">{f.gene ?? '—'}{f.caseSpNo && <span className="block not-italic font-normal t-micro text-indigo" title="병리 케이스 결속됨">병리 {f.caseSpNo}</span>}</td>
                            <td className="mono text-xs">{f.alteration ?? '—'}{f.note && <span className="block not-mono t-micro text-ink-3" title={f.note}>{f.note.length > 40 ? `${f.note.slice(0, 40)}…` : f.note}</span>}</td>
                            <td className="mono text-xs">{f.vaf != null ? `${f.vaf}%` : '—'}</td>
                            <td>{f.tier ? <span className={`px-1.5 py-0.5 r-chip t-micro ${tierTone[f.tier] ?? ''}`} title={TIER_LABEL[f.tier]}>{f.tier.replace('TIER_', 'Tier ')}</span> : '—'}</td>
                            <td className="text-xs text-ink-2">{f.therapy ?? '—'}</td>
                            <td className="text-right whitespace-nowrap">
                              {/* 병리 케이스 결속 — 조직 기반 NGS 소견은 병리 보고서에 함께 실려야 한다.
                                  API는 있었는데 화면이 없어 결속할 방법이 없었다(PP5). */}
                              {f.caseSpNo
                                ? <span className="t-micro text-ink-3 mr-1" title={`병리 케이스 ${f.caseSpNo} 결속됨`}>결속됨</span>
                                : <button onClick={() => { setLinkFor(linkFor === f.findingId ? null : f.findingId); setLinkSp(''); }}
                                    className="t-micro border border-line r-chip px-1.5 py-0.5 m-hover hover:border-teal hover:text-teal mr-1">병리 결속</button>}
                              <button onClick={async () => {
                                const ok = await confirm({ title: '소견 삭제', message: '오등록 정정용입니다. 판독에 인용된 소견인지 확인하세요.', detail: [{ label: '소견', value: `${f.gene ?? ''} ${f.alteration ?? ''}` }], danger: true, confirmLabel: '삭제' });
                                if (!ok) return;
                                try { await apiFetch(`/api/v1/ngs/findings/${encodeURIComponent(f.findingId)}`, { method: 'DELETE' }); toast('소견 삭제됨'); await openRun(sel.runId); }
                                catch (e) { setErr(e instanceof Error ? e.message : '삭제 실패'); }
                              }} className="t-micro border border-line r-chip px-1.5 py-0.5 m-hover hover:border-crit hover:text-crit">삭제</button>
                            </td>
                          </tr>
                        ))}
                        {sel.findings.some((f) => f.findingId === linkFor) && (
                          <tr>
                            <td colSpan={7} className="py-2">
                              <div className="flex flex-wrap gap-2 items-center">
                                <span className="t-micro text-ink-2">병리 케이스 번호</span>
                                <input aria-label="병리 케이스 번호" value={linkSp} onChange={(e) => setLinkSp(e.target.value)}
                                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void linkToCase(); } }}
                                  placeholder="예: SP26-00123" className={`${inp} mono w-44`} />
                                <button onClick={linkToCase} className="t-micro px-2 py-1 r-ctl bg-teal text-white font-semibold">결속</button>
                                <span className="t-micro text-ink-3">결속하면 병리 보고서에 이 소견이 함께 표시됩니다</span>
                              </div>
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}

                <div className="grid sm:grid-cols-3 lg:grid-cols-6 gap-2 border-t border-line pt-3">
                  <div>
                    <label htmlFor="f-cat" className="block t-micro mb-0.5">유형 *</label>
                    <select id="f-cat" value={fForm.category} onChange={(e) => setFForm({ ...fForm, category: e.target.value })} className={`${inp} w-full`}>
                      {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="f-gene" className="block t-micro mb-0.5">유전자</label>
                    <input id="f-gene" value={fForm.gene} onChange={(e) => setFForm({ ...fForm, gene: e.target.value })} placeholder="EGFR" className={`${inp} w-full`} />
                  </div>
                  <div className="sm:col-span-2">
                    <label htmlFor="f-alt" className="block t-micro mb-0.5">변경 내용 *</label>
                    <input id="f-alt" value={fForm.alteration} onChange={(e) => setFForm({ ...fForm, alteration: e.target.value })} placeholder="p.L858R · TMB 12.3 mut/Mb · MSI-H" className={`${inp} w-full mono`} />
                  </div>
                  <div>
                    <label htmlFor="f-vaf" className="block t-micro mb-0.5">VAF (%)</label>
                    <input id="f-vaf" value={fForm.vaf} onChange={(e) => setFForm({ ...fForm, vaf: e.target.value })} inputMode="decimal" className={`${inp} w-full mono`} />
                  </div>
                  <div>
                    <div className="flex items-center gap-2 mb-0.5">
                      <label htmlFor="f-tier" className="t-micro">Tier</label>
                      <button type="button" onClick={suggestTier} className="t-micro text-teal hover:underline">근거 제안(DRAFT)</button>
                    </div>
                    <select id="f-tier" value={fForm.tier} onChange={(e) => setFForm({ ...fForm, tier: e.target.value })} className={`${inp} w-full`}>
                      <option value="">미지정</option>
                      {TIERS.map((t) => <option key={t} value={t}>{TIER_LABEL[t]}</option>)}
                    </select>
                    {tierSug && <span className="block t-micro mt-0.5 text-ink-3">제안 <b className={tierSug.caution ? 'text-warn' : 'text-teal'}>{TIER_LABEL[tierSug.tier] ?? tierSug.tier}</b> · {tierSug.basis}{tierSug.citation ? ` (${tierSug.citation})` : ''}{tierSug.caution ? ` ${tierSug.caution}` : ''}</span>}
                  </div>
                  <div className="sm:col-span-2 lg:col-span-3">
                    <label htmlFor="f-tx" className="block t-micro mb-0.5">연관 치료·임상시험</label>
                    <input id="f-tx" value={fForm.therapy} onChange={(e) => setFForm({ ...fForm, therapy: e.target.value })} placeholder="예: Osimertinib" className={`${inp} w-full`} />
                  </div>
                  <div className="sm:col-span-3">
                    <label htmlFor="f-note" className="block t-micro mb-0.5">비고</label>
                    <input id="f-note" value={fForm.note} onChange={(e) => setFForm({ ...fForm, note: e.target.value })} className={`${inp} w-full`} />
                  </div>
                </div>
                <button onClick={addFinding} className={`${BTN.primary} mt-3`}>소견 등록</button>
              </section>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
