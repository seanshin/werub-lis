'use client';

/**
 * 감사추적 화면 (`/audit`).
 *
 * 사이드바 노출 역할: ADM, AUD.
 * ⚠ 노출 역할과 화면이 호출하는 API 권한이 어긋나면 전부 403인 죽은 화면이 된다 —
 *   역할을 바꿀 때는 `Sidebar.tsx`(정본)와 API 권한 매트릭스를 함께 본다.
 * 데이터는 `lib/api.ts`의 `apiFetch`로만 가져온다(HTTP 호출 정본).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useState, useEffect, useCallback, Fragment } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, getToken } from '@/lib/api';
import { Loading, ErrorText, EmptyState, TableSkeleton } from '@/components/ui';
import { csvCell } from '@/lib/csv';

interface AuditRow { logId: string; userId: string | null; action: string; target: string; detail: string | null; status: number | null; sensitive: boolean; createdDt: string; seq: number | null; }
interface AuditSummary {
  total: number; sensitive: number; failed: number;
  byAction: { action: string; count: number }[];
  topUsers: { userId: string; count: number }[];
  failedByUser: { userId: string; count: number }[];
  offHours: { count: number; truncated: boolean; topUsers: { userId: string; count: number }[] };
  byDay: { date: string; count: number }[];
}
interface PatientAccess { patientId: string; scannedKeys: number; count: number; truncated: boolean; rows: (AuditRow & { via: string })[] }
interface VerifyResult { ok: boolean; count: number; firstSeq: number | null; lastSeq: number | null; brokenAt: number | null; reason: string | null; }

/** detail(JSON)에서 사람이 볼 항목만 뽑는다 — 원문은 4000자까지 저장돼 그대로 표에 못 쓴다. */
function parseDetail(d: string | null): { ip?: string; ua?: string; params?: Record<string, unknown>; body?: Record<string, unknown> } {
  if (!d) return {};
  try { return JSON.parse(d); } catch { return {}; }
}
interface AuditResult { total: number; count: number; rows: AuditRow[]; }

const actionColor: Record<string, string> = { POST: 'text-teal', PATCH: 'text-warn', PUT: 'text-warn', DELETE: 'text-crit', READ: 'text-indigo' };

const TAKE = 50;

