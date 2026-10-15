'use client';

/**
 * Reflex(반사검사) 프로토콜 화면 (`/admin/reflex`).
 *
 * 사이드바 노출 역할: TEC, PHY, ADM.
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
import { useConfirm } from '@/components/confirm';
import { EmptyState, ErrorText, Loading } from '@/components/ui';
import {IconWarn, IconChevron } from '@/components/Icon';

interface Ev { eventId: string; event: string; actor: string | null; note: string | null; createdDt: string; }
interface Protocol {
  protocolId: string; name: string; version: number; status: string;
  whenTestCode: string; operator: string; threshold: number | null; thresholdHigh: number | null; flag: string | null;
  addTestCodes: string; priority: string | null; specialistBy: string | null; committeeNo: string | null; hisRef: string | null;
  effectiveFrom: string | null; effectiveTo: string | null; events?: Ev[];
}

const OPERATORS = [
  { v: '>=', label: '≥ 임계값' }, { v: '<=', label: '≤ 임계값' }, { v: '>', label: '> 임계값' }, { v: '<', label: '< 임계값' },
  { v: 'BETWEEN', label: '범위(하한~상한)' }, { v: 'OUT_OF_REF', label: '참고범위 밖' }, { v: 'FLAG', label: '지정 플래그' },
];
const statusCls: Record<string, string> = {
  ACTIVE: 'bg-good/15 text-good', DRAFT: 'bg-bg text-ink-2', REJECTED: 'bg-warn/15 text-warn',
  SUSPENDED: 'bg-warn/15 text-warn', RETIRED: 'bg-bg text-ink-3 line-through', SUPERSEDED: 'bg-bg text-ink-3 line-through',
  PENDING_SPECIALIST: 'bg-indigo/15 text-indigo', PENDING_COMMITTEE: 'bg-indigo/15 text-indigo', PENDING_HIS: 'bg-indigo/15 text-indigo',
};
const statusLabel: Record<string, string> = {
  DRAFT: '초안', PENDING_SPECIALIST: '전문의 검토', PENDING_COMMITTEE: '위원회 의결', PENDING_HIS: 'HIS 등록',
  ACTIVE: '실행중', REJECTED: '반려', SUSPENDED: '중지', RETIRED: '폐기', SUPERSEDED: '대체됨(개정)',
};
const empty = { name: '', whenTestCode: '', operator: '>=', threshold: '', thresholdHigh: '', flag: '', addTestCodes: '', priority: '', effectiveFrom: '', effectiveTo: '', supersedesProtocolId: '' };

// 발화 조건 표기 — BETWEEN은 하한~상한 범위로 표시(단일값 오독 방지)
function condLabel(p: { operator: string; threshold: number | null; thresholdHigh: number | null; flag: string | null }): string {
  if (p.operator === 'BETWEEN') return `${p.threshold ?? '?'}~${p.thresholdHigh ?? '?'}`;
  if (p.operator === 'FLAG') return p.flag ?? '';
  if (p.operator === 'OUT_OF_REF') return '참고범위 밖';
  return `${p.operator} ${p.threshold ?? p.flag ?? ''}`;
}

export default function ReflexAdminPage() {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const roles = getRoles();
  const isPhy = roles.includes('PHY') || roles.includes('ADM');
  const isAdm = roles.includes('ADM');
  const isAuthor = roles.includes('TEC') || isPhy; // 작성/수정/제출 권한(AUTHOR=TEC/PHY/ADM). MIC·AUD는 조회 전용
  const [list, setList] = useState<Protocol[]>([]);
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState<Protocol | null>(null);
  const [form, setForm] = useState({ ...empty });
  const [editing, setEditing] = useState(false);
  const [committeeNo, setCommitteeNo] = useState('');
  const [hisRef, setHisRef] = useState('');
  const [outbound, setOutbound] = useState<{ configured: boolean; counts: Record<string, number> } | null>(null);
  const [report, setReport] = useState<{ total: number; truncated?: boolean; totalApproved: number; totalRejected: number; trend: { date: string; count: number }[]; protocols: { protocolId: string; name: string; executions: number; approved: number; rejected: number; rejectionRatePct: number | null; outbound: Record<string, number> }[] } | null>(null);
  const [showReport, setShowReport] = useState(false);
  const [rejections, setRejections] = useState<{ mcid: string; protocolName: string | null; orderId: string | null; addTestCode: string | null; patientId: string | null; itemStatus: string | null; resulted: boolean; rejectedDt: string }[]>([]);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try { setList(await apiFetch<Protocol[]>('/api/v1/reflex/protocols')); }
    catch (e) { setErr(e instanceof Error ? e.message : '조회 실패(권한 필요)'); }
    finally { setLoading(false); }
  }, []);

  const loadOutbound = useCallback(async () => {
    if (!isAdm) return;
    try { setOutbound(await apiFetch('/api/v1/integration/hl7/reflex/outbound')); } catch { /* noop */ }
  }, [isAdm]);

  const loadReport = useCallback(async () => {
    try { setReport(await apiFetch('/api/v1/reflex/protocols/report')); } catch { /* noop */ }
  }, []);
  const loadRejections = useCallback(async () => {
    try { setRejections(await apiFetch('/api/v1/reflex/protocols/rejections')); } catch { /* noop */ }
  }, []);

  useEffect(() => { if (!getToken()) router.push('/'); else { load(); loadOutbound(); loadReport(); loadRejections(); } }, [router, load, loadOutbound, loadReport, loadRejections]);

  async function resolveRej(mcid: string, action: 'cancel' | 'keep') {
    if (action === 'cancel' && !(await confirm({ title: '후속검사 취소', message: 'HIS 의사 반려에 따라 이 후속검사(오더 항목)를 취소합니다.', detail: [{ label: '대상', value: mcid }], danger: true, confirmLabel: '취소 처리' }))) return;
    try { await apiFetch('/api/v1/reflex/protocols/rejections/resolve', { method: 'POST', body: JSON.stringify({ mcid, action }) }); toast(action === 'cancel' ? '후속검사 취소됨' : '유지 처리됨', 'success'); await loadRejections(); await loadReport(); }
    catch (e) { toast(e instanceof Error ? e.message : '처리 실패', 'error'); }
  }

  async function flush() {
    try {
      const r = await apiFetch<{ configured: boolean; attempted: number; sent: number; failed: number }>('/api/v1/integration/hl7/reflex/flush', { method: 'POST', body: '{}' });
      toast(r.configured ? `재발신: 시도 ${r.attempted} · 발신 ${r.sent} · 실패 ${r.failed}` : 'HIS 미설정 — 발신 대기(STAGED) 유지', r.configured ? 'success' : 'info');
      await loadOutbound();
    } catch (e) { toast(e instanceof Error ? e.message : '재발신 실패', 'error'); }
  }

  async function openDetail(id: string) {
    try { setSel(await apiFetch<Protocol>(`/api/v1/reflex/protocols/${id}`)); setEditing(false); }
    catch (e) { toast(e instanceof Error ? e.message : '조회 실패', 'error'); }
  }

  function startCreate() { setForm({ ...empty }); setEditing(true); setSel(null); }
  function startEdit(p: Protocol) {
    setForm({ name: p.name, whenTestCode: p.whenTestCode, operator: p.operator, threshold: p.threshold?.toString() ?? '', thresholdHigh: p.thresholdHigh?.toString() ?? '', flag: p.flag ?? '', addTestCodes: p.addTestCodes, priority: p.priority ?? '', effectiveFrom: p.effectiveFrom ?? '', effectiveTo: p.effectiveTo ?? '', supersedesProtocolId: '' });
    setEditing(true);
  }

  async function save() {
    const num = (v: string) => (v === '' ? undefined : Number(v));
    const body = { name: form.name, whenTestCode: form.whenTestCode, operator: form.operator, threshold: num(form.threshold), thresholdHigh: num(form.thresholdHigh), flag: form.flag || undefined, addTestCodes: form.addTestCodes, priority: form.priority || undefined, effectiveFrom: form.effectiveFrom || undefined, effectiveTo: form.effectiveTo || undefined };
    try {
      if (sel) { await apiFetch(`/api/v1/reflex/protocols/${sel.protocolId}`, { method: 'PATCH', body: JSON.stringify(body) }); toast('수정됨'); }
      else { await apiFetch('/api/v1/reflex/protocols', { method: 'POST', body: JSON.stringify({ ...body, supersedesProtocolId: form.supersedesProtocolId || undefined }) }); toast('초안 생성됨'); }
      setEditing(false); await load();
    } catch (e) { toast(e instanceof Error ? e.message : '저장 실패', 'error'); }
  }

  async function act(id: string, path: string, ok: string, body?: object, danger?: boolean) {
    if (danger && !(await confirm({ title: ok, message: '이 상태 전이를 진행합니다.', danger: true, confirmLabel: '진행' }))) return;
    try { await apiFetch(`/api/v1/reflex/protocols/${id}/${path}`, { method: 'POST', body: JSON.stringify(body ?? {}) }); toast(ok); await load(); if (sel?.protocolId === id) await openDetail(id); }
    catch (e) { toast(e instanceof Error ? e.message : '실패', 'error'); }
  }

  const inp = 'px-2 py-1.5 rounded-lg border border-line bg-bg text-sm';
  const cmp = ['>=', '<=', '>', '<', 'BETWEEN'].includes(form.operator);
  const isBetween = form.operator === 'BETWEEN';

  return (
    <main className="page">
      <div className="flex items-center justify-between mb-1">
        <h1 className="t-page">Reflex(반사검사) 프로토콜</h1>
        {isAuthor && <button onClick={startCreate} className="text-sm bg-teal text-white px-3 py-1.5 rounded-lg font-semibold">＋ 초안 작성</button>}
      </div>
      <p className="text-xs text-ink-2 mb-4">사전 승인(전문의→위원회→HIS)된 <b>ACTIVE</b> 프로토콜만 자동 실행됩니다(standing order). 근거: 기획 27.</p>
      <ErrorText message={err} />

      {/* 양방향 오더 아웃바운드 현황(ADM) — HIS 발신/스테이징 */}
      {isAdm && outbound && (
        <section className="card !p-3 mb-4 flex items-center gap-3 flex-wrap">
          <span className="text-xs font-bold">양방향 오더(HIS)</span>
          <span className={`text-xs px-2 py-0.5 rounded ${outbound.configured ? 'bg-good/15 text-good' : 'bg-warn/15 text-warn'}`}>{outbound.configured ? 'HIS 연동' : 'HIS 미설정(발신 대기)'}</span>
          {Object.entries(outbound.counts).map(([s, n]) => (
            <span key={s} className="text-xs text-ink-2 mono">{s} {n}</span>
          ))}
          {Object.keys(outbound.counts).length === 0 && <span className="text-xs text-ink-3">발신 이력 없음</span>}
          <button onClick={flush} className="ml-auto text-xs px-2 py-1 rounded-lg border border-line font-semibold">재발신(flush)</button>
        </section>
      )}

      {/* HIS 의사 반려 처리(취소/유지) */}
      {rejections.length > 0 && (
        <section className="card bg-crit/5 border-crit/30 mb-4">
          <h2 className="t-section text-sm text-crit mb-2"><IconWarn className="mr-1" />HIS 의사 반려 — 후속검사 처리 필요 ({rejections.length})</h2>
          <div className="space-y-2">
            {rejections.map((r) => (
              <div key={r.mcid} className="flex items-center gap-2 text-sm flex-wrap border-b border-line last:border-0 pb-2">
                <span className="font-medium">{r.protocolName ?? r.mcid}</span>
                <span className="mono text-xs text-ink-2">{r.addTestCode}</span>
                <span className="text-xs text-ink-3">오더 {r.orderId} · 환자 {r.patientId}</span>
                {r.itemStatus && <span className={`text-[11px] px-1.5 py-0.5 rounded font-bold ${r.itemStatus === 'CANCELLED' ? 'bg-bg text-ink-3 line-through' : 'bg-bg text-ink-2'}`} title="후속검사 오더 항목 상태">{r.itemStatus}</span>}
                {r.resulted && <span className="text-[11px] px-1.5 py-0.5 rounded bg-warn/15 text-warn font-bold">이미 결과 있음</span>}
                <span className="ml-auto flex gap-1">
                  <button onClick={() => resolveRej(r.mcid, 'cancel')} className="text-xs px-2 py-1 rounded-lg border border-warn text-warn font-semibold transition-colors duration-150 hover:bg-warn/10">후속검사 취소</button>
                  <button onClick={() => resolveRej(r.mcid, 'keep')} className="text-xs px-2 py-1 rounded-lg border border-line">유지</button>
                </span>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-ink-3 mt-2">HIS 의사가 PreOrder를 반려한 Reflex 후속검사입니다. 임상 판단으로 취소(오더 항목 CANCELLED) 또는 유지하세요. '이미 결과 있음'이면 취소 신중.</p>
        </section>
      )}

      {/* QI 실행 리포트 */}
      {report && (
        <section className="card mb-4">
          <button onClick={() => setShowReport((v) => !v)} aria-expanded={showReport} className="w-full flex items-center gap-3 text-left">
            <span className="font-bold text-sm">실행 리포트(QI)</span>
            <span className="text-xs text-ink-2">총 실행 <b className="mono">{report.total}</b> · 승인 <b className="text-good mono">{report.totalApproved}</b> · 반려 <b className="text-crit mono">{report.totalRejected}</b>{report.truncated && <span className="text-warn"> · 최근 5000건만(기간을 좁혀 조회)</span>}</span>
            <IconChevron open={showReport} className="ml-auto opacity-60" />
          </button>
          {showReport && (
            report.protocols.length === 0 ? <p className="text-xs text-ink-3 mt-2">실행 기록 없음</p> : (
              <div className="overflow-x-auto mt-3">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-xs text-ink-2 border-b border-line"><th className="py-1">프로토콜</th><th>실행</th><th>발신상태</th><th>승인</th><th>반려</th><th>반려율</th></tr></thead>
                  <tbody>
                    {report.protocols.map((p) => (
                      <tr key={p.protocolId} className="border-b border-line last:border-0">
                        <td className="py-1.5">{p.name}</td>
                        <td className="mono font-bold">{p.executions}</td>
                        <td className="text-xs text-ink-2 mono">{Object.entries(p.outbound).map(([s, n]) => `${s} ${n}`).join(' · ')}</td>
                        <td className="mono text-good">{p.approved}</td>
                        <td className="mono text-crit">{p.rejected}</td>
                        <td className={`mono font-bold ${p.rejectionRatePct != null && p.rejectionRatePct >= 20 ? 'text-crit' : 'text-ink-2'}`}>{p.rejectionRatePct != null ? `${p.rejectionRatePct}%` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="text-[11px] text-ink-3 mt-2">반려율 높은 프로토콜은 과다 트리거 가능성 — 위원회 검토 권장. 발신상태: STAGED(대기)·PROCESSED(발신)·APPROVED/REJECTED(HIS 의사 승인 폴링).</p>
                {report.trend.length > 0 && (
                  <div className="mt-3">
                    <div className="text-xs text-ink-2 mb-1">일자별 실행 추세</div>
                    <div className="flex items-end gap-1 h-20">
                      {(() => { const mx = Math.max(1, ...report.trend.map((t) => t.count)); return report.trend.slice(-30).map((t) => (
                        <div key={t.date} className="flex-1 flex flex-col items-center justify-end" title={`${t.date}: ${t.count}건`}>
                          <div className="w-full bg-teal rounded-t" style={{ height: `${(t.count / mx) * 100}%`, minHeight: 2 }} />
                          <span className="text-[11px] text-ink-3 mt-0.5">{t.date.slice(5)}</span>
                        </div>
                      )); })()}
                    </div>
                  </div>
                )}
              </div>
            )
          )}
        </section>
      )}

      <div className="grid md:grid-cols-2 gap-4">
        {/* 목록 */}
        <section className="card">
          <h2 className="t-section mb-3">프로토콜 <span className="text-xs text-ink-2">({list.length})</span></h2>
          {loading ? <Loading /> : list.length === 0 ? <EmptyState title="프로토콜 없음" hint="초안을 작성해 승인 절차를 시작하세요." /> : (
            <ul className="space-y-1.5">
              {list.map((p) => (
                <li key={p.protocolId}>
                  <button onClick={() => openDetail(p.protocolId)} className={`w-full text-left px-2 py-1.5 rounded-lg hover:bg-bg ${sel?.protocolId === p.protocolId ? 'bg-teal/10' : ''}`}>
                    <span className={`text-[11px] px-1.5 py-0.5 rounded font-bold mr-1 ${statusCls[p.status] ?? ''}`}>{statusLabel[p.status] ?? p.status}</span>
                    <span className="text-sm font-medium">{p.name}</span>
                    <span className="block text-xs text-ink-3 mono">{p.whenTestCode} {condLabel(p)} → {p.addTestCodes}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 편집/상세 */}
        <section className="card">
          {editing ? (
            <>
              <h2 className="t-section mb-3">{sel ? '프로토콜 수정' : '초안 작성'}</h2>
              <div className="space-y-2">
                <input aria-label="이름" placeholder="이름(예: 갑상선 반사검사 TSH→FT4)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={`${inp} w-full`} />
                <div className="flex flex-wrap gap-2 items-center">
                  <input aria-label="트리거 검사코드" placeholder="트리거 검사코드" value={form.whenTestCode} onChange={(e) => setForm({ ...form, whenTestCode: e.target.value })} className={`${inp} mono w-32`} />
                  <select aria-label="연산자" value={form.operator} onChange={(e) => setForm({ ...form, operator: e.target.value })} className={inp}>
                    {OPERATORS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
                  </select>
                  {cmp && <input aria-label="임계값" placeholder={isBetween ? '하한' : '임계값'} value={form.threshold} onChange={(e) => setForm({ ...form, threshold: e.target.value })} className={`${inp} mono w-20`} />}
                  {isBetween && <input aria-label="상한" placeholder="상한" value={form.thresholdHigh} onChange={(e) => setForm({ ...form, thresholdHigh: e.target.value })} className={`${inp} mono w-20`} />}
                  {form.operator === 'FLAG' && (
                    <select aria-label="플래그" value={form.flag} onChange={(e) => setForm({ ...form, flag: e.target.value })} className={inp}>
                      <option value="">플래그</option><option>H</option><option>HH</option><option>L</option><option>LL</option>
                    </select>
                  )}
                </div>
                <input aria-label="후속검사코드" placeholder="후속검사코드(콤마구분, 예: CHE-FT4)" value={form.addTestCodes} onChange={(e) => setForm({ ...form, addTestCodes: e.target.value })} className={`${inp} mono w-full`} />
                <div className="flex flex-wrap gap-2 items-center">
                  <label className="text-xs text-ink-2">유효</label>
                  <input type="date" aria-label="유효 시작" value={form.effectiveFrom} onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} className={inp} />
                  <span className="text-xs text-ink-3">~</span>
                  <input type="date" aria-label="유효 종료" value={form.effectiveTo} onChange={(e) => setForm({ ...form, effectiveTo: e.target.value })} className={inp} />
                </div>
                {!sel && (() => {
                  const cands = list.filter((p) => p.status === 'ACTIVE' && p.whenTestCode === form.whenTestCode);
                  return (
                    <div className="flex flex-wrap gap-2 items-center">
                      <label className="text-xs text-ink-2" title="지정하면 활성화 시 선행이 자동 대체(SUPERSEDED)됩니다. 같은 트리거 검사만 계보로 잡힙니다.">개정 대상(선행)</label>
                      <select aria-label="개정 대상 선행 프로토콜" value={form.supersedesProtocolId} onChange={(e) => setForm({ ...form, supersedesProtocolId: e.target.value })} className={`${inp} max-w-full`} disabled={!form.whenTestCode}>
                        <option value="">신규 — 선행 없음</option>
                        {cands.map((p) => <option key={p.protocolId} value={p.protocolId}>v{p.version} · {p.name} ({p.protocolId})</option>)}
                      </select>
                      {!form.whenTestCode && <span className="text-[11px] text-ink-3">트리거 검사코드 입력 후 선택</span>}
                    </div>
                  );
                })()}
                <div className="flex gap-2 pt-1">
                  <button onClick={save} className="py-1.5 px-4 rounded-lg bg-teal text-white font-semibold text-sm">저장(초안)</button>
                  <button onClick={() => setEditing(false)} className="py-1.5 px-4 rounded-lg border border-line text-sm">취소</button>
                </div>
              </div>
            </>
          ) : sel ? (
            <>
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <h2 className="t-section">{sel.name}</h2>
                <span className={`text-[11px] px-1.5 py-0.5 rounded font-bold ${statusCls[sel.status] ?? ''}`}>{statusLabel[sel.status] ?? sel.status}</span>
                <span className="text-xs text-ink-3">v{sel.version}</span>
              </div>
              <div className="text-sm mono text-ink-2 mb-2">{sel.whenTestCode} {condLabel(sel)} → {sel.addTestCodes}</div>
              <dl className="text-xs text-ink-2 grid grid-cols-2 gap-x-3 gap-y-0.5 mb-3">
                <div>전문의: {sel.specialistBy ?? '—'}</div><div>의결번호: {sel.committeeNo ?? '—'}</div>
                <div>HIS: {sel.hisRef ?? '—'}</div><div>유효: {sel.effectiveFrom ?? '—'}~{sel.effectiveTo ?? '—'}</div>
                <div>후속 우선순위: {sel.priority ?? '기본(R)'}</div>
              </dl>

              {/* 상태별 액션(역할 게이트) */}
              <div className="flex flex-wrap gap-1.5 mb-3">
                {isAuthor && ['DRAFT', 'REJECTED'].includes(sel.status) && <button onClick={() => startEdit(sel)} className="text-xs px-2 py-1 rounded-lg border border-line">수정</button>}
                {isAuthor && sel.status === 'DRAFT' && <button onClick={() => act(sel.protocolId, 'submit', '제출됨')} className="text-xs px-2 py-1 rounded-lg bg-teal text-white font-semibold">전문의 검토 제출</button>}
                {sel.status === 'PENDING_SPECIALIST' && isPhy && <>
                  <button onClick={() => act(sel.protocolId, 'specialist-approve', '전문의 승인됨')} className="text-xs px-2 py-1 rounded-lg bg-teal text-white font-semibold">전문의 승인</button>
                  <button onClick={() => act(sel.protocolId, 'reject', '반려됨', undefined, true)} className="text-xs px-2 py-1 rounded-lg border border-crit text-crit">반려</button>
                </>}
                {sel.status === 'PENDING_COMMITTEE' && isAdm && <span className="flex gap-1 items-center">
                  <input aria-label="위원회 의결번호" placeholder="의결번호" value={committeeNo} onChange={(e) => setCommitteeNo(e.target.value)} className="text-xs px-2 py-1 rounded border border-line bg-bg w-28" />
                  <button onClick={() => { if (!committeeNo.trim()) { toast('의결번호를 입력하세요', 'info'); return; } act(sel.protocolId, 'committee', '의결 기록됨', { committeeNo }); setCommitteeNo(''); }} className="text-xs px-2 py-1 rounded-lg bg-indigo text-white font-semibold">위원회 의결 기록</button>
                  <button onClick={() => act(sel.protocolId, 'reject', '반려됨', undefined, true)} className="text-xs px-2 py-1 rounded-lg border border-crit text-crit">반려</button>
                </span>}
                {sel.status === 'PENDING_HIS' && isAdm && <span className="flex gap-1 items-center">
                  <input aria-label="HIS 참조" placeholder="HIS 참조(선택)" value={hisRef} onChange={(e) => setHisRef(e.target.value)} className="text-xs px-2 py-1 rounded border border-line bg-bg w-28" />
                  <button onClick={async () => {
                    // 활성화는 자동 후속오더를 켜는 임상적 결정 — 반드시 확인
                    if (!(await confirm({ title: '반사검사 프로토콜 활성화', message: '활성화하면 조건 충족 시 후속검사가 실제 환자에게 자동 오더됩니다.', detail: [{ label: '프로토콜', value: sel.name ?? sel.protocolId }], danger: true, confirmLabel: '활성화' }))) return;
                    await act(sel.protocolId, 'activate', 'ACTIVE 전환됨', { hisRef });
                    setHisRef('');
                  }} className="text-xs px-2 py-1 rounded-lg bg-good text-white font-semibold">HIS 수용 → ACTIVE</button>
                  <button onClick={() => act(sel.protocolId, 'reject', '반려됨', undefined, true)} className="text-xs px-2 py-1 rounded-lg border border-crit text-crit">반려</button>
                </span>}
                {sel.status === 'ACTIVE' && isAdm && <button onClick={() => act(sel.protocolId, 'suspend', '중지됨', undefined, true)} className="text-xs px-2 py-1 rounded-lg border border-warn text-warn">중지</button>}
                {sel.status === 'SUSPENDED' && isAdm && <button onClick={() => act(sel.protocolId, 'resume', '재개됨')} className="text-xs px-2 py-1 rounded-lg bg-teal text-white">재개</button>}
                {isAdm && !['RETIRED', 'SUPERSEDED'].includes(sel.status) && <button onClick={() => act(sel.protocolId, 'retire', '폐기됨', undefined, true)} className="text-xs px-2 py-1 rounded-lg border border-line text-ink-3">폐기</button>}
              </div>

              <div className="border-t border-line pt-2">
                <div className="text-xs text-ink-2 mb-1">이력</div>
                <ul className="space-y-0.5 max-h-40 overflow-y-auto">
                  {sel.events?.map((e) => (
                    <li key={e.eventId} className="text-xs text-ink-3"><span className="mono">{e.createdDt.slice(0, 16).replace('T', ' ')}</span> · <b className="text-ink-2">{e.event}</b>{e.actor ? ` · ${e.actor}` : ''}{e.note ? ` · ${e.note}` : ''}</li>
                  ))}
                </ul>
              </div>
            </>
          ) : (
            <EmptyState title="프로토콜을 선택하세요" hint="좌측에서 프로토콜을 선택하거나 초안을 작성합니다." />
          )}
        </section>
      </div>
    </main>
  );
}
