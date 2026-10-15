'use client';

/**
 * 데이터 수명주기 · 보존 화면 (`/admin/lifecycle`).
 *
 * 사이드바 노출 역할: ADM.
 * ⚠ 노출 역할과 화면이 호출하는 API 권한이 어긋나면 전부 403인 죽은 화면이 된다 —
 *   역할을 바꿀 때는 `Sidebar.tsx`(정본)와 API 권한 매트릭스를 함께 본다.
 * 데이터는 `lib/api.ts`의 `apiFetch`로만 가져온다(HTTP 호출 정본).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, getToken } from '@/lib/api';
import { useToast } from '@/components/toast';
import { useConfirm } from '@/components/confirm';
import { ErrorText } from '@/components/ui';

interface Policy { key: string; label: string; days: number; purgeable: boolean; total: number; expired: number; }
interface PurgeRow { key: string; label: string; eligible: number; deleted: number; }

export default function LifecyclePage() {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [purge, setPurge] = useState<PurgeRow[]>([]);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try { setPolicies((await apiFetch<{ policies: Policy[] }>('/api/v1/admin/lifecycle/status')).policies); }
    catch (e) { setErr(e instanceof Error ? e.message : '조회 실패(관리자 권한 필요)'); }
  }, []);

  useEffect(() => { if (!getToken()) router.push('/'); else load(); }, [router, load]);

  async function runPurge(real: boolean) {
    if (real && !(await confirm({ title: '보존기간 경과 데이터 정리', message: '경과 운영로그가 영구 삭제됩니다(임상 결과 제외).', danger: true, confirmLabel: '삭제 실행' }))) return;
    try {
      const r = await apiFetch<{ results: PurgeRow[] }>(`/api/v1/admin/lifecycle/purge?dryRun=${!real}`, { method: 'POST', body: '{}' });
      setPurge(r.results); toast(real ? '정리 완료' : '모의 실행(dryRun)'); if (real) load();
    } catch (e) { toast(e instanceof Error ? e.message : '실패', 'error'); }
  }

  return (
    <main className="page">
      <h1 className="t-page mb-4">데이터 수명주기 · 보존</h1>
      {err && <ErrorText message={err} />}

      <section className="card mb-4">
        <h2 className="t-section mb-3">보존정책 현황</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-ink-2 border-b border-line"><th className="py-2">데이터</th><th>보존일</th><th>전체</th><th>경과(정리대상)</th><th>자동정리</th></tr></thead>
            <tbody>
              {policies.map((p) => (
                <tr key={p.key} className="border-b border-line last:border-0">
                  <td className="py-2">{p.label} <span className="mono text-xs text-ink-3">{p.key}</span></td>
                  <td className="mono">{p.days}d</td>
                  <td className="mono">{p.total}</td>
                  <td className={`mono ${p.expired ? 'text-warn font-bold' : ''}`}>{p.expired}</td>
                  <td>{p.purgeable ? <span className="text-good text-xs">정리 대상</span> : <span className="text-ink-2 text-xs">법정보존</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex gap-2 mt-4">
          <button onClick={() => runPurge(false)} className="py-1.5 px-4 rounded-lg border border-line text-sm font-semibold">모의 정리(dryRun)</button>
          <button onClick={() => runPurge(true)} className="py-1.5 px-4 rounded-lg border border-crit text-crit text-sm font-semibold transition-colors duration-150 hover:bg-crit/10">실제 정리</button>
        </div>
        {purge.length > 0 && (
          <div className="mt-3 text-sm text-ink-2">
            정리 대상: {purge.map((r) => `${r.label} ${r.eligible}건${r.deleted ? `(삭제 ${r.deleted})` : ''}`).join(' · ')}
          </div>
        )}
      </section>
      <p className="text-xs text-ink-3">임상 결과는 법정 보존기간으로 자동 삭제 대상에서 제외됩니다. 정기 정리는 매일 04:00(LIFECYCLE_PURGE=on).</p>
    </main>
  );
}
