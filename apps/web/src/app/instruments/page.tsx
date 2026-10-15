'use client';

/**
 * 장비 인터페이스 · 통신 모니터 화면 (`/instruments`).
 *
 * 사이드바 노출 역할: TEC, ADM.
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
import { StatusChip } from '@/components/Explain';
import { IconChevron } from '@/components/Icon';

interface Log { logId: string; messageType: string | null; messageControlId: string | null; status: string; errorText: string | null; createdDt: string; }
interface Mapping { instrument: string; rawCode: string; testCode: string; status: string; }

const statusCls: Record<string, string> = { PROCESSED: 'text-good', PARTIAL: 'text-warn', FAILED: 'text-crit' };

export default function InstrumentsPage() {
  const router = useRouter();
  const toast = useToast();
  const [logs, setLogs] = useState<Log[]>([]);
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState('CHEM1');
  const [format, setFormat] = useState<'ASTM' | 'CSV'>('ASTM');
  const [payload, setPayload] = useState('O|1||S-0088\rR|1|^^^GLU^|105|mg/dL\rL|1');
  const [fStatus, setFStatus] = useState('');
  const [expand, setExpand] = useState<string | null>(null);
  const [expandMap, setExpandMap] = useState<string | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [lg, mp] = await Promise.all([
        apiFetch<Log[]>('/api/v1/instruments/logs'),
        apiFetch<Mapping[]>('/api/v1/instruments/mappings').catch(() => [] as Mapping[]),
      ]);
      setLogs(lg); setMappings(mp);
    }
    catch (e) { setErr(e instanceof Error ? e.message : '조회 실패(권한 필요)'); }
    finally { setLoading(false); }
  }, []);

  // 장비 로스터 — 매핑 등록된 장비 목록. 수집은 USE 매핑만 쓰므로 사용/중지를 분리 집계(STOP 포함 총계는 오도).
  const roster = Array.from(mappings.reduce((m, x) => {
    const r = m.get(x.instrument) ?? { use: 0, stop: 0, rows: [] as Mapping[] };
    if (x.status === 'STOP') r.stop += 1; else r.use += 1;
    r.rows.push(x);
    return m.set(x.instrument, r);
  }, new Map<string, { use: number; stop: number; rows: Mapping[] }>()).entries())
    .map(([instrument, v]) => ({ instrument, ...v }))
    .sort((a, b) => a.instrument.localeCompare(b.instrument));
  const lastLog = logs[0];

  useEffect(() => { if (!getToken()) router.push('/'); else load(); }, [router, load]);

  async function ingest() {
    try {
      const r = await apiFetch<{ received: number; ingested: unknown[]; skipped: unknown[] }>(`/api/v1/instruments/${code}/results`, { method: 'POST', body: JSON.stringify({ format, payload: payload.replace(/\\r/g, '\r') }) });
      toast(`수집 ${r.received}건 → 등록 ${r.ingested.length} · 건너뜀 ${r.skipped.length}`);
      load();
    } catch (e) { toast(e instanceof Error ? e.message : '수집 실패', 'error'); }
  }

  const inp = 'px-2 py-1.5 rounded-lg border border-line bg-bg text-sm';

  return (
    <main className="page">
      <h1 className="t-page mb-4">장비 인터페이스 · 통신 모니터</h1>
      <ErrorText message={err} />

      {/* 장비 로스터 — 구성된(매핑 등록) 장비 현황 */}
      <section className="card mb-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="t-section text-sm">장비 로스터 <span className="text-xs text-ink-2">({roster.length})</span></h2>
          {lastLog && <span className="text-xs text-ink-3">인터페이스 최근 수신 <span className="mono">{lastLog.createdDt?.slice(0, 16).replace('T', ' ')}</span> · <span className={statusCls[lastLog.status] ?? ''}>{lastLog.status}</span></span>}
        </div>
        {roster.length === 0 ? (
          <p className="text-xs text-ink-3">등록된 장비 매핑이 없습니다. 마스터에서 장비 코드매핑을 등록하세요.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {roster.map((r) => (
              <div key={r.instrument} className="rounded-xl border border-line px-3 py-2 bg-bg">
                <button onClick={() => setExpandMap(expandMap === r.instrument ? null : r.instrument)} aria-expanded={expandMap === r.instrument} className="text-left">
                  <div className="font-bold text-sm mono">{r.instrument} <span className="text-ink-3 text-xs"><IconChevron open={expandMap === r.instrument} /></span></div>
                  <div className="text-xs text-ink-2">사용 {r.use}{r.stop > 0 && <span className="text-ink-3"> · 중지 {r.stop}</span>}</div>
                </button>
                {expandMap === r.instrument && (
                  <table className="w-full text-[11px] mt-2 border-t border-line pt-1">
                    <thead><tr className="text-left text-ink-3"><th className="py-0.5 pr-2">원시코드</th><th className="pr-2">검사코드</th><th>상태</th></tr></thead>
                    <tbody>
                      {r.rows.map((m) => (
                        <tr key={m.rawCode} className={m.status === 'STOP' ? 'text-ink-3 line-through' : ''}>
                          <td className="py-0.5 pr-2 mono">{m.rawCode}</td><td className="pr-2 mono">{m.testCode}</td><td>{m.status === 'STOP' ? '중지' : '사용'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ))}
          </div>
        )}
        <p className="text-[11px] text-ink-3 mt-2">※ 통신 로그는 인터페이스 단위 기록이라 장비별 최근 수신 시각은 별도 표기하지 않습니다.</p>
      </section>

      <section className="card mb-4">
        <h2 className="t-section text-sm mb-2">수동 수집 테스트(모의 장비)</h2>
        <div className="flex gap-2 items-center mb-2">
          <input aria-label="장비코드" value={code} onChange={(e) => setCode(e.target.value)} className={`${inp} mono w-24`} placeholder="장비코드" />
          <select aria-label="페이로드 형식" value={format} onChange={(e) => setFormat(e.target.value as 'ASTM' | 'CSV')} className={inp}><option>ASTM</option><option>CSV</option></select>
          <button onClick={ingest} className="py-1.5 px-4 rounded-lg bg-teal text-white font-semibold text-sm">수집 실행</button>
        </div>
        <textarea aria-label="원시 페이로드" value={payload} onChange={(e) => setPayload(e.target.value)} rows={3} className="w-full mono text-xs px-2 py-1.5 rounded-lg border border-line bg-bg" placeholder="원시 페이로드(줄바꿈=\r 또는 실제 줄바꿈)" />
      </section>

      <section className="card">
        <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
          <h2 className="t-section">통신 로그 <span className="text-xs text-ink-2">({logs.filter((l) => !fStatus || l.status === fStatus).length})</span></h2>
          <div className="flex gap-2 items-center">
            <select aria-label="상태 필터" value={fStatus} onChange={(e) => setFStatus(e.target.value)} className={inp}>
              <option value="">모든 상태</option><option>PROCESSED</option><option>PARTIAL</option><option>FAILED</option>
            </select>
            <button onClick={load} className="text-xs text-teal underline">새로고침</button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-ink-2 border-b border-line"><th className="py-2">시각</th><th>유형</th><th>장비·제어ID</th><th>상태</th><th>오류</th></tr></thead>
            <tbody>
              {logs.filter((l) => !fStatus || l.status === fStatus).map((l) => (
                <tr key={l.logId} className="border-b border-line last:border-0 cursor-pointer" onClick={() => setExpand(expand === l.logId ? null : l.logId)}>
                  <td className="py-1.5 mono text-xs text-ink-3">{l.createdDt?.slice(0, 19).replace('T', ' ')}</td>
                  <td className="mono text-xs">{l.messageType}</td>
                  <td className="mono text-xs text-ink-3">{l.messageControlId ?? '—'}</td>
                  <td><StatusChip code={l.status} tone={l.status === 'PROCESSED' ? 'good' : l.status === 'FAILED' ? 'warn' : 'neutral'} /></td>
                  <td className={`text-xs text-ink-2 ${expand === l.logId ? 'whitespace-pre-wrap break-all' : 'max-w-xs truncate'}`}>{l.errorText ?? ''}</td>
                </tr>
              ))}
              {loading && logs.length === 0 && <tr><td colSpan={5}><Loading /></td></tr>}
              {!loading && logs.length === 0 && <tr><td colSpan={5}><EmptyState title="통신 로그 없음" hint="장비 수집이 실행되면 로그가 기록됩니다." /></td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
