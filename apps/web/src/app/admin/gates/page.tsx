'use client';

/**
 * 개시 서명·결재 화면 (`/admin/gates`).
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
import Link from 'next/link';
import { apiFetch, getToken, getUserId, getRoles } from '@/lib/api';
import { useToast } from '@/components/toast';
import { useConfirm } from '@/components/confirm';
import { EmptyState, ErrorText, Loading } from '@/components/ui';
import { GATE_DOCS_MAP } from '@/lib/gate-docs';
import SignoffWorksheet from '@/components/SignoffWorksheet';
import { GATE_STATUS_LABEL } from '@lis/shared';
import { IconCheck } from '@/components/Icon';

interface Gate {
  gateCode: string; title: string; owner: string | null; scope: string | null;
  status: string; docNo: string | null; approvedDate: string | null; approver: string | null; approverUserId: string | null;
  recordedBy: string | null; source: string | null;
  reviewIntervalDays: number | null; nextReviewDate: string | null; needsReview: boolean; reviewReason: string | null;
  reviewFlags: string[]; reviewStatus: string; note: string | null;
}
interface Hist { historyId: string; action: string; actor: string | null; docNo: string | null; approvedDate: string | null; reason: string | null; createdDt: string; }

const statusCls: Record<string, string> = { APPROVED: 'bg-good/15 text-good', PENDING: 'bg-warn/15 text-warn', SUBMITTED: 'bg-indigo/15 text-indigo', IN_PROGRESS: 'bg-indigo/15 text-indigo', REJECTED: 'bg-warn/15 text-warn' };
const statusLabel = GATE_STATUS_LABEL; // 정본은 @lis/shared(과거 화면마다 '승인됨'/'승인'으로 갈렸다)
const actionLabel: Record<string, string> = { APPROVED: '승인', RE_APPROVED: '재승인', SUBMITTED: '상신', RESUBMITTED: '재상신', IN_PROGRESS: '진행중', REJECTED: '반려', FLAGGED_STALE: '재검토 플래그' };
// 데모 계정(공유 시드 계정)이 기입한 결재는 실결재가 아님 — recordedBy(서버 결속)로 판정.
const DEMO_ACCOUNTS = ['U00', 'U01', 'U02', 'U03', 'U04', 'U05', 'U06', 'U07', 'U08'];
const isDemoApproved = (g: Gate) => g.status === 'APPROVED' && !!g.recordedBy && DEMO_ACCOUNTS.includes(g.recordedBy);
const isPlaceholder = (g: Gate) => (g.status === 'PENDING' && (!g.approver || g.approver === '(미결재)')) || isDemoApproved(g);

export default function OrgGatesPage() {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const uid = getUserId() ?? '';
  const [list, setList] = useState<Gate[] | null>(null);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({ docNo: '', approvedDate: new Date().toISOString().slice(0, 10), approver: '', approverUserId: '', reviewIntervalDays: '365', note: '' });
  const [histOf, setHistOf] = useState<string | null>(null);
  const [hist, setHist] = useState<Hist[]>([]);
  const [docsOf, setDocsOf] = useState<string | null>(null);
  const isAdm = getRoles().includes('ADM');
  const [mainTab, setMainTab] = useState<'gates' | 'worksheet'>(isAdm ? 'gates' : 'worksheet');

  const load = useCallback(async () => {
    if (!getRoles().includes('ADM')) { setList([]); return; } // 게이트 결재는 ADM 전용(검사실은 워크시트만)
    setErr('');
    try { setList(await apiFetch<Gate[]>('/api/v1/admin/gates')); }
    catch (e) { setErr(e instanceof Error ? e.message : '게이트 조회 실패(ADM 권한 필요)'); setList([]); }
  }, []);

  useEffect(() => {
    if (!getToken()) { router.push('/'); return; }
    load();
  }, [router, load]);

  function startEdit(g: Gate) {
    setEditing(g.gateCode);
    setForm({
      docNo: g.docNo ?? '', approvedDate: g.approvedDate ?? new Date().toISOString().slice(0, 10),
      approver: g.approver && g.approver !== '(미결재)' ? g.approver : uid, approverUserId: g.approverUserId ?? uid,
      reviewIntervalDays: String(g.reviewIntervalDays ?? 365), note: g.note ?? '',
    });
  }

  async function submit(g: Gate) {
    if (!form.docNo.trim() || !form.approver.trim() || !form.approvedDate) {
      toast('문서번호·결재일·결재자는 필수입니다(근거 문서 기반 기입)', 'info'); return;
    }
    const reApprove = g.status === 'APPROVED';
    const ok = await confirm({
      title: `${reApprove ? '게이트 재결재' : '게이트 실결재 기입'} — ${g.gateCode}`,
      message: `실결재 문서에 근거해 이 게이트를 APPROVED로 ${reApprove ? '재확정' : '확정'}합니다. 정기 재검토일이 결재일+주기로 갱신됩니다.`,
      detail: [
        { label: '게이트', value: `${g.gateCode} · ${g.title}` },
        { label: '문서번호', value: form.docNo },
        { label: '결재일', value: form.approvedDate },
        { label: '결재자', value: `${form.approver}${form.approverUserId ? ` (${form.approverUserId})` : ''}` },
        { label: '재검토 주기', value: `${form.reviewIntervalDays}일` },
      ],
      confirmLabel: reApprove ? '재결재 확정' : 'APPROVED 확정',
    });
    if (!ok) return;
    try {
      await apiFetch(`/api/v1/admin/gates/${encodeURIComponent(g.gateCode)}/approve`, {
        method: 'POST',
        body: JSON.stringify({
          docNo: form.docNo.trim(), approvedDate: form.approvedDate, approver: form.approver.trim(),
          approverUserId: form.approverUserId.trim() || undefined, reviewIntervalDays: Number(form.reviewIntervalDays) || undefined,
          note: form.note.trim() || undefined,
        }),
      });
      toast(`${g.gateCode} ${reApprove ? '재결재' : '결재'} 기입됨(APPROVED)`, 'success');
      setEditing(null);
      await load();
    } catch (e) { toast(e instanceof Error ? e.message : '결재 기입 실패', 'error'); }
  }

  // EAS 결재 lifecycle 전이(상신/진행/반려/재상신) — 단일 수신 경로(/reference) 사용
  async function lifecycle(g: Gate, status: 'SUBMITTED' | 'IN_PROGRESS' | 'REJECTED') {
    const body: Record<string, unknown> = { status };
    if (status === 'REJECTED') {
      const r = window.prompt(`반려 사유 — ${g.gateCode}`, ''); if (!r?.trim()) return; body.reason = r.trim();
    } else if (status === 'SUBMITTED') {
      const d = window.prompt(`기안/상신 문서번호(선택) — ${g.gateCode}`, g.docNo ?? ''); if (d === null) return; if (d.trim()) body.docNo = d.trim();
    }
    try {
      await apiFetch(`/api/v1/admin/gates/${encodeURIComponent(g.gateCode)}/reference`, { method: 'POST', body: JSON.stringify(body) });
      toast(`${g.gateCode} ${statusLabel[status] ?? status} 기록됨`, 'success');
      await load();
    } catch (e) { toast(e instanceof Error ? e.message : '상태 기록 실패', 'error'); }
  }

  async function syncHis() {
    try {
      const r = await apiFetch<{ total: number; synced: number; results: { gateCode: string; synced: boolean; reason?: string }[] }>('/api/v1/admin/gates/sync', { method: 'POST' });
      const failReason = r.results.find((x) => !x.synced)?.reason;
      toast(`HIS 동기화: ${r.synced}/${r.total} 반영${r.synced === 0 && failReason ? ` · ${failReason}` : ''}`, r.synced > 0 ? 'success' : 'info');
      await load();
    } catch (e) { toast(e instanceof Error ? e.message : 'HIS 동기화 실패', 'error'); }
  }

  async function flagReview(g: Gate) {
    const reason = window.prompt(`재검토 필요 사유(예: 담당자 교체) — ${g.gateCode}`, '담당자 교체');
    if (!reason?.trim()) return;
    try {
      await apiFetch(`/api/v1/admin/gates/${encodeURIComponent(g.gateCode)}/flag-review`, { method: 'POST', body: JSON.stringify({ reason: reason.trim(), actor: uid || undefined }) });
      toast('재검토 필요로 표시됨', 'success');
      await load();
    } catch (e) { toast(e instanceof Error ? e.message : '표시 실패', 'error'); }
  }

  async function toggleHist(g: Gate) {
    if (histOf === g.gateCode) { setHistOf(null); return; }
    try { setHist(await apiFetch<Hist[]>(`/api/v1/admin/gates/${encodeURIComponent(g.gateCode)}/history`)); setHistOf(g.gateCode); }
    catch (e) { toast(e instanceof Error ? e.message : '이력 조회 실패', 'error'); }
  }

  // 실결재만 계수(데모 기입은 제외 — 개시 준비도 false-green 방지)
  const approvedCount = list?.filter((g) => g.status === 'APPROVED' && !isDemoApproved(g)).length ?? 0;
  const staleCount = list?.filter((g) => g.reviewStatus === 'STALE').length ?? 0;

  return (
    <main className="page">
      <h1 className="t-page mb-3">개시 서명·결재</h1>

      {/* 서명 워크시트(검사실 계열)와 조직 게이트 결재(ADM)를 한 화면 탭으로 */}
      <div className="flex gap-1 mb-4 border-b border-line pb-2 print:hidden">
        <button onClick={() => setMainTab('worksheet')} className={`text-sm px-3 py-1.5 rounded-lg font-semibold ${mainTab === 'worksheet' ? 'bg-teal text-white' : 'text-ink-2 hover:bg-bg'}`}>서명 워크시트</button>
        <button onClick={() => setMainTab('gates')} className={`text-sm px-3 py-1.5 rounded-lg font-semibold ${mainTab === 'gates' ? 'bg-teal text-white' : 'text-ink-2 hover:bg-bg'}`}>조직 게이트 결재{!isAdm && ' (ADM)'}</button>
      </div>

      {mainTab === 'worksheet' && <SignoffWorksheet />}

      {mainTab === 'gates' && !isAdm && <p className="text-sm text-warn">조직 게이트 결재는 관리자(ADM) 전용입니다. 게이트 현황은 서명 워크시트 H섹션에서 열람할 수 있습니다.</p>}

      {mainTab === 'gates' && isAdm && (<>
      <p className="text-sm text-ink-2 mb-4">개시 준비 조직 승인(A-1/A-2/A-3/PACS)·재검토. 결재자 인력변경(계정 비활성화·역할 회수)·정기 주기 만료 시 자동으로 재검토가 필요해집니다.</p>

      <div className="flex items-center gap-2 mb-4 text-sm flex-wrap">
        <span className="px-2 py-1 rounded-lg bg-surface border border-line">승인 {approvedCount}/{list?.length ?? 0}</span>
        {staleCount > 0 && <span className="px-2 py-1 rounded-lg bg-crit/10 text-crit border border-crit/20">재검토 필요 {staleCount}</span>}
        <button onClick={load} className="text-xs text-teal underline">새로고침</button>
        <button onClick={syncHis} className="text-xs px-2 py-1 rounded-lg border border-line text-indigo">HIS 동기화</button>
      </div>

      {err && <ErrorText message={err} />}
      {list === null ? <Loading /> : list.length === 0 && !err ? <EmptyState title="게이트 없음" /> : (
        <div className="space-y-3">
          {list?.map((g) => {
            const stale = g.reviewStatus === 'STALE';
            return (
              <section key={g.gateCode} className={`card border ${stale ? 'border-crit/40' : 'border-line'}`}>
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  <span className="mono font-bold">{g.gateCode}</span>
                  <span className="font-semibold">{g.title}</span>
                  <span className={`text-xs px-2 py-0.5 rounded ${statusCls[g.status] ?? 'bg-bg text-ink-2'}`}>{statusLabel[g.status] ?? g.status}</span>
                  {g.source === 'HIS' && <span className="text-xs px-2 py-0.5 rounded bg-teal/10 text-teal font-semibold" title="HIS 자동 동기화로 갱신됨(수기 입력 아님)">HIS 자동</span>}
                  {stale && <span className="text-xs px-2 py-0.5 rounded bg-crit/15 text-crit font-semibold">재검토 필요</span>}
                  {isPlaceholder(g) && <span className="text-xs px-2 py-0.5 rounded bg-crit/10 text-crit">{isDemoApproved(g) ? 'DEV 플레이스홀더(데모 기입 — 실결재 필요)' : 'DEV 플레이스홀더(미결재)'}</span>}
                  <span className="ml-auto text-xs text-ink-3">{g.owner}</span>
                </div>
                <p className="text-xs text-ink-2 mb-2">{g.scope}</p>

                {stale && (
                  <div className="text-xs bg-crit/5 border border-crit/20 rounded-lg p-2 mb-2">
                    <b className="text-crit">재검토 사유</b>: {g.reviewFlags.join(' · ')}
                    <span className="text-ink-3"> — 아래 재결재로 갱신하세요.</span>
                  </div>
                )}

                {g.status === 'APPROVED' && !editing && (
                  <div className="text-xs bg-surface-2 border border-line rounded-lg p-2 grid sm:grid-cols-2 gap-1 mb-2">
                    <span>문서번호: <b className="mono">{g.docNo ?? '—'}</b></span>
                    <span>결재일: <b>{g.approvedDate ?? '—'}</b></span>
                    <span>결재자: <b>{g.approver ?? '—'}</b>{g.approverUserId ? <span className="mono text-ink-3"> ({g.approverUserId})</span> : ''}</span>
                    <span>다음 재검토: <b className={stale ? 'text-crit' : ''}>{g.nextReviewDate ?? '—'}</b> {g.reviewIntervalDays ? `(${g.reviewIntervalDays}일 주기)` : ''}</span>
                  </div>
                )}

                {editing === g.gateCode ? (
                  <div className="grid sm:grid-cols-4 gap-2 items-end p-3 rounded-lg border border-line bg-bg">
                    <div><label className="block text-[11px] text-ink-2 mb-0.5">문서번호*</label><input aria-label="문서번호*" value={form.docNo} onChange={(e) => setForm({ ...form, docNo: e.target.value })} placeholder="결재 문서번호" className="w-full mono px-2 py-1 rounded border border-line bg-surface text-sm" /></div>
                    <div><label className="block text-[11px] text-ink-2 mb-0.5">결재일*</label><input aria-label="결재일*" type="date" value={form.approvedDate} onChange={(e) => setForm({ ...form, approvedDate: e.target.value })} className="w-full px-2 py-1 rounded border border-line bg-surface text-sm" /></div>
                    <div><label className="block text-[11px] text-ink-2 mb-0.5">결재자명*</label><input aria-label="결재자명*" value={form.approver} onChange={(e) => setForm({ ...form, approver: e.target.value })} placeholder="결재자명" className="w-full px-2 py-1 rounded border border-line bg-surface text-sm" /></div>
                    <div><label className="block text-[11px] text-ink-2 mb-0.5">결재자 계정ID</label><input aria-label="결재자 계정ID" value={form.approverUserId} onChange={(e) => setForm({ ...form, approverUserId: e.target.value })} placeholder="인력변경 감지 결속" className="w-full mono px-2 py-1 rounded border border-line bg-surface text-sm" /></div>
                    <div><label className="block text-[11px] text-ink-2 mb-0.5">재검토 주기(일)</label><input aria-label="재검토 주기(일)" value={form.reviewIntervalDays} onChange={(e) => setForm({ ...form, reviewIntervalDays: e.target.value })} inputMode="numeric" className="w-full px-2 py-1 rounded border border-line bg-surface text-sm" /></div>
                    <div className="sm:col-span-3"><label className="block text-[11px] text-ink-2 mb-0.5">비고</label><input aria-label="비고" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} className="w-full px-2 py-1 rounded border border-line bg-surface text-sm" /></div>
                    <div className="flex gap-2 sm:col-span-4">
                      <button onClick={() => submit(g)} className="py-1.5 px-4 rounded-lg bg-teal text-white font-semibold text-xs">{g.status === 'APPROVED' ? '재결재 확정' : 'APPROVED 확정'}</button>
                      <button onClick={() => setEditing(null)} className="py-1.5 px-3 rounded-lg border border-line text-xs">취소</button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 flex-wrap">
                    {g.status !== 'APPROVED' && <span className="text-xs text-ink-3">결재자: {g.approver && g.approver !== '(미결재)' ? g.approver : '(미결재)'}{g.docNo ? ` · ${g.docNo}` : ''}</span>}
                    <div className="ml-auto flex gap-2 flex-wrap">
                      <button onClick={() => setDocsOf(docsOf === g.gateCode ? null : g.gateCode)} className="py-1.5 px-3 rounded-lg border border-line text-teal text-xs">{docsOf === g.gateCode ? '첨부 닫기' : '상신 첨부'}</button>
                      <button onClick={() => toggleHist(g)} className="py-1.5 px-3 rounded-lg border border-line text-ink-2 text-xs">{histOf === g.gateCode ? '이력 닫기' : '이력'}</button>
                      {/* EAS lifecycle 전이(비완료 상태) */}
                      {(g.status === 'PENDING' || g.status === 'REJECTED') && <button onClick={() => lifecycle(g, 'SUBMITTED')} className="py-1.5 px-3 rounded-lg border border-line text-indigo text-xs">{g.status === 'REJECTED' ? '재상신' : '상신'}</button>}
                      {(g.status === 'SUBMITTED' || g.status === 'IN_PROGRESS') && <button onClick={() => lifecycle(g, 'IN_PROGRESS')} className="py-1.5 px-3 rounded-lg border border-line text-indigo text-xs">진행중</button>}
                      {(g.status === 'SUBMITTED' || g.status === 'IN_PROGRESS') && <button onClick={() => lifecycle(g, 'REJECTED')} className="py-1.5 px-3 rounded-lg border border-line text-crit text-xs">반려</button>}
                      {g.status === 'APPROVED' && !stale && <button onClick={() => flagReview(g)} className="py-1.5 px-3 rounded-lg border border-line text-warn text-xs">재검토 표시</button>}
                      <button onClick={() => startEdit(g)} className={`py-1.5 px-3 rounded-lg text-white font-semibold text-xs ${stale ? 'bg-crit' : 'bg-indigo'}`}>
                        {g.status === 'APPROVED' ? (stale ? '재결재' : '수정') : '완료(승인) 기입'}
                      </button>
                    </div>
                  </div>
                )}

                {docsOf === g.gateCode && GATE_DOCS_MAP[g.gateCode] && (
                  <div className="mt-2 border-t border-line pt-2 text-xs">
                    <h3 className="font-bold text-ink-2 mb-1">상신 첨부 근거 <span className="text-ink-3 font-normal">(권장 기준선 · </span><Link href="/admin/gates/checklist" className="text-teal underline font-normal">전문 보기</Link><span className="text-ink-3 font-normal">)</span></h3>
                    <div className="grid sm:grid-cols-2 gap-2">
                      <div>
                        <div className="text-teal font-semibold mb-1"><IconCheck className="mr-1" />LIS 산출물</div>
                        <ul className="list-disc pl-4 space-y-0.5 text-ink-2">{GATE_DOCS_MAP[g.gateCode].lis.map((d) => <li key={d}>{d}</li>)}</ul>
                      </div>
                      <div>
                        <div className="text-ink-2 font-semibold mb-1">☐ 주관 부서 작성</div>
                        <ul className="list-disc pl-4 space-y-0.5 text-ink-2">{GATE_DOCS_MAP[g.gateCode].org.map((d) => <li key={d}>{d}</li>)}</ul>
                      </div>
                    </div>
                  </div>
                )}

                {histOf === g.gateCode && (
                  <div className="mt-2 border-t border-line pt-2">
                    <h3 className="text-xs font-bold text-ink-2 mb-1">결재 이력</h3>
                    {hist.length === 0 ? <p className="text-xs text-ink-3">이력 없음</p> : (
                      <ul className="space-y-0.5">
                        {hist.map((h) => (
                          <li key={h.historyId} className="text-[11px] flex items-center gap-2">
                            <span className="mono text-ink-3">{h.createdDt.slice(0, 16).replace('T', ' ')}</span>
                            <span className={`px-1.5 py-0.5 rounded font-semibold ${h.action === 'FLAGGED_STALE' ? 'bg-crit/10 text-crit' : 'bg-good/10 text-good'}`}>{actionLabel[h.action] ?? h.action}</span>
                            {h.actor && <span className="text-ink-2">{h.actor}</span>}
                            {h.docNo && <span className="mono text-ink-3">{h.docNo}</span>}
                            {h.approvedDate && <span className="text-ink-3">결재일 {h.approvedDate}</span>}
                            {h.reason && <span className="text-ink-3">— {h.reason}</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
      <p className="text-xs text-ink-3 mt-4">※ 결재는 실 결재 문서에 근거해서만 기입하세요. 결재자 계정ID를 결속하면 그 계정이 비활성화·무권한이 될 때 이 게이트가 자동으로 재검토 필요로 표시됩니다.</p>
      </>)}
    </main>
  );
}
