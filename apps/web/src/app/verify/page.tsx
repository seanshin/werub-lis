'use client';

/**
 * 검증 워크리스트 화면 (`/verify`).
 *
 * 사이드바 노출 역할: TEC, PHY, MIC, ADM, AUD.
 * ⚠ 노출 역할과 화면이 호출하는 API 권한이 어긋나면 전부 403인 죽은 화면이 된다 —
 *   역할을 바꿀 때는 `Sidebar.tsx`(정본)와 API 권한 매트릭스를 함께 본다.
 * 데이터는 `lib/api.ts`의 `apiFetch`로만 가져온다(HTTP 호출 정본).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, apiBlob, getToken, getUserId } from '@/lib/api';
import { EmptyState, ErrorText, Loading } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useConfirm } from '@/components/confirm';
import AttachmentPanel from '@/components/AttachmentPanel';
import { useBarcodeNormalize } from '@/lib/barcode';
import { maskName } from '@/lib/privacy';
import { Explain, StatusChip } from '@/components/Explain';
import { IconWarn } from '@/components/Icon';

interface WorklistRow {
  resultId: string;
  specimenNo: string;
  testCode: string;
  testName: string;
  value: string | null;
  unit: string | null;
  flag: string | null;
  holdReason: string | null;
  prevValue: string | null;
  pctDelta: number | null;
  patientId: string;
  patientName: string;
}

const flagColor: Record<string, string> = { HH: 'text-crit', LL: 'text-crit', H: 'text-warn', L: 'text-warn', N: 'text-good' };

interface ResultEvidence {
  result: { resultId: string; testCode: string; testName: string | null; value: string | null; unit: string | null; flag: string | null; verifyState: string | null; holdReason: string | null };
  refRange: { sex: string; ageMin: number; ageMax: number; low: number | null; high: number | null; panicLow: number | null; panicHigh: number | null } | null;
  refBasis: string | null;
  delta: { hasPrev: boolean; prev: number | null; absDelta: number | null; pctDelta: number | null; exceeded: boolean; prevReportedDt: string | null } | null;
  qcOk: boolean | null;
  hil: { hemolysis: string | null; icterus: string | null; lipemia: string | null } | null;
  hilInterference: { factors: string[]; message: string } | null;
  trend: { value: string | null; flag: string | null; reportedDt: string | null }[];
  holdExplanation: string | null;
  sources: string[]; promptContext: string; llmNote: string;
}
interface AttachMeta { attachmentId: string; filename: string; note?: string | null; uploadedBy?: string | null; sizeBytes?: number; mimeType?: string; }
interface SpcResult { resultId: string; testCode: string; value: string | null; unit: string | null; flag: string | null; verifyState: string; version: number; verifier: string | null; test: { name: string }; }
const VS_LABEL: Record<string, string> = { PENDING: '대기', VERIFIED: '검증', REPORTED: '보고', CORRECTED: '정정', HOLD: '보류' };

export default function VerifyPage() {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const { normalize } = useBarcodeNormalize();
  const [rows, setRows] = useState<WorklistRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [attView, setAttView] = useState<{ specimenNo: string; items: AttachMeta[] } | null>(null);
  const [ecFor, setEcFor] = useState<string | null>(null);
  const [ecRes, setEcRes] = useState<ResultEvidence | null>(null);
  async function loadEvidence(resultId: string) {
    if (ecFor === resultId) { setEcFor(null); setEcRes(null); return; }
    setEcFor(resultId); setEcRes(null);
    try { setEcRes(await apiFetch<ResultEvidence>(`/api/v1/results/${resultId}/evidence-context`)); }
    catch (e) { setErr(e instanceof Error ? e.message : '근거 종합 조회 실패'); setEcFor(null); }
  }

  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allSelected = rows.length > 0 && rows.every((r) => sel.has(r.resultId));
  const toggleAll = () => setSel(allSelected ? new Set() : new Set(rows.map((r) => r.resultId)));

  // 검증 전 원본 문서(수기·외부 결과지) 확인 — 검체 첨부 전체 목록 표시(다건 대응)
  async function viewAttachments(specimenNo: string) {
    try {
      const list = await apiFetch<AttachMeta[]>(`/api/v1/results/specimens/${encodeURIComponent(specimenNo)}/attachments`);
      if (list.length === 0) { toast('첨부된 문서가 없습니다', 'info'); return; }
      setAttView({ specimenNo, items: list });
    } catch (e) { toast(e instanceof Error ? e.message : '첨부 조회 실패', 'error'); }
  }
  // 개별 첨부 열기(새 창) — 팝업 차단 대비 사용자 클릭 컨텍스트에서 실행
  async function openAttachment(a: AttachMeta) {
    try {
      const blob = await apiBlob(`/api/v1/results/attachments/${a.attachmentId}/download`);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) { toast(e instanceof Error ? e.message : '첨부 열기 실패', 'error'); }
  }

  const load = useCallback(async () => {
    setErr('');
    setLoading(true);
    try {
      setRows(await apiFetch<WorklistRow[]>('/api/v1/results/worklist'));
    } catch (e) {
      setErr(e instanceof Error ? e.message : '조회 실패');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!getToken()) router.push('/');
    else load();
  }, [router, load]);

  const verifier = getUserId() ?? '';

  // ── 검체 결과 조회·정정(검증 완료분 포함) ──
  const [lookNo, setLookNo] = useState('');
  const [spcResults, setSpcResults] = useState<SpcResult[] | null>(null);
  const [correctId, setCorrectId] = useState('');
  const [cVal, setCVal] = useState('');
  const [cReason, setCReason] = useState('');

  async function loadSpcResults(no: string) {
    const s = normalize(no).value; // 바코드 정규화
    if (!s) { toast('검체번호를 입력하세요', 'info'); return; }
    setCorrectId('');
    try {
      const list = await apiFetch<SpcResult[]>(`/api/v1/results?specimenNo=${encodeURIComponent(s)}`);
      setSpcResults(list);
    } catch (e) { setSpcResults(null); toast(e instanceof Error ? e.message : '결과 조회 실패', 'error'); }
  }
  function startCorrect(r: SpcResult) { setCorrectId(r.resultId); setCVal(r.value ?? ''); setCReason(''); }
  async function doCorrect() {
    if (!correctId) return;
    if (!cReason.trim()) { toast('정정 사유를 입력하세요', 'info'); return; }
    try {
      await apiFetch(`/api/v1/results/${correctId}/correct`, { method: 'POST', body: JSON.stringify({ value: cVal, reason: cReason, verifier }) });
      toast('결과 정정됨(신규 버전·원본 보존)', 'success');
      setCorrectId(''); await loadSpcResults(lookNo);
    } catch (e) { toast(e instanceof Error ? e.message : '정정 실패', 'error'); }
  }

  async function verify(resultId: string) {
    // ★확정은 되돌릴 수 없고 HIS 발신·리플렉스를 촉발한다. 위험치 보류 건은 특히 개별 확인을 받는다.
    const row = rows.find((r) => r.resultId === resultId);
    if (row?.holdReason === 'CRITICAL') {
      const ok = await confirm({
        title: '위험치 결과 확정',
        message: '확정하면 되돌릴 수 없고 HIS 발신·리플렉스가 실행됩니다.',
        detail: [
          { label: '검체', value: row.specimenNo },
          { label: '환자', value: row.patientName ?? '-' },
          { label: '검사', value: `${row.testCode} = ${row.value ?? ''}` },
        ],
        danger: true,
        confirmLabel: '확정',
      });
      if (!ok) return;
    }
    setBusy(resultId);
    setErr('');
    try {
      const res = await apiFetch<{ reflexAdded?: string[] }>(`/api/v1/results/${resultId}/verify`, {
        method: 'POST',
        body: JSON.stringify({ verifier }),
      });
      setRows((r) => r.filter((x) => x.resultId !== resultId));
      setSel((s) => { const n = new Set(s); n.delete(resultId); return n; });
      const reflex = res.reflexAdded ?? [];
      toast(reflex.length ? `확정됨 · 리플렉스 자동오더 ${reflex.length}건(${reflex.join(', ')}) — 검체채취 확인` : '확정됨', reflex.length ? 'info' : 'success');
    } catch (e) {
      // 이미 확정 등 → 해당 행·선택 정리 후 안내(원문 배너 대신 토스트)
      setRows((r) => r.filter((x) => x.resultId !== resultId));
      setSel((s) => { const n = new Set(s); n.delete(resultId); return n; });
      toast(e instanceof Error ? e.message : '검증 실패', 'error');
    } finally {
      setBusy('');
    }
  }

  // A3: 선택 항목 일괄 확정(verify/batch) — 부분 실패 안내
  async function verifyBatch() {
    const ids = rows.filter((r) => sel.has(r.resultId)).map((r) => r.resultId);
    if (ids.length === 0) { toast('선택된 결과가 없습니다', 'info'); return; }
    // ★일괄 확정은 위험치 보류 건까지 한 번에 내보낸다. 무엇이 나가는지 보여주고 확인받는다.
    const criticals = rows.filter((r) => sel.has(r.resultId) && r.holdReason === 'CRITICAL');
    const ok = await confirm({
      title: `선택 ${ids.length}건 일괄 확정`,
      message: '확정하면 되돌릴 수 없고 HIS 발신·리플렉스가 실행됩니다.',
      detail: [
        { label: '대상', value: `${ids.length}건` },
        { label: '위험치 포함', value: criticals.length > 0 ? `${criticals.length}건 (${criticals.map((c) => c.specimenNo).slice(0, 3).join(', ')}${criticals.length > 3 ? ' 외' : ''})` : '없음' },
      ],
      danger: criticals.length > 0,
      confirmLabel: '일괄 확정',
    });
    if (!ok) return;
    setBusy('batch'); setErr('');
    try {
      const res = await apiFetch<{ verified: string[]; skipped: { resultId: string; reason: string }[]; count: number; reflexAdded?: string[] }>(
        '/api/v1/results/verify/batch',
        { method: 'POST', body: JSON.stringify({ resultIds: ids, verifier }) },
      );
      const reflex = res.reflexAdded ?? [];
      toast(`${res.count}건 확정${res.skipped.length ? ` · ${res.skipped.length}건 제외` : ''}${reflex.length ? ` · 리플렉스 ${reflex.length}건(${reflex.join(', ')})` : ''}`, res.skipped.length || reflex.length ? 'info' : 'success');
      setSel(new Set());
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '일괄 확정 실패');
    } finally { setBusy(''); }
  }

  return (
    <main className="page">
      <div className="flex items-center justify-between mb-4">
        <h1 className="t-page">검증 워크리스트</h1>
        <button onClick={load} className="text-sm text-teal underline">새로고침</button>
      </div>
      <ErrorText message={err} />

      <section className="card">
        <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
          <p className="text-xs text-ink-3">
            자동검증에서 보류된 결과(위험치·델타·QC·비수치)를 사유 우선순위로 표시합니다. 확정 시 HIS 발신·리플렉스가 실행됩니다.
          </p>
          {sel.size > 0 && (
            <button onClick={verifyBatch} disabled={busy === 'batch'}
              className="py-1.5 px-4 rounded-lg bg-teal text-white font-semibold text-sm disabled:opacity-50 shrink-0">
              {busy === 'batch' ? '확정중…' : `선택 ${sel.size}건 일괄 확정`}
            </button>
          )}
        </div>
        {/* 첨부 문서 목록(다건) — 수기·외부 결과지 대조 */}
        {attView && (
          <div className="mb-3 rounded-xl border border-teal/30 bg-teal/5 p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-bold">첨부 문서 · <span className="mono">{attView.specimenNo}</span> <span className="text-xs text-ink-2 font-normal">({attView.items.length}건)</span></span>
              <button onClick={() => setAttView(null)} className="text-xs text-ink-3 hover:text-ink">닫기 ✕</button>
            </div>
            <ul className="flex flex-col gap-1">
              {attView.items.map((a) => (
                <li key={a.attachmentId} className="flex items-center gap-2 text-xs">
                  <button onClick={() => openAttachment(a)} className="text-teal underline">{a.filename}</button>
                  {a.note && <span className="text-ink-3">— {a.note}</span>}
                  {typeof a.sizeBytes === 'number' && <span className="text-ink-3">({(a.sizeBytes / 1024).toFixed(0)}KB)</span>}
                  {a.uploadedBy && <span className="text-ink-3">· {a.uploadedBy}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {loading && rows.length === 0 ? (
          <Loading />
        ) : rows.length === 0 ? (
          <EmptyState title="검증 대기 결과가 없습니다" hint="자동검증에서 보류된 결과가 여기에 표시됩니다." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-ink-2 border-b border-line">
                  <th className="py-2 w-8"><input type="checkbox" aria-label="전체 선택" checked={allSelected} onChange={toggleAll} /></th>
                  <th className="py-2">사유</th><th>환자</th><th>검체</th><th>검사</th><th>결과</th><th>판정</th><th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.resultId} className={`border-b border-line last:border-0 ${sel.has(r.resultId) ? 'bg-teal/5' : ''}`}>
                    <td className="py-2"><input type="checkbox" aria-label={`${r.specimenNo} ${r.testName} 선택`} checked={sel.has(r.resultId)} onChange={() => toggle(r.resultId)} /></td>
                    <td className="py-2">
                      {/* 원시 코드(NO_RANGE 등) 대신 한글 라벨 + 뜻 팝오버(UX §2-3) */}
                      <StatusChip code={r.holdReason} tone={r.holdReason === 'CRITICAL' ? 'crit' : 'warn'} />
                    </td>
                    <td>{maskName(r.patientName)} <span className="mono text-xs text-ink-3">{r.patientId}</span></td>
                    <td className="mono text-xs">{r.specimenNo}</td>
                    <td><Explain kind="test" id={r.testCode} label={r.testName} /> <span className="mono text-xs text-ink-3">{r.testCode}</span></td>
                    <td className="mono font-semibold">
                      {r.value}{r.unit ? ` ${r.unit}` : ''}
                      {r.holdReason === 'DELTA' && r.prevValue != null && (
                        <span className="block text-xs text-indigo font-normal">이전 {r.prevValue}{r.pctDelta != null ? ` · Δ${r.pctDelta}%` : ''}</span>
                      )}
                    </td>
                    <td className={`font-bold ${flagColor[r.flag ?? ''] ?? ''}`}>{r.flag ?? '—'}</td>
                    <td className="text-right">
                      <div className="flex gap-1 justify-end items-center">
                        <button
                          onClick={() => viewAttachments(r.specimenNo)}
                          title="첨부 문서 보기"
                          aria-label={`${r.specimenNo} 첨부 문서 보기`}
                          className="py-1.5 px-2 rounded-lg border border-line text-ink-2 text-xs hover:border-teal"
                        >첨부</button>
                        <button
                          onClick={() => loadEvidence(r.resultId)}
                          title="근거 종합(참고치 근거·델타·QC·HIL 간섭·추세)"
                          aria-label={`${r.testName} 근거 종합`}
                          className={`py-1.5 px-2 rounded-lg border text-xs font-semibold ${ecFor === r.resultId ? 'bg-teal/10 border-teal/40 text-teal' : 'border-line text-ink-2 hover:border-teal hover:text-teal'}`}
                        >근거</button>
                        <button
                          onClick={() => verify(r.resultId)}
                          disabled={busy === r.resultId}
                          className="py-1.5 px-3 rounded-lg bg-teal text-white font-semibold text-xs disabled:opacity-50"
                        >
                          {busy === r.resultId ? '확정중…' : '2차검증 확정'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {rows.map((r) => ecFor === r.resultId ? (
                  <tr key={`${r.resultId}-ec`} className="border-b border-line">
                    <td colSpan={8} className="p-0">
                      <div className="m-2 p-2 rounded-lg border border-teal/30 bg-teal/[0.03]">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-[11px] font-bold text-teal">근거 종합 — {r.testName}</span>
                          <span className="text-[11px] text-ink-3">검증 판단용 · 향후 원내 LLM(RAG) 컨텍스트 · 외부 미전송</span>
                          <button onClick={() => { setEcFor(null); setEcRes(null); }} className="ml-auto text-[11px] text-ink-3 hover:text-ink-2">닫기</button>
                        </div>
                        {!ecRes ? <p className="text-[11px] text-ink-3">불러오는 중…</p> : (
                          <div className="flex flex-col gap-1 text-[11px]">
                            <div className="flex gap-1 flex-wrap">{ecRes.sources.length ? ecRes.sources.map((sx, i) => <span key={i} className="px-1.5 py-0.5 rounded bg-teal/10 text-teal text-[11px] font-semibold">{sx}</span>) : <span className="text-ink-3">등록된 근거 없음</span>}</div>
                            {ecRes.holdExplanation && <div className="text-warn font-semibold">보류 사유: {ecRes.holdExplanation}</div>}
                            {ecRes.refRange && (
                              <div className="text-ink-2">참고치 {ecRes.refRange.low ?? '-'} ~ {ecRes.refRange.high ?? '-'}{ecRes.result.unit ? ` ${ecRes.result.unit}` : ''}
                                {(ecRes.refRange.panicLow != null || ecRes.refRange.panicHigh != null) && <span className="text-crit"> · 패닉 {ecRes.refRange.panicLow ?? '-'}/{ecRes.refRange.panicHigh ?? '-'}</span>}
                                {ecRes.refBasis && <span className="text-ink-3"> · {ecRes.refBasis}</span>}
                              </div>
                            )}
                            {ecRes.delta?.hasPrev && <div className="text-ink-2">델타: 직전 {ecRes.delta.prev}{ecRes.delta.prevReportedDt ? ` (${ecRes.delta.prevReportedDt})` : ''} → 현재 {ecRes.result.value} · 변화 {ecRes.delta.absDelta}{ecRes.delta.pctDelta != null ? ` (${ecRes.delta.pctDelta}%)` : ''}{ecRes.delta.exceeded && <span className="text-warn font-semibold"> 한계초과</span>}</div>}
                            {ecRes.qcOk != null && <div className={ecRes.qcOk ? 'text-ink-2' : 'text-crit font-semibold'}>QC {ecRes.qcOk ? 'PASS' : 'FAIL(차단)'}</div>}
                            {ecRes.hilInterference && <div className="text-warn"><IconWarn className="mr-1" />HIL 간섭: {ecRes.hilInterference.message}</div>}
                            {ecRes.trend.length > 0 && <div className="text-ink-3">추세: {ecRes.trend.map((t) => `${t.reportedDt ?? '?'} ${t.value ?? ''}${t.flag && t.flag !== 'N' ? `[${t.flag}]` : ''}`).join(' / ')}</div>}
                            <details><summary className="text-ink-3 cursor-pointer text-[11px]">RAG 컨텍스트 미리보기(모델에 넘길 문맥)</summary>
                              <pre className="mono text-[11px] text-ink-2 whitespace-pre-wrap bg-bg rounded p-1.5 mt-1 max-h-48 overflow-auto">{ecRes.promptContext}</pre>
                            </details>
                            <div className="text-[11px] text-ink-3">{ecRes.llmNote}</div>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                ) : null)}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 검체 결과 조회·정정·첨부 (검증 완료분 정정 = 신규 버전·원본 보존) */}
      <section className="card mt-4">
        <h2 className="t-section mb-3">결과 조회·정정 <span className="text-xs text-ink-2 font-normal">검증 완료 결과 정정(원본 보존·버전 증가)·첨부 문서</span></h2>
        <div className="flex flex-wrap gap-2 items-end">
          <input aria-label="검체번호" value={lookNo} onChange={(e) => setLookNo(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); loadSpcResults(lookNo); } }}
            placeholder="검체번호 스캔·입력" className="mono px-3 py-2 rounded-lg border border-line bg-bg text-sm w-56" autoComplete="off" />
          <button onClick={() => loadSpcResults(lookNo)} className="py-2 px-4 rounded-lg bg-teal text-white font-semibold text-sm">조회</button>
        </div>

        {spcResults && (
          <div className="mt-4 border-t border-line pt-4">
            {spcResults.length === 0 ? (
              <p className="text-sm text-ink-3">해당 검체의 결과가 없습니다.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-ink-2 border-b border-line">
                      <th className="py-2">검사</th><th>결과</th><th>판정</th><th>버전</th><th>상태</th><th>검증자</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {spcResults.sort((a, b) => a.testCode.localeCompare(b.testCode) || b.version - a.version).map((r) => (
                      <tr key={r.resultId} className="border-b border-line last:border-0">
                        <td className="py-2">{r.test?.name} <span className="mono text-xs text-ink-3">{r.testCode}</span></td>
                        <td className="mono font-semibold">{r.value}{r.unit ? ` ${r.unit}` : ''}</td>
                        <td className={`font-bold ${flagColor[r.flag ?? ''] ?? ''}`}>{r.flag ?? '—'}</td>
                        <td className="mono text-xs">v{r.version}</td>
                        <td className="text-xs">{VS_LABEL[r.verifyState] ?? r.verifyState}</td>
                        <td className="text-xs text-ink-2">{r.verifier ?? '—'}</td>
                        <td className="text-right">
                          <button onClick={() => startCorrect(r)} className="py-1.5 px-3 rounded-lg border border-line text-xs hover:border-teal">정정</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* 정정 폼(인라인) */}
            {correctId && (
              <div className="mt-3 p-3 rounded-lg border border-teal/30 bg-teal/5 flex flex-wrap items-end gap-2">
                <div><label className="block text-xs text-ink-2 mb-1">정정 결과값</label>
                  <input aria-label="정정 결과값" value={cVal} onChange={(e) => setCVal(e.target.value)} className="mono px-2 py-1.5 rounded-lg border border-line bg-bg text-sm w-28" /></div>
                <div className="flex-1 min-w-40"><label className="block text-xs text-ink-2 mb-1">정정 사유(필수)</label>
                  <input aria-label="정정 사유" value={cReason} onChange={(e) => setCReason(e.target.value)} placeholder="예: 재측정 결과 반영" className="w-full px-2 py-1.5 rounded-lg border border-line bg-bg text-sm" /></div>
                <button onClick={doCorrect} className="py-1.5 px-3 rounded-lg bg-teal text-white text-sm font-semibold">정정 저장</button>
                <button onClick={() => setCorrectId('')} className="py-1.5 px-3 rounded-lg border border-line text-sm">취소</button>
              </div>
            )}

            {/* 첨부 문서(업로드·목록·다운로드) */}
            <div className="mt-4">
              <AttachmentPanel specimenNo={lookNo.trim()} />
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
