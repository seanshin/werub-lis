'use client';

/**
 * 다운타임 오더 화면 (`/orders/downtime`).
 *
 * 사이드바 노출 역할: RCP, TEC, ADM.
 * ⚠ 노출 역할과 화면이 호출하는 API 권한이 어긋나면 전부 403인 죽은 화면이 된다 —
 *   역할을 바꿀 때는 `Sidebar.tsx`(정본)와 API 권한 매트릭스를 함께 본다.
 * 데이터는 `lib/api.ts`의 `apiFetch`로만 가져온다(HTTP 호출 정본).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, getToken, getRoles } from '@/lib/api';
import { EmptyState, ErrorText, Loading } from '@/components/ui';
import { useToast } from '@/components/toast';
import { maskName } from '@/lib/privacy';

/**
 * 다운타임 오더(P1-4) — HIS 단절 중 수기 접수 + 복구 후 HIS 오더번호 대사.
 *
 * HIS 폴링이 유일한 접수 경로면 HIS 장애·점검 시 **접수 자체가 중단**된다.
 * LIS 자체 오더 API는 있었으나 화면이 없어 호출할 곳이 없었다. 이 화면이 그 공백을 메운다.
 * 다운타임 접수분은 orderSource=DOWNTIME으로 남아, HIS 복구 후 이 화면에서 오더번호를 연결한다.
 */

interface DowntimeOrder {
  orderId: string;
  patientId: string;
  patientName: string | null;
  tests: string[];
  priority: string;
  downtimeReason: string | null;
  orderDt: string;
  status: string;
}

