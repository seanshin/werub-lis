'use client';

/**
 * 개시 전환 센터 — ③ 전환 실행 패널.
 *
 * 비가역 작업(파일럿 데이터 정리)을 화면에서 실행한다. **게이트를 화면이 판정하지 않는다** —
 * 서버가 4중 게이트(실데이터 차단·확인문구·2인 승인·감사)를 강제하고, 여기서는 그 게이트가
 * 무엇을 요구하는지 **먼저 보여줘서** 실수로 눌러 진행되는 일이 없게 한다.
 *
 * 데이터는 `lib/api.ts`의 `apiFetch`로만 가져온다(HTTP 호출 정본).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { Section, ErrorText } from '@/components/ui';
import { useToast } from '@/components/toast';

interface RealData { clean: boolean; realPatients: number; realOrders: number; signals: { entity: string; unregistered: number }[] }
interface Preview {
  batch: string; total: number; targets: { entity: string; count: number }[];
  realData: RealData; blocked: boolean; confirmPhrase: string; note: string;
}
interface BackfillPreview {
  unregistered: number; rows: { entity: string; total: number; unregistered: number }[];
  confirmPhraseHint: string; warning: string;
}
interface Run {
  runId: string; step: string; result: string; requestedBy: string | null; approvedBy: string | null;
  message: string | null; startedDt: string;
}
interface PendingReq { runId: string; step: string; requestedBy: string | null; message: string | null; startedDt: string }

const BATCHES = [
  { key: 'product-demo', label: '제품 데모 데이터', hint: '평가·교육용 합성 데이터' },
  { key: 'site-pilot', label: '현장 파일럿 데이터', hint: '이 사이트에서 만든 파일럿·리허설 산출물' },
  { key: 'e2e', label: 'E2E 테스트 잔재', hint: '운영 DB에 있으면 안 되는 것' },
];

export default function CutoverPanel() {
  const toast = useToast();
  const [real, setReal] = useState<RealData | null>(null);
  const [batch, setBatch] = useState('product-demo');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [backfill, setBackfill] = useState<BackfillPreview | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [pending, setPending] = useState<PendingReq[]>([]);
  const [me, setMe] = useState('');
  const [phrase, setPhrase] = useState('');
  const [bfPhrase, setBfPhrase] = useState('');
  const [bfApprover, setBfApprover] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setErr('');
    try {
      const [r, b, rs, pq, who] = await Promise.all([
        apiFetch<RealData>('/api/v1/admin/seed-cleanup/real-data'),
        apiFetch<BackfillPreview>('/api/v1/admin/seed-cleanup/backfill/preview'),
        apiFetch<Run[]>('/api/v1/admin/seed-cleanup/runs?limit=20'),
        apiFetch<PendingReq[]>('/api/v1/admin/seed-cleanup/requests'),
        apiFetch<{ userId: string }>('/api/v1/auth/me').catch(() => ({ userId: '' })),
      ]);
      setReal(r); setBackfill(b); setRuns(rs); setPending(pq); setMe(who.userId);
    } catch (e) { setErr(e instanceof Error ? e.message : '조회 실패'); }
  }, []);

  const loadPreview = useCallback(async (b: string) => {
    setPreview(null); setPhrase('');
    try { setPreview(await apiFetch<Preview>(`/api/v1/admin/seed-cleanup/preview?batch=${encodeURIComponent(b)}`)); }
    catch (e) { toast(e instanceof Error ? e.message : '미리보기 실패', 'error'); }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadPreview(batch); }, [batch, loadPreview]);

  async function runBackfill() {
    if (!backfill) return;
    setBusy(true);
    try {
      const r = await apiFetch<{ registered: number }>('/api/v1/admin/seed-cleanup/backfill', {
        method: 'POST', body: JSON.stringify({ confirmPhrase: bfPhrase, approverId: bfApprover.trim() }),
      });
      toast(`백필 완료 — ${r.registered}건 등록(삭제 없음)`, 'success');
      setBfPhrase(''); setBfApprover('');
      await load(); await loadPreview(batch);
    } catch (e) { toast(e instanceof Error ? e.message : '백필 실패', 'error'); }
    finally { setBusy(false); }
  }

  /** ① 요청 — 실행하지 않는다. 다른 관리자가 자기 계정으로 승인해야 실행된다. */
  async function requestCleanup() {
    if (!preview) return;
    setBusy(true);
    try {
      const r = await apiFetch<{ runId: string; total: number }>('/api/v1/admin/seed-cleanup/request', {
        method: 'POST', body: JSON.stringify({ batch: preview.batch, confirmPhrase: phrase }),
      });
      toast(`정리 요청 등록 — 대상 ${r.total}건. 다른 관리자의 승인이 필요합니다`, 'success');
      setPhrase('');
      await load();
    } catch (e) { toast(e instanceof Error ? e.message : '요청 실패', 'error'); }
    finally { setBusy(false); }
  }

  /** ② 승인·실행 — 승인자 본인 토큰으로 호출된다(ID를 대신 타이핑하지 않는다). */
  async function approveRun(runId: string) {
    if (!window.confirm('이 요청을 승인하면 즉시 삭제가 실행됩니다. 되돌릴 수 없습니다. 계속할까요?')) return;
    setBusy(true);
    try {
      const r = await apiFetch<{ deleted: number }>(`/api/v1/admin/seed-cleanup/approve/${encodeURIComponent(runId)}`, { method: 'POST' });
      toast(`정리 완료 — ${r.deleted}건 삭제`, 'success');
      await load(); await loadPreview(batch);
    } catch (e) { toast(e instanceof Error ? e.message : '승인 실패', 'error'); }
    finally { setBusy(false); }
  }

  const canRequest = !!preview && !preview.blocked && preview.total > 0 && phrase === preview.confirmPhrase;

  return (
    <div className="flex flex-col gap-4">
      {err && <ErrorText message={err} />}

      {/* 실 데이터 감지 — 이 판정이 모든 것의 전제다 */}
      <Section title="실 환자 데이터 감지" hint="시드로 등록되지 않은 환자·오더가 있으면 정리를 실행할 수 없다(서버가 거부)">
        {real && (
          real.clean
            ? <p className="text-sm text-good font-semibold">깨끗함 — 미등록 환자·오더 0건. 정리 가능한 상태입니다.</p>
            : (
              <div>
                <p className="text-sm text-crit font-bold">
                  실 데이터 감지 — 환자 {real.realPatients}건 · 오더 {real.realOrders}건
                </p>
                <p className="text-xs text-ink-2 mt-1">
                  미등록 신호: {real.signals.map((g) => `${g.entity} ${g.unregistered}`).join(' · ')}
                </p>
                <p className="t-meta mt-1">
                  정리 API가 <b>409로 거부</b>합니다. 우회 수단은 없습니다. 실 진료가 시작된 뒤에는
                  어떤 이유로도 파일럿 정리를 실행하지 않습니다.
                  {backfill && backfill.unregistered > 0 &&
                    ' 추적 도입 이전 데이터라면 아래 백필로 등록한 뒤 진행하십시오.'}
                </p>
              </div>
            )
        )}
      </Section>

      {/* 백필 — 추적 이전 데이터가 있을 때만 */}
      {backfill && backfill.unregistered > 0 && (
        <Section title="추적 이전 데이터 백필" hint="시드 추적이 도입되기 전에 쌓인 데이터를 파일럿으로 등록(삭제 없음)">
          <p className="text-sm mb-2">미등록 <b>{backfill.unregistered}건</b></p>
          <div className="flex flex-wrap gap-1 mb-2">
            {backfill.rows.slice(0, 12).map((r) => (
              <span key={r.entity} className="text-xs px-1.5 py-0.5 rounded bg-bg text-ink-2 mono">
                {r.entity} {r.unregistered}
              </span>
            ))}
          </div>
          <p className="t-meta mb-2">{backfill.warning}</p>
          {/* 확인 문구를 화면이 채워 넣지 않는다 — 그러면 '사람의 단언'이 버튼 한 번이 된다.
              운영자가 설치 가이드에서 찾아 직접 입력하고, 승인자도 따로 받는다. */}
          <div className="border border-warn/30 rounded-lg p-3 bg-warn/[0.03] flex flex-col gap-2">
            <p className="text-xs text-warn">{backfill.confirmPhraseHint}</p>
            <label className="text-xs">
              <span className="block mb-1 text-ink-2">승인자 계정(요청자와 다른 관리자)</span>
              <input value={bfApprover} onChange={(e) => setBfApprover(e.target.value)} placeholder="예: U01"
                className="px-2 py-1.5 rounded-lg border border-line bg-bg text-sm mono w-48" />
            </label>
            <label className="text-xs">
              <span className="block mb-1 text-ink-2">확인 문구(설치 가이드 §3-1)</span>
              <input value={bfPhrase} onChange={(e) => setBfPhrase(e.target.value)}
                className="px-2 py-1.5 rounded-lg border border-line bg-bg text-sm w-full max-w-md" />
            </label>
            <div>
              <button disabled={busy || !bfPhrase.trim() || !bfApprover.trim()} onClick={runBackfill}
                className="text-xs px-3 py-1.5 rounded border border-warn/50 text-warn font-semibold disabled:opacity-40">
                백필 실행(등록만)
              </button>
            </div>
          </div>
        </Section>
      )}

      {/* 정리 실행 — 4중 게이트 */}
      <Section title="파일럿 데이터 정리" hint="🔴 비가역. 서버가 4중 게이트를 강제합니다 — 실데이터 차단 · 확인문구 · 2인 승인 · 감사 기록">
        <div className="flex flex-wrap gap-1.5 mb-3">
          {BATCHES.map((b) => (
            <button key={b.key} onClick={() => setBatch(b.key)}
              className={`text-xs px-2.5 py-1 rounded border ${batch === b.key ? 'border-teal bg-teal/10 text-teal font-semibold' : 'border-line text-ink-2'}`}>
              {b.label}
            </button>
          ))}
          <span className="text-xs text-ink-3 self-center ml-1">
            {BATCHES.find((b) => b.key === batch)?.hint}
          </span>
        </div>

        {preview && (
          <>
            <p className="text-sm mb-2">
              삭제 대상 <b className={preview.total > 0 ? 'text-crit' : 'text-ink-3'}>{preview.total}건</b>
              <span className="text-ink-3 ml-2">{preview.note}</span>
            </p>
            {preview.total > 0 && (
              <div className="flex flex-wrap gap-1 mb-3">
                {preview.targets.slice(0, 16).map((t) => (
                  <span key={t.entity} className="text-xs px-1.5 py-0.5 rounded bg-bg text-ink-2 mono">
                    {t.entity} {t.count}
                  </span>
                ))}
              </div>
            )}

            {preview.total > 0 && !preview.blocked && (
              <div className="border border-crit/30 rounded-lg p-3 bg-crit/[0.03] flex flex-col gap-2">
                <p className="text-xs text-crit font-bold">
                  이 작업은 되돌릴 수 없습니다. 복구 수단은 백업 복원뿐입니다.
                </p>
                <p className="text-xs text-ink-2">
                  요청을 등록하면 <b>다른 관리자가 자기 계정으로 로그인해 승인</b>해야 실행됩니다.
                  승인자 ID를 대신 입력하는 방식이 아닙니다(요청 30분 내 승인).
                </p>
                <label className="text-xs">
                  <span className="block mb-1 text-ink-2">
                    확인 문구를 그대로 입력하세요: <b className="mono text-ink">{preview.confirmPhrase}</b>
                  </span>
                  <input value={phrase} onChange={(e) => setPhrase(e.target.value)}
                    className="px-2 py-1.5 rounded-lg border border-line bg-bg text-sm w-full max-w-md" />
                </label>
                <div>
                  <button disabled={!canRequest || busy} onClick={requestCleanup}
                    className="text-xs px-3 py-1.5 rounded bg-crit text-white font-bold disabled:opacity-40 disabled:cursor-not-allowed">
                    {busy ? '처리 중…' : `${preview.total}건 삭제 요청(승인 필요)`}
                  </button>
                  {!canRequest && phrase !== preview.confirmPhrase && (
                    <span className="text-xs text-ink-3 ml-2">확인 문구가 일치해야 합니다</span>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </Section>

      {/* 승인 대기 — 승인자가 자기 계정으로 들어와 처리한다 */}
      {pending.length > 0 && (
        <Section title="승인 대기 중인 정리 요청" hint="요청자와 다른 관리자만 승인할 수 있다. 승인 즉시 삭제가 실행된다">
          <div className="flex flex-col gap-2">
            {pending.map((q) => {
              const mine = !!me && q.requestedBy === me;
              return (
                <div key={q.runId} className="border border-crit/30 rounded-lg p-2.5 bg-crit/[0.03]">
                  <div className="flex items-center gap-2 flex-wrap text-sm">
                    <span className="mono text-xs text-ink-3">{q.step}</span>
                    <span>{q.message}</span>
                    <span className="text-xs text-ink-3 ml-auto">
                      요청자 <b className="mono">{q.requestedBy ?? '-'}</b> · {new Date(q.startedDt).toLocaleString('ko-KR')}
                    </span>
                  </div>
                  <div className="mt-2">
                    {mine ? (
                      <span className="text-xs text-ink-3">내가 요청한 건이라 승인할 수 없습니다(직무분리) — 다른 관리자가 승인해야 합니다.</span>
                    ) : (
                      <button disabled={busy} onClick={() => approveRun(q.runId)}
                        className="text-xs px-3 py-1.5 rounded bg-crit text-white font-bold disabled:opacity-50">
                        승인하고 실행
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {/* 실행 이력 */}
      <Section title="전환 실행 이력" hint="비가역 작업의 실행 단위 기록 — 차단된 시도도 남는다">
        {runs.length === 0 ? (
          <p className="t-meta">실행 이력이 없습니다.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-ink-3 text-left border-b border-line">
                  <th className="py-1 pr-3">시각</th><th className="pr-3">단계</th><th className="pr-3">결과</th>
                  <th className="pr-3">실행/승인</th><th>내용</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.runId} className="border-b border-line last:border-0">
                    <td className="py-1 pr-3 text-ink-3 whitespace-nowrap">{new Date(r.startedDt).toLocaleString('ko-KR')}</td>
                    <td className="pr-3 mono">{r.step}</td>
                    <td className="pr-3">
                      <span className={`font-bold ${r.result === 'OK' ? 'text-good' : r.result === 'BLOCKED' ? 'text-warn' : 'text-crit'}`}>
                        {r.result}
                      </span>
                    </td>
                    <td className="pr-3 mono text-ink-2">{r.requestedBy ?? '-'}{r.approvedBy ? ` / ${r.approvedBy}` : ''}</td>
                    <td className="text-ink-2">{r.message ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}
