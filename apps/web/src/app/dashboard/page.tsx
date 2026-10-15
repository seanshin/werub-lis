'use client';

/**
 * 대시보드 화면 (`/dashboard`).
 *
 * 데이터는 `lib/api.ts`의 `apiFetch`로만 가져온다(HTTP 호출 정본).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { apiFetch, getToken, getUserId, getRoles } from '@/lib/api';
import { refreshBadge } from '@/lib/badge';
import { useToast } from '@/components/toast';
import FirstRunHint from '@/components/FirstRunHint';

interface CriticalNotify { notifyId: string; dispatchStatus?: string | null; category?: string | null; label?: string | null; value?: string | null; patientName?: string | null; escalationLevel?: number | null; notifyTarget?: string | null; createdDt?: string | null; result: { value: string | null; flag: string | null; test: { name: string }; specimen: { specimenNo: string; order: { patient: { name: string } } } } | null; }

// 통보 경과(분) — 오래 미확인일수록 위험(상향 대상). createdDt 기준.
function elapsedMin(iso?: string | null): number | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return ms >= 0 ? Math.floor(ms / 60000) : null;
}
function elapsedLabel(min: number | null): string {
  if (min == null) return '';
  if (min < 60) return `${min}분 경과`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h}시간 경과` : `${Math.floor(h / 24)}일 경과`;
}
interface Notification { notifyId: string; ntype: string | null; message: string | null; }
interface Tat { count: number; meanMin: number; p90Min: number; }
interface Vol { total: number; rerunRatePct: number; }
interface Pending { overdue: boolean; }
interface Unit { expiryStatus: string; }
interface Overview {
  integration: { hisFhir: boolean; pacs: boolean; hisOrderPoll: boolean; reflexPoll: boolean; reflex: Record<string, number> };
  today: { received: number; inProcess: number; completed: number; reported: number; cancelled: number; total: number };
  domains: { diagnosticPending: number; pathologyOpen: number; culturing: number; bloodExpiring: number; genomicPending: number };
  qc: { failToday: number };
  generatedAt: string;
}

function Card({ label, value, sub, tone, href, hint }: { label: string; value: string; sub?: string; tone?: 'crit' | 'warn' | 'good'; href?: string; hint?: string }) {
  const c = tone === 'crit' ? 'text-crit' : tone === 'warn' ? 'text-warn' : tone === 'good' ? 'text-good' : 'text-teal';
  const body = (
    <>
      <div className="text-xs text-ink-2 mb-1 flex items-center gap-1">{label}{hint && <span title={hint} className="text-ink-3 cursor-help border border-line rounded-full w-3.5 h-3.5 inline-flex items-center justify-center text-[11px] leading-none">?</span>}</div>
      <div className={`text-2xl font-extrabold mono ${c}`}>{value}</div>
      {sub && <div className="text-xs text-ink-3 mt-0.5">{sub}</div>}
    </>
  );
  const cls = 'card block';
  return href
    ? <Link href={href} className={`${cls} hover:border-teal transition`}>{body}</Link>
    : <div className={cls}>{body}</div>;
}

/** 연동/설정 상태 배지 */
function StatusDot({ on, onLabel, offLabel }: { on: boolean; onLabel: string; offLabel: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      <span className={`w-2.5 h-2.5 rounded-full ${on ? 'bg-good' : 'bg-ink-3'}`} />
      <span className={on ? 'text-ink' : 'text-ink-3'}>{on ? onLabel : offLabel}</span>
    </span>
  );
}
const RX_LABEL: Record<string, string> = { STAGED: '대기', PROCESSED: '발신', FAILED: '실패', DLQ: '격리', APPROVED: '승인', REJECTED: '반려', SENDING: '전송중', REJECTED_CANCELLED: '반려취소' };
const RX_TONE: Record<string, string> = { STAGED: 'bg-bg text-ink-2', PROCESSED: 'bg-teal/10 text-teal', FAILED: 'bg-warn/15 text-warn', DLQ: 'bg-warn/20 text-warn', APPROVED: 'bg-good/15 text-good', REJECTED: 'bg-warn/15 text-warn' };

