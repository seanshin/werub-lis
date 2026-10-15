'use client';

/**
 * 연계 운영 콘솔 화면 (`/admin/integration`).
 *
 * 사이드바 노출 역할: ADM.
 * ⚠ 노출 역할과 화면이 호출하는 API 권한이 어긋나면 전부 403인 죽은 화면이 된다 —
 *   역할을 바꿀 때는 `Sidebar.tsx`(정본)와 API 권한 매트릭스를 함께 본다.
 * 데이터는 `lib/api.ts`의 `apiFetch`로만 가져온다(HTTP 호출 정본).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, getToken, getRoles } from '@/lib/api';
import { useToast } from '@/components/toast';
import { Loading } from '@/components/ui';
import { StatusChip } from '@/components/Explain';

interface DroppedOrder { logId: string; hisOrderId: string | null; code: string | null; codeName: string | null; loincCode: string | null; reason: string | null; droppedDt: string; }
interface FailedHl7Order { logId: string; messageControlId: string | null; hisOrderNo: string | null; patientId: string | null; orderControl: string | null; priority: string | null; codeNames: { code: string; nameKo: string | null }[]; reason: string | null; failedDt: string; retryable: boolean; }
interface Hl7RetryResult { attempted: number; created: number; changed: number; cancelled: number; exists: number; stillFailed: number; corrupt: number; }
interface Health { healthy: boolean; breaches: string[]; externalAlertConfigured: boolean; dlqDepth: number; stuckOutbound: number; oldestStuckAgeMin: number; undeliveredCritical: number; instrumentFailed: number; orderCancelFailed: number; droppedOrders: number; hl7OrderFailed: number; orderPollStaleMin: number | null; mwlFailed: number; billingStuck: number | null; }
interface Coverage { catalogTotal: number; lisMappedCodes: number; lisMappedFoundInCatalog: number; droppedOrders: number; lastSyncedDt: string | null; }
interface PollResult { configured: boolean; seen: number; created: number; dropped?: number; orders: { hisOrderId: string; code: string | null; lisOrderId?: string; items?: string[]; skipped?: string }[]; }
interface OutboundRow { logId: string; messageControlId: string | null; status: string; errorText: string | null; retryCount: number | null; hisRef: string | null; createdDt: string; }
interface Outbound { configured: boolean; maxRetry: number; counts: Record<string, number>; rows?: OutboundRow[]; }
interface LogRow { logId: string; ifId: string | null; direction: string; messageType: string | null; messageControlId: string | null; status: string; errorText: string | null; createdDt: string; }

const inp = 'px-2 py-1.5 rounded-lg border border-line bg-bg text-sm';

export default function IntegrationConsolePage() {
  const router = useRouter();
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [poll, setPoll] = useState<PollResult | null>(null);
  const [outbound, setOutbound] = useState<Outbound | null>(null);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [dropped, setDropped] = useState<DroppedOrder[]>([]);
  const [hl7Failed, setHl7Failed] = useState<FailedHl7Order[]>([]);
  const [cov, setCov] = useState<Coverage | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [spNo, setSpNo] = useState('');
  const [busy, setBusy] = useState('');
  const [preview, setPreview] = useState<{ title: string; content: string } | null>(null);
  const [pf, setPf] = useState({ spNos: '', patientIds: '' });
  const [pfResult, setPfResult] = useState<{ accession: { spNo: string; accession: string; length: number; ok: boolean; reason?: string }[]; patientId: { input: string; preserved: boolean; byteLength: number; risks: string[]; note: string }[] } | null>(null);
  const isAdmin = getRoles().includes('ADM');

  const loadStatus = useCallback(async () => {
    try {
      const [o, l, d, c, h, f] = await Promise.all([
        apiFetch<Outbound>('/api/v1/integration/hl7/reflex/outbound').catch(() => null),
        apiFetch<{ rows: LogRow[] }>('/api/v1/integration/hl7/logs?take=40').catch(() => ({ rows: [] })),
        apiFetch<DroppedOrder[]>('/api/v1/integration/hl7/his/dropped-orders').catch(() => []),
        apiFetch<Coverage>('/api/v1/integration/hl7/his/lab-codes/coverage').catch(() => null),
        apiFetch<Health>('/api/v1/integration/hl7/health/monitor').catch(() => null),
        apiFetch<FailedHl7Order[]>('/api/v1/integration/hl7/his/hl7-failed-orders').catch(() => []),
      ]);
      if (o) setOutbound(o); setLogs(l.rows); setDropped(d); setCov(c); setHealth(h); setHl7Failed(f);
    } finally { setLoading(false); }
  }, []);

  // 연계감시는 상시 모니터로 열어두는 화면 — 마운트 1회만 로드하면 DLQ 증가·판정 변화를 놓친다.
  // 30초마다 자동 갱신(OPS_WEBHOOK_URL 미설정 시 이 배지가 유일한 신호라 최신성이 중요).
  useEffect(() => {
    if (!getToken()) { router.push('/'); return; }
    void loadStatus();
    const t = setInterval(() => void loadStatus(), 30_000);
    return () => clearInterval(t);
  }, [router, loadStatus]);

  async function act(label: string, fn: () => Promise<unknown>, done: (r: unknown) => string) {
    setBusy(label);
    try { const r = await fn(); toast(done(r), 'success'); await loadStatus(); }
    catch (e) { toast(e instanceof Error ? e.message : `${label} 실패`, 'error'); }
    finally { setBusy(''); }
  }

  async function pollOrders() {
    setBusy('poll');
    try { const r = await apiFetch<PollResult>('/api/v1/integration/hl7/his/poll-orders', { method: 'POST' }); setPoll(r); toast(`폴링: 조회 ${r.seen} · 생성 ${r.created}${r.dropped ? ` · 미적재 ${r.dropped}` : ''}`, 'success'); await loadStatus(); }
    catch (e) { toast(e instanceof Error ? e.message : '폴링 실패', 'error'); }
    finally { setBusy(''); }
  }

  if (loading) return <main className="page"><Loading /></main>;

  return (
    <main className="max-w-5xl mx-auto p-6">
      <h1 className="t-page mb-1">연계 운영 콘솔</h1>
      <p className="text-xs text-ink-3 mb-4">HIS·PACS 연계 수동 조작·상태 확인(개발·운영 디버깅). 조작은 관리자(ADM).</p>

      {/* 연계 감시 상태 — "감시가 살아 있는가"를 화면에 세운다. 알림 채널이 없으면 지표는 아무 데도 도달하지 않는다. */}
      {health && (
        <section className={`card border mb-4 ${health.healthy ? 'border-line' : 'border-crit/40'}`}>
          <div className="flex items-center gap-2 flex-wrap mb-2">
            <h2 className="t-section text-sm">연계 감시</h2>
            <span className={`text-xs px-1.5 py-0.5 rounded font-bold ${health.healthy ? 'bg-good/15 text-good' : 'bg-crit/15 text-crit'}`}>
              {health.healthy ? '정상' : '이상'}
            </span>
            {!health.externalAlertConfigured && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-warn/15 text-warn font-bold">외부 알림 채널 미구성</span>
            )}
          </div>
          {!health.healthy && (
            <ul className="text-sm text-crit list-disc pl-5 mb-2">
              {health.breaches.map((b, i) => <li key={i}>{b}</li>)}
            </ul>
          )}
          <div className="flex flex-wrap gap-3 text-xs text-ink-2">
            <span>DLQ {health.dlqDepth}</span>
            <span className={health.oldestStuckAgeMin >= 30 ? 'text-warn font-semibold' : ''}>발신정체 {health.stuckOutbound}{health.stuckOutbound > 0 && health.oldestStuckAgeMin > 0 ? ` (최고참 ${health.oldestStuckAgeMin}분)` : ''}</span>
            <span>위험치 미확인 {health.undeliveredCritical}</span>
            <span>장비수집 실패 {health.instrumentFailed}</span>
            <span>취소적용 실패 {health.orderCancelFailed}</span>
            <span>미적재 오더 {health.droppedOrders}</span>
            <span className={health.hl7OrderFailed > 0 ? 'text-crit font-semibold' : ''} title="HIS 오더 수신(HL7 ORM) 처리 실패 — 오더 유실 카운터. 0이어야 정상.">오더수신 실패 {health.hl7OrderFailed}</span>
            {/* 폴링 정체 — 다른 지표는 '들어온 것'만 센다. 유입 자체가 멈추면 이 값만 커진다. */}
            <span className={(health.orderPollStaleMin ?? 0) >= 30 ? 'text-crit font-semibold' : ''} title="마지막 오더 폴링(워터마크 갱신) 이후 경과. 폴링이 멈추면 접수가 통째로 중단되는데 다른 지표는 전부 0으로 남는다.">
              폴링 {health.orderPollStaleMin == null ? 'off' : `${health.orderPollStaleMin}분 전`}
            </span>
            <span className={health.mwlFailed > 0 ? 'text-crit font-semibold' : ''} title="PACS 워크리스트(MWL) 송신 실패 — 병리 접수됐으나 스캔 워크리스트 미생성.">MWL 실패 {health.mwlFailed}</span>
            {health.billingStuck != null && (
              <span className={health.billingStuck > 0 ? 'text-crit font-semibold' : ''} title="ERP 청구 미전송 정체(PENDING). 반송(REJECTED)은 업무 정정 대상이라 여기 포함되지 않으며 청구 화면에서 처리합니다.">청구 정체 {health.billingStuck}</span>
            )}
          </div>
          {!health.externalAlertConfigured && (
            <p className="text-xs text-warn mt-2">
              <b>OPS_WEBHOOK_URL이 설정되지 않아 이상이 외부로 통보되지 않습니다.</b> 현재는 LIS 알림함에만 표시되므로,
              운영자가 화면을 봐야 인지합니다. 개시 전 알림 채널 연결을 권고합니다.
            </p>
          )}
        </section>
      )}

      {/* HIS 검사코드 카탈로그(H1) — 대기열의 코드명 해소·커버리지 근거 */}
      <section className="card mb-4">
        <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
          <h2 className="t-section text-sm">HIS 검사코드 카탈로그</h2>
          {isAdmin && (
            <span className="flex gap-1">
              <button onClick={() => act('cat-full', () => apiFetch<{ ok: boolean; reason?: string; total: number | null; distinctCodes: number; upserted: number; pageCountMismatch: boolean }>('/api/v1/integration/hl7/his/lab-codes/import', { method: 'POST' }), (r) => { const x = r as { ok: boolean; reason?: string; total: number | null; distinctCodes: number; pageCountMismatch: boolean }; return x.ok ? `반입 — distinct ${x.distinctCodes}/${x.total ?? '?'}${x.pageCountMismatch ? ' ★페이징 불일치' : ''}` : `반입 실패: ${x.reason}`; })} disabled={!!busy} className="text-xs px-2 py-1 rounded-lg bg-indigo text-white font-semibold disabled:opacity-50">전량 반입</button>
              <button onClick={() => act('cat-inc', () => apiFetch('/api/v1/integration/hl7/his/lab-codes/import?incremental=1', { method: 'POST' }), () => '증분 반입 완료')} disabled={!!busy} className="text-xs px-2 py-1 rounded-lg border border-line">증분</button>
            </span>
          )}
        </div>
        {cov ? (
          <div className="flex flex-wrap gap-4 text-sm">
            <span>카탈로그 <b className="mono">{cov.catalogTotal.toLocaleString()}</b>건</span>
            <span>LIS 매핑 <b className="mono">{cov.lisMappedCodes}</b>건</span>
            <span>그중 카탈로그 실재 <b className="mono">{cov.lisMappedFoundInCatalog}</b>건</span>
            <span className={cov.droppedOrders > 0 ? 'text-crit font-bold' : ''}>미적재 오더 {cov.droppedOrders}건</span>
            <span className="text-xs text-ink-3">{cov.lastSyncedDt ? `동기화 ${new Date(cov.lastSyncedDt).toLocaleString('ko-KR')}` : '미반입'}</span>
          </div>
        ) : <p className="text-sm text-ink-2">커버리지 조회 불가(권한 또는 미구성)</p>}
        <p className="text-xs text-ink-3 mt-2">
          카탈로그는 <b>참조·대사·매핑 보조 전용</b>입니다 — 오더 코드 해소는 검사마스터에 연결된 매핑(용어코드)만 사용합니다.
          커버리지 비율보다 <b>미적재 오더 건수</b>가 개시 리스크를 직접 반영합니다.
        </p>
      </section>

      {/* 미적재 HIS 오더 대기열 — 워터마크가 이미 지나가 재폴링되지 않는다. 여기서 보정하지 않으면 접수 자체가 없던 일이 된다. */}
      {dropped.length > 0 && (
        <section className="card border-crit/40 mb-4">
          <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
            <h2 className="t-section text-sm text-crit">미적재 HIS 오더 {dropped.length}건 — 접수 누락</h2>
            {isAdmin && (
              <button
                onClick={() => act('retry-dropped', () => apiFetch<{ attempted: number; created: number; stillDropped: number; failed: number }>('/api/v1/integration/hl7/his/dropped-orders/retry', { method: 'POST' }), (r) => { const x = r as { attempted: number; created: number; stillDropped: number; failed: number }; return `재적재 — 시도 ${x.attempted}·생성 ${x.created}·미해소 ${x.stillDropped}·실패 ${x.failed}`; })}
                disabled={!!busy}
                className="text-xs px-2 py-1 rounded-lg bg-teal text-white font-semibold transition-colors duration-150 hover:bg-teal-2 disabled:opacity-50"
              >재적재</button>
            )}
          </div>
          <p className="text-xs text-ink-3 mb-2">코드매핑(용어코드) 또는 환자정보를 보정한 뒤 재적재하세요. 폴링 워터마크는 이미 지나갔으므로 <b>자동으로는 다시 들어오지 않습니다</b>.</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-ink-2 border-b border-line"><th className="py-1">HIS 오더</th><th>코드</th><th>검사명(HIS 카탈로그)</th><th>사유</th><th>일시</th></tr></thead>
              <tbody>
                {dropped.map((d) => (
                  <tr key={d.logId} className="border-b border-line last:border-0">
                    <td className="py-1 mono text-xs">{d.hisOrderId ?? '—'}</td>
                    <td className="mono text-xs">{d.code ?? '—'}</td>
                    <td className="text-xs">
                      {d.codeName ?? <span className="text-ink-3">카탈로그에 없음</span>}
                      {d.loincCode && <span className="mono text-ink-3"> · {d.loincCode}</span>}
                    </td>
                    <td className="text-xs">{d.reason === 'unmapped' ? '코드 미매핑' : d.reason === 'no-patient-id' ? '환자 식별 불가' : d.reason}</td>
                    <td className="text-xs text-ink-3">{new Date(d.droppedDt).toLocaleString('ko-KR')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* HL7 푸시(IF-03) 수신 실패 — 폴링 대기열과 달리 HIS가 ACK를 받고 끝냈으므로 재전송도 재폴링도 없다.
          여기서 재적재하지 않으면 그 오더는 영영 접수되지 않는다(오더 유실). */}
      {hl7Failed.length > 0 && (
        <section className="card border-crit/40 mb-4">
          <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
            <h2 className="t-section text-sm text-crit">HL7 오더수신 실패 {hl7Failed.length}건 — 오더 유실</h2>
            {isAdmin && (
              <button
                onClick={() => act('retry-hl7', () => apiFetch<Hl7RetryResult>('/api/v1/integration/hl7/his/hl7-failed-orders/retry', { method: 'POST', body: '{}' }), (r) => { const x = r as Hl7RetryResult; return `재적재 — 시도 ${x.attempted}·생성 ${x.created}·변경 ${x.changed}·취소 ${x.cancelled}·기적재 ${x.exists}·미해소 ${x.stillFailed}${x.corrupt ? `·원문손상 ${x.corrupt}` : ''}`; })}
                disabled={!!busy}
                className="text-xs px-2 py-1 rounded-lg bg-teal text-white font-semibold transition-colors duration-150 hover:bg-teal-2 disabled:opacity-50"
              >전체 재적재</button>
            )}
          </div>
          <p className="text-xs text-ink-3 mb-2">
            HIS가 HL7로 밀어 넣었으나 LIS가 처리하지 못한 오더입니다. <b>폴링과 달리 자동 재시도 경로가 없습니다</b> —
            코드매핑(용어코드) 등록 또는 취소대상 확인 후 재적재하세요. 최초 수신과 같은 경로로 처리되며 이미 적재된 오더는 중복 생성되지 않습니다.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-ink-2 border-b border-line"><th className="py-1">HIS 오더</th><th>환자</th><th>구분</th><th>검사코드(HIS 카탈로그)</th><th>실패 사유</th><th>일시</th><th></th></tr></thead>
              <tbody>
                {hl7Failed.map((f) => (
                  <tr key={f.logId} className="border-b border-line last:border-0 align-top">
                    <td className="py-1 mono text-xs">
                      {f.hisOrderNo ?? '—'}
                      {f.priority === 'S' && <span className="text-crit font-bold ml-1">응급</span>}
                      <span className="block text-ink-3">{f.messageControlId}</span>
                    </td>
                    <td className="mono text-xs">{f.patientId ?? '—'}</td>
                    <td className="text-xs">{f.orderControl === 'CA' ? '취소' : f.orderControl === 'XO' || f.orderControl === 'RP' ? '변경' : '신규'}</td>
                    <td className="text-xs">
                      {f.codeNames.length === 0 ? '—' : f.codeNames.map((c) => (
                        <span key={c.code} className="block"><span className="mono">{c.code}</span> {c.nameKo ?? <span className="text-ink-3">카탈로그에 없음</span>}</span>
                      ))}
                    </td>
                    <td className="text-xs text-crit">{f.reason ?? '—'}</td>
                    <td className="text-xs text-ink-3">{new Date(f.failedDt).toLocaleString('ko-KR')}</td>
                    <td>
                      {!f.retryable ? (
                        <span className="text-xs text-ink-3" title="원문이 없거나 파싱 불가 — HIS 재전송이 필요합니다">재적재 불가</span>
                      ) : isAdmin && (
                        <button
                          onClick={() => act(`retry-hl7-${f.logId}`, () => apiFetch<Hl7RetryResult>('/api/v1/integration/hl7/his/hl7-failed-orders/retry', { method: 'POST', body: JSON.stringify({ logIds: [f.logId] }) }), (r) => { const x = r as Hl7RetryResult; return x.created || x.changed || x.cancelled || x.exists ? '재적재 완료' : x.corrupt ? '원문 손상 — HIS 재전송 필요' : '여전히 실패 — 사유 확인'; })}
                          disabled={!!busy}
                          className="text-xs px-2 py-1 rounded-lg border border-line hover:bg-bg disabled:opacity-50"
                        >재적재</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* HIS 오더 폴링 */}
      <section className="card mb-4">
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <h2 className="t-section">HIS 오더 폴링 <span className="text-xs text-ink-3 font-normal">ServiceRequest(active) → LIS 오더/병리 케이스</span></h2>
          {isAdmin && <button onClick={pollOrders} disabled={busy === 'poll'} className="py-1.5 px-3 rounded-lg bg-teal text-white text-sm font-semibold disabled:opacity-50">{busy === 'poll' ? '폴링중…' : '수동 폴링'}</button>}
        </div>
        {poll && (
          <div className="text-sm">
            <div className="text-xs text-ink-2 mb-2">연동 {poll.configured ? '' : '미설정'} · 조회 {poll.seen} · 생성 {poll.created}</div>
            <div className="overflow-x-auto"><table className="w-full text-xs">
              <thead><tr className="text-left text-ink-2 border-b border-line"><th className="py-1">HIS 오더</th><th>코드</th><th>결과</th></tr></thead>
              <tbody>{poll.orders.map((o) => (
                <tr key={o.hisOrderId} className="border-b border-line last:border-0">
                  <td className="py-1 mono">{o.hisOrderId.slice(0, 12)}</td><td className="mono">{o.code ?? '—'}</td>
                  <td>{o.lisOrderId ? <span className="text-good mono">{o.lisOrderId} {(o.items ?? []).join(',')}</span> : <span className="text-ink-3">{o.skipped}</span>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          </div>
        )}
      </section>

      {/* 결과 재전송 */}
      <section className="card mb-4">
        <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
          <h2 className="t-section">결과 재전송 <span className="text-xs text-ink-3 font-normal">검체 결과를 HIS로 전송(FHIR DiagnosticReport)</span></h2>
          {isAdmin && <button onClick={() => act('res-retry', () => apiFetch<{ attempted: number; sent: number; dlq: number }>('/api/v1/integration/hl7/results/retry', { method: 'POST' }), (r) => { const x = r as { attempted: number; sent: number; dlq: number }; return `결과 재발신 — 시도 ${x.attempted}·발신 ${x.sent}·DLQ ${x.dlq}`; })} disabled={!!busy} className="text-xs px-2 py-1 rounded-lg border border-line">실패분 재발신</button>}
        </div>
        <div className="flex flex-wrap items-end gap-2 mt-2">
          <div><label className="block text-xs text-ink-2 mb-1">검체번호</label><input aria-label="검체번호" className={`${inp} mono w-48`} value={spNo} onChange={(e) => setSpNo(e.target.value)} placeholder="S2607150001" /></div>
          {/* 미리보기 — 전송 전 생성 메시지 확인(트러블슈팅) */}
          <button onClick={async () => { if (!spNo.trim()) return toast('검체번호 입력', 'info'); try { const r = await apiFetch<{ message: string }>(`/api/v1/integration/hl7/oru/${encodeURIComponent(spNo.trim())}`); setPreview({ title: `ORU^R01 · ${spNo.trim()}`, content: r.message }); } catch (e) { toast(e instanceof Error ? e.message : 'ORU 생성 실패', 'error'); } }} disabled={!!busy} className="py-1.5 px-3 rounded-lg border border-line text-sm">ORU 미리보기</button>
          <button onClick={async () => { if (!spNo.trim()) return toast('검체번호 입력', 'info'); try { const r = await apiFetch<unknown>(`/api/v1/integration/hl7/fhir/${encodeURIComponent(spNo.trim())}`); setPreview({ title: `FHIR DiagnosticReport · ${spNo.trim()}`, content: JSON.stringify(r, null, 2) }); } catch (e) { toast(e instanceof Error ? e.message : 'FHIR 생성 실패', 'error'); } }} disabled={!!busy} className="py-1.5 px-3 rounded-lg border border-line text-sm">FHIR 미리보기</button>
          {isAdmin && <>
            <button onClick={() => { if (!spNo.trim()) return toast('검체번호 입력', 'info'); act('fhir', () => apiFetch<{ sent: boolean }>(`/api/v1/integration/hl7/fhir/${encodeURIComponent(spNo.trim())}/send-his`, { method: 'POST' }), (r) => `FHIR 전송 ${(r as { sent: boolean }).sent ? '성공' : '대기/실패'}`); }} disabled={!!busy} className="py-1.5 px-3 rounded-lg bg-indigo text-white text-sm font-semibold disabled:opacity-50">FHIR 전송</button>
            <button onClick={() => { if (!spNo.trim()) return toast('검체번호 입력', 'info'); act('oru', () => apiFetch(`/api/v1/integration/hl7/oru/${encodeURIComponent(spNo.trim())}/send-mllp`, { method: 'POST' }), () => 'ORU MLLP 전송 시도'); }} disabled={!!busy} className="py-1.5 px-3 rounded-lg border border-line text-sm">ORU MLLP</button>
          </>}
        </div>
        {preview && (
          <div className="mt-3 rounded-xl border border-line bg-bg p-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-bold mono">{preview.title}</span>
              <button onClick={() => setPreview(null)} className="text-xs text-ink-3 hover:text-ink">닫기 ✕</button>
            </div>
            <pre className="text-[11px] mono whitespace-pre-wrap break-all max-h-72 overflow-y-auto">{preview.content}</pre>
          </div>
        )}
      </section>

      {/* Reflex 발신 현황 */}
      <section className="card mb-4">
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <h2 className="t-section">Reflex 양방향 오더 발신</h2>
          {isAdmin && outbound && <div className="flex gap-1.5">
            <button onClick={() => act('flush', () => apiFetch('/api/v1/integration/hl7/reflex/flush', { method: 'POST' }), () => '재발신(flush)')} disabled={!!busy} className="text-xs px-2 py-1 rounded-lg border border-line">flush</button>
            <button onClick={() => act('retry', () => apiFetch('/api/v1/integration/hl7/reflex/retry', { method: 'POST' }), () => '실패분 재시도')} disabled={!!busy} className="text-xs px-2 py-1 rounded-lg border border-line">재시도</button>
            <button onClick={() => act('requeue', () => apiFetch('/api/v1/integration/hl7/reflex/requeue-dlq', { method: 'POST' }), (r) => `DLQ 재큐 ${(r as { requeued: number }).requeued}`)} disabled={!!busy} className="text-xs px-2 py-1 rounded-lg border border-line">DLQ 재큐</button>
            <button onClick={() => act('poll', () => apiFetch('/api/v1/integration/hl7/reflex/poll-preorders', { method: 'POST' }), () => '승인상태 폴링')} disabled={!!busy} className="text-xs px-2 py-1 rounded-lg border border-line">승인 폴링</button>
          </div>}
        </div>
        {outbound && (
          <div className="flex flex-wrap gap-1.5 text-xs">
            <span className="text-ink-3">연동 {outbound.configured ? '' : '미설정'} · 재시도임계 {outbound.maxRetry}</span>
            {Object.entries(outbound.counts).map(([s, n]) => <span key={s} className="px-2 py-0.5 rounded bg-bg border border-line">{s} {n}</span>)}
            {Object.keys(outbound.counts).length === 0 && <span className="text-ink-3">발신 이력 없음</span>}
          </div>
        )}
        {/* 개별 발신 건 — 어떤 오더가 정체·DLQ 근접인지 확인(재시도횟수·오류). status 카운트만으로는 특정 불가. */}
        {outbound?.rows && outbound.rows.length > 0 && (
          <div className="overflow-x-auto mt-3">
            <table className="w-full text-xs">
              <thead><tr className="text-left text-ink-2 border-b border-line"><th className="py-1">시각</th><th>제어ID</th><th>상태</th><th>재시도</th><th>HIS참조</th><th>오류</th></tr></thead>
              <tbody>
                {outbound.rows.slice(0, 40).map((r) => (
                  <tr key={r.logId} className="border-b border-line last:border-0">
                    <td className="py-1 mono text-ink-3">{r.createdDt?.slice(0, 16).replace('T', ' ')}</td>
                    <td className="mono">{r.messageControlId ?? '—'}</td>
                    <td><StatusChip code={r.status} tone={r.status === 'PROCESSED' || r.status === 'APPROVED' ? 'good' : r.status === 'FAILED' || r.status === 'DLQ' || r.status === 'REJECTED' ? 'warn' : 'neutral'} /></td>
                    <td className={`mono ${(r.retryCount ?? 0) >= outbound.maxRetry ? 'text-crit font-bold' : ''}`}>{r.retryCount ?? 0}{(r.retryCount ?? 0) >= outbound.maxRetry ? '' : ''}</td>
                    <td className="mono text-ink-3">{r.hisRef ?? '—'}</td>
                    <td className="text-ink-2 max-w-xs truncate" title={r.errorText ?? undefined}>{r.errorText ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {outbound.rows.length > 40 && <p className="text-[11px] text-ink-3 mt-1">최근 40건 표시(총 {outbound.rows.length}).</p>}
          </div>
        )}
      </section>

      {/* PACS 컷오버 프리플라이트 — 실 병리번호·PID 검증 */}
      <section className="card mb-4">
        <h2 className="t-section mb-1">PACS 컷오버 프리플라이트 <span className="text-xs text-ink-3 font-normal">Accession(≤16) · PID 바이트보존 즉석 검증</span></h2>
        <div className="grid sm:grid-cols-2 gap-2 mt-2">
          <textarea aria-label="병리번호 목록" value={pf.spNos} onChange={(e) => setPf({ ...pf, spNos: e.target.value })} rows={3} placeholder="병리번호(줄바꿈/쉼표)&#10;SP-2026-0456" className="mono text-xs px-2 py-1.5 rounded-lg border border-line bg-bg" />
          <textarea aria-label="환자ID 목록" value={pf.patientIds} onChange={(e) => setPf({ ...pf, patientIds: e.target.value })} rows={3} placeholder="환자ID(줄바꿈/쉼표)&#10;00123456" className="mono text-xs px-2 py-1.5 rounded-lg border border-line bg-bg" />
        </div>
        <button onClick={async () => {
          const parse = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
          try { const r = await apiFetch<typeof pfResult>('/api/v1/integration/hl7/pacs/cutover-preflight', { method: 'POST', body: JSON.stringify({ spNos: parse(pf.spNos), patientIds: parse(pf.patientIds) }) }); setPfResult(r); }
          catch (e) { toast(e instanceof Error ? e.message : '프리플라이트 실패', 'error'); }
        }} className="mt-2 py-1.5 px-3 rounded-lg bg-teal text-white text-sm font-semibold">검증 실행</button>
        {pfResult && (
          <div className="mt-3 grid sm:grid-cols-2 gap-3 text-xs">
            <div>
              <div className="font-bold text-ink-2 mb-1">Accession</div>
              {pfResult.accession.length === 0 ? <p className="text-ink-3">입력 없음</p> : pfResult.accession.map((a) => (
                <div key={a.spNo} className="flex items-center gap-2 border-b border-line py-0.5">
                  <span className="mono">{a.spNo}→{a.accession}</span><span className="text-ink-3">({a.length})</span>
                  <span className={`ml-auto font-bold ${a.ok ? 'text-good' : 'text-crit'}`}>{a.ok ? 'OK' : (a.reason ?? 'NG')}</span>
                </div>
              ))}
            </div>
            <div>
              <div className="font-bold text-ink-2 mb-1">PatientID</div>
              {pfResult.patientId.length === 0 ? <p className="text-ink-3">입력 없음</p> : pfResult.patientId.map((p) => (
                <div key={p.input} className="flex items-center gap-2 border-b border-line py-0.5">
                  <span className="mono">{p.input}</span>{p.risks.length > 0 && <span className="text-warn">[{p.risks.join(',')}]</span>}
                  <span className={`ml-auto font-bold ${p.preserved ? 'text-good' : 'text-crit'}`} title={p.note}>{p.preserved ? 'OK' : 'NG'}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* 최근 연계 로그 */}
      <section className="card">
        <div className="flex items-center justify-between mb-2"><h2 className="t-section">최근 연계 로그</h2><button onClick={loadStatus} className="text-xs text-teal underline">새로고침</button></div>
        {logs.length === 0 ? <p className="text-xs text-ink-3">로그 없음</p> : (
          <div className="overflow-x-auto max-h-96 overflow-y-auto"><table className="w-full text-xs">
            <thead><tr className="text-left text-ink-2 border-b border-line sticky top-0 bg-surface"><th className="py-1">시각</th><th>방향</th><th>유형</th><th>MCID</th><th>상태</th></tr></thead>
            <tbody>{logs.map((l) => (
              <tr key={l.logId} className="border-b border-line last:border-0">
                <td className="py-1 mono whitespace-nowrap">{new Date(l.createdDt).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                <td>{l.direction === 'INBOUND' ? '수신' : '발신'}</td>
                <td className="text-ink-2">{l.messageType ?? l.ifId ?? '—'}</td>
                <td className="mono text-ink-3">{(l.messageControlId ?? '').slice(0, 20)}</td>
                <td><StatusChip code={l.status} tone={l.status === 'PROCESSED' || l.status === 'RECEIVED' ? 'good' : l.status === 'FAILED' || l.status === 'DLQ' ? 'warn' : 'neutral'} />{l.errorText && <span className="text-ink-3 ml-1" title={l.errorText}>ⓘ</span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
    </main>
  );
}
