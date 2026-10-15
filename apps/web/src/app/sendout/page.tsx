'use client';

/**
 * 외부검사 위탁 화면 (`/sendout`).
 *
 * 사이드바 노출 역할: TEC, PHY, MIC, PAT, GEN, ADM, AUD.
 * ⚠ 노출 역할과 화면이 호출하는 API 권한이 어긋나면 전부 403인 죽은 화면이 된다 —
 *   역할을 바꿀 때는 `Sidebar.tsx`(정본)와 API 권한 매트릭스를 함께 본다.
 * 데이터는 `lib/api.ts`의 `apiFetch`로만 가져온다(HTTP 호출 정본).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useState, useEffect, useCallback, useRef, Fragment } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, getToken } from '@/lib/api';
import { EmptyState, ErrorText, Loading } from '@/components/ui';
import { useToast } from '@/components/toast';
import { UNIT_DICT } from '@lis/shared';
import AttachmentPanel from '@/components/AttachmentPanel';

/**
 * 외부검사 위탁(send-out) — 의뢰 → 발송 → 회신 추적.
 *
 * 회신값을 기록하면 **환자 결과로 적재되어 검증 워크리스트에 올라간다**(자동검증 안 함).
 * 외부 검사실 보고서를 사람이 옮겨 적는 값이고 방법·참고치가 우리와 다를 수 있어서,
 * 검증 화면에서 확인·확정해야 결과지·HIS로 나간다. 그 흐름을 화면에서도 보이게 한다.
 */

interface Sendout {
  sendoutId: string;
  specimenNo: string;
  testCode: string;
  testName: string | null;
  referralLab: string;
  status: string;
  requestedBy: string | null;
  requestedDt: string;
  sentDt: string | null;
  resultValue: string | null;
  resultUnit: string | null;
  unitUcum: string | null; // 위탁검사의 검사마스터 단위 — 회신 단위 자동채움용
  resultedDt: string | null;
  resultedBy: string | null;
  resultId: string | null;
  note: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  REQUESTED: '의뢰',
  SENT: '발송',
  RESULTED: '회신완료',
  CANCELLED: '취소',
};
const statusCls: Record<string, string> = {
  REQUESTED: 'bg-warn/15 text-warn',
  SENT: 'bg-indigo/15 text-indigo',
  RESULTED: 'bg-good/15 text-good',
  CANCELLED: 'bg-ink-3/15 text-ink-2',
};

/** 경과일 — 발송 후 오래 회신이 없는 건을 눈에 띄게 한다(위탁은 잊히기 쉽다). */
function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400_000);
}

