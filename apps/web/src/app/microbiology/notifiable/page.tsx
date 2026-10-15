'use client';

/**
 * 감염관리 화면 (`/microbiology/notifiable`).
 *
 * 사이드바 노출 역할: MIC, PHY, ADM.
 * ⚠ 노출 역할과 화면이 호출하는 API 권한이 어긋나면 전부 403인 죽은 화면이 된다 —
 *   역할을 바꿀 때는 `Sidebar.tsx`(정본)와 API 권한 매트릭스를 함께 본다.
 * 데이터는 `lib/api.ts`의 `apiFetch`로만 가져온다(HTTP 호출 정본).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useState, useEffect, useCallback, Fragment } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, getToken, getRoles } from '@/lib/api';
import { EmptyState, ErrorText, Loading, TableSkeleton } from '@/components/ui';
import { maskName } from '@/lib/privacy';
import { useToast } from '@/components/toast';
import AttachmentPanel from '@/components/AttachmentPanel';
import { IconChevron } from '@/components/Icon';

/**
 * 법정감염병 신고 대기(P1-15) — 검출 건의 신고 대기·완료 처리.
 *
 * 목록·완료 API는 있었으나 화면이 없었다. 감염관리팀이 신고 여부를 이 화면에서 추적한다.
 * 배양·PCR 검출 시 감염관리팀 알림도 생성되지만(사이드바 배지), 실제 신고 완료 처리는 여기서.
 */

interface LineListRow { isolateId: string; patientId: string; patientName: string; specimenNo: string; organism: string; mdro: string | null; isolation: string | null; resistant: boolean; resistantAbx?: string[]; reportedDt: string | null; }
interface Report {
  reportId: string;
  patientId: string | null;
  patientName: string | null;
  organism: string;
  disease: string;
  grade: string | null;
  specimenNo: string | null;
  detectedDt: string;
  notifiedDt: string | null;
  notifiedBy: string | null;
  status: string;
  note: string | null;
  reportNo?: string | null;
  attachmentCount?: number;
}