export default function DashboardPage() {
  const router = useRouter();
  const toast = useToast();
  const [criticals, setCriticals] = useState<CriticalNotify[]>([]);
  const [notis, setNotis] = useState<Notification[]>([]);
  const [tat, setTat] = useState<Tat | null>(null);
  const [vol, setVol] = useState<Vol | null>(null);
  const [pendingCnt, setPendingCnt] = useState<{ total: number; overdue: number } | null>(null);
  const [expiring, setExpiring] = useState<number | null>(null);
  const [ov, setOv] = useState<Overview | null>(null);
  const [updated, setUpdated] = useState('');
  const [busy, setBusy] = useState('');
  // 위험치 통보확인 시 복창(read-back) 입력 상태 — 어느 통보를 확인 중인지 + 복창자·메모
  const [ackFor, setAckFor] = useState<string | null>(null);
  const [readback, setReadback] = useState<Record<string, { by: string; note: string }>>({});
  const ackBy = getUserId() ?? undefined;
  // 내 작업(P2 역할별 랜딩·위젯) — 역할 관련 워크리스트 건수(권한 있는 역할만 조회)
  const [wlCount, setWlCount] = useState<number | null>(null); // 결과입력 워크리스트(TEC·MIC)
  const [vfCount, setVfCount] = useState<number | null>(null); // 검증 보류(PHY)
  const [dtCount, setDtCount] = useState<number | null>(null); // 다운타임 대사 대기(RCP)

  const load = useCallback(async () => {
    const [c, n] = await Promise.all([
      apiFetch<CriticalNotify[]>('/api/v1/results/criticals/pending').catch(() => []),
      apiFetch<Notification[]>('/api/v1/notifications/pending').catch(() => []),
    ]);
    setCriticals(c); setNotis(n);
    setUpdated(new Date().toTimeString().slice(0, 5));
    apiFetch<Overview>('/api/v1/dashboard/overview').then(setOv).catch(() => {}); // 전 역할 공개
    // 통계·재고·워크리스트는 권한 있는 역할만 호출(불필요한 403·감사 노이즈 방지)
    const roles = getRoles();
    const hasStat = roles.some((r) => ['TEC', 'PHY', 'MIC', 'PAT', 'BB', 'ADM', 'AUD'].includes(r)); // F-STAT:R
    if (hasStat) {
      apiFetch<Tat>('/api/v1/stats/tat').then(setTat).catch(() => {});
      apiFetch<Vol>('/api/v1/stats/volumes').then(setVol).catch(() => {});
      apiFetch<Pending[]>('/api/v1/stats/pending').then((p) => setPendingCnt({ total: p.length, overdue: p.filter((x) => x.overdue).length })).catch(() => {});
    }
    if (roles.some((r) => ['BB', 'ADM'].includes(r))) apiFetch<Unit[]>('/api/v1/transfusion/inventory').then((u) => setExpiring(u.filter((x) => x.expiryStatus !== 'OK').length)).catch(() => {});
    if (roles.some((r) => ['TEC', 'MIC'].includes(r))) apiFetch<unknown[]>('/api/v1/orders/specimens/worklist').then((r) => setWlCount(r.length)).catch(() => {});
    if (roles.includes('PHY')) apiFetch<unknown[]>('/api/v1/results/worklist').then((r) => setVfCount(r.length)).catch(() => {});
    if (roles.includes('RCP')) apiFetch<unknown[]>('/api/v1/orders/downtime/pending').then((r) => setDtCount(r.length)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!getToken()) { router.push('/'); return; }
    void load();
    const t = setInterval(() => void load(), 45_000); // B7 자동 갱신
    return () => clearInterval(t);
  }, [load, router]);

  // B1 위험치 폐루프: 통보확인(ack, 복창 read-back 동반) / 재발송(dispatch)
  // ★복창(read-back)은 위험치 통보의 핵심 안전 단계 — 통보받은 사람이 값을 되읽어 확인한다.
  //   확인만 하고 복창을 안 남기면 "누가 정말 받았는지"가 사라져 폐루프가 끊긴다.
  async function ack(notifyId: string) {
    const rb = readback[notifyId];
    if (!rb?.by?.trim()) { toast('복창 확인자(통보받아 값을 되읽은 사람)를 입력하세요', 'error'); return; }
    setBusy(notifyId);
    try {
      await apiFetch(`/api/v1/results/criticals/${notifyId}/ack`, {
        method: 'POST',
        body: JSON.stringify({ ackBy, readbackBy: rb.by.trim(), readbackNote: rb.note?.trim() || undefined }),
      });
      toast('통보 확인·복창 기록됨', 'success'); setAckFor(null); await load(); refreshBadge();
    } catch (e) { toast(e instanceof Error ? e.message : '확인 실패', 'error'); }
    finally { setBusy(''); }
  }
  // 시스템 알림 확인(QC·MDRO·AST·근접만료·Reflex반려 등)
  async function ackNoti(notifyId: string) {
    try { await apiFetch(`/api/v1/notifications/${notifyId}/ack`, { method: 'POST', body: '{}' }); toast('알림 확인됨', 'success'); await load(); refreshBadge(); }
    catch (e) { toast(e instanceof Error ? e.message : '확인 실패', 'error'); }
  }
  async function dispatch(notifyId: string) {
    setBusy(notifyId + ':d');
    try { await apiFetch(`/api/v1/results/criticals/${notifyId}/dispatch`, { method: 'POST' }); toast('재발송 요청됨', 'info'); await load(); }
    catch (e) { toast(e instanceof Error ? e.message : '재발송 실패', 'error'); }
    finally { setBusy(''); }
  }

  return (
    <main className="page">
      <div className="flex items-center justify-between mb-4">
        <h1 className="t-page">대시보드</h1>
        <div className="flex items-center gap-3">
          {updated && <span className="text-xs text-ink-3">업데이트 {updated}</span>}
          <Link href="/results/entry" className="text-sm bg-teal text-white px-3 py-1.5 rounded-lg font-semibold">결과 입력 →</Link>
        </div>
      </div>

      <FirstRunHint />

      {/* 내 작업 — 역할 관련 워크리스트 바로가기(P2: 전 역할 동일 대시보드이던 것) */}
      {(() => {
        const roles = getRoles();
        const todayTotal = ov ? ov.today.total : null;
        const chips: { label: string; href: string; count: number | null; tone?: 'crit' | 'warn' }[] = [];
        if (roles.includes('RCP')) {
          chips.push({ label: '오늘 오더', href: '/orders', count: todayTotal });
          chips.push({ label: '다운타임 대사', href: '/orders/downtime', count: dtCount, tone: dtCount ? 'warn' : undefined });
        }
        if (roles.some((r) => ['TEC', 'MIC'].includes(r))) chips.push({ label: '결과입력 워크리스트', href: '/results/entry', count: wlCount });
        if (roles.includes('PHY')) chips.push({ label: '검증 보류', href: '/verify', count: vfCount, tone: vfCount ? 'warn' : undefined });
        if (roles.includes('PAT')) chips.push({ label: '병리 판독대기', href: '/pathology', count: ov?.domains.pathologyOpen ?? null });
        if (roles.includes('BB')) chips.push({ label: '수혈 만료임박', href: '/transfusion', count: expiring, tone: expiring ? 'warn' : undefined });
        if (roles.includes('MIC')) {
          chips.push({ label: '배양 진행', href: '/microbiology', count: ov?.domains.culturing ?? null });
          chips.push({ label: '감염병 신고', href: '/microbiology/notifiable', count: null });
        }
        if (roles.some((r) => ['GEN', 'GC'].includes(r))) chips.push({ label: '유전체 미해석', href: '/genomic', count: ov?.domains.genomicPending ?? null });
        if (roles.includes('ADM')) { chips.push({ label: '연계 콘솔', href: '/admin/integration', count: null }); chips.push({ label: '서명·결재', href: '/admin/gates', count: null }); }
        if (roles.includes('AUD')) chips.push({ label: '감사 조회', href: '/audit', count: null });
        if (chips.length === 0) return null;
        return (
          <section className="mb-4">
            <div className="text-xs text-ink-2 mb-1.5">내 작업</div>
            <div className="flex flex-wrap gap-2">
              {chips.map((c) => (
                <Link key={`${c.href}|${c.label}`} href={c.href}
                  className={`px-3 py-1.5 rounded-full border text-sm font-semibold flex items-center gap-1.5 ${c.tone === 'warn' ? 'border-warn/50 text-warn bg-warn/10' : 'border-line bg-surface hover:border-teal'}`}>
                  {c.label}
                  {c.count != null && <span className="mono font-extrabold">{c.count}</span>}
                  <span aria-hidden>→</span>
                </Link>
              ))}
            </div>
          </section>
        );
      })()}

      {/* 요약 카드 (설명 툴팁 포함) — 권한상 조회 불가한 카드는 '—' 대신 렌더하지 않는다(P2) */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3 mb-4">
        <Card label="위험치 대기" value={String(criticals.length)} tone={criticals.length ? 'crit' : 'good'} hint="위험치(panic value) 결과의 미확인 통보 건수. 0이어야 정상 — 있으면 즉시 담당의 통보·확인(폐루프) 필요." />
        {pendingCnt && <Card label="미보고" value={String(pendingCnt.total)} sub={pendingCnt.overdue ? `지연 ${pendingCnt.overdue}` : '지연 없음'} tone={pendingCnt.overdue ? 'warn' : undefined} href="/stats" hint="아직 보고되지 않은 검사 건수. '지연'은 TAT 목표 초과분 — 우선 처리 대상." />}
        {tat && <Card label="TAT 평균" value={`${tat.meanMin}분`} sub={`p90 ${tat.p90Min}분`} href="/stats" hint="접수→보고 소요시간(Turnaround Time) 평균. p90은 90% 검사가 이 시간 내 완료. 짧을수록 좋음." />}
        {vol && <Card label="검사량(30일)" value={String(vol.total)} sub={`재검 ${vol.rerunRatePct}%`} href="/stats" hint="최근 30일 총 검사 건수와 재검률. 재검률이 높으면 검체/장비 품질 점검 필요." />}
        {expiring != null && <Card label="재고 임박/만료" value={String(expiring)} tone={expiring ? 'warn' : undefined} href="/transfusion" hint="유효기간 임박/만료 혈액제제 수. 폐기·우선사용 관리 대상." />}
        <Card label="시스템 알림" value={String(notis.length)} tone={notis.length ? 'warn' : undefined} href="/notifications" hint="QC 실패·내성균 등 시스템 자동 알림. 확인·조치 필요." />
      </div>

      {/* 연계·시스템 상태 */}
      <section className="card mb-4">
        <h2 className="t-section mb-1 flex items-center gap-2">연계 · 시스템 상태</h2>
        <p className="text-xs text-ink-3 mb-3">HIS·PACS 연동과 Reflex 양방향 오더 발신 상태. 연동이 꺼져 있으면 자격증명·설정(운영자) 확인이 필요합니다.</p>
        <div className="flex flex-wrap gap-x-6 gap-y-2 mb-3">
          <StatusDot on={!!ov?.integration.hisFhir} onLabel="HIS FHIR 연동" offLabel="HIS 미연동(자격증명 대기)" />
          <StatusDot on={!!ov?.integration.pacs} onLabel="PACS 연동" offLabel="PACS 미연동" />
          <StatusDot on={!!ov?.integration.hisOrderPoll} onLabel="오더 폴링 ON" offLabel="오더 폴링 OFF" />
          <StatusDot on={!!ov?.integration.reflexPoll} onLabel="Reflex 폴링 ON" offLabel="Reflex 폴링 OFF" />
        </div>
        <div className="pt-3 border-t border-line">
          <div className="text-xs text-ink-2 mb-1.5">Reflex 양방향 오더 발신 <span className="text-ink-3" title="결과확정 시 후속검사를 HIS로 발신. STAGED=발신대기, 발신=성공, 실패/격리=재시도·DLQ, 승인/반려=HIS 의사 게이트 결과.">ⓘ</span></div>
          {ov && Object.keys(ov.integration.reflex).length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(ov.integration.reflex).map(([s, n]) => (
                <span key={s} className={`px-2 py-0.5 rounded text-xs font-medium ${RX_TONE[s] ?? 'bg-bg text-ink-2'}`}>{RX_LABEL[s] ?? s} {n}</span>
              ))}
            </div>
          ) : <span className="text-xs text-ink-3">발신 이력 없음</span>}
        </div>
      </section>

      {/* 오늘 처리 현황 */}
      <section className="card mb-4">
        <h2 className="t-section mb-1">오늘 처리 현황</h2>
        <p className="text-xs text-ink-3 mb-3">오늘 등록(orderDt) 기준 오더의 진행 단계별 분포. 접수→진행→완료→보고 순으로 이동합니다.</p>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {([['received', '접수', 'text-teal'], ['inProcess', '진행', 'text-indigo'], ['completed', '완료', 'text-good'], ['reported', '보고', 'text-good'], ['cancelled', '취소', 'text-ink-3']] as const).map(([k, lbl, col]) => (
            <div key={k} className="text-center">
              <div className={`text-2xl font-extrabold mono ${col}`}>{ov ? ov.today[k] : '—'}</div>
              <div className="text-xs text-ink-2">{lbl}</div>
            </div>
          ))}
        </div>
        <Link href="/orders" className="text-xs text-teal underline mt-2 inline-block">오더 처리이력·CSV →</Link>
      </section>

      {/* 5분야별 처리 현황 */}
      <section className="card mb-4">
        <h2 className="t-section mb-1">분야별 처리 현황</h2>
        <p className="text-xs text-ink-3 mb-3">5개 검사 분야의 대기·진행 업무량. 각 카드를 눌러 해당 워크리스트로 이동합니다.</p>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <Card label="진단검사 미보고" value={ov ? String(ov.domains.diagnosticPending) : '—'} href="/verify" hint="접수·진행 상태의 미보고 검사항목. 결과입력·검증 대상." />
          <Card label="병리 판독대기" value={ov ? String(ov.domains.pathologyOpen) : '—'} tone={ov?.domains.pathologyOpen ? 'warn' : undefined} href="/pathology" hint="완료·개정 이외(접수·그로싱·판독대기) 병리 케이스." />
          <Card label="미생물 배양진행" value={ov ? String(ov.domains.culturing) : '—'} href="/microbiology" hint="완료되지 않은 배양(예비보고·진행) 건수." />
          <Card label="수혈 만료임박" value={ov ? String(ov.domains.bloodExpiring) : '—'} tone={ov?.domains.bloodExpiring ? 'warn' : undefined} href="/transfusion" hint="7일 이내 유효기간 만료 예정 재고 제제." />
          <Card label="유전체 미해석" value={ov ? String(ov.domains.genomicPending) : '—'} href="/genomic" hint="확정(FINAL) 해석이 없는 변이를 가진 유전체 오더." />
          <Card label="QC 실패(오늘)" value={ov ? String(ov.qc.failToday) : '—'} tone={ov?.qc.failToday ? 'crit' : undefined} href="/qc" hint="오늘 Westgard 규칙 위반(FAIL) QC 결과. 있으면 해당 검사 결과 차단·재교정 필요." />
        </div>
      </section>

      <div className="grid md:grid-cols-2 gap-4">
        {/* 위험치 통보 대기 */}
        <section className="card">
          <h2 className="t-section mb-3 flex items-center gap-2">위험치(Panic) 통보 대기
            <span className="mono text-xs bg-crit/10 text-crit px-2 py-0.5 rounded">{criticals.length}</span>
          </h2>
          {criticals.length === 0 ? <p className="text-sm text-ink-2">대기 없음 </p> : (
            <ul className="flex flex-col gap-2">
              {criticals.map((c) => (
                <li key={c.notifyId} className="border-b border-line pb-2 last:border-0">
                  <div className="flex justify-between items-center gap-2 text-sm">
                    <span className="min-w-0">
                      <span className="font-medium">{c.result?.specimen.order.patient.name ?? c.patientName ?? '-'}</span> · {c.result?.test.name ?? c.label ?? (c.category === 'MICRO' ? '미생물' : '위험치')}
                      <span className="mono font-bold text-crit ml-1">{c.result?.value ?? c.value} {c.result?.flag ?? ''}</span>
                      <span className="block text-[11px] text-ink-3">
                        {(() => { const m = elapsedMin(c.createdDt); return m != null ? <span className={m >= 30 ? 'text-crit font-bold' : ''}>{elapsedLabel(m)}</span> : null; })()}
                        {!!c.escalationLevel && c.escalationLevel > 0 && <span className="ml-1 px-1 py-0.5 rounded bg-crit/15 text-crit font-bold">↑상향 {c.escalationLevel}단계{c.notifyTarget ? ` · ${c.notifyTarget}` : ''}</span>}
                        {c.dispatchStatus && <span className="ml-1 text-ink-3">발송 {c.dispatchStatus}</span>}
                      </span>
                    </span>
                    <span className="flex gap-1 shrink-0">
                      <button onClick={() => dispatch(c.notifyId)} disabled={busy === c.notifyId + ':d'}
                        className="text-xs px-2 py-1 rounded-lg border border-line text-ink-2 hover:border-teal disabled:opacity-50">재발송</button>
                      <button onClick={() => setAckFor(ackFor === c.notifyId ? null : c.notifyId)}
                        className="text-xs px-2 py-1 rounded-lg bg-teal text-white font-semibold">통보확인</button>
                    </span>
                  </div>
                  {/* 복창(read-back) 폐루프 — 통보받은 사람이 값을 되읽어 확인. 이걸 남겨야 "누가 받았는지"가 추적된다 */}
                  {ackFor === c.notifyId && (
                    <div className="mt-2 flex flex-wrap gap-1.5 items-center bg-crit/[0.04] rounded-lg p-2">
                      <span className="text-[11px] text-ink-2">복창 확인:</span>
                      <input aria-label="복창 확인자" placeholder="통보받은 사람(복창자)" value={readback[c.notifyId]?.by ?? ''}
                        onChange={(e) => setReadback({ ...readback, [c.notifyId]: { ...readback[c.notifyId], by: e.target.value, note: readback[c.notifyId]?.note ?? '' } })}
                        className="px-2 py-1 rounded-lg border border-line bg-surface text-xs w-40" />
                      <input aria-label="복창 메모" placeholder="복창 내용(예: K 6.8 되읽음)" value={readback[c.notifyId]?.note ?? ''}
                        onChange={(e) => setReadback({ ...readback, [c.notifyId]: { ...readback[c.notifyId], note: e.target.value, by: readback[c.notifyId]?.by ?? '' } })}
                        className="px-2 py-1 rounded-lg border border-line bg-surface text-xs flex-1 min-w-[8rem]" />
                      <button onClick={() => ack(c.notifyId)} disabled={busy === c.notifyId}
                        className="text-xs px-3 py-1 rounded-lg bg-crit text-white font-semibold disabled:opacity-50">확인 완료</button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 시스템 알림 */}
        <section className="card">
          <div className="flex items-center justify-between mb-3">
            <h2 className="t-section">시스템 알림</h2>
            <a href="/notifications" className="text-xs text-teal underline">전체·이력 →</a>
          </div>
          {notis.length === 0 ? <p className="text-sm text-ink-2">알림 없음</p> : (
            <ul className="flex flex-col gap-2">
              {notis.map((n) => (
                <li key={n.notifyId} className="text-sm border-b border-line pb-2 last:border-0 flex items-start justify-between gap-2">
                  <div><span className="mono text-xs text-warn">{n.ntype}</span> · {n.message}</div>
                  <div className="flex gap-1 shrink-0">
                    {n.ntype === 'Reflex반려' && <a href="/admin/reflex" className="text-xs text-indigo underline whitespace-nowrap">처리</a>}
                    <button onClick={() => ackNoti(n.notifyId)} className="text-xs text-teal hover:underline whitespace-nowrap">확인</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