export default function AuditPage() {
  const router = useRouter();
  const [q, setQ] = useState({ userId: '', action: '', target: '', sensitive: '', failed: '', from: '', to: '' });
  const [open, setOpen] = useState<string | null>(null); // 펼친 행
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [verifying, setVerifying] = useState(false);
  // 환자별 열람 이력 — "이 환자 기록을 누가 봤나"(의료법 대응 대표 질문)
  const [tab, setTab] = useState<'log' | 'patient' | 'summary'>('log');
  const [sum, setSum] = useState<AuditSummary | null>(null);
  const [sumLoading, setSumLoading] = useState(false);
  const [pid, setPid] = useState('');
  const [pAccess, setPAccess] = useState<PatientAccess | null>(null);
  const [pLoading, setPLoading] = useState(false);
  const [res, setRes] = useState<AuditResult | null>(null);
  const [skip, setSkip] = useState(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const buildParams = useCallback((sk: number) => {
    const params = new URLSearchParams();
    if (q.userId) params.set('userId', q.userId);
    if (q.action) params.set('action', q.action);
    if (q.target) params.set('target', q.target);
    if (q.sensitive) params.set('sensitive', q.sensitive);
    if (q.failed) params.set('failed', q.failed);
    if (q.from) params.set('from', `${q.from}T00:00:00`);
    if (q.to) params.set('to', `${q.to}T23:59:59`); // 종료일 하루 전체 포함
    params.set('skip', String(sk));
    params.set('take', String(TAKE));
    return params;
  }, [q]);

  const run = useCallback(async (sk: number) => {
    setErr('');
    setLoading(true);
    try { setRes(await apiFetch<AuditResult>(`/api/v1/audit?${buildParams(sk)}`)); setSkip(sk); }
    catch (e) { setErr(e instanceof Error ? e.message : '조회 실패'); }
    finally { setLoading(false); }
  }, [buildParams]);

  const search = useCallback(() => run(0), [run]);

  // 해시체인 무결성 — 감사자가 "이 기록이 변조되지 않았다"를 화면에서 직접 확인해야 한다
  async function loadSummary() {
    setErr(''); setSumLoading(true);
    try {
      const qs = new URLSearchParams();
      if (q.from) qs.set('from', `${q.from}T00:00:00`);
      if (q.to) qs.set('to', `${q.to}T23:59:59`);
      setSum(await apiFetch<AuditSummary>(`/api/v1/audit/summary?${qs}`));
    } catch (e) { setErr(e instanceof Error ? e.message : '요약 조회 실패'); }
    finally { setSumLoading(false); }
  }

  async function loadPatientAccess() {
    if (!pid.trim()) { setErr('환자ID를 입력하세요'); return; }
    setErr(''); setPLoading(true);
    try {
      const qs = new URLSearchParams({ take: '200' });
      if (q.from) qs.set('from', `${q.from}T00:00:00`);
      if (q.to) qs.set('to', `${q.to}T23:59:59`);
      setPAccess(await apiFetch<PatientAccess>(`/api/v1/audit/patient/${encodeURIComponent(pid.trim())}?${qs}`));
    } catch (e) { setErr(e instanceof Error ? e.message : '조회 실패'); setPAccess(null); }
    finally { setPLoading(false); }
  }

  async function runVerify() {
    setVerifying(true);
    try { setVerify(await apiFetch<VerifyResult>('/api/v1/audit/verify')); }
    catch (e) { setErr(e instanceof Error ? e.message : '무결성 검증 실패'); }
    finally { setVerifying(false); }
  }

  useEffect(() => { if (!getToken()) router.push('/'); else run(0); }, [router]); // eslint-disable-line react-hooks/exhaustive-deps

  // D4: 현재 필터 전체를 CSV로 내보내기(200건씩 순회, 최대 20페이지=4000건)
  async function exportCsv() {
    setErr('');
    try {
      const rows: AuditRow[] = [];
      for (let page = 0; page < 20; page++) {
        const p = buildParams(page * 200); p.set('take', '200');
        const r = await apiFetch<AuditResult>(`/api/v1/audit?${p}`);
        rows.push(...r.rows);
        if (rows.length >= r.total || r.rows.length < 200) break;
      }
      // 감사 대응 자료는 "어디서·무엇을"까지 필요하다 — IP·상세를 함께 낸다
      const head = ['시각', 'seq', '사용자', '액션', '대상', '상태', '민감', 'IP', '상세'];
      const lines = rows.map((r) => {
        const d = parseDetail(r.detail);
        return [r.createdDt, r.seq ?? '', r.userId ?? '', r.action, r.target, r.status ?? '', r.sensitive ? 'Y' : '', d.ip ?? '', r.detail ?? '']
          .map(csvCell).join(',');
      });
      const blob = new Blob(['﻿' + [head.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = url; a.download = `audit_${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(url);
    } catch (e) { setErr(e instanceof Error ? e.message : '내보내기 실패'); }
  }

  const inp = 'px-2 py-1.5 rounded-lg border border-line bg-bg text-sm';

  return (
    <main className="page">
      <h1 className="t-page">감사추적</h1>
      <p className="t-meta mb-3">모든 조회·변경이 해시체인으로 기록됩니다. 환자별 열람 이력은 검체·오더 경유 접근까지 포함해 조회합니다.</p>
      <div className="flex gap-1 mb-3">
        <button onClick={() => setTab('log')} className={`px-3 py-1.5 r-ctl text-sm font-semibold m-hover ${tab === 'log' ? 'bg-teal text-white' : 'border border-line text-ink-2 hover:border-teal hover:text-teal'}`}>전체 로그</button>
        <button onClick={() => setTab('patient')} className={`px-3 py-1.5 r-ctl text-sm font-semibold m-hover ${tab === 'patient' ? 'bg-teal text-white' : 'border border-line text-ink-2 hover:border-teal hover:text-teal'}`}>환자별 열람 이력</button>
        <button onClick={() => { setTab('summary'); if (!sum) void loadSummary(); }} className={`px-3 py-1.5 r-ctl text-sm font-semibold m-hover ${tab === 'summary' ? 'bg-teal text-white' : 'border border-line text-ink-2 hover:border-teal hover:text-teal'}`}>기간 요약</button>
      </div>
      {err && <ErrorText message={err} />}

      {tab === 'summary' && (
        <>
          <section className="card mb-4">
            <div className="flex flex-wrap gap-2 items-end">
              <div>
                <label htmlFor="sm-from" className="block t-micro mb-0.5">시작</label>
                <input id="sm-from" type="date" value={q.from} onChange={(e) => setQ({ ...q, from: e.target.value })} className={inp} />
              </div>
              <div>
                <label htmlFor="sm-to" className="block t-micro mb-0.5">종료</label>
                <input id="sm-to" type="date" value={q.to} onChange={(e) => setQ({ ...q, to: e.target.value })} className={inp} />
              </div>
              <button onClick={loadSummary} className="py-1.5 px-4 r-ctl bg-teal text-white font-semibold text-sm m-hover hover:bg-teal-2">집계</button>
              <span className="t-meta">기간 미지정 시 전체</span>
            </div>
          </section>

          {sumLoading ? <TableSkeleton rows={4} cols={4} /> : sum && (
            <>
              {/* 먼저 봐야 할 것 — 실패·민감·심야가 앞에 온다(수천 건을 넘기지 않게) */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                <div className="card"><div className="t-meta mb-1">전체 기록</div><div className="text-2xl font-extrabold mono">{sum.total.toLocaleString()}</div></div>
                <div className="card"><div className="t-meta mb-1">실패(4xx·5xx)</div><div className={`text-2xl font-extrabold mono ${sum.failed ? 'text-warn' : 'text-good'}`}>{sum.failed.toLocaleString()}</div><div className="t-micro">권한 위반·오류 시도</div></div>
                <div className="card"><div className="t-meta mb-1">민감 접근</div><div className="text-2xl font-extrabold mono">{sum.sensitive.toLocaleString()}</div><div className="t-micro">유전정보 등</div></div>
                <div className="card"><div className="t-meta mb-1">업무시간 외</div><div className={`text-2xl font-extrabold mono ${sum.offHours.count ? 'text-warn' : ''}`}>{sum.offHours.count.toLocaleString()}</div><div className="t-micro">평일 07~20시 밖·주말{sum.offHours.truncated && ' (표본 2만건)'}</div></div>
              </div>

              <div className="grid md:grid-cols-2 gap-4 mb-4">
                <section className="card">
                  <h2 className="t-section mb-2">액션별</h2>
                  {sum.byAction.map((a) => (
                    <div key={a.action} className="flex items-center justify-between py-0.5">
                      <span className={`t-body font-bold ${actionColor[a.action] ?? ''}`}>{a.action}</span>
                      <span className="mono t-body">{a.count.toLocaleString()}</span>
                    </div>
                  ))}
                </section>
                <section className="card">
                  <h2 className="t-section mb-2">활동 상위 사용자</h2>
                  {sum.topUsers.map((u) => (
                    <div key={u.userId} className="flex items-center justify-between py-0.5">
                      <button onClick={() => { setQ({ ...q, userId: u.userId }); setTab('log'); run(0); }} className="t-body mono underline decoration-dotted hover:text-teal">{u.userId}</button>
                      <span className="mono t-body">{u.count.toLocaleString()}</span>
                    </div>
                  ))}
                </section>
              </div>

              {(sum.failedByUser.length > 0 || sum.offHours.topUsers.length > 0) && (
                <div className="grid md:grid-cols-2 gap-4 mb-4">
                  {sum.failedByUser.length > 0 && (
                    <section className="card">
                      <h2 className="t-section mb-1">실패가 몰린 사용자</h2>
                      <p className="t-meta mb-2">권한 위반 시도가 한 계정에 몰리면 계정 오용이거나 권한 설정이 잘못된 것입니다.</p>
                      {sum.failedByUser.map((u) => (
                        <div key={u.userId} className="flex items-center justify-between py-0.5">
                          <span className="t-body mono">{u.userId}</span><span className="mono t-body text-warn">{u.count}</span>
                        </div>
                      ))}
                    </section>
                  )}
                  {sum.offHours.topUsers.length > 0 && (
                    <section className="card">
                      <h2 className="t-section mb-1">업무시간 외 접근 상위</h2>
                      <p className="t-meta mb-2">당직·응급이면 정상입니다. 근무 패턴과 맞지 않으면 확인 대상입니다.</p>
                      {sum.offHours.topUsers.map((u) => (
                        <div key={u.userId} className="flex items-center justify-between py-0.5">
                          <span className="t-body mono">{u.userId}</span><span className="mono t-body">{u.count}</span>
                        </div>
                      ))}
                    </section>
                  )}
                </div>
              )}

              {sum.byDay.length > 1 && (
                <section className="card">
                  <h2 className="t-section mb-2">일자별 추이 <span className="t-meta">({sum.byDay.length}일)</span></h2>
                  <div className="flex items-end gap-1 h-24" role="img" aria-label={`일자별 감사 기록 추이 ${sum.byDay.length}일`}>
                    {sum.byDay.map((d) => {
                      const max = Math.max(...sum.byDay.map((x) => x.count)) || 1;
                      return (
                        <span key={d.date} title={`${d.date}: ${d.count}건`} className="flex-1 bg-teal/30 hover:bg-teal/50 m-hover r-chip" style={{ height: `${Math.max(4, (d.count / max) * 100)}%` }} />
                      );
                    })}
                  </div>
                  <div className="flex justify-between t-micro mt-1">
                    <span>{sum.byDay[0]?.date}</span><span>{sum.byDay[sum.byDay.length - 1]?.date}</span>
                  </div>
                </section>
              )}
            </>
          )}
        </>
      )}

      {tab === 'patient' && (
        <>
          <section className="card mb-4">
            <div className="flex flex-wrap gap-2 items-end">
              <div>
                <label htmlFor="pa-pid" className="block t-micro mb-0.5">환자ID(등록번호)</label>
                <input id="pa-pid" value={pid} onChange={(e) => setPid(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') loadPatientAccess(); }}
                  placeholder="예: 2345678" className={`${inp} mono w-40`} />
              </div>
              <div>
                <label htmlFor="pa-from" className="block t-micro mb-0.5">시작</label>
                <input id="pa-from" type="date" value={q.from} onChange={(e) => setQ({ ...q, from: e.target.value })} className={inp} />
              </div>
              <div>
                <label htmlFor="pa-to" className="block t-micro mb-0.5">종료</label>
                <input id="pa-to" type="date" value={q.to} onChange={(e) => setQ({ ...q, to: e.target.value })} className={inp} />
              </div>
              <button onClick={loadPatientAccess} className="py-1.5 px-4 r-ctl bg-teal text-white font-semibold text-sm m-hover hover:bg-teal-2">조회</button>
            </div>
            {pAccess && (
              <p className="t-meta mt-2">
                식별자 <b className="mono">{pAccess.scannedKeys}</b>개(환자·검체·오더·병리·유전체)를 대상으로 검색 —
                <b className="mono"> {pAccess.count}</b>건{pAccess.truncated && ' (상한 200건 — 기간을 좁히세요)'}
              </p>
            )}
          </section>

          {pLoading ? <TableSkeleton rows={4} cols={5} /> : pAccess && (
            pAccess.rows.length === 0
              ? <EmptyState title="해당 기간에 이 환자 기록 접근이 없습니다" hint="기간을 넓히거나 환자ID를 확인하세요." />
              : (
                <section className="card">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead><tr className="text-left t-micro border-b border-line"><th className="py-2">시각</th><th>사용자</th><th>액션</th><th>접근 경로</th><th>IP</th><th>대상</th></tr></thead>
                      <tbody>
                        {pAccess.rows.map((r) => {
                          const d = parseDetail(r.detail);
                          return (
                            <tr key={r.logId} className="border-b border-line last:border-0">
                              <td className="py-1.5 mono text-xs text-ink-3">{r.createdDt.slice(0, 19).replace('T', ' ')}</td>
                              <td className="mono text-xs">{r.userId ?? '—'}</td>
                              <td className={`font-bold text-xs ${actionColor[r.action] ?? ''}`}>{r.action}</td>
                              <td className="text-xs">{r.via}</td>
                              <td className="mono text-xs text-ink-3">{d.ip ?? '—'}</td>
                              <td className="mono text-xs text-ink-3">{r.target}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </section>
              )
          )}
        </>
      )}

      {tab === 'log' && (<>
      <section className="card mb-4">
        <div className="flex flex-wrap gap-2 items-center">
          <input aria-label="사용자 ID" placeholder="사용자ID" value={q.userId} onChange={(e) => setQ({ ...q, userId: e.target.value })} className={`${inp} mono w-28`} />
          <select aria-label="액션 필터" value={q.action} onChange={(e) => setQ({ ...q, action: e.target.value })} className={inp}>
            <option value="">모든 액션</option><option>POST</option><option>PATCH</option><option>PUT</option><option>DELETE</option><option>READ</option>
          </select>
          <input aria-label="대상" placeholder="대상(라우트 포함)" value={q.target} onChange={(e) => setQ({ ...q, target: e.target.value })} className={`${inp} w-56`} />
          <select aria-label="민감 접근 필터" value={q.sensitive} onChange={(e) => setQ({ ...q, sensitive: e.target.value })} className={inp}>
            <option value="">전체</option><option value="true">민감접근만</option><option value="false">일반만</option>
          </select>
          <label className="text-xs text-ink-2">기간</label>
          <input type="date" aria-label="시작일" value={q.from} onChange={(e) => setQ({ ...q, from: e.target.value })} className={inp} />
          <span className="text-xs text-ink-3">~</span>
          <input type="date" aria-label="종료일" value={q.to} onChange={(e) => setQ({ ...q, to: e.target.value })} className={inp} />
          <label className="flex items-center gap-1 t-meta">
            <input type="checkbox" checked={q.failed === 'true'} onChange={(e) => setQ({ ...q, failed: e.target.checked ? 'true' : '' })} />
            실패(4xx·5xx)만
          </label>
          <button onClick={search} className="py-1.5 px-4 r-ctl bg-teal text-white font-semibold text-sm m-hover hover:bg-teal-2">검색</button>
          <button onClick={exportCsv} className="py-1.5 px-3 r-ctl border border-line text-sm font-semibold m-hover hover:border-teal hover:text-teal">CSV</button>
          <span className="flex-1" />
          <button onClick={runVerify} disabled={verifying}
            className="py-1.5 px-3 r-ctl border border-line text-sm font-semibold m-hover hover:border-teal hover:text-teal disabled:opacity-50">
            {verifying ? '검증 중…' : '무결성 검증'}
          </button>
        </div>

        {/* 해시체인 검증 결과 — 로그가 위·변조·삭제되지 않았음을 감사자가 직접 확인한다 */}
        {verify && (
          <p className={`mt-2 text-sm ${verify.ok ? 'text-good' : 'text-crit'}`} role="status">
            {verify.ok
              ? `무결성 정상 — ${verify.count}건 연속(seq ${verify.firstSeq}~${verify.lastSeq}). 위·변조·삭제 흔적 없음`
              : `✗ 무결성 깨짐 — seq ${verify.brokenAt} 지점: ${verify.reason ?? '원인 불명'}`}
          </p>
        )}
      </section>

      {loading && !res && <Loading />}
      {res && (
        <section className="card">
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <p className="text-xs text-ink-2">총 <b className="mono">{res.total}</b>건 · {skip + 1}~{skip + res.count} 표시</p>
            <div className="flex gap-1">
              <button onClick={() => run(Math.max(0, skip - TAKE))} disabled={skip === 0} className="text-xs px-2 py-1 rounded-lg border border-line disabled:opacity-40">이전</button>
              <button onClick={() => run(skip + TAKE)} disabled={skip + res.count >= res.total} className="text-xs px-2 py-1 rounded-lg border border-line disabled:opacity-40">다음</button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-ink-2 border-b border-line">
                  <th className="py-2">시각</th><th>사용자</th><th>액션</th><th>대상</th><th>IP</th><th>상태</th><th></th>
                </tr>
              </thead>
              <tbody>
                {res.rows.map((r) => {
                  const d = parseDetail(r.detail);
                  const isOpen = open === r.logId;
                  return (
                  <Fragment key={r.logId}>
                  <tr className={`border-b border-line last:border-0 ${isOpen ? 'bg-teal/5' : ''}`}>
                    <td className="py-1.5 mono text-xs text-ink-3">{r.createdDt.slice(0, 19).replace('T', ' ')}</td>
                    <td className="mono text-xs">{r.userId ?? '—'}</td>
                    <td className={`font-bold text-xs ${actionColor[r.action] ?? ''}`}>{r.action}</td>
                    <td className="mono text-xs">{r.target}</td>
                    <td className="mono text-xs text-ink-3">{d.ip ?? '—'}</td>
                    <td className={`mono text-xs ${r.status && r.status >= 400 ? 'text-crit' : 'text-good'}`}>{r.status ?? ''}</td>
                    <td className="text-right whitespace-nowrap">
                      {r.sensitive && <span className="px-1.5 py-0.5 r-chip bg-warn/20 text-warn t-micro mr-1">민감</span>}
                      {r.detail && (
                        <button onClick={() => setOpen(isOpen ? null : r.logId)} aria-expanded={isOpen}
                          className="t-micro border border-line r-chip px-1.5 py-0.5 m-hover hover:border-teal hover:text-teal">
                          {isOpen ? '접기' : '상세'}
                        </button>
                      )}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="border-b border-line bg-surface-2">
                      <td colSpan={7} className="px-3 py-2">
                        <dl className="grid sm:grid-cols-2 gap-x-4 gap-y-1 t-meta">
                          {r.seq != null && <div><dt className="inline text-ink-3">체인 seq </dt><dd className="inline mono">{r.seq}</dd></div>}
                          {d.ip && <div><dt className="inline text-ink-3">접속지 </dt><dd className="inline mono">{d.ip}</dd></div>}
                          {d.ua && <div className="sm:col-span-2"><dt className="inline text-ink-3">클라이언트 </dt><dd className="inline">{d.ua}</dd></div>}
                          {d.params && Object.keys(d.params).length > 0 && (
                            <div className="sm:col-span-2"><dt className="inline text-ink-3">경로 파라미터 </dt><dd className="inline mono">{JSON.stringify(d.params)}</dd></div>
                          )}
                          {d.body && Object.keys(d.body).length > 0 && (
                            <div className="sm:col-span-2">
                              <dt className="text-ink-3">변경 내용(민감값 마스킹됨)</dt>
                              <dd className="mono bg-bg r-ctl p-2 mt-0.5 overflow-x-auto text-xs">{JSON.stringify(d.body, null, 1)}</dd>
                            </div>
                          )}
                        </dl>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
      </>)}
    </main>
  );
}