export default function DowntimeOrderPage() {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState<DowntimeOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [form, setForm] = useState({ patientId: '', patientName: '', testCodes: '', orderingProvider: '', priority: 'R', downtimeReason: 'HIS 단절' });
  const [recon, setRecon] = useState<Record<string, string>>({});
  // 수기 접수·HIS 대사는 F-RCV:W = 접수담당(RCP)만. TEC/ADM은 F-RCV:R뿐이라 목록은 보되 실행은 403이다.
  // (접수 직무분리는 08 매트릭스 근거 — 권한을 넓히는 게 아니라 죽은 버튼을 없앤다.)
  const [canWrite, setCanWrite] = useState(false);
  useEffect(() => { setCanWrite(getRoles().includes('RCP')); }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      setPending(await apiFetch<DowntimeOrder[]>('/api/v1/orders/downtime/pending'));
    } catch (e) {
      setErr(e instanceof Error ? e.message : '조회 실패(권한 필요)');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!getToken()) router.push('/');
    else load();
  }, [router, load]);

  async function createOrder(e: React.FormEvent) {
    e.preventDefault();
    const codes = form.testCodes.split(/[,\s]+/).map((c) => c.trim()).filter(Boolean);
    if (!form.patientId.trim() || codes.length === 0) {
      toast('환자ID와 검사코드를 입력하세요', 'error');
      return;
    }
    setBusy('new');
    try {
      const r = await apiFetch<{ order: { orderId: string } }>('/api/v1/orders', {
        method: 'POST',
        body: JSON.stringify({
          patientId: form.patientId.trim(),
          patientName: form.patientName.trim() || undefined,
          testCodes: codes,
          orderingProvider: form.orderingProvider.trim() || undefined,
          priority: form.priority,
          downtime: true,
          downtimeReason: form.downtimeReason.trim() || undefined,
        }),
      });
      toast(`다운타임 오더 생성 — ${r.order.orderId} · 접수 화면에서 검체 접수하세요`);
      setForm({ ...form, patientId: '', patientName: '', testCodes: '', orderingProvider: '' });
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : '생성 실패', 'error');
    } finally {
      setBusy('');
    }
  }

  async function reconcile(orderId: string) {
    const hisOrderNo = recon[orderId]?.trim();
    if (!hisOrderNo) {
      toast('HIS 오더번호를 입력하세요', 'error');
      return;
    }
    setBusy(orderId);
    try {
      await apiFetch(`/api/v1/orders/${encodeURIComponent(orderId)}/reconcile-his`, { method: 'POST', body: JSON.stringify({ hisOrderNo }) });
      toast(`대사 완료 — ${orderId} → HIS ${hisOrderNo}`);
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : '대사 실패', 'error');
    } finally {
      setBusy('');
    }
  }

  const inp = 'px-2 py-1.5 rounded-lg border border-line bg-bg text-sm';

  return (
    <main className="page">
      <h1 className="t-page mb-1">다운타임 오더</h1>
      <p className="text-xs text-ink-3 mb-4">
        HIS 단절 중 수기 접수 경로입니다. HIS 복구 후 아래 대사 대기 목록에서 HIS 오더번호를 연결하세요 — 연결하지 않으면 청구·이력이 이원화됩니다.
      </p>
      <ErrorText message={err} />

      {!canWrite && (
        <p className="mb-4 rounded-xl border border-warn/40 bg-warn/[0.06] px-3 py-2 text-sm text-warn">
          읽기 전용 — 다운타임 수기 접수·HIS 대사는 <b>접수담당(RCP)</b>만 수행합니다. 대사 대기 현황은 아래에서 확인할 수 있습니다.
        </p>
      )}

      {canWrite && (
      <section className="card border-warn/40 mb-4">
        <h2 className="t-section text-sm mb-2">수기 오더 접수</h2>
        <form onSubmit={createOrder} className="grid gap-2 sm:grid-cols-2">
          <input required aria-label="환자ID" placeholder="환자ID*" value={form.patientId} onChange={(e) => setForm({ ...form, patientId: e.target.value })} className={`${inp} mono`} />
          <input aria-label="환자명" placeholder="환자명(미등록 환자 시 필수)" value={form.patientName} onChange={(e) => setForm({ ...form, patientName: e.target.value })} className={inp} />
          <input required aria-label="검사코드" placeholder="검사코드(쉼표·공백 구분)*" value={form.testCodes} onChange={(e) => setForm({ ...form, testCodes: e.target.value })} className={`${inp} mono sm:col-span-2`} />
          <input aria-label="처방의" placeholder="처방의ID(선택)" value={form.orderingProvider} onChange={(e) => setForm({ ...form, orderingProvider: e.target.value })} className={`${inp} mono`} />
          <select aria-label="우선순위" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} className={inp}>
            <option value="R">일반</option>
            <option value="S">응급(STAT)</option>
          </select>
          <input aria-label="다운타임 사유" placeholder="다운타임 사유" value={form.downtimeReason} onChange={(e) => setForm({ ...form, downtimeReason: e.target.value })} className={`${inp} sm:col-span-2`} />
          <button disabled={busy === 'new'} className="py-1.5 px-3 rounded-lg bg-warn text-white font-semibold text-sm disabled:opacity-50 sm:col-span-2">다운타임 오더 생성</button>
        </form>
        <p className="text-xs text-ink-3 mt-2">미등록 환자는 환자명으로 즉석 생성됩니다. 생성 후 <b>접수·바코드</b>는 오더·접수 화면에서 이어서 진행하세요.</p>
      </section>
      )}

      <section className="card">
        <h2 className="t-section mb-3">
          HIS 대사 대기 <span className="text-xs text-ink-2">({pending.length})</span>
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-2 border-b border-line">
                <th className="py-2">오더</th>
                <th>환자</th>
                <th>검사</th>
                <th>사유·시각</th>
                <th>HIS 오더번호 연결</th>
              </tr>
            </thead>
            <tbody>
              {pending.map((o) => (
                <tr key={o.orderId} className="border-b border-line last:border-0 align-top">
                  <td className="py-2 mono text-xs">
                    {o.orderId}
                    {o.priority === 'S' && <span className="text-crit font-bold ml-1">응급</span>}
                  </td>
                  <td className="text-xs">
                    <span className="font-semibold">{maskName(o.patientName)}</span>
                    <span className="mono text-ink-3 block">{o.patientId}</span>
                  </td>
                  <td className="mono text-xs">{o.tests.join(', ')}</td>
                  <td className="text-xs text-ink-3">
                    {o.downtimeReason ?? '—'}
                    <span className="block">{new Date(o.orderDt).toLocaleString('ko-KR')}</span>
                  </td>
                  <td>
                    {canWrite ? (
                      <span className="flex gap-1 items-center">
                        <input aria-label="HIS 오더번호" placeholder="HIS 오더번호" value={recon[o.orderId] ?? ''} onChange={(e) => setRecon({ ...recon, [o.orderId]: e.target.value })} className={`${inp} mono w-40`} />
                        <button disabled={busy === o.orderId} onClick={() => reconcile(o.orderId)} className="py-1 px-2 rounded-lg bg-teal text-white text-xs disabled:opacity-50">대사</button>
                      </span>
                    ) : (
                      <span className="text-xs text-ink-3">대사 대기 — 접수담당(RCP) 수행</span>
                    )}
                  </td>
                </tr>
              ))}
              {loading && pending.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <Loading />
                  </td>
                </tr>
              )}
              {!loading && pending.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <EmptyState title="대사 대기 없음" hint="HIS 단절 중 접수한 오더가 여기에 표시됩니다." />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
