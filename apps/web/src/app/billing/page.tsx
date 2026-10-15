'use client';

/**
 * 청구 관리 화면 (`/billing`).
 *
 * 사이드바 노출 역할: ADM, AUD.
 * ⚠ 노출 역할과 화면이 호출하는 API 권한이 어긋나면 전부 403인 죽은 화면이 된다 —
 *   역할을 바꿀 때는 `Sidebar.tsx`(정본)와 API 권한 매트릭스를 함께 본다.
 * 데이터는 `lib/api.ts`의 `apiFetch`로만 가져온다(HTTP 호출 정본).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, getToken, getRoles } from '@/lib/api';
import { EmptyState, ErrorText, Section, PageHeader, StatBadge, TableSkeleton, BTN } from '@/components/ui';
import { useToast } from '@/components/toast';

/** 청구 관리(P2: API만 있고 화면이 없던 기능) — 확정결과 캡처 · 미청구 목록 · 청구배치(stub). */
interface BillingItem {
  billingId: string; orderId: string; patientId: string | null; testCode: string;
  ediCode: string | null; testName: string | null; quantity: number; status: string;
  claimBatchId: string | null; capturedDt: string;
}
interface Claim { claimId: string; orderId: string; patientId: string | null; performedOn: string | null; revision: number; itemCount: number; status: string; rejectReason: string | null; attempts: number; sentDt: string | null; ackDt: string | null; }
interface TransmitResult { transmitted: number; total: number; claims: { claimId: string; status: string; items: number; rejectReason?: string }[] }