export default function SendoutPage() {
  const router = useRouter();
  const toast = useToast();
  const [rows, setRows] = useState<Sendout[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState(''); // '' = 미회신(REQUESTED+SENT)
  const [ns, setNs] = useState({ specimenNo: '', testCode: '', referralLab: '', note: '' });
  const [rv, setRv] = useState<Record<string, { value: string; unit: string }>>({});
  const [busy, setBusy] = useState('');
  const [attachOpen, setAttachOpen] = useState<Record<string, boolean>>({});

  // 검체별 위탁 이력 — 같은 검체를 어디로 몇 번 보냈는지. 조회 화면이 없었다.
  const [spQuery, setSpQuery] = useState('');
  const [spRows, setSpRows] = useState<Sendout[] | null>(null);
  const [soFrom, setSoFrom] = useState('');
  const [soTo, setSoTo] = useState('');
  /**
   * ★기간 필터가 통째로 무시되던 버그(2026-07-30 수정).
   *
   * `load`가 `useCallback(…, [])`인데 기본 인자가 `f = soFrom, t = soTo`였다.
   * 기본 인자는 **함수가 만들어진 시점의 클로저**에서 값을 읽으므로, 최초 렌더의
   * 빈 문자열에 영구 고정된다 — 사용자가 기간을 넣고 [조회]를 눌러도 전체가 조회됐다.
   * ([기간 해제]만 우연히 동작했다. 빈 값을 명시로 넘겨서다.)
   *
   * deps에 soFrom/soTo를 넣으면 `load` 신원이 바뀌고, 그것이 아래 useEffect의 deps라
   * **날짜를 한 글자 칠 때마다 재조회**한다. 그래서 ref로 최신 값을 읽고 load는 안정적으로 둔다.
   */
  const rangeRef = useRef({ from: '', to: '' });
  useEffect(() => { rangeRef.current = { from: soFrom, to: soTo }; }, [soFrom, soTo]);
  const load = useCallback(async (status: string, f?: string, t?: string) => {
    // 인자를 주면 그것을 쓰고(기간 해제는 ''를 명시로 넘긴다), 없으면 화면의 현재 기간을 쓴다.
    const from = f ?? rangeRef.current.from;
    const to = t ?? rangeRef.current.to;
    setLoading(true);
    setErr('');
    try {
      const qs = new URLSearchParams();
      if (status) qs.set('status', status);
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      setRows(await apiFetch<Sendout[]>(`/api/v1/sendout${qs.toString() ? `?${qs}` : ''}`));
    } catch (e) {
      setErr(e instanceof Error ? e.message : '조회 실패(권한 필요)');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!getToken()) router.push('/');
    else load(filter);
  }, [router, load, filter]);

  /** 검체 하나의 위탁 이력 — 중복 의뢰·재발송 여부를 보려면 검체 기준 조회가 필요하다. */
  async function loadBySpecimen() {
    if (!spQuery.trim()) { setSpRows(null); return; }
    try { setSpRows(await apiFetch<Sendout[]>(`/api/v1/sendout/specimen/${encodeURIComponent(spQuery.trim())}`)); }
    catch (e) { toast(e instanceof Error ? e.message : '조회 실패', 'error'); setSpRows([]); }
  }

  async function request(e: React.FormEvent) {
    e.preventDefault();
    setBusy('new');
    try {
      await apiFetch('/api/v1/sendout', {
        method: 'POST',
        body: JSON.stringify({ ...ns, note: ns.note || undefined }),
      });
      toast('위탁 의뢰 등록');
      setNs({ specimenNo: '', testCode: '', referralLab: ns.referralLab, note: '' });
      load(filter);
    } catch (e) {
      toast(e instanceof Error ? e.message : '실패', 'error');
    } finally {
      setBusy('');
    }
  }

  async function act(id: string, path: string, body?: unknown, okMsg?: string) {
    setBusy(id);
    try {
      await apiFetch(`/api/v1/sendout/${id}/${path}`, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
      toast(okMsg ?? '처리 완료');
      load(filter);
    } catch (e) {
      toast(e instanceof Error ? e.message : '실패', 'error');
    } finally {
      setBusy('');
    }
  }

  function recordResult(s: Sendout) {
    const v = rv[s.sendoutId];
    if (!v?.value?.trim()) {
      toast('회신값을 입력하세요', 'error');
      return;
    }
    // 단위를 손대지 않았으면 검사마스터 단위를 그대로 쓴다(입력칸이 unitUcum으로 채워져 보이므로 일치)
    const unit = (v.unit ?? s.unitUcum ?? '').trim() || undefined;
    act(
      s.sendoutId,
      'result',
      { resultValue: v.value.trim(), resultUnit: unit },
      '회신 기록 — 환자 결과로 적재됨(검증 대기)',
    );
  }

  const inp = 'px-2 py-1.5 rounded-lg border border-line bg-bg text-sm';

  return (
    <main className="page">
      <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
        <h1 className="t-page">외부검사 위탁</h1>
        <select aria-label="상태 필터" value={filter} onChange={(e) => setFilter(e.target.value)} className={inp}>
          <option value="">미회신(의뢰·발송)</option>
          <option value="REQUESTED">의뢰</option>
          <option value="SENT">발송</option>
          <option value="RESULTED">회신완료</option>
          <option value="CANCELLED">취소</option>
        </select>
        {/* 기간(의뢰일) — 회신완료 건은 기본 목록에서 빠지므로 지난 건은 기간으로 찾는다 */}
        <span className="flex items-end gap-1.5">
          <span>
            <label htmlFor="so-from" className="block t-micro mb-0.5">의뢰일 시작</label>
            <input id="so-from" type="date" value={soFrom} onChange={(e) => setSoFrom(e.target.value)} className={`${inp} text-xs`} />
          </span>
          <span>
            <label htmlFor="so-to" className="block t-micro mb-0.5">종료</label>
            <input id="so-to" type="date" value={soTo} onChange={(e) => setSoTo(e.target.value)} className={`${inp} text-xs`} />
          </span>
          <button onClick={() => load(filter)} className="py-1.5 px-3 r-ctl bg-teal text-white text-xs font-semibold m-hover hover:bg-teal-2">조회</button>
          {(soFrom || soTo) && (
            <button onClick={() => { setSoFrom(''); setSoTo(''); load(filter, '', ''); }} className="py-1.5 px-3 r-ctl border border-line text-ink-2 text-xs font-semibold m-hover hover:border-teal hover:text-teal">기간 해제</button>
          )}
        </span>
      </div>
      <ErrorText message={err} />

      <section className="card mb-4">
        <h2 className="t-section text-sm mb-2">위탁 의뢰</h2>
        <form onSubmit={request} className="flex flex-wrap gap-2 items-center">
          <input required aria-label="검체번호" placeholder="검체번호" value={ns.specimenNo} onChange={(e) => setNs({ ...ns, specimenNo: e.target.value })} className={`${inp} mono w-36`} />
          <input required aria-label="검사코드" placeholder="검사코드" value={ns.testCode} onChange={(e) => setNs({ ...ns, testCode: e.target.value })} className={`${inp} mono w-32`} />
          <input required aria-label="위탁검사실" placeholder="위탁검사실" value={ns.referralLab} onChange={(e) => setNs({ ...ns, referralLab: e.target.value })} className={`${inp} w-40`} />
          <input aria-label="비고" placeholder="비고(선택)" value={ns.note} onChange={(e) => setNs({ ...ns, note: e.target.value })} className={`${inp} flex-1 min-w-32`} />
          <button disabled={busy === 'new'} className="py-1.5 px-3 rounded-lg bg-teal text-white font-semibold text-xs disabled:opacity-50">의뢰</button>
        </form>
        <p className="text-xs text-ink-3 mt-2">검사마스터에 등록된 검사코드만 위탁할 수 있습니다 — 미등록 코드는 회신을 받아도 환자 결과로 적재할 수 없습니다.</p>

        {/* 검체별 이력 — 중복 의뢰·재발송을 확인하려면 검체 기준 조회가 필요하다 */}
        <div className="mt-3 pt-3 border-t border-line">
          <div className="flex gap-2 items-center">
            <label htmlFor="so-sp" className="t-micro text-ink-2">검체별 이력</label>
            <input id="so-sp" value={spQuery} onChange={(e) => setSpQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void loadBySpecimen(); } }}
              placeholder="검체번호" className={`${inp} mono w-40`} />
            <button onClick={loadBySpecimen} className="py-1.5 px-3 r-ctl border border-line text-xs font-semibold m-hover hover:border-teal hover:text-teal">조회</button>
            {spRows && <button onClick={() => { setSpRows(null); setSpQuery(''); }} className="t-micro text-ink-3 underline">닫기</button>}
          </div>
          {spRows && (spRows.length === 0 ? (
            <p className="text-xs text-ink-3 mt-2">이 검체의 위탁 이력이 없습니다.</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-1">
              {spRows.map((r) => (
                <li key={r.sendoutId} className="text-xs text-ink-2 flex flex-wrap gap-x-2">
                  <span className="mono">{r.testCode}</span>
                  <span>{r.referralLab}</span>
                  <span className="font-semibold">{r.status}</span>
                  <span className="text-ink-3">{(r.requestedDt ?? '').slice(0, 10)}</span>
                </li>
              ))}
            </ul>
          ))}
        </div>
      </section>

      <section className="card">
        <h2 className="t-section mb-3">
          위탁 목록 <span className="text-xs text-ink-2">({rows.length})</span>
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-2 border-b border-line">
                <th className="py-2">검체</th>
                <th>검사</th>
                <th>위탁검사실</th>
                <th>상태</th>
                <th>회신값</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const waiting = s.status === 'SENT' ? daysSince(s.sentDt) : null;
                return (
                  <Fragment key={s.sendoutId}>
                  <tr className="border-b border-line last:border-0 align-top">
                    <td className="py-2 mono text-xs">{s.specimenNo}
                      {s.requestedDt && <span className="block not-mono text-[11px] text-ink-3">의뢰 {s.requestedDt.slice(0, 10)}{s.requestedBy ? ` · ${s.requestedBy}` : ''}</span>}
                    </td>
                    <td className="text-xs">
                      <span className="mono">{s.testCode}</span>
                      {s.testName && <span className="text-ink-3"> {s.testName}</span>}
                    </td>
                    <td className="text-xs">{s.referralLab}
                      {s.note && <span className="block text-[11px] text-ink-3">{s.note}</span>}
                    </td>
                    <td>
                      <span className={`text-xs px-1.5 py-0.5 rounded font-bold ${statusCls[s.status] ?? ''}`}>{STATUS_LABEL[s.status] ?? s.status}</span>
                      {waiting != null && waiting >= 7 && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-warn/20 text-warn font-bold ml-1">발송 {waiting}일</span>
                      )}
                      {/* 발송 안 된 채 오래된 의뢰(REQUESTED) 노화 — sentDt 없어 '발송 N일'로 안 잡히던 것 */}
                      {s.status === 'REQUESTED' && (() => { const d = daysSince(s.requestedDt); return d != null && d >= 3 ? <span className="text-xs px-1.5 py-0.5 rounded bg-warn/15 text-warn font-bold ml-1">미발송 {d}일</span> : null; })()}
                    </td>
                    <td className="mono text-xs">
                      {s.resultValue != null ? (
                        <>
                          {s.resultValue} {s.resultUnit ?? ''}
                          {s.resultId && <div className="text-ink-3">→ {s.resultId}</div>}
                          {(s.resultedBy || s.resultedDt) && <div className="not-mono text-[11px] text-ink-3">{s.resultedBy ?? ''}{s.resultedDt ? ` · ${s.resultedDt.slice(0, 10)}` : ''}</div>}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      <span className="flex gap-1 items-center flex-wrap justify-end">
                        {s.status === 'REQUESTED' && (
                          <button disabled={busy === s.sendoutId} onClick={() => act(s.sendoutId, 'sent', undefined, '발송 처리')} className="py-1 px-2 rounded-lg bg-indigo text-white text-xs disabled:opacity-50">발송</button>
                        )}
                        {s.status === 'SENT' && (
                          <>
                            <input aria-label="회신값" placeholder="회신값" value={rv[s.sendoutId]?.value ?? ''} onChange={(e) => setRv({ ...rv, [s.sendoutId]: { ...rv[s.sendoutId], value: e.target.value } })} className={`${inp} mono w-24`} />
                            {/* 단위는 검사마스터 값으로 자동 채우고(rv에 아직 손 안 댔으면 unitUcum), 단위 사전으로 제안 —
                                매번 손으로 치지 않고 표기 불일치(mIU/L vs miu/l)를 줄인다 */}
                            <input aria-label="단위" list="sendout-units" placeholder={s.unitUcum ?? '단위'}
                              value={rv[s.sendoutId]?.unit ?? s.unitUcum ?? ''}
                              onChange={(e) => setRv({ ...rv, [s.sendoutId]: { ...rv[s.sendoutId], unit: e.target.value } })}
                              className={`${inp} mono w-20`} />
                            <button onClick={() => setAttachOpen({ ...attachOpen, [s.sendoutId]: !attachOpen[s.sendoutId] })} className="py-1 px-2 rounded-lg border border-line text-teal text-xs">결과지</button>
                            <button disabled={busy === s.sendoutId} onClick={() => recordResult(s)} className="py-1 px-2 rounded-lg bg-teal text-white text-xs disabled:opacity-50">회신기록</button>
                          </>
                        )}
                        {s.status !== 'RESULTED' && s.status !== 'CANCELLED' && (
                          <button disabled={busy === s.sendoutId} onClick={() => act(s.sendoutId, 'cancel', {}, '위탁 취소')} className="py-1 px-2 rounded-lg border border-line text-ink-2 text-xs disabled:opacity-50">취소</button>
                        )}
                      </span>
                    </td>
                  </tr>
                  {attachOpen[s.sendoutId] && (
                    <tr>
                      <td colSpan={9} className="bg-bg/40 px-3 py-2">
                        <p className="text-xs text-ink-2 mb-1">외부검사실 회신 결과지(스캔·PDF)를 검체 {s.specimenNo}에 첨부하세요 — 회신기록에 필요합니다.</p>
                        <AttachmentPanel specimenNo={s.specimenNo} />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
              {loading && rows.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <Loading />
                  </td>
                </tr>
              )}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <EmptyState title="위탁 없음" hint="상단에서 외부검사 위탁을 의뢰하세요." />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {/* 단위 사전 — 회신 단위 입력 시 표준 단위를 제안(자유 입력도 허용). 표기 불일치를 줄인다 */}
        <datalist id="sendout-units">
          {Object.keys(UNIT_DICT).map((u) => <option key={u} value={u}>{UNIT_DICT[u].display}</option>)}
        </datalist>
        <p className="text-xs text-ink-3 mt-3">
          회신값을 기록하면 환자 결과로 적재되며 <b>자동검증하지 않습니다</b> — 검증 화면에서 확인·확정해야 결과지·HIS로 나갑니다.
          단위는 검사마스터 값으로 자동 채워지며, 필요하면 목록에서 고르거나 직접 입력할 수 있습니다.
        </p>
      </section>
    </main>
  );
}
