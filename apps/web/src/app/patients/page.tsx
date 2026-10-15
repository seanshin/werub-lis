'use client';

/**
 * 환자 조회 · 등록 화면 (`/patients`).
 *
 * 데이터는 `lib/api.ts`의 `apiFetch`로만 가져온다(HTTP 호출 정본).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { apiFetch, apiFetchFull, getToken, getRoles } from '@/lib/api';
import { useToast } from '@/components/toast';
import { useConfirm } from '@/components/confirm';
import { Loading, EmptyState } from '@/components/ui';
import { maskName } from '@/lib/privacy';
import { ORDER_STATUS_LABEL } from '@lis/shared';
import { IconChevron } from '@/components/Icon';

interface Patient { patientId: string; name: string; sex: string | null; birthDate: string | null; status: string; mergedInto?: string | null; }
interface OrderItem { orderItemId: string; testCode: string; status: string; }
interface Completeness { orderId: string; status: string | null; total: number; reported: number; partial: boolean; complete: boolean; specimenNos?: string[]; items: { testCode: string; testName: string; status: string }[]; }
interface CumTest { testCode: string; testName: string; unit: string | null; refRange: string; series: { dt: string | null; specimenNo: string; value: string | null; flag: string | null }[]; }
interface Cumulative { patient: { patientId: string; name: string }; tests: CumTest[]; }
interface Order { orderId: string; hisOrderNo: string | null; orderDt: string | null; status: string; priority: string; items: OrderItem[]; }
interface Visit { visitId: string; type: string | null; dept: string | null; ward: string | null; }
interface PatientDetail extends Patient {
  visits: Visit[]; orders: Order[];
  // 서버가 최근 100건만 준다 — 전체 건수와 잘림 여부를 함께 받아 화면이 "이게 전부"로 오해되지 않게 한다.
  orderTotal?: number; visitTotal?: number; ordersTruncated?: boolean; visitsTruncated?: boolean;
}

const SEX_LABEL: Record<string, string> = { M: '남', F: '여', O: '기타', U: '미상' };
const OSTATUS = ORDER_STATUS_LABEL; // 정본은 @lis/shared — 화면마다 복제하면 같은 상태가 다른 단어로 보인다
const inp = 'px-2 py-1.5 rounded-lg border border-line bg-bg text-sm';

function CompBadge({ c }: { c: Completeness }) {
  const [label, cls] = c.complete
    ? ['완결', 'bg-good/15 text-good']
    : c.partial
      ? ['부분보고', 'bg-warn/15 text-warn']
      : ['미보고', 'bg-bg text-ink-3 border border-line'];
  return <span className={`text-[11px] px-1.5 py-0.5 rounded ml-1 ${cls}`}>{label} {c.reported}/{c.total}</span>;
}

export default function PatientsPage() {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [q, setQ] = useState('');
  const [dFrom, setDFrom] = useState(''); // 기간 검색(오더 활동일) from
  const [dTo, setDTo] = useState('');
  const [list, setList] = useState<Patient[]>([]);
  const [total, setTotal] = useState(0); // 전체 건수(페이지 탭 렌더용)
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 100;
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState<PatientDetail | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [np, setNp] = useState({ patientId: '', name: '', sex: 'U', birthDate: '' });
  const [comp, setComp] = useState<Record<string, Completeness>>({});
  const [openOrder, setOpenOrder] = useState<string | null>(null);
  const [cum, setCum] = useState<Cumulative | null>(null);
  const [cumOpen, setCumOpen] = useState(false);
  const [cumFrom, setCumFrom] = useState('');
  const [cumTo, setCumTo] = useState('');
  const [editP, setEditP] = useState<{ name: string; sex: string; birthDate: string } | null>(null);
  const [mergeSrc, setMergeSrc] = useState('');
  const canRegister = getRoles().some((r) => ['RCP', 'ADM'].includes(r));
  const canMerge = getRoles().includes('ADM');

  const search = useCallback(async (query = '', from = '', to = '', pg = 0) => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      if (query.trim()) p.set('q', query.trim());
      if (from) p.set('from', from);
      if (to) p.set('to', to);
      if (pg) p.set('page', String(pg));
      const qs = p.toString();
      const res = await apiFetchFull<Patient[], { total: number; page: number; pageSize: number }>(`/api/v1/patients${qs ? `?${qs}` : ''}`);
      setList(res.data);
      setTotal(res.meta?.total ?? res.data.length);
      setPage(res.meta?.page ?? pg);
    }
    catch (e) { toast(e instanceof Error ? e.message : '조회 실패', 'error'); }
    finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { if (!getToken()) router.push('/'); else search(); }, [router, search]);

  async function openDetail(patientId: string) {
    try {
      const detail = await apiFetch<PatientDetail>(`/api/v1/patients/${encodeURIComponent(patientId)}`);
      setSel(detail); setOpenOrder(null); setComp({}); setCum(null); setCumOpen(false);
      // 완결도 병렬 선조회 → 배지 즉시 표시(한눈에). 권한 없으면 조용히 생략.
      // ★최근 20건만 — 오더 하나당 요청 하나라, 장기 환자를 열면 그대로 요청 폭증이 된다.
      //   나머지는 행을 클릭할 때 개별 조회한다(toggleCompleteness).
      const preload = detail.orders
        .slice().sort((a, b) => (b.orderDt ?? '').localeCompare(a.orderDt ?? '')).slice(0, 20);
      const entries = await Promise.all(preload.map(async (o) => {
        try { return [o.orderId, await apiFetch<Completeness>(`/api/v1/orders/${encodeURIComponent(o.orderId)}/completeness`)] as const; }
        catch { return null; }
      }));
      setComp(Object.fromEntries(entries.filter((e): e is readonly [string, Completeness] => e !== null)));
    } catch (e) { toast(e instanceof Error ? e.message : '상세 조회 실패', 'error'); }
  }

  // 오더 완결도 — 최근 20건은 선조회 배지, 그 밖은 펼칠 때 조회(미리 다 부르면 요청 폭증).
  async function toggleCompleteness(orderId: string) {
    setOpenOrder((cur) => (cur === orderId ? null : orderId));
    if (comp[orderId]) return;
    try {
      const c = await apiFetch<Completeness>(`/api/v1/orders/${encodeURIComponent(orderId)}/completeness`);
      setComp((m) => ({ ...m, [orderId]: c }));
    } catch { /* 권한 없으면 조용히 생략(선조회와 동일) */ }
  }

  // 누적(추세) 결과 — 검사별 시계열 조회/토글.
  const loadCumulative = useCallback(async (patientId: string) => {
    const qs = new URLSearchParams();
    if (cumFrom) qs.set('from', cumFrom);
    if (cumTo) qs.set('to', cumTo);
    try { setCum(await apiFetch<Cumulative>(`/api/v1/results/cumulative/${encodeURIComponent(patientId)}${qs.toString() ? `?${qs}` : ''}`)); }
    catch (e) { toast(e instanceof Error ? e.message : '누적 조회 실패', 'error'); }
  }, [cumFrom, cumTo, toast]);

  async function toggleCumulative(patientId: string) {
    if (cumOpen) { setCumOpen(false); return; }
    setCumOpen(true);
    if (!cum || cum.patient.patientId !== patientId) await loadCumulative(patientId);
  }

  async function register() {
    if (!np.patientId.trim() || !np.name.trim()) { toast('환자ID·성명은 필수입니다', 'info'); return; }
    try {
      await apiFetch('/api/v1/patients', { method: 'POST', body: JSON.stringify({ patientId: np.patientId.trim(), name: np.name.trim(), sex: np.sex, birthDate: np.birthDate || undefined }) });
      toast(`환자 등록됨 · ${np.name}`, 'success');
      setShowNew(false); setNp({ patientId: '', name: '', sex: 'U', birthDate: '' });
      await search(np.patientId.trim());
    } catch (e) { toast(e instanceof Error ? e.message : '등록 실패(중복 ID 등)', 'error'); }
  }

  // 환자 인적정보 정정 — 성별·생년 오타는 참고치 오분류로 이어짐(수정 후 상세 재조회)
  async function saveEdit() {
    if (!sel || !editP) return;
    if (!editP.name.trim()) { toast('성명은 필수입니다', 'info'); return; }
    try {
      await apiFetch(`/api/v1/patients/${encodeURIComponent(sel.patientId)}`, { method: 'PATCH', body: JSON.stringify({ name: editP.name.trim(), sex: editP.sex, birthDate: editP.birthDate || undefined }) });
      toast('환자 정보 수정됨', 'success');
      setEditP(null);
      await openDetail(sel.patientId);
      await search(q, dFrom, dTo);
    } catch (e) { toast(e instanceof Error ? e.message : '수정 실패', 'error'); }
  }

  // 환자 병합 — 중복 등록(source)의 임상 이력을 현재 환자(정본)로 이관(되돌리기 어려움 → 이중확인)
  async function doMerge() {
    if (!sel) return;
    const src = mergeSrc.trim();
    if (!src) { toast('병합할 중복 환자ID(source)를 입력하세요', 'info'); return; }
    if (src === sel.patientId) { toast('동일 환자는 병합할 수 없습니다', 'info'); return; }
    const ok = await confirm({
      title: '환자 병합 확인',
      message: '중복 환자(source)의 모든 임상 이력(오더·검체·병리·수혈·유전체 등)을 현재 환자로 이관합니다. 되돌리기 어렵습니다.',
      detail: [{ label: '정본(유지)', value: `${sel.name} · ${sel.patientId}` }, { label: '병합대상(→MERGED)', value: src }],
      danger: true, confirmLabel: '병합',
      doubleConfirm: '두 레코드가 동일 환자임을 확인했습니다.',
    });
    if (!ok) return;
    try {
      const r = await apiFetch<{ moved: Record<string, number> }>(`/api/v1/patients/${encodeURIComponent(sel.patientId)}/merge`, { method: 'POST', body: JSON.stringify({ sourceId: src }) });
      const total = Object.values(r.moved).reduce((a, b) => a + b, 0);
      toast(`병합 완료 · ${total}건 이관`, 'success');
      setMergeSrc(''); await openDetail(sel.patientId); await search(q, dFrom, dTo);
    } catch (e) { toast(e instanceof Error ? e.message : '병합 실패', 'error'); }
  }

  return (
    <main className="page">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h1 className="t-page">환자 조회 · 등록</h1>
        {canRegister && <button onClick={() => setShowNew((v) => !v)} className="text-sm bg-teal text-white px-3 py-1.5 rounded-lg font-semibold">＋ 환자 등록</button>}
      </div>

      {showNew && canRegister && (
        <section className="card mb-4">
          <h2 className="t-section mb-1">환자 등록 <span className="text-xs text-ink-3 font-normal">HIS ADT 미연동 시 수기 등록. 환자ID = HIS 등록번호</span></h2>
          <div className="flex flex-wrap items-end gap-2 mt-2">
            <div><label className="block text-xs text-ink-2 mb-1">환자ID(등록번호)</label><input aria-label="환자ID(등록번호)" className={`${inp} mono w-36`} value={np.patientId} onChange={(e) => setNp({ ...np, patientId: e.target.value })} placeholder="1234567" /></div>
            <div><label className="block text-xs text-ink-2 mb-1">성명</label><input aria-label="성명" className={`${inp} w-32`} value={np.name} onChange={(e) => setNp({ ...np, name: e.target.value })} placeholder="홍길동" /></div>
            <div><label className="block text-xs text-ink-2 mb-1">성별</label><select className={`${inp}`} value={np.sex} onChange={(e) => setNp({ ...np, sex: e.target.value })}><option value="M">남</option><option value="F">여</option><option value="O">기타</option><option value="U">미상</option></select></div>
            <div><label className="block text-xs text-ink-2 mb-1">생년월일</label><input aria-label="생년월일" type="date" className={`${inp}`} value={np.birthDate} onChange={(e) => setNp({ ...np, birthDate: e.target.value })} /></div>
            <button onClick={register} className="py-1.5 px-4 rounded-lg bg-teal text-white text-sm font-semibold">등록</button>
          </div>
        </section>
      )}

      <div className="grid md:grid-cols-2 gap-4">
        {/* 검색·목록 */}
        <section className="card">
          <form onSubmit={(e) => { e.preventDefault(); search(q, dFrom, dTo); }} className="flex flex-col gap-2 mb-3">
            <div className="flex gap-2">
              <input aria-label="환자ID · 성명 검색" className={`${inp} flex-1`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="환자ID · 성명 검색" autoComplete="off" />
              <button className="py-1.5 px-4 rounded-lg bg-teal text-white text-sm font-semibold">검색</button>
            </div>
            <div className="flex gap-2 items-center text-xs text-ink-2">
              <span className="shrink-0">오더활동 기간</span>
              <input type="date" aria-label="시작일" className={`${inp} flex-1`} value={dFrom} onChange={(e) => setDFrom(e.target.value)} />
              <span>~</span>
              <input type="date" aria-label="종료일" className={`${inp} flex-1`} value={dTo} onChange={(e) => setDTo(e.target.value)} />
              {(dFrom || dTo) && <button type="button" onClick={() => { setDFrom(''); setDTo(''); search(q, '', ''); }} className="shrink-0 px-2 py-1 rounded border border-line text-ink-3">기간해제</button>}
            </div>
          </form>
          {loading ? <Loading /> : list.length === 0 ? <EmptyState title="환자 없음" hint="검색어를 바꾸거나 환자를 등록하세요." /> : (
            <div className="overflow-x-auto max-h-[28rem] overflow-y-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-xs text-ink-2 border-b border-line sticky top-0 bg-surface"><th className="py-2">환자ID</th><th>성명</th><th>성별</th><th>생년월일</th></tr></thead>
                <tbody>
                  {list.map((p) => (
                    <tr key={p.patientId} onClick={() => openDetail(p.patientId)} className={`border-b border-line last:border-0 cursor-pointer hover:bg-bg ${sel?.patientId === p.patientId ? 'bg-teal/10' : ''}`}>
                      <td className="py-2 mono">{p.patientId}</td><td>{maskName(p.name)}</td><td>{SEX_LABEL[p.sex ?? ''] ?? '-'}</td><td className="mono text-xs">{p.birthDate ?? '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {/* 100건 초과 시 페이지 탭 — 각 탭 100건씩 */}
          {total > PAGE_SIZE && (
            <div className="flex flex-wrap items-center gap-1 mt-2">
              <span className="text-xs text-ink-3 mr-1">전체 {total}건 · {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)}</span>
              {Array.from({ length: Math.ceil(total / PAGE_SIZE) }, (_, i) => i).map((i) => (
                <button key={i} onClick={() => search(q, dFrom, dTo, i)}
                  className={`px-2 py-0.5 rounded text-xs ${i === page ? 'bg-teal text-white font-semibold' : 'border border-line text-ink-2 hover:border-teal'}`}>
                  {i * PAGE_SIZE + 1}–{Math.min((i + 1) * PAGE_SIZE, total)}
                </button>
              ))}
            </div>
          )}
          <p className="text-xs text-ink-3 mt-2">페이지당 100건{total > PAGE_SIZE ? ` · 전체 ${total}건(탭 구분)` : ''}. 정확 검색은 환자ID 전체 입력. <b>오더활동 기간</b> 지정 시 해당 기간 검사 오더가 있는 환자만.</p>
        </section>

        {/* 상세 */}
        <section className="card">
          {!sel ? <EmptyState title="환자를 선택하세요" hint="좌측 목록에서 환자를 클릭하면 내원·오더 이력이 표시됩니다." /> : (
            <div>
              <div className="flex items-center gap-2 mb-3 flex-wrap">
                <span className="text-lg font-bold">{sel.name}</span>
                <span className="mono text-sm text-ink-2">{sel.patientId}</span>
                <span className="text-xs px-2 py-0.5 rounded bg-bg border border-line">{SEX_LABEL[sel.sex ?? ''] ?? '-'} · {sel.birthDate ?? '생년 미상'}</span>
                <span className={`text-xs px-2 py-0.5 rounded ${sel.status === 'ACTIVE' ? 'bg-good/15 text-good' : 'bg-bg text-ink-3'}`}>{sel.status}</span>
                {canRegister && !editP && <button onClick={() => setEditP({ name: sel.name, sex: sel.sex ?? 'U', birthDate: sel.birthDate ?? '' })} className="text-xs text-teal underline ml-auto">정보 수정</button>}
              </div>
              {sel.status === 'MERGED' && sel.mergedInto && (
                <div className="mb-3 rounded-xl border border-warn/40 bg-warn/5 p-3 text-sm">
                  이 환자는 <b>병합된 구 레코드</b>입니다. 임상 이력은 정본으로 이관되었습니다 →{' '}
                  <button onClick={() => { setQ(sel.mergedInto!); openDetail(sel.mergedInto!); }} className="text-teal underline font-semibold mono">{sel.mergedInto}</button> 로 이동
                </div>
              )}
              {editP && (
                <div className="mb-3 rounded-xl border border-teal/30 bg-teal/5 p-3">
                  <div className="text-xs font-bold text-ink-2 mb-2">인적정보 정정 <span className="font-normal text-ink-3">— 성별·생년 오타는 참고치 판정에 직접 영향</span></div>
                  <div className="flex flex-wrap items-end gap-2">
                    <div><label className="block text-[11px] text-ink-3 mb-0.5">성명</label><input aria-label="성명" className={`${inp} w-32`} value={editP.name} onChange={(e) => setEditP({ ...editP, name: e.target.value })} /></div>
                    <div><label className="block text-[11px] text-ink-3 mb-0.5">성별</label><select className={inp} value={editP.sex} onChange={(e) => setEditP({ ...editP, sex: e.target.value })}><option value="M">남</option><option value="F">여</option><option value="O">기타</option><option value="U">미상</option></select></div>
                    <div><label className="block text-[11px] text-ink-3 mb-0.5">생년월일</label><input aria-label="생년월일" type="date" className={inp} value={editP.birthDate} onChange={(e) => setEditP({ ...editP, birthDate: e.target.value })} /></div>
                    <button onClick={saveEdit} className="py-1.5 px-3 rounded-lg bg-teal text-white text-xs font-semibold">저장</button>
                    <button onClick={() => setEditP(null)} className="py-1.5 px-3 rounded-lg border border-line text-xs">취소</button>
                  </div>
                  {canMerge && (
                    <div className="mt-3 pt-2 border-t border-line">
                      <div className="text-[11px] text-ink-3 mb-1">중복 환자 병합 — 다른 등록(source)의 이력을 <b>이 환자</b>로 이관 후 source는 MERGED</div>
                      <div className="flex flex-wrap items-center gap-2">
                        <input aria-label="병합할 중복 환자ID" className={`${inp} mono w-40`} value={mergeSrc} onChange={(e) => setMergeSrc(e.target.value)} placeholder="병합할 중복 환자ID" />
                        <button onClick={doMerge} className="py-1.5 px-3 rounded-lg border border-crit text-crit text-xs font-semibold transition-colors duration-150 hover:bg-crit/10">이 환자로 병합</button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="mb-3">
                <div className="text-xs text-ink-2 mb-1">내원 이력 <span className="text-ink-3">({sel.visits.length})</span></div>
                {sel.visits.length === 0 ? <p className="text-xs text-ink-3">내원 기록 없음</p> : (
                  <div className="flex flex-wrap gap-1.5">
                    {sel.visits.map((v) => <span key={v.visitId} className="text-xs bg-bg border border-line rounded px-2 py-0.5">{v.type === 'I' ? '입원' : v.type === 'O' ? '외래' : v.type === 'E' ? '응급' : v.type ?? '-'} · {v.dept ?? ''}{v.ward ? ` · ${v.ward}` : ''}</span>)}
                  </div>
                )}
              </div>

              <div>
                <div className="text-xs text-ink-2 mb-1">
                  검사 오더 <span className="text-ink-3">({sel.orders.length}{sel.ordersTruncated ? ` / 전체 ${sel.orderTotal}` : ''})</span>
                  {sel.ordersTruncated && <span className="ml-1 text-ink-3">— 최근 100건만 표시, 전체는 오더 화면에서</span>}
                </div>
                {sel.orders.length === 0 ? <p className="text-xs text-ink-3">오더 없음</p> : (
                  <ul className="flex flex-col gap-1.5 max-h-72 overflow-y-auto">
                    {sel.orders.slice().sort((a, b) => (b.orderDt ?? '').localeCompare(a.orderDt ?? '')).map((o) => (
                      <li key={o.orderId} className="text-sm border-b border-line pb-1.5 last:border-0">
                        <button onClick={() => toggleCompleteness(o.orderId)} aria-expanded={openOrder === o.orderId} className="text-left w-full hover:bg-bg rounded px-1 -mx-1">
                          <span className="mono text-xs text-ink-3">{o.orderDt ? new Date(o.orderDt).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-'}</span>
                          {o.priority === 'S' && <span className="text-crit text-xs font-bold ml-1">STAT</span>}
                          <span className="mono ml-1">{o.orderId}</span>
                          <span className="text-xs text-ink-2 ml-1">· {OSTATUS[o.status] ?? o.status} · {o.items.length}항목</span>
                          {comp[o.orderId] && <CompBadge c={comp[o.orderId]} />}
                          <span className="text-ink-3 text-xs ml-1"><IconChevron open={openOrder === o.orderId} /></span>
                        </button>
                        {openOrder === o.orderId && comp[o.orderId] && (
                          <div className="mt-1 ml-2 pl-2 border-l-2 border-line">
                            <div className="text-xs text-ink-2 mb-1">완결도 {comp[o.orderId].reported}/{comp[o.orderId].total} 보고</div>
                            <ul className="flex flex-col gap-0.5">
                              {comp[o.orderId].items.map((it) => (
                                <li key={it.testCode} className="text-xs flex items-center gap-1.5">
                                  <span className={`w-1.5 h-1.5 rounded-full ${it.status === 'REPORTED' ? 'bg-good' : it.status === 'CANCELLED' ? 'bg-ink-3' : 'bg-warn'}`} />
                                  <span>{it.testName}</span>
                                  <span className="mono text-ink-3">{it.testCode}</span>
                                  <span className="text-ink-2 ml-auto">{OSTATUS[it.status] ?? it.status}</span>
                                </li>
                              ))}
                            </ul>
                            {(comp[o.orderId].specimenNos?.length ?? 0) > 0 && (
                              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                <span className="text-[11px] text-ink-3">보고서:</span>
                                {comp[o.orderId].specimenNos!.map((sp) => (
                                  <Link key={sp} href={`/results/report?sp=${encodeURIComponent(sp)}`} className="text-[11px] text-teal underline mono">{sp}</Link>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                <Link href="/orders" className="text-xs text-teal underline mt-2 inline-block">오더·접수 화면 →</Link>
              </div>

              {/* 누적(추세) 결과 */}
              <div className="mt-4 pt-3 border-t border-line">
                <button onClick={() => toggleCumulative(sel.patientId)} aria-expanded={cumOpen} className="text-xs font-semibold text-teal">
                  <IconChevron open={cumOpen} /> 누적 결과 추세
                </button>
                {cumOpen && (
                  <>
                    <div className="flex flex-wrap items-end gap-2 mt-2 no-print">
                      <div><label className="block text-[11px] text-ink-3 mb-0.5">시작</label><input aria-label="시작" type="date" value={cumFrom} onChange={(e) => setCumFrom(e.target.value)} className={`${inp} text-xs py-1`} /></div>
                      <div><label className="block text-[11px] text-ink-3 mb-0.5">종료</label><input aria-label="종료" type="date" value={cumTo} onChange={(e) => setCumTo(e.target.value)} className={`${inp} text-xs py-1`} /></div>
                      <button onClick={() => loadCumulative(sel.patientId)} className="py-1 px-3 rounded-lg bg-teal text-white text-xs font-semibold">적용</button>
                      {cum && cum.tests.length > 0 && <button onClick={() => window.print()} className="py-1 px-3 rounded-lg bg-indigo text-white text-xs font-semibold">인쇄</button>}
                    </div>
                    {cum && cum.tests.length > 0 ? (
                      <div className="mt-2 overflow-x-auto print-area">
                        <div className="print-only mb-2">
                          <h3 className="text-base font-bold">누적 결과 추세 — {sel.name} ({sel.patientId})</h3>
                          <p className="text-xs">{cumFrom || '전체'} ~ {cumTo || '현재'}</p>
                        </div>
                        <table className="text-xs border-collapse">
                          <thead><tr className="text-ink-2"><th className="text-left py-1 pr-2 sticky left-0 bg-surface">검사</th>
                            {cum.tests[0] && Array.from(new Set(cum.tests.flatMap((t) => t.series.map((s) => (s.dt ?? '').slice(0, 10))))).sort().map((d) => <th key={d} className="px-1.5 py-1 mono whitespace-nowrap">{d.slice(5)}</th>)}
                          </tr></thead>
                          <tbody>
                            {cum.tests.map((t) => {
                              const dates = Array.from(new Set(cum.tests.flatMap((x) => x.series.map((s) => (s.dt ?? '').slice(0, 10))))).sort();
                              const byDate: Record<string, { value: string | null; flag: string | null; specimenNo: string }> = {};
                              t.series.forEach((s) => { byDate[(s.dt ?? '').slice(0, 10)] = { value: s.value, flag: s.flag, specimenNo: s.specimenNo }; });
                              return (
                                <tr key={t.testCode} className="border-t border-line">
                                  <td className="py-1 pr-2 sticky left-0 bg-surface"><span className="font-medium">{t.testName}</span> <span className="text-ink-3">{t.unit ?? ''}</span></td>
                                  {dates.map((d) => {
                                    const c = byDate[d];
                                    const crit = c?.flag === 'HH' || c?.flag === 'LL';
                                    const abn = c?.flag && c.flag !== 'N';
                                    const cls = `px-1.5 py-1 mono text-center ${crit ? 'text-crit font-bold' : abn ? 'text-warn' : ''}`;
                                    if (!c) return <td key={d} className={cls}>·</td>;
                                    const txt = `${c.value ?? ''}${c.flag && c.flag !== 'N' ? ` ${c.flag}` : ''}`;
                                    return <td key={d} className={cls}><Link href={`/results/report?sp=${encodeURIComponent(c.specimenNo)}`} className="hover:underline" title={`보고서 ${c.specimenNo}`}>{txt}</Link></td>;
                                  })}
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                        <p className="text-xs text-ink-3 mt-1">확정 결과 검사별 시계열. 값 클릭 → 해당 검체 보고서. <span className="text-crit font-bold">HH/LL 위험치</span> · <span className="text-warn">H/L 이상</span>.</p>
                      </div>
                    ) : cum ? <p className="text-xs text-ink-3 mt-2">확정 결과 없음</p> : <p className="text-xs text-ink-3 mt-2">불러오는 중…</p>}
                  </>
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
