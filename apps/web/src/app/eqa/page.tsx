'use client';

/**
 * 외부정도관리 (EQA) 화면 (`/eqa`).
 *
 * 사이드바 노출 역할: TEC, PHY, MIC, ADM.
 * ⚠ 노출 역할과 화면이 호출하는 API 권한이 어긋나면 전부 403인 죽은 화면이 된다 —
 *   역할을 바꿀 때는 `Sidebar.tsx`(정본)와 API 권한 매트릭스를 함께 본다.
 * 데이터는 `lib/api.ts`의 `apiFetch`로만 가져온다(HTTP 호출 정본).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, getToken } from '@/lib/api';
import { EmptyState, ErrorText, Loading } from '@/components/ui';
import { useToast } from '@/components/toast';
import AttachmentPanel from '@/components/AttachmentPanel';
import { IconWarn } from '@/components/Icon';

interface Survey { surveyId: string; program: string; cycle: string; testCode: string; sampleId: string; submittedValue: number; peerMean: number | null; peerSd: number | null; sdi: number | null; verdict: string | null; submittedDt: string | null; submittedBy: string | null; }
interface TrendPoint { cycle: string; sdi: number; verdict: string | null; sampleId: string; }
interface Trend { testCode: string; program: string; n: number; meanSdi: number; biasFlag: string | null; unacceptable: number; warning: number; points: TrendPoint[]; }

const verdictCls: Record<string, string> = { ACCEPT: 'text-good', WARNING: 'text-warn', UNACCEPTABLE: 'text-crit', PENDING: 'text-ink-2' };

/** SDI 추세 차트(SVG) — ±2(수용)·±3(부적합) 밴드, 주기별 점. */
function SdiChart({ points }: { points: TrendPoint[] }) {
  const W = 480, H = 130, padL = 24, padR = 8, padT = 8, padB = 18;
  const sdiToY = (s: number) => padT + ((4 - Math.max(-4, Math.min(4, s))) / 8) * (H - padT - padB);
  const xAt = (i: number) => padL + (points.length <= 1 ? 0 : (i / (points.length - 1)) * (W - padL - padR));
  const dot = (s: number) => (Math.abs(s) > 3 ? '#dc2626' : Math.abs(s) > 2 ? '#d97706' : '#0d9488');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 150 }}>
      {[-3, -2, 0, 2, 3].map((s) => (
        <g key={s}>
          <line x1={padL} y1={sdiToY(s)} x2={W - padR} y2={sdiToY(s)} stroke={s === 0 ? '#64748b' : Math.abs(s) === 3 ? '#dc262655' : '#d9770655'} strokeWidth={s === 0 ? 1 : 0.5} strokeDasharray={s === 0 ? '' : '3 3'} />
          <text x={2} y={sdiToY(s) + 3} fontSize={8} fill="#94a3b8">{s > 0 ? `+${s}` : s}</text>
        </g>
      ))}
      {points.length > 1 && <polyline fill="none" stroke="#0d948855" strokeWidth={1.5} points={points.map((p, i) => `${xAt(i)},${sdiToY(p.sdi)}`).join(' ')} />}
      {points.map((p, i) => (
        <g key={i}>
          <circle cx={xAt(i)} cy={sdiToY(p.sdi)} r={3.5} fill={dot(p.sdi)} />
          <text x={xAt(i)} y={H - 6} fontSize={7} fill="#94a3b8" textAnchor="middle">{p.cycle}</text>
        </g>
      ))}
    </svg>
  );
}