export default function NotifiablePage() {
  // MDRO line list — 감염관리팀이 격리 대상을 한눈에(API는 있었으나 화면이 없었다)
  // 신고 완료 처리(write)는 MIC/ADM만 — 감염관리 의사(PHY)는 조회 전용(API도 동일).
  const [canNotify, setCanNotify] = useState(false);
  useEffect(() => { setCanNotify(getRoles().some((r) => r === 'MIC' || r === 'ADM')); }, []);
  const [tab, setTab] = useState<'notifiable' | 'mdro'>('notifiable');
  const [ll, setLl] = useState<LineListRow[]>([]);
  const [llFrom, setLlFrom] = useState('');
  const [llTo, setLlTo] = useState('');
  const [llLoading, setLlLoading] = useState(false);
  async function loadLineList() {
    setLlLoading(true);
    try {
      const qs = new URLSearchParams();
      if (llFrom) qs.set('from', llFrom);
      if (llTo) qs.set('to', llTo);
      const r = await apiFetch<{ total: number; rows: LineListRow[] }>(`/api/v1/microbiology/line-list${qs.toString() ? `?${qs}` : ''}`);
      setLl(r.rows);
    } catch { setLl([]); }
    finally { setLlLoading(false); }
  }
  const router = useRouter();
  const toast = useToast();
  const [rows, setRows] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [status, setStatus] = useState('PENDING');
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState<Record<string, string>>({});
  const [reportNo, setReportNo] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const load = useCallback(async (st: string) => {
    setLoading(true);
    setErr('');
    try {
      setRows(await apiFetch<Report[]>(`/api/v1/microbiology/notifiable?status=${st}`));
    } catch (e) {
      setErr(e instanceof Error ? e.message : '조회 실패(권한 필요)');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!getToken()) router.push('/');
    else load(status);
  }, [router, load, status]);

  async function markNotified(r: Report) {
    setBusy(r.reportId);
    try {
      await apiFetch(`/api/v1/microbiology/notifiable/${encodeURIComponent(r.reportId)}/notify`, {
        method: 'POST',
        body: JSON.stringify({ reportNo: reportNo[r.reportId]?.trim() || undefined, note: note[r.reportId]?.trim() || undefined }),
      });
      toast(`신고 완료 처리 — ${r.disease}`);
      load(status);
    } catch (e) {
      toast(e instanceof Error ? e.message : '처리 실패', 'error');
    } finally {
      setBusy('');
    }
  }

  // 등급 문자열은 '제1급'/'제2급'/'제3급'(notifiable-disease.ts) — 키를 일치시켜야 색배지가 뜬다(안 그러면 전부 회색)
  const gradeCls: Record<string, string> = { '제1급': 'bg-crit/15 text-crit', '제2급': 'bg-warn/15 text-warn', '제3급': 'bg-indigo/15 text-indigo' };
  const inp = 'px-2 py-1.5 rounded-lg border border-line bg-bg text-sm';

  return (
    <main className="page">
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <h1 className="t-page">감염관리</h1>
        {tab === 'notifiable' && (
          <select aria-label="상태" value={status} onChange={(e) => setStatus(e.target.value)} className={inp}>
            <option value="PENDING">신고 대기</option>
            <option value="NOTIFIED">신고 완료</option>
          </select>
        )}
      </div>
      <div className="flex gap-1 mb-3">
        <button onClick={() => setTab('notifiable')} className={`px-3 py-1.5 r-ctl text-sm font-semibold m-hover ${tab === 'notifiable' ? 'bg-teal text-white' : 'border border-line text-ink-2 hover:border-teal hover:text-teal'}`}>법정감염병 신고</button>
        <button onClick={() => { setTab('mdro'); if (ll.length === 0) void loadLineList(); }} className={`px-3 py-1.5 r-ctl text-sm font-semibold m-hover ${tab === 'mdro' ? 'bg-teal text-white' : 'border border-line text-ink-2 hover:border-teal hover:text-teal'}`}>MDRO line list</button>
      </div>
      <ErrorText message={err} />

      {tab === 'mdro' && (
        <>
          <p className="t-meta mb-3">다제내성균·내성 균주 목록 — 격리 대상 판단과 감염관리 라운딩에 씁니다.</p>
          <section className="card mb-4">
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <label htmlFor="ll-from" className="block t-micro mb-0.5">시작</label>
                <input id="ll-from" type="date" value={llFrom} onChange={(e) => setLlFrom(e.target.value)} className={inp} />
              </div>
              <div>
                <label htmlFor="ll-to" className="block t-micro mb-0.5">종료</label>
                <input id="ll-to" type="date" value={llTo} onChange={(e) => setLlTo(e.target.value)} className={inp} />
              </div>
              <button onClick={loadLineList} className="py-1.5 px-4 r-ctl bg-teal text-white font-semibold text-sm m-hover hover:bg-teal-2">조회</button>
              <span className="t-meta">{ll.length}건</span>
            </div>
          </section>
          <section className="card">
            {llLoading ? <TableSkeleton rows={4} cols={5} /> : ll.length === 0 ? (
              <EmptyState title="해당 기간에 MDRO·내성 균주가 없습니다" hint="기간을 넓혀 조회하거나, 균 동정이 완료됐는지 확인하세요." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left t-micro border-b border-line"><th className="py-2">일자</th><th>환자</th><th>검체</th><th>균종</th><th>MDRO</th><th>격리</th></tr></thead>
                  <tbody>
                    {ll.map((r) => (
                      <tr key={r.isolateId} className="border-b border-line last:border-0">
                        <td className="py-1.5 mono text-xs text-ink-3">{r.reportedDt ? r.reportedDt.slice(0, 10) : '—'}</td>
                        <td>{maskName(r.patientName)} <span className="mono text-xs text-ink-3">{r.patientId}</span></td>
                        <td className="mono text-xs">{r.specimenNo}</td>
                        <td className="text-xs italic">{r.organism}</td>
                        <td>
                          {r.mdro ? <span className="px-1.5 py-0.5 r-chip bg-warn/20 text-warn t-micro">{r.mdro}</span> : r.resistant ? <span className="t-micro text-ink-2">내성</span> : '—'}
                          {r.resistantAbx && r.resistantAbx.length > 0 && <span className="block t-micro text-ink-3" title={`내성 항생제: ${r.resistantAbx.join(', ')}`}>R: {r.resistantAbx.slice(0, 4).join(', ')}{r.resistantAbx.length > 4 ? ` +${r.resistantAbx.length - 4}` : ''}</span>}
                        </td>
                        <td className="text-xs">{r.isolation ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      {tab === 'notifiable' && (<>
      <p className="t-meta mb-4">
        검출 시 자동 등록됩니다(배양·PCR). 관할 보건소 신고 후 <b>신고 서류(스캔·사진)를 첨부</b>하고 완료 처리하세요 — 법정 신고 기한(1급 즉시·2급 24시간)을 준수하세요.
      </p>

      <section className="card">
        <h2 className="t-section mb-3">
          {status === 'PENDING' ? '신고 대기' : '신고 완료'} <span className="text-xs text-ink-2">({rows.length})</span>
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-2 border-b border-line">
                <th className="py-2">감염병·등급</th>
                <th>병원체</th>
                <th>환자·검체</th>
                <th>검출</th>
                <th>{status === 'PENDING' ? '신고 처리' : '신고 정보'}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Fragment key={r.reportId}>
                <tr className="border-b border-line last:border-0 align-top">
                  <td className="py-2">
                    <span className="font-semibold">{r.disease}</span>
                    {r.grade && <span className={`text-xs px-1.5 py-0.5 rounded font-bold ml-1 ${gradeCls[r.grade] ?? 'bg-ink-3/15'}`}>{r.grade}</span>}
                  </td>
                  <td className="text-xs italic">{r.organism}</td>
                  <td className="text-xs">
                    <span className="font-semibold">{r.patientName ?? '—'}</span>
                    <span className="mono text-ink-3 block">{r.patientId ?? '—'}{r.specimenNo ? ` · ${r.specimenNo}` : ''}</span>
                  </td>
                  <td className="text-xs text-ink-3">{new Date(r.detectedDt).toLocaleString('ko-KR')}</td>
                  <td>
                    <button onClick={() => setExpanded({ ...expanded, [r.reportId]: !expanded[r.reportId] })} aria-expanded={!!expanded[r.reportId]} className={`text-xs underline mb-1 block ${r.attachmentCount ? 'text-teal' : 'text-crit'}`}>
                      신고 서류 {r.attachmentCount ? `(${r.attachmentCount})` : '없음'} <IconChevron open={expanded[r.reportId]} />
                    </button>
                    {status === 'PENDING' ? (
                      canNotify ? (
                        <span className="flex gap-1 items-center flex-wrap">
                          <input aria-label="보건소 신고번호" placeholder="신고번호(필수)" value={reportNo[r.reportId] ?? ''} onChange={(e) => setReportNo({ ...reportNo, [r.reportId]: e.target.value })} className={`${inp} w-28`} />
                          <input aria-label="신고 비고" placeholder="비고(선택)" value={note[r.reportId] ?? ''} onChange={(e) => setNote({ ...note, [r.reportId]: e.target.value })} className={`${inp} w-24`} />
                          <button disabled={busy === r.reportId} onClick={() => markNotified(r)} className="py-1 px-2 rounded-lg bg-teal text-white text-xs disabled:opacity-50">신고완료</button>
                        </span>
                      ) : (
                        <span className="text-xs text-ink-3">미신고 · 처리는 감염관리팀(MIC)</span>
                      )
                    ) : (
                      <span className="text-xs text-ink-3">
                        {r.reportNo && <span className="block font-semibold text-ink">신고번호 {r.reportNo}</span>}
                        {r.notifiedDt ? new Date(r.notifiedDt).toLocaleString('ko-KR') : '—'}
                        {r.notifiedBy && <span className="block">by {r.notifiedBy}</span>}
                        {r.note && <span className="block text-ink-2">{r.note}</span>}
                      </span>
                    )}
                  </td>
                </tr>
                {expanded[r.reportId] && (
                  <tr>
                    <td colSpan={5} className="bg-bg/40 px-3 py-2">
                      <p className="text-xs text-ink-2 mb-1">보건소 신고 서류(스캔·사진, PDF·이미지)를 첨부하세요 — 완료 처리에 최소 1건 필요합니다.</p>
                      <AttachmentPanel reportId={r.reportId} compact={!canNotify} />
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
              {loading && rows.length === 0 && (
                <tr><td colSpan={5}><Loading /></td></tr>
              )}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={5}><EmptyState title={status === 'PENDING' ? '신고 대기 없음' : '신고 완료 내역 없음'} hint="법정감염병 검출 시 자동 등록됩니다." /></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      </>)}
    </main>
  );
}