export default function BillingPage() {
  const router = useRouter();
  const toast = useToast();
  const [items, setItems] = useState<BillingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [captureId, setCaptureId] = useState('');
  const [claims, setClaims] = useState<Claim[]>([]);
  const [busy, setBusy] = useState('');
  // 청구 쓰기(캡처·전송·동기화)는 ADM만(F-BIL:W). AUD는 조회 전용 — 쓰기 버튼 숨김(403 죽은버튼 방지).
  const [canWrite, setCanWrite] = useState(false);
  useEffect(() => { setCanWrite(getRoles().includes('ADM')); }, []);

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      setItems(await apiFetch<BillingItem[]>('/api/v1/billing/unbilled'));
      setClaims(await apiFetch<Claim[]>('/api/v1/billing/claims'));
    }
    catch (e) { setErr(e instanceof Error ? e.message : '조회 실패'); setItems([]); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { if (!getToken()) router.push('/'); else load(); }, [router, load]);

  async function capture() {
    const orderId = captureId.trim();
    if (!orderId) return;
    try {
      const r = await apiFetch<{ captured: number }>(`/api/v1/billing/capture/${encodeURIComponent(orderId)}`, { method: 'POST' });
      toast(r.captured > 0 ? `${r.captured}건 캡처됨` : '캡처 대상 없음(확정 결과·EDI 매핑 확인)', r.captured > 0 ? 'success' : 'info');
      setCaptureId(''); load();
    } catch (e) { toast(e instanceof Error ? e.message : '캡처 실패', 'error'); }
  }


  async function transmit() {
    setBusy('tx');
    try {
      const r = await apiFetch<TransmitResult>('/api/v1/billing/transmit', { method: 'POST', body: '{}' });
      const rejected = r.claims.filter((c) => c.status === 'REJECTED').length;
      const pending = r.claims.filter((c) => c.status === 'PENDING').length;
      toast(r.total === 0 ? '전송 대상 없음' : `${r.transmitted}/${r.total}건 전송${pending ? ` · 보류 ${pending}(ERP 미구성/일시장애)` : ''}${rejected ? ` · 반송 ${rejected}` : ''}`, rejected ? 'error' : r.transmitted ? 'success' : 'info');
      load();
    } catch (e) { toast(e instanceof Error ? e.message : '전송 실패', 'error'); }
    finally { setBusy(''); }
  }
  /**
   * 반송(REJECTED) 개별 재전송 — 사유를 보고 마스터·수가매핑을 고친 뒤 그 건만 다시 보낸다.
   * sweep(자동)은 PENDING만 재전송한다: 4xx 반송은 원인을 고치지 않으면 계속 반송되므로
   * 맹목 재시도 대상이 아니다. 그래서 반송분은 **사람이 확인한 뒤 여기서** 재전송한다.
   * 반송 건의 청구항목은 CLAIMED로 넘어가지 않고 CAPTURED로 남아 있어 같은 리비전으로 재기술된다.
   */
  async function resend(c: Claim) {
    setBusy(c.claimId);
    try {
      const r = await apiFetch<TransmitResult>('/api/v1/billing/transmit', { method: 'POST', body: JSON.stringify({ orderId: c.orderId }) });
      const one = r.claims[0];
      if (!one) toast('재전송 대상 항목 없음 — 청구 캡처 상태를 확인하세요', 'info');
      else toast(one.status === 'SENT' || one.status === 'ACCEPTED' ? `재전송 완료 — ${one.claimId}` : `${claimKo[one.status] ?? one.status}${one.rejectReason ? ` — ${one.rejectReason}` : ''}`, one.status === 'SENT' || one.status === 'ACCEPTED' ? 'success' : 'error');
      load();
    } catch (e) { toast(e instanceof Error ? e.message : '재전송 실패', 'error'); }
    finally { setBusy(''); }
  }
  async function poll(claimId: string) {
    setBusy(claimId);
    try { await apiFetch(`/api/v1/billing/claims/${encodeURIComponent(claimId)}/poll`, { method: 'POST', body: '{}' }); load(); }
    catch (e) { toast(e instanceof Error ? e.message : '상태조회 실패', 'error'); }
    finally { setBusy(''); }
  }
  async function sweep() {
    setBusy('sw');
    try {
      const r = await apiFetch<{ skipped: boolean; retried: number; polled: number; accepted: number; rejected: number }>('/api/v1/billing/sweep', { method: 'POST', body: '{}' });
      toast(r.skipped ? 'ERP 미구성 — 동기화 대상 없음' : `재전송 ${r.retried} · 폴링 ${r.polled}(수납 ${r.accepted}·반송 ${r.rejected})`, r.rejected ? 'error' : 'success');
      load();
    } catch (e) { toast(e instanceof Error ? e.message : '동기화 실패', 'error'); }
    finally { setBusy(''); }
  }
  const claimTone: Record<string, string> = { PENDING: 'bg-bg text-ink-2 border-line', SENT: 'bg-indigo/10 text-indigo border-indigo/30', ACCEPTED: 'bg-good/10 text-good border-good/30', REJECTED: 'bg-crit/10 text-crit border-crit/30' };
  const claimKo: Record<string, string> = { PENDING: '전송대기', SENT: '전송됨', ACCEPTED: '수납확정', REJECTED: '반송' };

  const inp = 'px-2 py-1.5 rounded-lg border border-line bg-bg text-sm';

  return (
    <main className="page">
      <PageHeader
        title="청구 관리"
        hint="확정 결과를 청구 대상으로 캡처(검사당 1회) → ERP로 전송(1메시지=1오더). 수가·EDI 산정은 ERP 소관(LIS는 검사코드·수량·실시일만). ERP 미구성 시 전송대기로 스테이징."
      />

      {canWrite ? (
      <Section className="mb-4">
        <div className="flex flex-wrap gap-2 items-center">
          <input aria-label="캡처 오더ID" placeholder="오더ID(확정결과 캡처)" value={captureId} onChange={(e) => setCaptureId(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); capture(); } }} className={`${inp} mono w-56`} />
          <button onClick={capture} className={BTN.neutral}>캡처</button>
          <span className="flex-1" />
          <button onClick={sweep} disabled={busy === 'sw'} className={BTN.neutral} title="PENDING 재전송 + SENT 상태 일괄 조회(크론과 동일)">{busy === 'sw' ? '동기화 중…' : '상태 동기화'}</button>
          <button onClick={transmit} disabled={busy === 'tx'} className={BTN.primary}>{busy === 'tx' ? '전송 중…' : 'ERP 청구 전송(미청구 전량)'}</button>
        </div>
      </Section>
      ) : (
        <p className="mb-4 rounded-xl border border-warn/40 bg-warn/[0.06] px-3 py-2 text-sm text-warn">읽기 전용 — 청구 캡처·전송은 관리자(ADM)만 가능합니다(감사자는 조회).</p>
      )}

      {/* 청구 전송 현황 — 반송(REJECTED) 워크리스트 포함 */}
      {claims.length > 0 && (
        <Section title="청구 전송 현황" hint={`ERP로 전송된 청구 메시지(1메시지=1오더) ${claims.length}건 · 반송 ${claims.filter((c) => c.status === 'REJECTED').length}건`} className="mb-4">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-ink-2 border-b border-line"><th className="py-2">청구ID</th><th>오더</th><th>환자</th><th>실시일</th><th>항목</th><th>상태</th><th>사유/시각</th><th></th></tr></thead>
              <tbody>
                {claims.map((c) => (
                  <tr key={c.claimId} className={`border-b border-line last:border-0 ${c.status === 'REJECTED' ? 'bg-crit/[0.03]' : ''}`}>
                    <td className="py-1.5 mono text-xs">{c.claimId}{c.revision > 1 && <span className="text-ink-3"> r{c.revision}</span>}</td>
                    <td className="mono text-xs">{c.orderId}</td>
                    <td className="mono text-xs">{c.patientId ?? '—'}</td>
                    <td className="mono text-xs">{c.performedOn ?? '—'}</td>
                    <td className="mono text-xs">{c.itemCount}</td>
                    <td><span className={`px-1.5 py-0.5 rounded border text-[11px] font-semibold ${claimTone[c.status] ?? 'bg-bg text-ink-2 border-line'}`}>{claimKo[c.status] ?? c.status}</span></td>
                    <td className="text-xs text-ink-3">{c.status === 'REJECTED' ? <span className="text-crit">{c.rejectReason}</span> : ((c.ackDt ?? c.sentDt)?.slice(0, 16).replace('T', ' ') ?? '—')}{c.attempts > 1 && <span className="ml-1">·{c.attempts}회</span>}</td>
                    <td className="text-right whitespace-nowrap">{canWrite && (
                      <>
                        {c.status === 'REJECTED' && (
                          <button onClick={() => resend(c)} disabled={busy === c.claimId} className="text-xs text-crit underline disabled:opacity-50 mr-2" title="반송 사유를 수정한 뒤 이 건만 재전송(자동 sweep은 반송분을 맹목 재시도하지 않습니다)">재전송</button>
                        )}
                        <button onClick={() => poll(c.claimId)} disabled={busy === c.claimId} className="text-xs text-teal underline disabled:opacity-50">상태조회</button>
                      </>
                    )}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      <Section title="미청구 목록" hint={`캡처됐지만 아직 청구 배치에 묶이지 않은 항목 ${items.length}건`}>
        {err && <ErrorText message={err} />}
        {loading ? <TableSkeleton rows={4} cols={6} /> : items.length === 0 ? <EmptyState title="미청구 항목 없음" hint="확정 결과가 있는 오더ID로 캡처하면 목록에 나타납니다" /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-ink-2 border-b border-line"><th className="py-2">캡처일시</th><th>오더</th><th>환자ID</th><th>검사</th><th>EDI</th><th>수량</th></tr></thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.billingId} className="border-b border-line last:border-0">
                    <td className="py-1.5 mono text-xs">{it.capturedDt.slice(0, 16).replace('T', ' ')}</td>
                    <td className="mono text-xs">{it.orderId}</td>
                    <td className="mono text-xs">{it.patientId ?? '—'}</td>
                    <td>{it.testName ?? it.testCode} <span className="mono text-xs text-ink-3">{it.testCode}</span></td>
                    <td className="mono text-xs">{it.ediCode ?? <StatBadge tone="warn">미매핑</StatBadge>}</td>
                    <td className="mono">{it.quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </main>
  );
}