export default function EqaPage() {
  const router = useRouter();
  const toast = useToast();
  const [rows, setRows] = useState<Survey[]>([]);
  const [loading, setLoading] = useState(true);
  const [ns, setNs] = useState({ program: 'KEQAS', cycle: '2026-1', testCode: '', sampleId: '', submittedValue: '' });
  const [peer, setPeer] = useState<Record<string, { peerMean: string; peerSd: string }>>({});
  const [fProgram, setFProgram] = useState('');
  const [fCycle, setFCycle] = useState('');
  const [err, setErr] = useState('');
  const [trend, setTrend] = useState<Trend[]>([]);
  const [trendOpen, setTrendOpen] = useState(false);
  const [selEqa, setSelEqa] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try { setRows(await apiFetch<Survey[]>('/api/v1/eqa')); }
    catch (e) { setErr(e instanceof Error ? e.message : '조회 실패(권한 필요)'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { if (!getToken()) router.push('/'); else load(); }, [router, load]);

  async function toggleTrend() {
    if (trendOpen) { setTrendOpen(false); return; }
    setTrendOpen(true);
    try { setTrend(await apiFetch<Trend[]>('/api/v1/eqa/trend')); }
    catch (e) { toast(e instanceof Error ? e.message : '추세 조회 실패', 'error'); }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try { await apiFetch('/api/v1/eqa', { method: 'POST', body: JSON.stringify({ ...ns, submittedValue: Number(ns.submittedValue) }) }); toast('EQA 제출'); setNs({ ...ns, testCode: '', sampleId: '', submittedValue: '' }); load(); }
    catch (e) { toast(e instanceof Error ? e.message : '실패', 'error'); }
  }
  async function evaluate(id: string) {
    const p = peer[id];
    if (!p?.peerMean || !p?.peerSd) { toast('또래군 평균·SD 입력', 'error'); return; }
    try { await apiFetch(`/api/v1/eqa/${id}/evaluate`, { method: 'POST', body: JSON.stringify({ peerMean: Number(p.peerMean), peerSd: Number(p.peerSd) }) }); toast('SDI 평가'); load(); }
    catch (e) { toast(e instanceof Error ? e.message : '실패', 'error'); }
  }

  const inp = 'px-2 py-1.5 rounded-lg border border-line bg-bg text-sm';

  return (
    <main className="page">
      <div className="flex items-center justify-between mb-4">
        <h1 className="t-page">외부정도관리 (EQA)</h1>
        <button onClick={toggleTrend} className="text-sm text-teal underline">{trendOpen ? 'SDI 추세 닫기' : 'SDI 추세 보기'}</button>
      </div>
      <ErrorText message={err} />

      {/* SDI 다주기 추세 — 계통편향·반복 부적합 감지 */}
      {trendOpen && (
        <section className="card mb-4">
          <h2 className="t-section mb-3">SDI 추세 <span className="text-xs text-ink-3 font-normal">검사별 다주기 · ±2 수용/±3 부적합 · 계통편향 감지</span></h2>
          {trend.length === 0 ? <p className="text-sm text-ink-2 py-4 text-center">평가완료(SDI) EQA가 없습니다. 또래군 통계 입력 후 추세가 쌓입니다.</p> : (
            <div className="grid md:grid-cols-2 gap-4">
              {trend.map((t) => (
                <div key={t.testCode} className="border border-line rounded-xl p-3">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <b className="mono text-sm">{t.testCode}</b>
                    <span className="text-xs text-ink-3">{t.program} · n{t.n}</span>
                    <span className={`text-xs font-bold ${Math.abs(t.meanSdi) >= 1 ? 'text-warn' : 'text-good'}`}>평균 SDI {t.meanSdi > 0 ? '+' : ''}{t.meanSdi}</span>
                    {t.biasFlag && <span className="text-xs px-1.5 py-0.5 rounded bg-warn/15 text-warn font-bold"><IconWarn className="mr-1" />{t.biasFlag}</span>}
                    {t.unacceptable > 0 && <span className="text-xs px-1.5 py-0.5 rounded bg-warn/20 text-warn font-bold">부적합 {t.unacceptable}</span>}
                    {t.warning > 0 && <span className="text-xs px-1.5 py-0.5 rounded bg-warn/10 text-warn font-bold" title="±2~3 SDI 경고(반복 시 드리프트 조기신호)">경고 {t.warning}</span>}
                  </div>
                  <SdiChart points={t.points} />
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <section className="card mb-4">
        <h2 className="t-section text-sm mb-2">EQA 결과 제출</h2>
        <form onSubmit={submit} className="flex flex-wrap gap-2 items-center">
          <input required aria-label="프로그램" placeholder="프로그램" value={ns.program} onChange={(e) => setNs({ ...ns, program: e.target.value })} className={`${inp} w-24`} />
          <input required aria-label="주기" placeholder="주기" value={ns.cycle} onChange={(e) => setNs({ ...ns, cycle: e.target.value })} className={`${inp} mono w-20`} />
          <input required aria-label="검사코드" placeholder="검사코드" value={ns.testCode} onChange={(e) => setNs({ ...ns, testCode: e.target.value })} className={`${inp} mono w-28`} />
          <input required aria-label="시료 ID" placeholder="시료ID" value={ns.sampleId} onChange={(e) => setNs({ ...ns, sampleId: e.target.value })} className={`${inp} mono w-20`} />
          <input required aria-label="측정값" placeholder="측정값" value={ns.submittedValue} onChange={(e) => setNs({ ...ns, submittedValue: e.target.value })} className={`${inp} mono w-24`} />
          <button className="py-1.5 px-3 rounded-lg bg-teal text-white font-semibold text-xs">제출</button>
        </form>
      </section>

      <section className="card">
        <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
          <h2 className="t-section">EQA 목록 <span className="text-xs text-ink-2">({rows.filter((r) => (!fProgram || r.program === fProgram) && (!fCycle || r.cycle === fCycle)).length})</span></h2>
          <div className="flex gap-2">
            <select aria-label="프로그램 필터" value={fProgram} onChange={(e) => setFProgram(e.target.value)} className={inp}>
              <option value="">모든 프로그램</option>{[...new Set(rows.map((r) => r.program))].map((p) => <option key={p}>{p}</option>)}
            </select>
            <select aria-label="주기 필터" value={fCycle} onChange={(e) => setFCycle(e.target.value)} className={inp}>
              <option value="">모든 주기</option>{[...new Set(rows.map((r) => r.cycle))].map((c) => <option key={c}>{c}</option>)}
            </select>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-ink-2 border-b border-line"><th className="py-2">프로그램/주기</th><th>검사·시료</th><th>측정값</th><th>또래(평균/SD)</th><th>SDI</th><th>판정</th><th></th></tr></thead>
            <tbody>
              {rows.filter((r) => (!fProgram || r.program === fProgram) && (!fCycle || r.cycle === fCycle)).map((r) => (
                <tr key={r.surveyId} className="border-b border-line last:border-0">
                  <td className="py-2 text-xs">{r.program} · <span className="mono">{r.cycle}</span>{r.submittedDt && <span className="block text-[11px] text-ink-3 mono">제출 {r.submittedDt.slice(0, 10)}{r.submittedBy ? ` · ${r.submittedBy}` : ''}</span>}</td>
                  <td className="mono text-xs">{r.testCode}/{r.sampleId}</td>
                  <td className="mono">{r.submittedValue}</td>
                  <td className="mono text-xs">{r.peerMean != null ? `${r.peerMean} / ${r.peerSd}` : '—'}</td>
                  <td className="mono font-bold">{r.sdi ?? '—'}</td>
                  <td className={`font-bold ${verdictCls[r.verdict ?? ''] ?? ''}`}>{r.verdict}</td>
                  <td>
                    <span className="flex gap-1 items-center">
                      {r.verdict === 'PENDING' && (
                        <>
                          <input aria-label="또래 평균" placeholder="평균" value={peer[r.surveyId]?.peerMean ?? ''} onChange={(e) => setPeer({ ...peer, [r.surveyId]: { ...peer[r.surveyId], peerMean: e.target.value } })} className={`${inp} mono w-16`} />
                          <input aria-label="또래 SD" placeholder="SD" value={peer[r.surveyId]?.peerSd ?? ''} onChange={(e) => setPeer({ ...peer, [r.surveyId]: { ...peer[r.surveyId], peerSd: e.target.value } })} className={`${inp} mono w-14`} />
                          <button onClick={() => evaluate(r.surveyId)} className="py-1 px-2 rounded-lg bg-indigo text-white text-xs">평가</button>
                        </>
                      )}
                      <button onClick={() => setSelEqa(selEqa === r.surveyId ? '' : r.surveyId)} className={`py-1 px-2 rounded-lg text-xs border ${selEqa === r.surveyId ? 'bg-teal/10 border-teal/40 text-teal' : 'border-line text-ink-2'}`}>성적서</button>
                    </span>
                  </td>
                </tr>
              ))}
              {loading && rows.length === 0 && <tr><td colSpan={7}><Loading /></td></tr>}
              {!loading && rows.length === 0 && <tr><td colSpan={7}><EmptyState title="EQA 결과 없음" hint="상단에서 외부정도관리 결과를 제출하세요." /></td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {/* 외부 정도관리 성적서(PDF) 첨부 — 선택 서베이 단위 */}
      {selEqa && <AttachmentPanel eqaId={selEqa} />}
    </main>
  );
}
