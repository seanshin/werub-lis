'use client';

/**
 * 정도관리 (QC · Westgard) 화면 (`/qc`).
 *
 * 사이드바 노출 역할: TEC, PHY, ADM.
 * ⚠ 노출 역할과 화면이 호출하는 API 권한이 어긋나면 전부 403인 죽은 화면이 된다 —
 *   역할을 바꿀 때는 `Sidebar.tsx`(정본)와 API 권한 매트릭스를 함께 본다.
 * 데이터는 `lib/api.ts`의 `apiFetch`로만 가져온다(HTTP 호출 정본).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, getToken } from '@/lib/api';

interface QcResult {
  saved: { qcResultId: string; measuredValue: number };
  evaluation: { z: number; violations: string[]; verdict: 'PASS' | 'WARN' | 'FAIL' };
}
interface Chart {
  mean: number; sd: number;
  points: { at: string | null; value: number; z: number }[];
}
interface QcTarget { qcTargetId: string; qcCode: string; instrument: string; testCode: string; mean: number; sd: number; }
interface MonthlyRow { testCode: string; instrument: string | null; PASS: number; WARN: number; FAIL: number; total: number; failRate: number; }
interface QcReview { reviewId: string; period: string; scope: string; instrument: string | null; reviewedBy: string; verdict: string; note: string | null; reviewedDt: string; }
interface MonthlySummary { period: string; total: number; rows: MonthlyRow[]; review: QcReview | null; }

const verdictColor: Record<string, string> = {
  PASS: 'text-good',
  WARN: 'text-warn',
  FAIL: 'text-crit',
};

/** Levey-Jennings 차트(SVG) — z-score 시계열, ±1/2/3SD 밴드. */
function LJChart({ chart }: { chart: Chart }) {
  const W = 620, H = 200, padL = 30, padR = 10, padT = 10, padB = 20;
  const pts = chart.points;
  const zToY = (z: number) => padT + ((4 - z) / 8) * (H - padT - padB); // z: +4(top)~-4(bottom)
  const xAt = (i: number) => padL + (pts.length <= 1 ? 0 : (i / (pts.length - 1)) * (W - padL - padR));
  const bandColor: Record<number, string> = { 3: '#dc2626', 2: '#d97706', 1: '#cbd5e1' };
  const dotColor = (z: number) => (Math.abs(z) >= 3 ? '#dc2626' : Math.abs(z) >= 2 ? '#d97706' : '#0d9488');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 220 }}>
      {[-3, -2, -1, 0, 1, 2, 3].map((z) => (
        <g key={z}>
          <line x1={padL} y1={zToY(z)} x2={W - padR} y2={zToY(z)} stroke={z === 0 ? '#64748b' : (bandColor[Math.abs(z)] ?? '#e2e8f0')} strokeWidth={z === 0 ? 1 : 0.5} strokeDasharray={z === 0 ? '' : '3 3'} />
          <text x={2} y={zToY(z) + 3} fontSize={9} fill="#94a3b8">{z > 0 ? `+${z}s` : z === 0 ? 'x̄' : `${z}s`}</text>
        </g>
      ))}
      {pts.length > 1 && (
        <polyline fill="none" stroke="#0d948855" strokeWidth={1.5}
          points={pts.map((p, i) => `${xAt(i)},${zToY(p.z)}`).join(' ')} />
      )}
      {pts.map((p, i) => (
        <circle key={i} cx={xAt(i)} cy={zToY(p.z)} r={3.5} fill={dotColor(p.z)}>
          <title>{`${p.at ? `${p.at.slice(0, 16).replace('T', ' ')} · ` : ''}측정 ${p.value} · z=${p.z.toFixed(2)}`}</title>
        </circle>
      ))}
    </svg>
  );
}

