'use client';

/**
 * 미생물 · 단계보고 화면 (`/microbiology`).
 *
 * 사이드바 노출 역할: MIC, ADM.
 * ⚠ 노출 역할과 화면이 호출하는 API 권한이 어긋나면 전부 403인 죽은 화면이 된다 —
 *   역할을 바꿀 때는 `Sidebar.tsx`(정본)와 API 권한 매트릭스를 함께 본다.
 * 데이터는 `lib/api.ts`의 `apiFetch`로만 가져온다(HTTP 호출 정본).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, getToken, getUserId } from '@/lib/api';
import AttachmentPanel from '@/components/AttachmentPanel';
import { useToast } from '@/components/toast';
import { ErrorText } from '@/components/ui';
import {IconWarn, IconChevron } from '@/components/Icon';
import { maskName } from '@/lib/privacy';

interface Sus { antibiotic: string; mic: string; interpretation: string; }
interface SelAstItem { antibiotic: string; interpretation: string | null; report: boolean; suppressReason: string | null; }
interface SelAst { cultureId: string; isolates: { isolateId: string; organism: string; firstLineSusceptible: boolean; ast: SelAstItem[] }[]; }
interface CultureReport { reportId: string; stage: string; status: string; content: string; reportedDt: string; reporter?: string | null; }
interface Report { cultureId: string; stage: string | null; reportStatus: string | null; gramStain: string | null; organisms: string[]; reports: CultureReport[]; }
interface Mdro { mdro: string | null; isolation: boolean; reason: string | null; }
interface AstWarning { antibiotic: string; rule: string; message: string; }
interface Isolate { isolateId: string; organism: string | null; snomed: string | null; susceptibilities: { susId: string; antibiotic: string | null; mic: string | null; interpretation: string | null; method: string | null; standard: string | null }[]; mdro?: Mdro; astWarnings?: AstWarning[]; }
interface CultureDetail { cultureId: string; gramStain: string | null; medium: string | null; gramDt: string | null; rejectStatus: string | null; rejectReason: string | null; rejectedBy: string | null; rejectedDt: string | null; isolates: Isolate[]; }
interface MicroEvidence {
  isolate: { organism: string | null; specimenType: string | null; specimenNo: string | null };
  susceptibilities: { antibiotic: string | null; mic: string | null; interpretation: string | null; method: string | null; standard: string | null; breakpointNote?: string | null }[];
  warnings: { antibiotic: string; rule: string; message: string }[];
  mdro: { mdro: string | null; isolation: boolean };
  notifiable: { reportable: boolean; disease?: string | null; grade?: string | null };
  priorResistance: { organism: string | null; antibiotic: string | null; interpretation: string | null; specimenNo: string | null; reportedDate: string | null }[];
  sources: string[]; promptContext: string; llmNote: string;
}
interface RecordResult {
  mdro: Mdro; astWarnings: AstWarning[]; infectionAlert: unknown | null; reportStatus: string;
  criticalNotify?: { label: string | null; notifyTarget: string | null } | null;
  infectiousReport?: { disease: string | null; grade: string | null } | null;
}
interface AbgCell { antibiotic: string; n: number; pctS: number | null; }
interface Antibiogram { from: string | null; to: string | null; antibiotics: string[]; organisms: { organism: string; isolateCount: number; cells: AbgCell[] }[]; }

const interpColor: Record<string, string> = { R: 'text-crit', I: 'text-warn', S: 'text-good' };
const statusBadge: Record<string, string> = { PRELIMINARY: 'bg-indigo/15 text-indigo', FINAL: 'bg-good/15 text-good', AMENDED: 'bg-warn/15 text-warn' };

export default function MicrobiologyPage() {
  const router = useRouter();
  const toast = useToast();
  const [selAst, setSelAst] = useState<SelAst | null>(null);
  const [cultureId, setCultureId] = useState('');
  const [newCul, setNewCul] = useState({ specimenNo: '', medium: '' });
  const [organism, setOrganism] = useState(''); // 데모 기본값 제거 — 확인 없이 특정 균종으로 최종보고됐다
  const [gram, setGram] = useState('Gram-negative rods');
  const [ast, setAst] = useState<Sus[]>([{ antibiotic: '', mic: '', interpretation: '' }]);
  const [report, setReport] = useState<Report | null>(null);
  const [detail, setDetail] = useState<CultureDetail | null>(null);
  const [err, setErr] = useState('');
  const [recResult, setRecResult] = useState<RecordResult | null>(null);
  const [abg, setAbg] = useState<Antibiogram | null>(null);
  const [abgOpen, setAbgOpen] = useState(false);
  const [ecFor, setEcFor] = useState<string | null>(null);
  const [ecRes, setEcRes] = useState<MicroEvidence | null>(null);
  const [abgRange, setAbgRange] = useState({ from: '', to: '' });
  async function loadMicroEvidence(isolateId: string) {
    if (ecFor === isolateId) { setEcFor(null); setEcRes(null); return; }
    setEcFor(isolateId); setEcRes(null);
    try { setEcRes(await apiFetch<MicroEvidence>(`/api/v1/microbiology/isolates/${isolateId}/evidence-context`)); }
    catch (e) { setErr(e instanceof Error ? e.message : '근거 종합 조회 실패'); setEcFor(null); }
  }

  const [cultures, setCultures] = useState<{ cultureId: string; specimenNo: string; patientName: string; stage: string; reportStatus: string | null; organisms?: string[] }[]>([]);
  const [scope, setScope] = useState<'pending' | 'completed' | 'all'>('pending');

  const loadReport = useCallback(async (id: string) => {
    try {
      const [rep, det] = await Promise.all([
        apiFetch<Report>(`/api/v1/microbiology/cultures/${id}/report`),
        apiFetch<CultureDetail>(`/api/v1/microbiology/cultures/${id}`).catch(() => null),
      ]);
      setReport(rep); setDetail(det);
    } catch { /* 배양 없으면 무시 */ }
  }, []);
  const loadCultures = useCallback(async (sc: 'pending' | 'completed' | 'all' = scope) => { try { setCultures(await apiFetch(`/api/v1/microbiology/cultures?scope=${sc}`)); } catch (e) { setErr(e instanceof Error ? e.message : '배양 목록 조회 실패'); } }, [scope]);
  const registerCulture = async () => {
    setErr('');
    if (!newCul.specimenNo.trim()) { setErr('검체번호를 입력하세요'); return; }
    try {
      const c = await apiFetch<{ cultureId: string }>('/api/v1/microbiology/cultures', { method: 'POST', body: JSON.stringify({ specimenNo: newCul.specimenNo.trim(), medium: newCul.medium.trim() || undefined }) });
      toast(`배양 등록됨 · ${c.cultureId}`, 'success');
      setCultureId(c.cultureId); setNewCul({ specimenNo: '', medium: '' });
      await loadCultures();
    } catch (e) { setErr(e instanceof Error ? e.message : '배양 등록 실패'); }
  };

  async function loadAntibiogram() {
    const qs = new URLSearchParams();
    if (abgRange.from) qs.set('from', abgRange.from);
    if (abgRange.to) qs.set('to', abgRange.to);
    try { setAbg(await apiFetch<Antibiogram>(`/api/v1/microbiology/antibiogram${qs.toString() ? `?${qs}` : ''}`)); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Antibiogram 조회 실패'); }
  }
  async function toggleAntibiogram() {
    if (abgOpen) { setAbgOpen(false); return; }
    setAbgOpen(true);
    if (!abg) await loadAntibiogram();
  }

  useEffect(() => { if (!getToken()) { router.push('/'); return; } loadCultures(); }, [router, loadCultures]);

  async function recordGram() {
    setErr('');
    try {
      await apiFetch('/api/v1/microbiology/gram', { method: 'POST', body: JSON.stringify({ cultureId, gramStain: gram, reporter: getUserId() ?? undefined }) });
      loadReport(cultureId);
    } catch (e) { setErr(e instanceof Error ? e.message : '그람 기록 실패'); }
  }

  // 흔한 균종 SNOMED(없으면 미지정)
  const SNOMED: Record<string, string> = {
    'Escherichia coli': '112283007', 'Klebsiella pneumoniae': '56415008', 'Staphylococcus aureus': '3092008',
    'Pseudomonas aeruginosa': '52499004', 'Enterococcus faecalis': '78065002',
  };

  async function recordFinal() {
    setErr('');
    if (!cultureId.trim()) { setErr('배양ID를 선택/입력하세요'); return; }
    // 항생제만 있으면 채택 — 디스크확산(MIC 없이 S/I/R)도 보존한다(예전엔 MIC 없는 행을 무음 누락).
    // MIC만 있고 해석 공란이면 서버가 브레이크포인트로 도출(interpretMic). 둘 다 없으면 제외.
    const sus = ast.filter((a) => a.antibiotic.trim() && (a.mic.trim() || a.interpretation.trim()));
    try {
      const r = await apiFetch<RecordResult>('/api/v1/microbiology/isolates', {
        method: 'POST',
        body: JSON.stringify({ cultureId, organism, snomed: SNOMED[organism] || undefined, susceptibilities: sus, reporter: getUserId() ?? undefined }),
      });
      setRecResult(r); // MDRO·AST 경고·감염관리 알림 결과 표시
      // C8 다균종: 다음 균주 입력을 위해 폼 초기화(배양은 유지)
      setOrganism(''); setAst([{ antibiotic: '', mic: '', interpretation: '' }]);
      loadReport(cultureId);
    } catch (e) { setErr(e instanceof Error ? e.message : '등록 실패'); }
  }

  // C8 무증식(음성) 최종 — 전용 엔드포인트(그람 선행/가짜 균주 없이 배양 종결)
  async function recordNoGrowth() {
    setErr('');
    if (!cultureId.trim()) { setErr('배양ID를 선택/입력하세요'); return; }
    try {
      await apiFetch('/api/v1/microbiology/no-growth', {
        method: 'POST',
        body: JSON.stringify({ cultureId, reporter: getUserId() ?? undefined }),
      });
      setRecResult(null);
      loadReport(cultureId);
    } catch (e) { setErr(e instanceof Error ? e.message : '등록 실패'); }
  }

  // M1 검체 부적합·반려 — 동정 전만
  async function rejectCulture() {
    if (!cultureId.trim()) { setErr('배양ID를 선택/입력하세요'); return; }
    const reason = window.prompt(`검체 반려 사유(오염·부적절 채취·이송지연 등) — ${cultureId}`, '');
    if (!reason?.trim()) return;
    try {
      await apiFetch(`/api/v1/microbiology/cultures/${encodeURIComponent(cultureId)}/reject`, { method: 'POST', body: JSON.stringify({ reason: reason.trim(), rejectedBy: getUserId() ?? undefined }) });
      toast(`검체 반려됨 · ${cultureId}`, 'success'); setDetail(null); setCultureId(''); await loadCultures();
    } catch (e) { toast(e instanceof Error ? e.message : '반려 실패', 'error'); }
  }

  // M2 선택적/cascade AST 보고 — 분리주별 보고 여부
  async function loadSelectiveAst() {
    if (!cultureId.trim()) return;
    try { setSelAst(await apiFetch(`/api/v1/microbiology/cultures/${encodeURIComponent(cultureId)}/selective-ast`)); }
    catch (e) { toast(e instanceof Error ? e.message : '선택적 보고 조회 실패', 'error'); }
  }

  const inp = 'px-3 py-2 rounded-lg border border-line bg-bg text-sm';

  return (
    <main className="page">
      <h1 className="t-page mb-4">미생물 · 단계보고</h1>
      {err && <ErrorText message={err} />}

      <section className="card mb-4">
        <div className="flex items-center gap-2 mb-4">
          <label className="text-xs text-ink-2">배양ID</label>
          <input aria-label="배양ID" className={`${inp} mono w-32`} value={cultureId} onChange={(e) => setCultureId(e.target.value)} />
          <button onClick={() => loadReport(cultureId)} className="text-sm text-teal underline ml-2">이력 조회</button>
        </div>

        {/* M1 배양 등록 — 접수 검체를 배지에 접종해 워크리스트에 올리는 진입점(수기 정본) */}
        <div className="flex items-end gap-2 mb-4 p-3 rounded-lg bg-bg border border-line flex-wrap">
          <div>
            <label className="text-xs text-ink-2 block mb-0.5">검체번호</label>
            <input aria-label="배양 등록 검체번호" className={`${inp} mono w-36`} value={newCul.specimenNo} onChange={(e) => setNewCul({ ...newCul, specimenNo: e.target.value })} placeholder="검체번호" />
          </div>
          <div>
            <label className="text-xs text-ink-2 block mb-0.5">배지·검체원(선택)</label>
            <input aria-label="배지" className={`${inp} w-36`} value={newCul.medium} onChange={(e) => setNewCul({ ...newCul, medium: e.target.value })} placeholder="Blood agar·혈액" />
          </div>
          <button onClick={registerCulture} className="py-1.5 px-3 rounded-lg bg-teal text-white font-semibold text-sm">배양 등록</button>
        </div>

        {/* C5 미생물 배양 목록 — 대기(기본)/완료/전체. 완료 배양은 목록에서 사라지던 것 보완 */}
        <div className="mb-2">
          <div className="flex items-center gap-2 mb-1">
            <div className="text-xs text-ink-2">배양 목록 ({cultures.length})</div>
            <div className="flex gap-1 ml-auto">
              {(['pending', 'completed', 'all'] as const).map((sc) => (
                <button key={sc} onClick={() => { setScope(sc); void loadCultures(sc); }}
                  className={`text-[11px] px-2 py-0.5 rounded-lg border ${scope === sc ? 'bg-teal text-white border-teal' : 'border-line text-ink-2 hover:border-teal'}`}>
                  {sc === 'pending' ? '판독대기' : sc === 'completed' ? '완료' : '전체'}
                </button>
              ))}
            </div>
          </div>
          {cultures.length === 0 ? (
            <p className="text-xs text-ink-3 py-2">{scope === 'completed' ? '완료된 배양이 없습니다.' : scope === 'pending' ? '판독 대기 배양이 없습니다.' : '배양이 없습니다.'}</p>
          ) : (
            <div className="overflow-x-auto max-h-80 overflow-y-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left t-micro text-ink-2 border-b border-line sticky top-0 bg-surface">
                  <th className="py-1.5 pr-3">배양ID</th><th className="pr-3">검체번호</th><th className="pr-3">환자</th><th className="pr-3">단계</th><th className="pr-3">보고</th><th className="pr-3">균명</th>
                </tr></thead>
                <tbody>
                  {cultures.map((c) => (
                    <tr key={c.cultureId} onClick={() => { setCultureId(c.cultureId); loadReport(c.cultureId); }}
                      className={`border-b border-line last:border-0 cursor-pointer ${cultureId === c.cultureId ? 'bg-teal/10' : 'hover:bg-bg'}`}>
                      <td className="py-1.5 pr-3 mono font-medium">{c.cultureId}</td>
                      <td className="pr-3 mono text-ink-2">{c.specimenNo}</td>
                      <td className="pr-3">{maskName(c.patientName)}</td>
                      <td className="pr-3 text-ink-3">{c.stage ?? '—'}</td>
                      <td className="pr-3">
                        <span className={`px-1.5 py-0.5 r-chip t-micro ${(c.reportStatus === 'FINAL' || c.reportStatus === 'AMENDED') ? 'bg-good/15 text-good' : c.reportStatus === 'PRELIMINARY' ? 'bg-indigo/15 text-indigo' : 'bg-bg text-ink-3'}`}>
                          {c.reportStatus ?? '진행'}
                        </span>
                      </td>
                      <td className="pr-3 italic">{c.organisms && c.organisms.length > 0 ? c.organisms.join(', ') : <span className="text-ink-3 not-italic">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="grid md:grid-cols-2 gap-4">
          {/* 1단계: 그람 예비 */}
          <div className="border border-line rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2"><span className="w-5 h-5 rounded-full bg-indigo text-white text-xs flex items-center justify-center font-bold">1</span><b className="text-sm">그람 염색 (예비보고)</b></div>
            <input aria-label="그람 소견" className={`${inp} w-full mb-2`} value={gram} onChange={(e) => setGram(e.target.value)} placeholder="그람 소견" />
            <button onClick={recordGram} className="w-full py-2 rounded-lg bg-indigo text-white font-semibold text-sm">예비보고 등록</button>
          </div>
          {/* 2단계: 동정/감수성 최종 */}
          <div className="border border-line rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2"><span className="w-5 h-5 rounded-full bg-teal text-white text-xs flex items-center justify-center font-bold">2</span><b className="text-sm">동정·감수성 (최종보고)</b></div>
            <input aria-label="균명" className={`${inp} w-full mb-2`} value={organism} onChange={(e) => setOrganism(e.target.value)} placeholder="균명" />
            {/* 감수성(AST) 입력 그리드 */}
            <div className="space-y-1 mb-2">
              <div className="flex gap-1 text-xs text-ink-2"><span className="flex-1">항생제</span><span className="w-16">MIC</span><span className="w-14">판정</span><span className="w-6" /></div>
              {ast.map((a, i) => (
                <div key={i} className="flex gap-1 items-center">
                  <input aria-label="항생제" value={a.antibiotic} onChange={(e) => setAst(ast.map((x, j) => j === i ? { ...x, antibiotic: e.target.value } : x))} placeholder="Ampicillin" className={`${inp} flex-1`} />
                  <input aria-label="MIC" value={a.mic} onChange={(e) => setAst(ast.map((x, j) => j === i ? { ...x, mic: e.target.value } : x))} placeholder=">32" className={`${inp} mono w-16`} />
                  <select aria-label="감수성 해석" value={a.interpretation} onChange={(e) => setAst(ast.map((x, j) => j === i ? { ...x, interpretation: e.target.value } : x))} className={`${inp} w-20 ${interpColor[a.interpretation] ?? ''}`}><option value="">자동(MIC)</option><option>S</option><option>I</option><option>R</option></select>
                  <button onClick={() => setAst(ast.filter((_, j) => j !== i))} aria-label="항생제 행 삭제" className="w-6 text-ink-3 text-sm">✕</button>
                </div>
              ))}
              <button onClick={() => setAst([...ast, { antibiotic: '', mic: '', interpretation: '' }])} className="text-xs text-teal">+ 항생제 추가</button>
            </div>
            <div className="flex gap-2 flex-wrap">
              <button onClick={recordFinal} className="flex-1 py-2 rounded-lg bg-teal text-white font-semibold text-sm">균주 등록(다균종 반복)</button>
              <button onClick={recordNoGrowth} className="py-2 px-3 rounded-lg border border-line text-sm font-semibold">무증식 최종</button>
              <button onClick={rejectCulture} title="오염·부적절 채취·이송지연 — 동정 전만" className="py-2 px-3 rounded-lg border border-line text-crit text-sm font-semibold">검체 반려</button>
            </div>
            <p className="text-xs text-ink-3 mt-2">여러 균주는 반복 등록. R(내성) 포함 시 감염관리팀 자동 알림. 부적합 검체는 동정 전 반려.</p>
          </div>
        </div>

        {/* 등록 결과 피드백 — MDRO 분류·격리·AST expert-rule 경고·감염관리 알림 */}
        {recResult && (
          <div className="mt-4 rounded-xl border border-line p-3 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-ink-2">등록 결과:</span>
              {recResult.mdro.mdro
                ? <span className="px-2 py-0.5 rounded bg-crit/15 text-crit text-xs font-bold"><IconWarn className="mr-1" />{recResult.mdro.mdro}{recResult.mdro.isolation ? ' · 격리 필요' : ''}</span>
                : <span className="px-2 py-0.5 rounded bg-good/15 text-good text-xs font-bold">MDRO 없음</span>}
              {!!recResult.infectionAlert && <span className="px-2 py-0.5 rounded bg-warn/15 text-warn text-xs font-bold">감염관리팀 알림 발송</span>}
              {recResult.criticalNotify && <span className="px-2 py-0.5 rounded bg-crit/15 text-crit text-xs font-bold" title="혈액배양 양성 — 담당의 확인응답·재발송 대상(폐루프)">🩸 {recResult.criticalNotify.label ?? '혈액배양 양성'} · {recResult.criticalNotify.notifyTarget ?? '담당의'} 폐루프 통보</span>}
              {recResult.infectiousReport && <span className="px-2 py-0.5 rounded bg-crit/15 text-crit text-xs font-bold" title="법정감염병 신고 대상 — 신고 화면에서 처리 상태 확인">📋 법정감염병 신고: {recResult.infectiousReport.disease}{recResult.infectiousReport.grade ? ` (${recResult.infectiousReport.grade})` : ''}</span>}
              <span className="text-xs text-ink-3">{recResult.reportStatus === 'AMENDED' ? '개정보고' : '최종보고'}</span>
            </div>
            {recResult.mdro.reason && <p className="text-xs text-ink-2">{recResult.mdro.reason}</p>}
            {recResult.astWarnings.length > 0 && (
              <div className="rounded-lg bg-crit/5 border border-crit/20 p-2">
                <p className="text-xs font-bold text-crit mb-1">AST expert-rule 경고 {recResult.astWarnings.length}건 — 입력 재확인</p>
                <ul className="text-xs text-ink-2 space-y-0.5">
                  {recResult.astWarnings.map((w, i) => <li key={i}>· <b>{w.antibiotic}</b>: {w.message}</li>)}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>

      {/* 반려 배양 — listCultures가 반려건을 걸러내(정상 워크리스트 유지) 배양번호로 직접 조회했을 때만 보인다.
          반려 사유·처리자를 표기(감사·재검체 판단). */}
      {detail && detail.rejectStatus === 'REJECTED' && (
        <section className="card mb-4 border-crit/30 bg-crit/[0.03]">
          <div className="flex items-center gap-2 flex-wrap text-sm">
            <span className="px-2 py-0.5 rounded bg-crit/15 text-crit font-bold">반려된 배양</span>
            <span className="text-ink-2">{detail.rejectReason ?? '사유 미기재'}</span>
            <span className="text-xs text-ink-3">{detail.rejectedBy ? `처리 ${detail.rejectedBy}` : ''}{detail.rejectedDt ? ` · ${detail.rejectedDt.slice(0, 16).replace('T', ' ')}` : ''}</span>
          </div>
        </section>
      )}

      {detail && detail.isolates.length > 0 && (
        <section className="card mb-4">
          <div className="flex items-center gap-3 mb-3 flex-wrap">
            <h2 className="t-section">동정 균주 · 감수성</h2>
            <span className="text-xs text-ink-2">{detail.isolates.length}균주{detail.gramStain ? ` · 그람: ${detail.gramStain}` : ''}{detail.medium ? ` · 배지: ${detail.medium}` : ''}{detail.gramDt ? ` · 그람 ${detail.gramDt.slice(0, 10)}` : ''}</span>
            <button onClick={() => { if (selAst) setSelAst(null); else loadSelectiveAst(); }} className="ml-auto text-xs px-2 py-1 rounded-lg border border-line text-teal">{selAst ? '선택적 보고 닫기' : '선택적 보고(cascade)'}</button>
          </div>
          {selAst && (
            <div className="mb-3 border border-teal/30 rounded-xl p-3 bg-teal/5">
              <p className="text-xs text-ink-2 mb-2">선택적/cascade 보고 — 1차약 감수성 시 reserve(광범위) 약제는 <b>억제</b>(보고 보류). 스타터 규칙(검사실·감염내과 확정).</p>
              {selAst.isolates.map((iso) => (
                <div key={iso.isolateId} className="mb-2">
                  <div className="text-xs font-bold mb-1">{iso.organism} {iso.firstLineSusceptible && <span className="text-teal font-normal">· 1차약 감수성</span>}</div>
                  <div className="flex flex-wrap gap-1">
                    {iso.ast.map((a) => (
                      <span key={a.antibiotic} title={a.suppressReason ?? ''} className={`px-1.5 py-0.5 rounded text-[11px] ${a.report ? 'bg-bg border border-line' : 'bg-ink-3/10 text-ink-3 line-through'}`}>{a.antibiotic} {a.interpretation ?? ''}{!a.report && ' ⊘'}</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="grid md:grid-cols-2 gap-3">
            {detail.isolates.map((iso) => (
              <div key={iso.isolateId} className="border border-line rounded-xl p-3">
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  <b className="text-sm">{iso.organism ?? '미상'}</b>
                  {iso.snomed && <span className="mono text-[11px] text-ink-3 px-1.5 py-0.5 rounded bg-bg border border-line">SNOMED {iso.snomed}</span>}
                  {iso.mdro?.mdro && <span className="px-1.5 py-0.5 rounded bg-crit/15 text-crit text-[11px] font-bold">{iso.mdro.mdro}</span>}
                  {iso.mdro?.isolation && <span className="px-1.5 py-0.5 rounded bg-crit text-white text-[11px] font-bold">격리</span>}
                  {iso.astWarnings && iso.astWarnings.length > 0 && <span className="px-1.5 py-0.5 rounded bg-warn/15 text-warn text-[11px] font-bold" title={iso.astWarnings.map((w) => `${w.antibiotic}: ${w.message}`).join('\n')}>AST경고 {iso.astWarnings.length}</span>}
                  <button onClick={() => loadMicroEvidence(iso.isolateId)} title="근거 종합(브레이크포인트·expert-rule·MDRO·법정감염병·과거 내성)" className={`ml-auto py-0.5 px-2 rounded border text-[11px] font-semibold ${ecFor === iso.isolateId ? 'bg-teal/10 border-teal/40 text-teal' : 'border-line hover:border-teal hover:text-teal'}`}>근거 종합</button>
                </div>
                {iso.susceptibilities.length === 0 ? (
                  <p className="text-xs text-ink-3">감수성 결과 없음</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead><tr className="text-left text-xs text-ink-2 border-b border-line"><th className="py-1">항생제</th><th className="w-16">MIC</th><th className="w-16">검사법</th><th className="w-12">판정</th></tr></thead>
                    <tbody>
                      {iso.susceptibilities.map((s) => (
                        <tr key={s.susId} className="border-b border-line last:border-0">
                          <td className="py-1">{s.antibiotic ?? '-'}</td>
                          <td className="mono text-xs">{s.mic ?? '-'}</td>
                          <td className="text-[11px] text-ink-3">{s.method ?? '-'}</td>
                          <td className={`font-bold ${interpColor[s.interpretation ?? ''] ?? ''}`}>{s.interpretation ?? '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {(() => { const std = iso.susceptibilities.find((s) => s.standard)?.standard; return std ? <p className="text-[11px] text-ink-3 mt-1">브레이크포인트 기준: {std}</p> : null; })()}
                {ecFor === iso.isolateId && (
                  <div className="mt-2 p-2 rounded-lg border border-teal/30 bg-teal/[0.03]">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[11px] font-bold text-teal">근거 종합</span>
                      <span className="text-[11px] text-ink-3">판독 검토용 · 향후 원내 LLM(RAG) 컨텍스트 · 외부 미전송</span>
                      <button onClick={() => { setEcFor(null); setEcRes(null); }} className="ml-auto text-[11px] text-ink-3 hover:text-ink-2">닫기</button>
                    </div>
                    {!ecRes ? <p className="text-[11px] text-ink-3">불러오는 중…</p> : (
                      <div className="flex flex-col gap-1 text-[11px]">
                        <div className="flex gap-1 flex-wrap">{ecRes.sources.length ? ecRes.sources.map((sx, i) => <span key={i} className="px-1.5 py-0.5 rounded bg-teal/10 text-teal text-[11px] font-semibold">{sx}</span>) : <span className="text-ink-3">등록된 근거 없음</span>}</div>
                        {ecRes.notifiable.reportable && <div className="text-crit font-semibold">법정감염병: {ecRes.notifiable.disease}{ecRes.notifiable.grade ? ` (${ecRes.notifiable.grade})` : ''}</div>}
                        {ecRes.warnings.length > 0 && (
                          <div className="text-warn">expert-rule {ecRes.warnings.length}: {ecRes.warnings.slice(0, 3).map((w) => `${w.antibiotic}(${w.rule})`).join(', ')}</div>
                        )}
                        {ecRes.priorResistance.length > 0 && (
                          <div className="text-ink-2">과거 내성 {ecRes.priorResistance.length}: {ecRes.priorResistance.slice(0, 4).map((pr) => `${pr.reportedDate ?? '?'} ${pr.antibiotic} R`).join(' / ')}</div>
                        )}
                        <details><summary className="text-ink-3 cursor-pointer text-[11px]">RAG 컨텍스트 미리보기(모델에 넘길 문맥)</summary>
                          <pre className="mono text-[11px] text-ink-2 whitespace-pre-wrap bg-bg rounded p-1.5 mt-1 max-h-48 overflow-auto">{ecRes.promptContext}</pre>
                        </details>
                        <div className="text-[11px] text-ink-3">{ecRes.llmNote}</div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          <p className="text-xs text-ink-3 mt-2">S 감수성 · I 중간 · <span className="text-crit font-bold">R 내성</span>(감염관리팀 알림 대상).</p>
        </section>
      )}

      {/* Antibiogram — 균종×항생제 %S 누적(경험적 항생제 선택 근거) */}
      <section className="card mb-4">
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={toggleAntibiogram} aria-expanded={abgOpen} className="font-bold text-teal text-sm"><IconChevron open={abgOpen} /> Antibiogram (%S 누적)</button>
          {abgOpen && (
            <div className="flex items-center gap-1.5 ml-auto">
              <input type="date" aria-label="시작" value={abgRange.from} onChange={(e) => setAbgRange({ ...abgRange, from: e.target.value })} className="px-2 py-1 rounded-lg border border-line bg-bg text-xs" />
              <input type="date" aria-label="종료" value={abgRange.to} onChange={(e) => setAbgRange({ ...abgRange, to: e.target.value })} className="px-2 py-1 rounded-lg border border-line bg-bg text-xs" />
              <button onClick={loadAntibiogram} className="py-1 px-2 rounded-lg bg-teal text-white text-xs font-semibold">적용</button>
            </div>
          )}
        </div>
        {abgOpen && (abg && abg.organisms.length > 0 ? (
          <div className="mt-3 overflow-x-auto">
            <table className="text-xs border-collapse">
              <thead>
                <tr className="text-ink-2">
                  <th className="text-left py-1 pr-2 sticky left-0 bg-surface">균종 (n)</th>
                  {abg.antibiotics.map((a) => <th key={a} className="px-1.5 py-1 whitespace-nowrap font-medium" style={{ writingMode: 'vertical-rl' }}>{a}</th>)}
                </tr>
              </thead>
              <tbody>
                {abg.organisms.map((o) => (
                  <tr key={o.organism} className="border-t border-line">
                    <td className="py-1 pr-2 sticky left-0 bg-surface whitespace-nowrap"><span className="font-medium">{o.organism}</span> <span className="text-ink-3">({o.isolateCount})</span></td>
                    {o.cells.map((c) => {
                      if (c.pctS == null) return <td key={c.antibiotic} className="px-1.5 py-1 text-center text-ink-3">·</td>;
                      const cls = c.pctS >= 90 ? 'text-good' : c.pctS >= 70 ? 'text-warn' : 'text-crit font-bold';
                      return <td key={c.antibiotic} className={`px-1.5 py-1 text-center mono ${cls}`} title={`n=${c.n}${c.n < 30 ? ' (n<30 참고)' : ''}`}>{c.pctS}{c.n < 30 ? '*' : ''}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-xs text-ink-3 mt-1">%감수성(S). <span className="text-good">≥90</span> · <span className="text-warn">70–89</span> · <span className="text-crit font-bold">&lt;70</span>. <b>*</b> n&lt;30(CLSI 신뢰 낮음).</p>
          </div>
        ) : abg ? <p className="text-xs text-ink-3 mt-2">집계할 감수성 데이터 없음</p> : <p className="text-xs text-ink-3 mt-2">불러오는 중…</p>)}
      </section>

      {report && (
        <section className="card print-area">
          <div className="flex items-center gap-3 mb-3">
            <h2 className="t-section">단계보고 이력 <span className="mono text-xs text-ink-2">{report.cultureId}</span></h2>
            {report.reportStatus && <span className={`px-2 py-0.5 rounded text-xs font-bold ${statusBadge[report.reportStatus] ?? ''}`}>{report.reportStatus}</span>}
            <span className="text-xs text-ink-2">단계 {report.stage ?? '접종'}</span>
            <button onClick={() => window.print()} className="no-print ml-auto text-xs bg-indigo text-white px-3 py-1 rounded-lg font-semibold">인쇄</button>
          </div>
          {report.reports.length === 0 ? (
            <p className="text-sm text-ink-2 py-4 text-center">보고 이력 없음</p>
          ) : (
            <ol className="relative border-l-2 border-line ml-2">
              {report.reports.map((r) => (
                <li key={r.reportId} className="ml-4 pb-4 last:pb-0">
                  <span className="absolute -left-[7px] w-3 h-3 rounded-full bg-teal" />
                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-0.5 rounded text-xs font-bold ${statusBadge[r.status] ?? 'bg-bg text-ink-2'}`}>{r.status}</span>
                    <span className="mono text-xs text-ink-3">{r.reportedDt.slice(0, 19).replace('T', ' ')}</span>
                    {r.reporter && <span className="text-xs text-ink-3">· 보고자 {r.reporter}</span>}
                  </div>
                  <p className="text-sm mt-1">{r.content}</p>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}

      {/* 외부 수탁 배양·동정 결과지(PDF) 등 문서 첨부 — 검체 단위 */}
      {report && (() => {
        const sp = cultures.find((c) => c.cultureId === report.cultureId)?.specimenNo;
        return sp ? <AttachmentPanel specimenNo={sp} /> : null;
      })()}
    </main>
  );
}
