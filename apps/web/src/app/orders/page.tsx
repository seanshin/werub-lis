'use client';

/**
 * 오더 · 검체 접수 화면 (`/orders`).
 *
 * 데이터는 `lib/api.ts`의 `apiFetch`로만 가져온다(HTTP 호출 정본).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, apiFetchFull, getToken } from '@/lib/api';
import { Loading } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useConfirm } from '@/components/confirm';
import { useBarcodeNormalize, beep as beepSound } from '@/lib/barcode';
import { maskName } from '@/lib/privacy';
import { ORDER_STATUS_LABEL } from '@lis/shared';
import { Code128Svg } from '@/components/Code128';
import { csvCell } from '@/lib/csv';

interface Order {
  orderId: string;
  hisOrderNo?: string | null;
  orderDt?: string | null;
  status: string;
  priority: string;
  patient: { name: string; patientId?: string };
  provider?: { providerId: string; name: string; dept?: string | null } | null;
  items: { orderItemId: string; test: { name: string } }[];
}
interface OrderSummary { total: number; byStatus: Record<string, number>; statCount: number; from: string | null; to: string | null; }
const STATUS_LABEL = ORDER_STATUS_LABEL; // 정본은 @lis/shared
const SPC_STATUS_LABEL: Record<string, string> = { COLLECTED: '채취', RECEIVED: '접수', IN_PROCESS: '진행', COMPLETED: '완료', REJECTED: '거부', STORED: '보관', DISPOSED: '폐기' };
const REJECT_REASONS: { code: string; label: string }[] = [
  { code: 'HEMOLYZED', label: '용혈' }, { code: 'INSUFFICIENT', label: '검체 부족' }, { code: 'CLOTTED', label: '응고' }, { code: 'CONTAMINATED', label: '오염' }, { code: 'OTHER', label: '기타' },
];
interface SpcTimeline {
  specimenNo: string; status: string;
  specimen: { orderId: string; patientName: string; containerCode: string | null; collectedDt: string | null; collectedBy: string | null; rejectReason: string | null; hasResults: boolean; aliquotCount: number };
  events: { at: string | null; event: string; detail: string }[];
}

export default function OrdersPage() {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const { cfg: barCfg, normalize } = useBarcodeNormalize();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [orderId, setOrderId] = useState('');
  const [container, setContainer] = useState('EDTA');
  const [specimenType, setSpecimenType] = useState('');
  const [collectedDt, setCollectedDt] = useState('');
  const [collectedBy, setCollectedBy] = useState('');
  const [label, setLabel] = useState<{ specimenNo: string; zpl: string; patientName?: string; patientId?: string } | null>(null);
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [statOnly, setStatOnly] = useState(false);
  const [recvLog, setRecvLog] = useState<{ specimenNo: string; patientName: string; time: string }[]>([]);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [summary, setSummary] = useState<OrderSummary | null>(null);
  const orderIdRef = useRef<HTMLInputElement>(null);
  const TAKE = 50;

  const dateQs = useCallback((qs: URLSearchParams) => { if (from) qs.set('from', from); if (to) qs.set('to', to); }, [from, to]);

  const load = useCallback(async (status = statusFilter, sk = 0) => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (status) qs.set('status', status);
      qs.set('skip', String(sk)); qs.set('take', String(TAKE));
      dateQs(qs);
      const r = await apiFetchFull<Order[]>(`/api/v1/orders?${qs}`);
      setOrders(r.data); setTotal(r.meta?.total ?? r.data.length); setPage(sk / TAKE);
      // 기간 요약(관리 리포트)
      const sq = new URLSearchParams(); if (status) sq.set('status', status); dateQs(sq);
      const s = await apiFetch<OrderSummary>(`/api/v1/orders/summary?${sq}`);
      setSummary(s);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '조회 실패');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, dateQs]);

  // 프리셋: 오늘 / 최근 N일
  function preset(days: number) {
    const end = new Date(); const start = new Date(); start.setDate(end.getDate() - days);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    setFrom(fmt(start)); setTo(fmt(end));
  }

  async function cancelOrder(e: React.MouseEvent, oid: string) {
    e.stopPropagation();
    const ok = await confirm({ title: '오더 취소', message: '접수 대기 오더를 취소합니다. 되돌릴 수 없습니다.', detail: [{ label: '오더', value: oid }], danger: true, confirmLabel: '취소' });
    if (!ok) return;
    try {
      await apiFetch(`/api/v1/orders/${encodeURIComponent(oid)}/cancel`, { method: 'POST', body: JSON.stringify({ reason: '접수 대기 오더 취소' }) });
      toast(`오더 취소 — ${oid}`); load();
    } catch (err) { toast(err instanceof Error ? err.message : '취소 실패', 'error'); }
  }
  async function toggleHold(e: React.MouseEvent, oid: string, currentlyHold: boolean) {
    e.stopPropagation();
    try {
      await apiFetch(`/api/v1/orders/${encodeURIComponent(oid)}/hold`, { method: 'POST', body: JSON.stringify({ hold: !currentlyHold, reason: currentlyHold ? undefined : '처방 확인 대기' }) });
      toast(currentlyHold ? `보류 해제 — ${oid}` : `보류 — ${oid}`); load();
    } catch (err) { toast(err instanceof Error ? err.message : '처리 실패', 'error'); }
  }

  async function exportCsv() {
    try {
      const qs = new URLSearchParams(); if (statusFilter) qs.set('status', statusFilter); dateQs(qs);
      const r = await apiFetch<{ total: number; truncated: boolean; rows: Record<string, string>[] }>(`/api/v1/orders/export?${qs}`);
      if (!r.rows.length) { toast('내보낼 오더가 없습니다', 'info'); return; }
      const cols = ['orderId', 'hisOrderNo', 'orderDt', 'patientId', 'patientName', 'orderingProvider', 'orderingProviderName', 'priority', 'status', 'tests'];
      const head = ['오더ID', 'HIS오더', '등록일시', '환자ID', '환자명', '처방의ID', '처방의', '우선', '상태', '항목'];
      const csv = [head.join(','), ...r.rows.map((row) => cols.map((c) => csvCell(row[c] ?? '')).join(','))].join('\r\n');
      const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = `orders_${from || 'all'}_${to || 'all'}.csv`; a.click(); URL.revokeObjectURL(a.href);
      toast(`CSV ${r.rows.length}건 내보냄${r.truncated ? ' (5000건 초과 일부)' : ''}`, r.truncated ? 'info' : 'success');
    } catch (e) { toast(e instanceof Error ? e.message : '내보내기 실패', 'error'); }
  }

  // ── 검체 처리(거부·분주·타임라인·정정·취소) ──
  const [spcNo, setSpcNo] = useState('');
  const [spc, setSpc] = useState<SpcTimeline | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('HEMOLYZED');
  const [recollect, setRecollect] = useState(true);
  const [aliquotTargets, setAliquotTargets] = useState('');
  const [editReceipt, setEditReceipt] = useState<{ containerCode: string; collectedDt: string; collectedBy: string } | null>(null);

  const loadSpc = useCallback(async (no: string) => {
    const s = normalize(no).value; // 바코드 정규화
    if (!s) { toast('검체번호를 입력하세요', 'info'); return; }
    setEditReceipt(null); setRejectOpen(false);
    try {
      setSpc(await apiFetch<SpcTimeline>(`/api/v1/orders/specimens/${encodeURIComponent(s)}/timeline`));
    } catch (e) { setSpc(null); toast(e instanceof Error ? e.message : '검체 조회 실패', 'error'); }
  }, [toast, normalize]);

  async function doReject() {
    if (!spc) return;
    try {
      const r = await apiFetch<{ recollection: { orderId: string } | null }>(`/api/v1/orders/specimens/${encodeURIComponent(spc.specimenNo)}/reject`, { method: 'POST', body: JSON.stringify({ reason: rejectReason, recollect }) });
      toast(`검체 거부됨${r.recollection ? ` · 재채취 오더 ${r.recollection.orderId} 생성` : ''}`, 'success');
      setRejectOpen(false); await loadSpc(spc.specimenNo); await load(statusFilter, 0);
    } catch (e) { toast(e instanceof Error ? e.message : '거부 실패', 'error'); }
  }

  async function doAliquot() {
    if (!spc) return;
    const targets = aliquotTargets.split(',').map((t) => t.trim()).filter(Boolean);
    if (!targets.length) { toast('분주 대상(분석기)을 입력하세요', 'info'); return; }
    try {
      await apiFetch(`/api/v1/orders/specimens/${encodeURIComponent(spc.specimenNo)}/aliquots`, { method: 'POST', body: JSON.stringify({ targets }) });
      toast(`분주 ${targets.length}건 생성`, 'success'); setAliquotTargets(''); await loadSpc(spc.specimenNo);
    } catch (e) { toast(e instanceof Error ? e.message : '분주 실패', 'error'); }
  }

  async function doCorrect() {
    if (!spc || !editReceipt) return;
    try {
      await apiFetch(`/api/v1/orders/specimens/${encodeURIComponent(spc.specimenNo)}/receipt`, {
        method: 'PATCH',
        body: JSON.stringify({ containerCode: editReceipt.containerCode, collectedDt: editReceipt.collectedDt ? new Date(editReceipt.collectedDt).toISOString() : '', collectedBy: editReceipt.collectedBy }),
      });
      toast('접수 정정됨', 'success'); setEditReceipt(null); await loadSpc(spc.specimenNo);
    } catch (e) { toast(e instanceof Error ? e.message : '정정 실패', 'error'); }
  }

  async function doCancelReceipt() {
    if (!spc) return;
    const ok = await confirm({ title: '접수 취소', message: '오접수를 되돌립니다. 검체·분주가 삭제되고 오더가 접수 전으로 복귀합니다.', detail: [{ label: '검체', value: spc.specimenNo }, { label: '환자', value: spc.specimen.patientName }], danger: true });
    if (!ok) return;
    try {
      const r = await apiFetch<{ orderReverted: boolean; orderId: string }>(`/api/v1/orders/specimens/${encodeURIComponent(spc.specimenNo)}/cancel-receipt`, { method: 'POST' });
      toast(`접수 취소됨${r.orderReverted ? ` · 오더 ${r.orderId} 접수전 복귀` : ''}`, 'success'); setSpc(null); setSpcNo(''); await load(statusFilter, 0);
    } catch (e) { toast(e instanceof Error ? e.message : '접수 취소 실패', 'error'); }
  }

  const filtered = orders
    .filter((o) => !statOnly || o.priority === 'S')
    .filter((o) => {
      const s = q.trim().toLowerCase();
      return !s || o.orderId.toLowerCase().includes(s) || (o.patient?.name ?? '').toLowerCase().includes(s);
    })
    .sort((a, b) => (a.priority === 'S' ? 0 : 1) - (b.priority === 'S' ? 0 : 1)); // 응급 우선

  // B3 안전: 접수 전 대상 오더의 환자·검사 미리 확인(오검체 방지)
  const selectedOrder = orders.find((o) => o.orderId === orderId.trim());

  useEffect(() => {
    if (!getToken()) {
      router.push('/');
      return;
    }
    void load('');
  }, [load, router]);

  async function receive(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    const nb = normalize(orderId); // 바코드 정규화(접두/접미/길이 규칙)
    const oid = nb.value;
    if (!oid) { toast('오더ID를 입력하세요', 'info'); orderIdRef.current?.focus(); return; }
    if (nb.warning) toast(`바코드 경고: ${nb.warning}`, 'info');
    const ord = orders.find((o) => o.orderId === oid);
    try {
      const r = await apiFetch<{ specimenNo: string }>('/api/v1/orders/receive', {
        method: 'POST',
        body: JSON.stringify({ orderId: oid, containerCode: container, specimenType: specimenType.trim() || undefined, collectedDt: collectedDt ? new Date(collectedDt).toISOString() : undefined, collectedBy: collectedBy || undefined }),
      });
      const patientName = ord?.patient?.name ?? '';
      toast(`접수 완료 · ${patientName ? patientName + ' · ' : ''}검체 ${r.specimenNo}`);
      if (barCfg.beep) beepSound();
      try {
        const lbl = await apiFetch<{ specimenNo: string; zpl: string }>(`/api/v1/orders/specimens/${r.specimenNo}/label`);
        setLabel({ ...lbl, patientName, patientId: ord?.patient?.patientId });
      } catch { /* noop */ }
      // B2 연속접수: 세션 접수로그 + 입력칸 클리어·리포커스
      setRecvLog((prev) => [{ specimenNo: r.specimenNo, patientName, time: new Date().toTimeString().slice(0, 5) }, ...prev].slice(0, 12));
      setOrderId('');
      orderIdRef.current?.focus();
      await load(statusFilter);
    } catch (e) {
      toast(e instanceof Error ? e.message : '접수 실패', 'error');
    }
  }

  // B8: 이미 접수된 검체 라벨 재출력
  async function reprint(rawNo: string) {
    const specimenNo = normalize(rawNo).value; // 바코드 정규화
    if (!specimenNo) { toast('검체번호를 입력하세요', 'info'); return; }
    try {
      const lbl = await apiFetch<{ specimenNo: string; zpl: string }>(`/api/v1/orders/specimens/${encodeURIComponent(specimenNo.trim())}/label`);
      setLabel(lbl);
      toast(`라벨 재출력 · ${lbl.specimenNo}`);
    } catch (e) { toast(e instanceof Error ? e.message : '라벨 조회 실패', 'error'); }
  }

  return (
    <main className="page">
      <h1 className="t-page mb-4">오더 · 검체 접수</h1>
      {err && <p className="text-sm text-crit mb-3">{err}</p>}

      <section className="card mb-4">
        <h2 className="t-section mb-3">검체 접수</h2>
        <form onSubmit={receive} className="flex flex-wrap gap-2 items-end">
          <div>
            <label className="block text-xs text-ink-2 mb-1">오더ID</label>
            <input
              ref={orderIdRef}
              autoFocus
              aria-label="오더ID"
              className="mono px-3 py-2 rounded-lg border border-line bg-bg text-sm w-40"
              value={orderId}
              onChange={(e) => setOrderId(e.target.value)}
              placeholder="O-0001 (스캔)"
              autoComplete="off"
            />
          </div>
          <div>
            <label className="block text-xs text-ink-2 mb-1">용기</label>
            <select
              aria-label="용기"
              className="mono px-3 py-2 rounded-lg border border-line bg-bg text-sm w-28"
              value={container}
              onChange={(e) => setContainer(e.target.value)}
            >
              <option>EDTA</option><option>SST</option><option>Sodium Citrate</option><option>Heparin</option><option>Fluoride</option><option>Plain</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-ink-2 mb-1">검체종류(선택)</label>
            <input aria-label="검체종류" list="specimen-types" value={specimenType} onChange={(e) => setSpecimenType(e.target.value)} placeholder="Serum·Whole blood·Urine" className="px-2 py-2 rounded-lg border border-line bg-bg text-sm w-36" />
            <datalist id="specimen-types"><option value="Serum" /><option value="Whole blood" /><option value="Plasma" /><option value="Urine" /><option value="Sputum" /><option value="CSF" /><option value="Stool" /><option value="Swab" /></datalist>
          </div>
          <div>
            <label className="block text-xs text-ink-2 mb-1">채취시각(선택)</label>
            <input type="datetime-local" aria-label="채취시각" value={collectedDt} onChange={(e) => setCollectedDt(e.target.value)} className="px-2 py-2 rounded-lg border border-line bg-bg text-sm" />
          </div>
          <div>
            <label className="block text-xs text-ink-2 mb-1">채취자(선택)</label>
            <input aria-label="채취자" value={collectedBy} onChange={(e) => setCollectedBy(e.target.value)} placeholder="채취자" className="px-2 py-2 rounded-lg border border-line bg-bg text-sm w-24" />
          </div>
          <button type="submit" className="py-2 px-4 rounded-lg bg-teal text-white font-semibold text-sm">
            접수·라벨발행
          </button>
          <span className="mx-1 text-line">|</span>
          <input aria-label="라벨 재출력 검체번호" placeholder="검체번호 라벨 재출력" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); reprint((e.target as HTMLInputElement).value); } }}
            className="mono px-3 py-2 rounded-lg border border-line bg-bg text-sm w-48" />
        </form>

        {/* B3 접수 전 환자 확인(오검체 방지) */}
        {selectedOrder ? (
          <div className="mt-3 flex items-center gap-2 text-sm bg-teal/10 border border-teal/30 rounded-lg px-3 py-2">
            <span className="text-teal font-bold">확인</span>
            <span className="font-semibold">{selectedOrder.patient?.name}</span>
            {selectedOrder.patient?.patientId && <span className="mono text-xs text-ink-2">{selectedOrder.patient.patientId}</span>}
            <span className="text-xs text-ink-2">· {selectedOrder.items?.map((i) => i.test?.name).join(', ')}</span>
            {selectedOrder.priority === 'S' && <span className="text-xs text-crit font-bold">응급</span>}
          </div>
        ) : orderId.trim() ? (
          <p className="mt-3 text-xs text-warn">해당 오더를 목록에서 찾지 못했습니다 — 오더ID를 확인하세요.</p>
        ) : null}

        {label && (
          <div className="mt-4 flex items-start gap-4 flex-wrap">
            {/* 라벨 미리보기(인쇄 영역) */}
            <div className="print-area border-2 border-ink rounded-lg p-3 w-64 bg-white text-black">
              <div className="text-center font-mono tracking-widest text-lg font-bold border-b border-black pb-1">{label.specimenNo}</div>
              {(label.patientName || label.patientId) && (
                <div className="text-sm font-bold text-center mt-1">{label.patientName}{label.patientId ? ` · ${label.patientId}` : ''}</div>
              )}
              {/* 실물 Code128 바코드(P1-19) — 이전 문자코드 기반 장식 막대는 스캔되지 않았다 */}
              <Code128Svg value={label.specimenNo} />
              <div className="text-xs flex justify-between"><span>용기 {container}</span><span className="font-mono">{new Date().toISOString().slice(5, 16).replace('T', ' ')}</span></div>
            </div>
            <div className="no-print flex flex-col gap-2">
              <button onClick={() => window.print()} className="py-2 px-4 rounded-lg bg-indigo text-white font-semibold text-sm">라벨 인쇄</button>
              <details className="text-xs text-ink-2"><summary className="cursor-pointer">ZPL(프린터 전송용)</summary><pre className="mono bg-bg rounded p-2 mt-1 max-w-xs overflow-x-auto">{label.zpl}</pre></details>
            </div>
          </div>
        )}

        {/* B2 세션 접수 로그(연속 접수 집계) */}
        {recvLog.length > 0 && (
          <div className="mt-4 border-t border-line pt-3">
            <div className="text-xs text-ink-2 mb-1">이번 세션 접수 <b className="text-ink">{recvLog.length}</b>건</div>
            <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
              {recvLog.map((r) => (
                <button key={r.specimenNo} onClick={() => { setSpcNo(r.specimenNo); loadSpc(r.specimenNo); }} className="text-xs bg-bg border border-line rounded px-2 py-0.5 hover:bg-teal/10" title="검체 처리 열기">
                  <span className="mono">{r.specimenNo}</span> {r.patientName} <span className="text-ink-3">{r.time}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* 검체 처리 — 거부·분주·타임라인·정정·취소 */}
      <section className="card mb-4">
        <h2 className="t-section mb-3">검체 처리 <span className="text-xs text-ink-2 font-normal">거부·재채취 / 분주 / 정정 / 취소 / 이력</span></h2>
        <div className="flex flex-wrap gap-2 items-end">
          <input aria-label="검체번호" value={spcNo} onChange={(e) => setSpcNo(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); loadSpc(spcNo); } }}
            placeholder="검체번호 스캔·입력" className="mono px-3 py-2 rounded-lg border border-line bg-bg text-sm w-56" autoComplete="off" />
          <button onClick={() => loadSpc(spcNo)} className="py-2 px-4 rounded-lg bg-teal text-white font-semibold text-sm">조회</button>
        </div>

        {spc && (
          <div className="mt-4 border-t border-line pt-4">
            {/* 검체 요약 */}
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <span className="mono font-bold">{spc.specimenNo}</span>
              <span className="text-sm">{spc.specimen.patientName}</span>
              <span className={`px-2 py-0.5 rounded text-xs font-bold ${spc.status === 'REJECTED' ? 'bg-crit/15 text-crit' : spc.status === 'COMPLETED' ? 'bg-good/15 text-good' : 'bg-teal/15 text-teal'}`}>{SPC_STATUS_LABEL[spc.status] ?? spc.status}</span>
              <span className="text-xs text-ink-2">오더 {spc.specimen.orderId} · 용기 {spc.specimen.containerCode ?? '—'}</span>
              {spc.specimen.aliquotCount > 0 && <span className="text-xs text-ink-2">· 분주 {spc.specimen.aliquotCount}</span>}
              {spc.specimen.hasResults && <span className="text-xs text-warn">· 결과 입력됨</span>}
            </div>

            {/* 액션 버튼(상태·무결성 기반) */}
            <div className="flex flex-wrap gap-2 mb-3">
              {spc.status !== 'REJECTED' && <button onClick={() => setRejectOpen(true)} className="py-1.5 px-3 rounded-lg bg-crit/10 text-crit border border-crit/30 text-sm font-medium">거부·재채취</button>}
              {spc.status !== 'REJECTED' && <button onClick={() => setEditReceipt({ containerCode: spc.specimen.containerCode ?? '', collectedDt: spc.specimen.collectedDt ? new Date(spc.specimen.collectedDt).toISOString().slice(0, 16) : '', collectedBy: spc.specimen.collectedBy ?? '' })} disabled={spc.specimen.hasResults} className="py-1.5 px-3 rounded-lg border border-line text-sm disabled:opacity-40" title={spc.specimen.hasResults ? '결과 입력 후 정정 불가' : ''}>접수 정정</button>}
              {spc.status === 'RECEIVED' && !spc.specimen.hasResults && <button onClick={doCancelReceipt} className="py-1.5 px-3 rounded-lg border border-crit/30 text-crit text-sm">접수 취소</button>}
              <button onClick={() => reprint(spc.specimenNo)} className="py-1.5 px-3 rounded-lg border border-line text-sm">라벨 재출력</button>
            </div>

            {/* 거부 모달(인라인) */}
            {rejectOpen && (
              <div className="mb-3 p-3 rounded-lg border border-crit/30 bg-crit/5 flex flex-wrap items-end gap-2">
                <div>
                  <label className="block text-xs text-ink-2 mb-1">거부 사유</label>
                  <select aria-label="거부 사유" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} className="px-2 py-1.5 rounded-lg border border-line bg-bg text-sm">
                    {REJECT_REASONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
                  </select>
                </div>
                <label className="flex items-center gap-1 text-sm cursor-pointer"><input type="checkbox" checked={recollect} onChange={(e) => setRecollect(e.target.checked)} />재채취 오더 생성</label>
                <button onClick={doReject} className="py-1.5 px-3 rounded-lg border border-crit text-crit text-sm font-semibold transition-colors duration-150 hover:bg-crit/10">거부 확정</button>
                <button onClick={() => setRejectOpen(false)} className="py-1.5 px-3 rounded-lg border border-line text-sm">취소</button>
              </div>
            )}

            {/* 접수 정정(인라인) */}
            {editReceipt && (
              <div className="mb-3 p-3 rounded-lg border border-line bg-bg flex flex-wrap items-end gap-2">
                <div><label className="block text-xs text-ink-2 mb-1">용기</label>
                  <select aria-label="용기 정정" value={editReceipt.containerCode} onChange={(e) => setEditReceipt({ ...editReceipt, containerCode: e.target.value })} className="mono px-2 py-1.5 rounded-lg border border-line bg-bg text-sm">
                    <option value="">—</option><option>EDTA</option><option>SST</option><option>Sodium Citrate</option><option>Heparin</option><option>Fluoride</option><option>Plain</option>
                  </select></div>
                <div><label className="block text-xs text-ink-2 mb-1">채취시각</label>
                  <input type="datetime-local" aria-label="채취시각 정정" value={editReceipt.collectedDt} onChange={(e) => setEditReceipt({ ...editReceipt, collectedDt: e.target.value })} className="px-2 py-1.5 rounded-lg border border-line bg-bg text-sm" /></div>
                <div><label className="block text-xs text-ink-2 mb-1">채취자</label>
                  <input aria-label="채취자 정정" value={editReceipt.collectedBy} onChange={(e) => setEditReceipt({ ...editReceipt, collectedBy: e.target.value })} className="px-2 py-1.5 rounded-lg border border-line bg-bg text-sm w-24" /></div>
                <button onClick={doCorrect} className="py-1.5 px-3 rounded-lg bg-teal text-white text-sm font-semibold">정정 저장</button>
                <button onClick={() => setEditReceipt(null)} className="py-1.5 px-3 rounded-lg border border-line text-sm">취소</button>
              </div>
            )}

            {/* 분주 */}
            {spc.status !== 'REJECTED' && (
              <div className="mb-3 flex items-end gap-2">
                <div><label className="block text-xs text-ink-2 mb-1">분주 대상(분석기, 콤마 구분)</label>
                  <input aria-label="분주 대상" value={aliquotTargets} onChange={(e) => setAliquotTargets(e.target.value)} placeholder="CHEM1, COAG1" className="mono px-2 py-1.5 rounded-lg border border-line bg-bg text-sm w-56" /></div>
                <button onClick={doAliquot} className="py-1.5 px-3 rounded-lg border border-line text-sm">분주 생성</button>
              </div>
            )}

            {/* 타임라인 */}
            <div>
              <div className="text-xs text-ink-2 mb-1">검체 이력</div>
              <ol className="text-sm space-y-1">
                {spc.events.length === 0 && <li className="text-ink-3 text-xs">이벤트 없음</li>}
                {spc.events.map((ev, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <span className="mono text-xs text-ink-3 w-32 shrink-0">{ev.at ? new Date(ev.at).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}</span>
                    <span className={`text-xs font-semibold w-14 shrink-0 ${ev.event === 'REJECTED' ? 'text-crit' : 'text-ink-2'}`}>{ev.event}</span>
                    <span className="text-xs">{ev.detail}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        )}
      </section>

      <section className="card">
        {/* 등록일자 범위·처리 이력 관리 필터 */}
        <div className="flex flex-wrap items-end gap-2 mb-3 pb-3 border-b border-line">
          <div>
            <label className="block text-xs text-ink-2 mb-1">등록일 From</label>
            <input type="date" aria-label="등록일 From" value={from} onChange={(e) => setFrom(e.target.value)} className="px-2 py-1.5 rounded-lg border border-line bg-bg text-sm" />
          </div>
          <div>
            <label className="block text-xs text-ink-2 mb-1">To</label>
            <input type="date" aria-label="등록일 To" value={to} onChange={(e) => setTo(e.target.value)} className="px-2 py-1.5 rounded-lg border border-line bg-bg text-sm" />
          </div>
          <button onClick={() => load(statusFilter, 0)} className="py-1.5 px-3 rounded-lg bg-teal text-white text-sm font-semibold">조회</button>
          <div className="flex gap-1">
            <button onClick={() => { preset(0); }} className="text-xs px-2 py-1.5 rounded-lg border border-line">오늘</button>
            <button onClick={() => { preset(7); }} className="text-xs px-2 py-1.5 rounded-lg border border-line">최근 7일</button>
            <button onClick={() => { preset(30); }} className="text-xs px-2 py-1.5 rounded-lg border border-line">최근 30일</button>
            <button onClick={() => { setFrom(''); setTo(''); load(statusFilter, 0); }} className="text-xs px-2 py-1.5 rounded-lg border border-line text-ink-2">전체</button>
          </div>
          <span className="mx-1 text-line">|</span>
          <button onClick={exportCsv} className="text-xs px-3 py-1.5 rounded-lg border border-teal/40 text-teal font-medium">CSV 내보내기</button>
        </div>
        {/* 처리 현황 요약(관리 리포트) */}
        {summary && (
          <div className="flex flex-wrap gap-2 mb-3 text-xs">
            <span className="px-2 py-1 rounded-lg bg-bg border border-line">총 <b>{summary.total}</b>건</span>
            {summary.statCount > 0 && <span className="px-2 py-1 rounded-lg bg-crit/10 text-crit">응급 {summary.statCount}</span>}
            {Object.entries(summary.byStatus).map(([s, n]) => (
              <span key={s} className="px-2 py-1 rounded-lg bg-bg border border-line">{STATUS_LABEL[s] ?? s} <b>{n}</b></span>
            ))}
            {(summary.from || summary.to) && <span className="px-2 py-1 rounded-lg text-ink-2">기간 {summary.from ?? '~'} ~ {summary.to ?? '~'}</span>}
          </div>
        )}
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <h2 className="t-section">오더 목록 <span className="text-xs text-ink-2">(총 {total}건 · 페이지 {page * 50 + 1}~{page * 50 + orders.length}{(q || statOnly) ? ` · 필터 ${filtered.length}` : ''})</span></h2>
          <div className="flex gap-2 items-center">
            <button onClick={() => load(statusFilter, Math.max(0, (page - 1) * 50))} disabled={page === 0} className="text-xs px-2 py-1 rounded-lg border border-line disabled:opacity-40">이전</button>
            <button onClick={() => load(statusFilter, (page + 1) * 50)} disabled={(page + 1) * 50 >= total} className="text-xs px-2 py-1 rounded-lg border border-line disabled:opacity-40">다음</button>
            <input aria-label="오더ID·환자 검색" value={q} onChange={(e) => setQ(e.target.value)} placeholder="오더ID·환자 검색" className="px-2 py-1.5 rounded-lg border border-line bg-bg text-sm w-44" />
            <select aria-label="상태 필터" value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); load(e.target.value); }} className="px-2 py-1.5 rounded-lg border border-line bg-bg text-sm">
              <option value="">전체 상태</option><option value="RECEIVED">접수</option><option value="IN_PROCESS">진행</option><option value="COMPLETED">완료</option><option value="REPORTED">보고</option><option value="CANCELLED">취소</option><option value="HOLD">보류</option>
            </select>
            <label className="flex items-center gap-1 text-xs text-ink-2 cursor-pointer"><input type="checkbox" checked={statOnly} onChange={(e) => setStatOnly(e.target.checked)} />응급만</label>
          </div>
        </div>
        {loading && orders.length === 0 ? <Loading /> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-2 border-b border-line">
                <th className="py-2">등록일시</th>
                <th>오더ID</th>
                <th>환자</th>
                <th>처방의</th>
                <th>항목</th>
                <th>우선</th>
                <th>상태</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((o) => (
                <tr key={o.orderId} onClick={() => setOrderId(o.orderId)}
                  className={`border-b border-line last:border-0 cursor-pointer hover:bg-bg ${orderId === o.orderId ? 'bg-teal/10' : ''}`}>
                  <td className="py-2 mono text-xs whitespace-nowrap">{o.orderDt ? new Date(o.orderDt).toLocaleString('ko-KR', { year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                  <td className="mono">{o.orderId}</td>
                  <td>{maskName(o.patient?.name)}</td>
                  <td className="text-xs">{o.provider?.name ? <span title={o.provider.dept ?? ''}>{o.provider.name}{o.provider.dept ? ` · ${o.provider.dept}` : ''}</span> : <span className="text-ink-3">—</span>}</td>
                  <td>{o.items?.map((i) => i.test?.name).join(', ')}</td>
                  <td>{o.priority === 'S' ? '응급' : '일반'}</td>
                  <td className="mono text-xs">{STATUS_LABEL[o.status] ?? o.status}</td>
                  <td className="whitespace-nowrap text-right" onClick={(e) => e.stopPropagation()}>
                    {(o.status === 'RECEIVED' || o.status === 'HOLD') && (
                      <>
                        <button onClick={(e) => toggleHold(e, o.orderId, o.status === 'HOLD')} className="text-xs px-1.5 py-0.5 rounded border border-line text-ink-2 mr-1">{o.status === 'HOLD' ? '보류해제' : '보류'}</button>
                        <button onClick={(e) => cancelOrder(e, o.orderId)} className="text-xs px-1.5 py-0.5 rounded border border-crit/40 text-crit">취소</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )}
      </section>
    </main>
  );
}
