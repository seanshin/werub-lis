'use client';

/**
 * 통계 · 리포트 화면 (`/stats`).
 *
 * 사이드바 노출 역할: TEC, PHY, MIC, PAT, BB, ADM, AUD.
 * ⚠ 노출 역할과 화면이 호출하는 API 권한이 어긋나면 전부 403인 죽은 화면이 된다 —
 *   역할을 바꿀 때는 `Sidebar.tsx`(정본)와 API 권한 매트릭스를 함께 본다.
 * 데이터는 `lib/api.ts`의 `apiFetch`로만 가져온다(HTTP 호출 정본).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, getToken } from '@/lib/api';
import { Loading } from '@/components/ui';
import { StatusChip } from '@/components/Explain';

interface Tat { count: number; meanMin: number; medianMin: number; p90Min: number; buckets: { label: string; count: number }[]; }
interface Vol { total: number; byDomain: Record<string, number>; rerunCount: number; rerunRatePct: number; }
interface Pending { resultId: string; specimenNo: string; testName: string; holdReason: string | null; ageMin: number; overdue: boolean; }
interface Abx { antibiotic: string; tested: number; susceptible: number; pctS: number; }
interface Organism { organism: string; total: number; antibiotics: Abx[]; }
interface Workload { total: number; entered: { user: string; count: number }[]; verified: { user: string; count: number }[]; }
interface SectionTat { sections: { domain: string; count: number; meanMin: number; medianMin: number }[]; }
interface VolumeTrend { total: number; series: { day: string; count: number }[]; }
interface PathologyQa { totalCases: number; byCaseType: Record<string, number>; signedCases: number; amendedCases: number; amendmentRatePct: number; frozen: { total: number; concordant: number; concordanceRatePct: number | null }; tat: { count: number; meanMin: number; medianMin: number; p90Min: number }; ihcResultCount: number; cytologyReportCount: number; }
interface Transfusion { issued: number; transfused: number; returned: number; emergency: number; crossmatches: number; discardCount: number; byProduct: Record<string, number>; discardByReason: Record<string, number>; inventory: Record<string, number>; ctRatio: number | null; returnRatePct: number; emergencyRatePct: number; }

export default function StatsPage() {
  const router = useRouter();
  const [tat, setTat] = useState<Tat | null>(null);
  const [vol, setVol] = useState<Vol | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<Pending[]>([]);
  const [abg, setAbg] = useState<Organism[]>([]);
  const [bb, setBb] = useState<Transfusion | null>(null);
  // 관리 통계 — API는 있었으나 화면이 없어 쓸 수 없던 4종
  const [wl, setWl] = useState<Workload | null>(null);
  const [stat, setStat] = useState<SectionTat | null>(null);
  const [trend, setTrend] = useState<VolumeTrend | null>(null);
  const [pqa, setPqa] = useState<PathologyQa | null>(null);
  const [csv, setCsv] = useState('');
  const [range, setRange] = useState({ from: '', to: '' });
  const [err, setErr] = useState('');

  function saveCsv(name: string, content: string) {
    const blob = new Blob(['﻿' + content], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  }
  function downloadCsv() { saveCsv('antibiogram.csv', csv); }
  // 리포트 CSV — TAT·검사량·분야TAT·수혈·병리QA 요약을 한 파일로(운영 보고용)
  function exportReport() {
    const rows: (string | number)[][] = [['구분', '지표', '값']];
    rows.push(['TAT', '건수', tat?.count ?? ''], ['TAT', '평균(분)', tat?.meanMin ?? ''], ['TAT', '중앙(분)', tat?.medianMin ?? ''], ['TAT', 'p90(분)', tat?.p90Min ?? '']);
    rows.push(['검사량', '총 보고', vol?.total ?? ''], ['검사량', '재검률(%)', vol?.rerunRatePct ?? '']);
    if (vol) for (const [d, n] of Object.entries(vol.byDomain)) rows.push(['검사량:분야', d, n]);
    if (stat) for (const x of stat.sections) rows.push(['분야TAT', x.domain, `건수 ${x.count} · 평균 ${x.meanMin}분 · 중앙 ${x.medianMin}분`]);
    if (bb) {
      rows.push(['수혈', '수혈 시행', bb.transfused], ['수혈', 'C:T ratio', bb.ctRatio ?? ''], ['수혈', '반납률(%)', bb.returnRatePct], ['수혈', '폐기 건수', bb.discardCount], ['수혈', '응급 출고율(%)', bb.emergencyRatePct]);
      for (const [p, n] of Object.entries(bb.byProduct)) rows.push(['수혈:제제', p, n]);
    }
    if (pqa) {
      rows.push(['병리QA', '케이스', pqa.totalCases], ['병리QA', '서명', pqa.signedCases], ['병리QA', '개정률(%)', pqa.amendmentRatePct], ['병리QA', '동결 일치도(%)', pqa.frozen.concordanceRatePct ?? ''], ['병리QA', 'TAT 평균(일)', pqa.tat.count ? Math.round(pqa.tat.meanMin / 144) / 10 : ''], ['병리QA', 'IHC 볼륨', pqa.ihcResultCount], ['병리QA', '세포병리 볼륨', pqa.cytologyReportCount]);
    }
    rows.push(['기간', 'from', range.from || '전체'], ['기간', 'to', range.to || '현재']);
    saveCsv(`stats_${range.from || 'all'}_${range.to || 'now'}.csv`, rows.map((r) => r.map((v) => `"${v}"`).join(',')).join('\n'));
  }

  const load = useCallback(async (override?: { from: string; to: string }) => {
    const rng = override ?? range;
    setErr('');
    setLoading(true);
    const qs = new URLSearchParams();
    if (rng.from) qs.set('from', `${rng.from}T00:00:00`);
    if (rng.to) qs.set('to', `${rng.to}T23:59:59`);
    const s = qs.toString() ? `?${qs}` : '';
    try {
      const [t, v, p, a, bbs] = await Promise.all([
        apiFetch<Tat>(`/api/v1/stats/tat${s}`),
        apiFetch<Vol>(`/api/v1/stats/volumes${s}`),
        apiFetch<Pending[]>('/api/v1/stats/pending'),
        apiFetch<{ organisms: Organism[]; csv: string }>(`/api/v1/stats/antibiogram${s}`),
        apiFetch<Transfusion>(`/api/v1/stats/transfusion${s}`),
      ]);
      setTat(t); setVol(v); setPending(p); setAbg(a.organisms); setCsv(a.csv); setBb(bbs);
      // 관리 통계는 실패해도 나머지 지표를 막지 않는다(권한·데이터 부족 시 개별 생략)
      apiFetch<Workload>(`/api/v1/stats/workload${s}`).then(setWl).catch(() => setWl(null));
      apiFetch<SectionTat>(`/api/v1/stats/section-tat${s}`).then(setStat).catch(() => setStat(null));
      apiFetch<VolumeTrend>(`/api/v1/stats/volume-trend${s}`).then(setTrend).catch(() => setTrend(null));
      apiFetch<PathologyQa>(`/api/v1/stats/pathology-qa${s}`).then(setPqa).catch(() => setPqa(null));
    } catch (e) { setErr(e instanceof Error ? e.message : '조회 실패'); }
    finally { setLoading(false); }
  }, [range]);

  // 기간 프리셋 — 운영자가 매번 날짜를 고르지 않도록(오늘/최근 N일/전체)
  const fmtDate = (d: Date) => d.toISOString().slice(0, 10);
  function preset(days: number | 'all') {
    if (days === 'all') { setRange({ from: '', to: '' }); void load({ from: '', to: '' }); return; }
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - (days - 1));
    const nr = { from: fmtDate(from), to: fmtDate(to) };
    setRange(nr); void load(nr);
  }

  useEffect(() => {
    if (!getToken()) { router.push('/'); return; }
    void load();
  }, [router]); // eslint-disable-line react-hooks/exhaustive-deps

  const maxBucket = tat ? Math.max(1, ...tat.buckets.map((b) => b.count)) : 1;
  const pctColor = (p: number) => (p >= 80 ? 'text-good' : p >= 50 ? 'text-warn' : 'text-crit');

  return (
    <main className="page print-area">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h1 className="t-page">통계 · 리포트</h1>
        <div className="flex items-center gap-2 no-print flex-wrap">
          <div className="flex items-center gap-1 mr-1" role="group" aria-label="기간 프리셋">
            {([['오늘', 1], ['7일', 7], ['30일', 30], ['전체', 'all']] as const).map(([label, d]) => (
              <button key={label} onClick={() => preset(d)} className="py-1.5 px-2 rounded-lg border border-line text-xs font-semibold text-ink-2 hover:border-teal hover:text-teal">{label}</button>
            ))}
          </div>
          <input type="date" aria-label="시작일" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} className="px-2 py-1.5 rounded-lg border border-line bg-bg text-sm" />
          <span className="text-xs text-ink-3">~</span>
          <input type="date" aria-label="종료일" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} className="px-2 py-1.5 rounded-lg border border-line bg-bg text-sm" />
          <button onClick={() => load()} className="py-1.5 px-3 rounded-lg bg-teal text-white font-semibold text-sm">조회</button>
          <button onClick={exportReport} className="py-1.5 px-3 rounded-lg border border-line text-sm font-semibold">CSV</button>
          <button onClick={() => window.print()} className="py-1.5 px-3 rounded-lg border border-line text-sm font-semibold">인쇄</button>
        </div>
      </div>
      {err && <p className="text-sm text-crit mb-3">{err}</p>}

      {loading && !tat ? <Loading /> : (
      <>
      <div className="grid md:grid-cols-3 gap-4 mb-4">
        {/* TAT */}
        <section className="card md:col-span-2">
          <h2 className="t-section mb-3">TAT (접수→보고)</h2>
          {tat && (
            <>
              <div className="flex gap-6 mb-4 text-sm">
                <div><span className="text-ink-2">건수</span> <b className="mono">{tat.count}</b></div>
                <div><span className="text-ink-2">평균</span> <b className="mono">{tat.meanMin}분</b></div>
                <div><span className="text-ink-2">중앙</span> <b className="mono">{tat.medianMin}분</b></div>
                <div><span className="text-ink-2">p90</span> <b className="mono">{tat.p90Min}분</b></div>
              </div>
              <div className="space-y-1.5">
                {tat.buckets.map((b) => (
                  <div key={b.label} className="flex items-center gap-2 text-xs">
                    <span className="w-12 text-ink-2 text-right">{b.label}</span>
                    <div className="flex-1 bg-bg rounded h-4 overflow-hidden">
                      <div className="h-full bg-teal rounded" style={{ width: `${(b.count / maxBucket) * 100}%` }} />
                    </div>
                    <span className="w-8 mono">{b.count}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>

        {/* 검사량 */}
        <section className="card">
          <h2 className="t-section mb-3">검사량 · 재검률</h2>
          {vol && (
            <>
              <div className="text-3xl font-extrabold text-teal mono mb-1">{vol.total}</div>
              <p className="text-xs text-ink-2 mb-3">총 보고 건수 · 재검률 <b className={vol.rerunRatePct > 5 ? 'text-warn' : 'text-good'}>{vol.rerunRatePct}%</b> <span className="text-ink-3">({vol.rerunCount}건)</span></p>
              {Object.entries(vol.byDomain).map(([d, n]) => (
                <div key={d} className="flex justify-between text-xs py-0.5"><span className="text-ink-2">{d}</span><span className="mono">{n}</span></div>
              ))}
            </>
          )}
        </section>

        {/* 수혈 사용·폐기(T3) */}
        {bb && (
          <section className="card md:col-span-2">
            <h2 className="t-section mb-3">수혈 사용·폐기</h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
              <div><div className="text-2xl font-extrabold text-teal mono">{bb.transfused}</div><div className="text-[11px] text-ink-2">수혈 시행</div></div>
              <div><div className="text-2xl font-extrabold mono">{bb.ctRatio ?? '—'}</div><div className="text-[11px] text-ink-2">C:T ratio <span className="text-ink-3">(교차 {bb.crossmatches} · 목표 ≤2)</span></div></div>
              <div><div className={`text-2xl font-extrabold mono ${bb.returnRatePct > 10 ? 'text-warn' : ''}`}>{bb.returnRatePct}%</div><div className="text-[11px] text-ink-2">반납률 ({bb.returned}/{bb.issued})</div></div>
              <div><div className={`text-2xl font-extrabold mono ${bb.discardCount > 0 ? 'text-warn' : 'text-good'}`}>{bb.discardCount}</div><div className="text-[11px] text-ink-2">폐기 건수</div></div>
            </div>
            <div className="grid sm:grid-cols-3 gap-3 text-xs">
              <div>
                <div className="text-ink-2 font-semibold mb-1">제제별 사용</div>
                {Object.keys(bb.byProduct).length === 0 ? <span className="text-ink-3">없음</span> : Object.entries(bb.byProduct).map(([p, n]) => <div key={p} className="flex justify-between py-0.5"><span className="text-ink-2">{p}</span><span className="mono">{n}</span></div>)}
              </div>
              <div>
                <div className="text-ink-2 font-semibold mb-1">폐기 사유</div>
                {Object.keys(bb.discardByReason).length === 0 ? <span className="text-ink-3">없음</span> : Object.entries(bb.discardByReason).map(([p, n]) => <div key={p} className="flex justify-between py-0.5"><span className="text-ink-2 truncate mr-2">{p}</span><span className="mono">{n}</span></div>)}
              </div>
              <div>
                <div className="text-ink-2 font-semibold mb-1">재고 현황</div>
                {Object.entries(bb.inventory).map(([s, n]) => <div key={s} className="flex justify-between py-0.5"><span className="text-ink-2 mono">{s}</span><span className="mono">{n}</span></div>)}
              </div>
            </div>
            {bb.emergencyRatePct > 0 && <p className="text-[11px] text-ink-3 mt-2">응급(MTP·미교차) 출고율 {bb.emergencyRatePct}%</p>}
          </section>
        )}
      </div>

      {/* 관리 통계 — 운영 관리자가 보는 지표(API는 있었으나 화면이 없었다) */}
      {(wl || stat || trend) && (
        <div className="grid md:grid-cols-3 gap-4 mb-4">
          {stat && stat.sections.length > 0 && (
            <section className="card">
              <h2 className="t-section mb-1">분야별 TAT</h2>
              <p className="t-meta mb-2">분야마다 목표 시간이 다르므로 전체 평균만으로는 병목을 못 찾는다.</p>
              <table className="w-full text-sm">
                <thead><tr className="text-left t-micro border-b border-line"><th className="py-1">분야</th><th>건수</th><th>평균</th><th>중앙</th></tr></thead>
                <tbody>
                  {stat.sections.map((x) => (
                    <tr key={x.domain} className="border-b border-line last:border-0">
                      <td className="py-1 text-xs">{x.domain}</td>
                      <td className="mono text-xs">{x.count}</td>
                      <td className="mono text-xs">{x.meanMin}분</td>
                      <td className="mono text-xs text-ink-3">{x.medianMin}분</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {wl && (
            <section className="card">
              <h2 className="t-section mb-1">워크로드 <span className="t-meta">총 {wl.total}건</span></h2>
              <p className="t-meta mb-2">직원별 결과입력·검증 건수. 업무 편중·인력 배치 판단용.</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="t-micro mb-1">결과입력</div>
                  {wl.entered.length === 0 ? <span className="t-meta">—</span> : wl.entered.map((u) => (
                    <div key={u.user} className="flex justify-between text-xs py-0.5"><span className="mono">{u.user}</span><span className="mono">{u.count}</span></div>
                  ))}
                </div>
                <div>
                  <div className="t-micro mb-1">검증</div>
                  {wl.verified.length === 0 ? <span className="t-meta">—</span> : wl.verified.map((u) => (
                    <div key={u.user} className="flex justify-between text-xs py-0.5"><span className="mono">{u.user}</span><span className="mono">{u.count}</span></div>
                  ))}
                </div>
              </div>
            </section>
          )}

          {trend && trend.series.length > 0 && (
            <section className="card">
              <h2 className="t-section mb-1">검사량 추세 <span className="t-meta">총 {trend.total}건</span></h2>
              <p className="t-meta mb-2">일자별 결과 건수 — 급증·급감은 장비·연계 이상 신호일 수 있다.</p>
              <div className="flex items-end gap-1 h-20" role="img" aria-label={`일자별 검사량 추세 ${trend.series.length}일`}>
                {trend.series.map((d) => {
                  const max = Math.max(...trend.series.map((x) => x.count)) || 1;
                  return <span key={d.day} title={`${d.day}: ${d.count}건`} className="flex-1 bg-teal/30 hover:bg-teal/50 m-hover r-chip" style={{ height: `${Math.max(6, (d.count / max) * 100)}%` }} />;
                })}
              </div>
              <div className="flex justify-between t-micro mt-1"><span>{trend.series[0]?.day}</span><span>{trend.series[trend.series.length - 1]?.day}</span></div>
            </section>
          )}
        </div>
      )}

      {/* 병리 QA — 개정률·동결절편 일치도는 인증 지표(PP6) */}
      {pqa && pqa.totalCases > 0 && (
        <section className="card mb-4">
          <h2 className="t-section mb-1">병리 QA</h2>
          <p className="t-meta mb-3">개정률과 동결절편 일치도는 병리 인증에서 요구하는 품질 지표입니다.</p>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <div><div className="t-micro">케이스</div><div className="text-xl font-extrabold mono">{pqa.totalCases}</div></div>
            <div><div className="t-micro">서명 완료</div><div className="text-xl font-extrabold mono">{pqa.signedCases}</div></div>
            <div><div className="t-micro">개정</div><div className="text-xl font-extrabold mono">{pqa.amendedCases}</div></div>
            <div><div className="t-micro">개정률</div><div className={`text-xl font-extrabold mono ${pqa.amendmentRatePct > 5 ? 'text-warn' : ''}`}>{pqa.amendmentRatePct}%</div></div>
            <div><div className="t-micro">동결 일치도</div><div className="text-xl font-extrabold mono">{pqa.frozen.concordanceRatePct != null ? `${pqa.frozen.concordanceRatePct}%` : '—'}</div><div className="t-micro">{pqa.frozen.total}건 중 {pqa.frozen.concordant}</div></div>
          </div>
          {/* 병리 TAT(일 단위)·IHC/세포병리 볼륨·케이스 유형 — 백엔드가 반환하던 지표(화면 누락 보완) */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3 pt-3 border-t border-line">
            <div><div className="t-micro">TAT 평균</div><div className="text-xl font-extrabold mono">{pqa.tat.count ? `${Math.round(pqa.tat.meanMin / 144) / 10}일` : '—'}</div>{pqa.tat.count > 0 && <div className="t-micro">중앙 {Math.round(pqa.tat.medianMin / 144) / 10}일 · n{pqa.tat.count}</div>}</div>
            <div><div className="t-micro">IHC 볼륨</div><div className="text-xl font-extrabold mono">{pqa.ihcResultCount}</div></div>
            <div><div className="t-micro">세포병리 볼륨</div><div className="text-xl font-extrabold mono">{pqa.cytologyReportCount}</div></div>
            <div><div className="t-micro">케이스 유형</div><div className="flex flex-wrap gap-1 mt-1">{Object.keys(pqa.byCaseType).length === 0 ? <span className="text-ink-3 text-xs">—</span> : Object.entries(pqa.byCaseType).map(([t, n]) => <span key={t} className="text-[11px] mono px-1.5 py-0.5 rounded bg-bg border border-line">{t} {n}</span>)}</div></div>
          </div>
        </section>
      )}

      <div className="grid md:grid-cols-2 gap-4">
        {/* 미보고 */}
        <section className="card">
          <h2 className="t-section mb-3">미보고 · 지연 <span className="text-xs text-ink-2">({pending.length})</span></h2>
          <div className="overflow-x-auto max-h-64 overflow-y-auto">
            <table className="w-full text-sm">
              <tbody>
                {pending.length === 0 ? <tr><td className="py-3 text-center text-ink-3 text-xs">대기 없음 </td></tr> :
                  pending.map((p) => (
                    <tr key={p.resultId} className="border-b border-line last:border-0">
                      <td className="py-1.5">{p.testName}</td>
                      <td className="mono text-xs text-ink-3">{p.specimenNo}</td>
                      <td className="text-xs"><StatusChip code={p.holdReason} tone={p.holdReason === 'CRITICAL' ? 'crit' : 'warn'} /></td>
                      <td className={`mono text-xs text-right ${p.overdue ? 'text-crit font-bold' : 'text-ink-2'}`}>{p.ageMin}분</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* antibiogram */}
        <section className="card">
          <div className="flex items-center justify-between mb-3">
            <h2 className="t-section">Antibiogram (%S) <span className="text-xs font-normal text-ink-3">· 전체 누적(기간 필터 미적용)</span></h2>
            {csv && <button onClick={downloadCsv} className="text-xs bg-teal text-white px-2 py-1 rounded-lg font-semibold">CSV 다운로드</button>}
          </div>
          {abg.length === 0 ? <p className="text-sm text-ink-2 py-6 text-center">균주 데이터 없음</p> :
            abg.map((o) => (
              <div key={o.organism} className="mb-3">
                <div className="font-semibold text-sm mb-1">{o.organism} <span className="text-xs text-ink-3">(n≈{o.total})</span></div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                  {o.antibiotics.map((a) => (
                    <div key={a.antibiotic} className="flex justify-between text-xs">
                      <span className="text-ink-2">{a.antibiotic}</span>
                      <span className={`mono font-bold ${pctColor(a.pctS)}`} title={`감수성 ${a.susceptible}/${a.tested} 균주`}>{a.pctS}% <span className="font-normal text-ink-3">({a.susceptible}/{a.tested})</span></span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
        </section>
      </div>
      </>
      )}
    </main>
  );
}