export default function QcPage() {
  const router = useRouter();
  const [qcCode, setQcCode] = useState('QC-CH1');
  const [instrument, setInstrument] = useState('화학1호기');
  const [testCode, setTestCode] = useState(''); // 데모 기본값 제거 — Enter 한 번에 가짜 QC가 등록됐다
  const [value, setValue] = useState('101');
  const [rows, setRows] = useState<{ v: number; eval: QcResult['evaluation'] }[]>([]);
  const [chart, setChart] = useState<Chart | null>(null);
  // 서버 QC 측정 로그(판정 이력이 세션 제출분만 보이던 것 보완) — 새로고침·타인 측정·과거 측정 조회
  const [log, setLog] = useState<{ qcResultId: string; testCode: string; testName: string; instrument: string | null; measuredValue: number | null; verdict: string | null; lot: string; unit: string | null; measuredDt: string | null }[]>([]);
  const [logVerdict, setLogVerdict] = useState('');
  // 로트 크로스오버(신로트 목표 확립) — API만 있고 화면이 없던 기능(P2)
  const [xo, setXo] = useState({ lot: '', values: '', mean: '', sd: '' });
  const [xoRes, setXoRes] = useState<{ target: QcTarget & { lot?: string }; computed: { n: number; mean: number; sd: number } | null } | null>(null);
  const [xoErr, setXoErr] = useState('');
  const [status, setStatus] = useState<{ verdict: string; blocked: boolean; measuredDt: string | null } | null>(null);
  const [targets, setTargets] = useState<QcTarget[]>([]);
  const [err, setErr] = useState('');
  // 월간 리뷰 사인오프(인증 요건)
  const [period, setPeriod] = useState(() => new Date().toISOString().slice(0, 7));
  const [summary, setSummary] = useState<MonthlySummary | null>(null);
  const [reviews, setReviews] = useState<QcReview[]>([]);
  const [revVerdict, setRevVerdict] = useState('승인');
  const [revNote, setRevNote] = useState('');
  const [revErr, setRevErr] = useState('');

  async function loadChart(qc = qcCode, inst = instrument, tc = testCode) {
    try {
      const params = new URLSearchParams({ qcCode: qc, instrument: inst, testCode: tc });
      setChart(await apiFetch<Chart>(`/api/v1/stats/qc-chart?${params}`));
    } catch { setChart(null); }
    try { setStatus(await apiFetch(`/api/v1/qc/status?testCode=${encodeURIComponent(tc)}`)); } catch { setStatus(null); }
  }

  const loadLog = async (verdict = logVerdict, tc = testCode) => {
    const qs = new URLSearchParams();
    if (tc) qs.set('testCode', tc);
    if (verdict) qs.set('verdict', verdict);
    try { setLog(await apiFetch(`/api/v1/qc/results${qs.toString() ? `?${qs}` : ''}`)); } catch { /* noop */ }
  };

  useEffect(() => {
    if (!getToken()) { router.push('/'); return; }
    apiFetch<QcTarget[]>('/api/v1/master/qc-targets').then(setTargets).catch(() => { /* noop */ });
    void loadLog('', '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  // QC 대상(물질·장비·검사) 선택 → 입력칸 일괄 채움(수기 오타 방지)
  function pickTarget(id: string) {
    const t = targets.find((x) => x.qcTargetId === id);
    if (!t) return;
    setQcCode(t.qcCode); setInstrument(t.instrument); setTestCode(t.testCode);
    // 선택하면 바로 차트·상태·로그를 보여준다(예전엔 '차트 불러오기'를 눌러야 해서 안 뜨는 것처럼 보였다)
    void loadChart(t.qcCode, t.instrument, t.testCode);
    void loadLog(logVerdict, t.testCode);
  }

  async function loadMonthly() {
    setRevErr('');
    try {
      const [s, rv] = await Promise.all([
        apiFetch<MonthlySummary>(`/api/v1/qc/monthly-summary?period=${encodeURIComponent(period)}`),
        apiFetch<QcReview[]>(`/api/v1/qc/reviews?period=${encodeURIComponent(period)}`),
      ]);
      setSummary(s); setReviews(rv);
      if (s.review) { setRevVerdict(s.review.verdict); setRevNote(s.review.note ?? ''); }
    } catch (e) { setRevErr(e instanceof Error ? e.message : '월간 요약 조회 실패'); }
  }

  async function submitReview() {
    setRevErr('');
    try {
      await apiFetch('/api/v1/qc/review', { method: 'POST', body: JSON.stringify({ period, scope: 'ALL', verdict: revVerdict, note: revNote || undefined }) });
      await loadMonthly();
    } catch (e) { setRevErr(e instanceof Error ? e.message : '리뷰 기록 실패'); }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    try {
      const r = await apiFetch<QcResult>('/api/v1/qc/results', {
        method: 'POST',
        body: JSON.stringify({ qcCode, instrument, testCode, value: Number(value) }),
      });
      setRows((prev) => [{ v: r.saved.measuredValue, eval: r.evaluation }, ...prev]);
      await loadChart(); await loadLog();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '등록 실패');
    }
  }

  return (
    <main className="page">
      <h1 className="t-page mb-4">정도관리 (QC · Westgard)</h1>
      {err && <p className="text-sm text-crit mb-3">{err}</p>}

      <section className="card mb-4">
        <div className="flex items-center gap-2 mb-3">
          <h2 className="t-section">QC 측정 등록</h2>
          {status && (
            <span className={`text-xs px-2 py-0.5 rounded font-bold ${status.blocked ? 'bg-crit/15 text-crit' : status.verdict === 'PASS' ? 'bg-good/15 text-good' : status.verdict === 'NONE' ? 'bg-bg text-ink-3' : 'bg-warn/15 text-warn'}`}>
              오늘 {testCode}: {status.verdict === 'NONE' ? '미측정' : status.verdict}{status.blocked && ' · 결과확정 차단'}{status.measuredDt && ` · ${status.measuredDt.slice(11, 16)}`}
            </span>
          )}
        </div>
        {targets.length > 0 && (
          <div className="mb-3">
            <label className="block text-xs text-ink-2 mb-1">QC 대상 선택 <span className="text-ink-3">(물질·장비·검사 일괄)</span></label>
            <select aria-label="QC 대상 선택" onChange={(e) => pickTarget(e.target.value)} value={targets.find((t) => t.qcCode === qcCode && t.instrument === instrument && t.testCode === testCode)?.qcTargetId ?? ''} className="px-3 py-2 rounded-lg border border-line bg-bg text-sm w-full max-w-md">
              <option value="">직접 입력…</option>
              {targets.map((t) => <option key={t.qcTargetId} value={t.qcTargetId}>{t.qcCode} · {t.instrument} · {t.testCode} (x̄ {t.mean}·SD {t.sd})</option>)}
            </select>
          </div>
        )}
        <form onSubmit={submit} className="flex flex-wrap gap-2 items-end">
          <div>
            <label className="block text-xs text-ink-2 mb-1">QC 로트</label>
            <input aria-label="QC 로트" className="mono px-3 py-2 rounded-lg border border-line bg-bg text-sm w-28" value={qcCode} onChange={(e) => setQcCode(e.target.value)} />
          </div>
          <div>
            <label className="block text-xs text-ink-2 mb-1">장비</label>
            <input aria-label="장비" className="mono px-3 py-2 rounded-lg border border-line bg-bg text-sm w-28" value={instrument} onChange={(e) => setInstrument(e.target.value)} />
          </div>
          <div>
            <label className="block text-xs text-ink-2 mb-1">검사</label>
            <input aria-label="검사" className="mono px-3 py-2 rounded-lg border border-line bg-bg text-sm w-28" value={testCode} onChange={(e) => setTestCode(e.target.value)} />
          </div>
          <div>
            <label className="block text-xs text-ink-2 mb-1">측정값</label>
            <input aria-label="측정값" className="mono px-3 py-2 rounded-lg border border-line bg-bg text-sm w-24" value={value} onChange={(e) => setValue(e.target.value)} />
          </div>
          <button type="submit" className="py-2 px-4 rounded-lg bg-teal text-white font-semibold text-sm">등록·판정</button>
          <button type="button" onClick={() => void loadChart()} className="py-2 px-4 rounded-lg border border-line text-sm font-semibold">차트 새로고침</button>
        </form>

      </section>

      {chart && (
        <section className="card mb-4">
          <div className="flex items-center gap-2 mb-2">
            <h2 className="t-section">Levey-Jennings</h2>
            <span className="mono text-xs text-ink-2">x̄ {chart.mean} · SD {chart.sd} · n {chart.points.length}</span>
          </div>
          {chart.points.length === 0 ? <p className="text-sm text-ink-2 py-4 text-center">측정 이력 없음</p> : <LJChart chart={chart} />}
        </section>
      )}

      {rows.length > 0 && (
        <section className="card">
          <h2 className="t-section mb-3">판정 이력</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-ink-2 border-b border-line">
                  <th className="py-2">측정값</th><th>z-score</th><th>위반규칙</th><th>판정</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-b border-line last:border-0">
                    <td className="py-2 mono">{r.v}</td>
                    <td className="mono">{r.eval.z}</td>
                    <td className="mono text-xs">{r.eval.violations.join(', ') || '—'}</td>
                    <td className={`font-bold ${verdictColor[r.eval.verdict]}`}>{r.eval.verdict}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* QC 측정 로그(서버) — 판정 이력이 세션 제출분만 보이던 것 보완: 새로고침·타인·과거 측정 조회 */}
      <section className="card">
        <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
          <h2 className="t-section">QC 측정 로그 <span className="text-ink-3 text-xs font-normal">({log.length})</span></h2>
          <div className="flex gap-2 items-center">
            <select aria-label="판정 필터" value={logVerdict} onChange={(e) => { setLogVerdict(e.target.value); void loadLog(e.target.value); }} className="px-2 py-1 rounded-lg border border-line bg-bg text-xs">
              <option value="">전체 판정</option><option value="PASS">PASS</option><option value="WARN">WARN</option><option value="FAIL">FAIL</option>
            </select>
            {testCode && <button onClick={() => void loadLog(logVerdict, testCode)} className="text-xs text-teal underline">이 검사만</button>}
            <button onClick={() => { setLogVerdict(''); void loadLog('', ''); }} className="text-xs text-ink-3 underline">전체</button>
          </div>
        </div>
        {log.length === 0 ? <p className="text-sm text-ink-3 py-3">측정 로그가 없습니다.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-ink-2 border-b border-line">
                <th className="py-2">측정일</th><th>검사</th><th>장비</th><th>로트</th><th>측정값</th><th>판정</th>
              </tr></thead>
              <tbody>
                {log.map((r) => (
                  <tr key={r.qcResultId} className="border-b border-line last:border-0">
                    <td className="py-1.5 mono text-xs text-ink-2">{r.measuredDt ? r.measuredDt.slice(0, 16).replace('T', ' ') : '—'}</td>
                    <td>{r.testName} <span className="mono text-xs text-ink-3">{r.testCode}</span></td>
                    <td className="text-ink-2">{r.instrument ?? '—'}</td>
                    <td className="mono text-xs">{r.lot}</td>
                    <td className="mono">{r.measuredValue ?? '—'} {r.unit ?? ''}</td>
                    <td className={`font-bold ${r.verdict ? verdictColor[r.verdict] ?? '' : ''}`}>{r.verdict ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 월간 QC 리뷰 사인오프 — 인증 요건(감독자 검토·승인) */}
      <section className="card mt-4">
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <h2 className="t-section">월간 QC 리뷰</h2>
          <input aria-label="기간(YYYY-MM)" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className="px-2 py-1.5 rounded-lg border border-line bg-bg text-sm" />
          <button onClick={loadMonthly} className="py-1.5 px-3 rounded-lg bg-teal text-white text-sm font-semibold">요약 조회</button>
          {summary?.review && (
            <span className={`text-xs px-2 py-0.5 rounded font-bold ${summary.review.verdict === '승인' ? 'bg-good/15 text-good' : 'bg-warn/15 text-warn'}`}>
              {summary.review.verdict} · {summary.review.reviewedBy} · {summary.review.reviewedDt.slice(0, 10)}
            </span>
          )}
        </div>
        {revErr && <p className="text-sm text-crit mb-2">{revErr}</p>}
        {summary && (
          <>
            <p className="text-xs text-ink-2 mb-2">{summary.period} · 총 QC {summary.total}건</p>
            {summary.rows.length === 0 ? (
              <p className="text-sm text-ink-2 py-4 text-center">해당 월 QC 측정 없음</p>
            ) : (
              <div className="overflow-x-auto mb-3">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-ink-2 border-b border-line">
                      <th className="py-2">검사</th><th>장비</th><th className="text-good">PASS</th><th className="text-warn">WARN</th><th className="text-crit">FAIL</th><th>실패율</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.rows.map((r) => (
                      <tr key={`${r.testCode}|${r.instrument}`} className="border-b border-line last:border-0">
                        <td className="py-2 mono">{r.testCode}</td>
                        <td className="text-xs">{r.instrument || '—'}</td>
                        <td className="mono text-good">{r.PASS}</td>
                        <td className="mono text-warn">{r.WARN}</td>
                        <td className="mono text-crit">{r.FAIL}</td>
                        <td className={`mono font-bold ${r.failRate >= 10 ? 'text-crit' : r.failRate > 0 ? 'text-warn' : 'text-good'}`}>{r.failRate}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {/* 사인오프 폼 */}
            <div className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
              <div>
                <label className="block text-xs text-ink-2 mb-1">검토 판정</label>
                <select value={revVerdict} onChange={(e) => setRevVerdict(e.target.value)} className="px-2 py-1.5 rounded-lg border border-line bg-bg text-sm"><option>승인</option><option>보류</option></select>
              </div>
              <div className="flex-1 min-w-48">
                <label className="block text-xs text-ink-2 mb-1">검토 의견</label>
                <input aria-label="검토 의견" value={revNote} onChange={(e) => setRevNote(e.target.value)} placeholder="예: 화학1호기 5일 FAIL 재교정 확인 후 승인" className="w-full px-2 py-1.5 rounded-lg border border-line bg-bg text-sm" />
              </div>
              <button onClick={submitReview} className="py-1.5 px-4 rounded-lg bg-teal text-white text-sm font-semibold">{summary.review ? '리뷰 갱신' : '리뷰 사인오프'}</button>
            </div>
          </>
        )}
        {reviews.length > 0 && (
          <div className="mt-3 pt-3 border-t border-line">
            <p className="text-xs text-ink-2 mb-1">리뷰 이력</p>
            <ul className="text-xs space-y-1">
              {reviews.map((r) => (
                <li key={r.reviewId} className="flex items-center gap-2">
                  <span className={`px-1.5 py-0.5 rounded font-bold ${r.verdict === '승인' ? 'bg-good/15 text-good' : 'bg-warn/15 text-warn'}`}>{r.verdict}</span>
                  <span className="mono text-ink-3">{r.period}</span>
                  <span>{r.scope}{r.instrument ? `·${r.instrument}` : ''}</span>
                  <span className="text-ink-2">— {r.reviewedBy} {r.reviewedDt.slice(0, 10)}</span>
                  {r.note && <span className="text-ink-3">· {r.note}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* 로트 크로스오버 — 신로트 목표(mean/SD) 확립: 평행검사값 입력 또는 직접 지정(P2: API만 있고 화면 없던 기능) */}
      <section className="card mt-4">
        <h2 className="t-section mb-1">로트 크로스오버 <span className="text-xs text-ink-3 font-normal">신로트 평행검사값(≥2)으로 목표 mean/SD 확립 — 위 QC물질·장비·검사 기준</span></h2>
        <div className="flex flex-wrap items-end gap-2 mt-3">
          <div>
            <label className="block text-xs text-ink-2 mb-1">신로트 번호</label>
            <input aria-label="신로트 번호" value={xo.lot} onChange={(e) => setXo({ ...xo, lot: e.target.value })} placeholder="LOT-2026-08" className="px-2 py-1.5 rounded-lg border border-line bg-bg text-sm mono w-36" />
          </div>
          <div className="flex-1 min-w-56">
            <label className="block text-xs text-ink-2 mb-1">평행검사값(쉼표 구분, ≥2)</label>
            <input aria-label="평행검사값" value={xo.values} onChange={(e) => setXo({ ...xo, values: e.target.value })} placeholder="101, 99.5, 100.2, 100.8" className="w-full px-2 py-1.5 rounded-lg border border-line bg-bg text-sm mono" />
          </div>
          <span className="text-xs text-ink-3 pb-2">또는</span>
          <div>
            <label className="block text-xs text-ink-2 mb-1">mean</label>
            <input aria-label="mean 직접지정" value={xo.mean} onChange={(e) => setXo({ ...xo, mean: e.target.value })} className="px-2 py-1.5 rounded-lg border border-line bg-bg text-sm mono w-20" />
          </div>
          <div>
            <label className="block text-xs text-ink-2 mb-1">SD</label>
            <input aria-label="SD 직접지정" value={xo.sd} onChange={(e) => setXo({ ...xo, sd: e.target.value })} className="px-2 py-1.5 rounded-lg border border-line bg-bg text-sm mono w-20" />
          </div>
          <button onClick={async () => {
            setXoErr(''); setXoRes(null);
            if (!testCode.trim()) { setXoErr('상단 검사코드를 먼저 입력하세요(어느 검사의 목표인지)'); return; }
            if (!xo.lot.trim()) { setXoErr('신로트 번호가 필요합니다'); return; }
            const values = xo.values.split(',').map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));
            const body: Record<string, unknown> = { qcCode, instrument, testCode: testCode.trim(), lot: xo.lot.trim() };
            if (values.length >= 2) body.values = values;
            else { if (xo.mean.trim()) body.mean = Number(xo.mean); if (xo.sd.trim()) body.sd = Number(xo.sd); }
            try { setXoRes(await apiFetch(`/api/v1/qc/lot-crossover`, { method: 'POST', body: JSON.stringify(body) })); }
            catch (e) { setXoErr(e instanceof Error ? e.message : '크로스오버 실패'); }
          }} className="py-1.5 px-4 rounded-lg bg-teal text-white text-sm font-semibold">목표 확립</button>
        </div>
        {xoErr && <p className="text-sm text-crit mt-2" role="alert">{xoErr}</p>}
        {xoRes && (
          <p className="text-sm mt-2">
            <span className="mono">{xoRes.target.testCode}</span> · 로트 <span className="mono">{xo.lot}</span> 목표 확립 — mean <b className="mono">{xoRes.target.mean.toFixed(2)}</b> · SD <b className="mono">{xoRes.target.sd.toFixed(3)}</b>
            {xoRes.computed && <span className="text-ink-2"> (평행검사 n={xoRes.computed.n}에서 산출)</span>}
          </p>
        )}
      </section>
    </main>
  );
}
