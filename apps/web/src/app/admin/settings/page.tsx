'use client';

/**
 * 운영 설정 화면 (`/admin/settings`).
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
import { ErrorText, Loading } from '@/components/ui';
import { IconWarn } from '@/components/Icon';

interface Setting {
  key: string;
  label: string;
  kind: 'url' | 'secret' | 'number' | 'bool';
  group: string;
  help: string;
  placeholder: string | null;
  min: number | null;
  max: number | null;
  configured: boolean;
  seed?: boolean;
  source: 'DB' | 'ENV' | 'NONE';
  display: string;
  updatedBy: string | null;
  updatedDt: string | null;
}

interface TestResult { channel: string; ok: boolean; httpStatus: number | null; elapsedMs: number; error: string | null; signed: boolean }

/**
 * 운영 설정 — 위험치 통보·운영 감시 채널.
 * 이전에는 환경변수 전용이라 값을 받아도 서버 파일 수정 + 재기동이 필요했다.
 */
export default function SettingsAdminPage() {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [items, setItems] = useState<Setting[] | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');
  const [test, setTest] = useState<Record<string, TestResult>>({});
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      const d = await apiFetch<Setting[]>('/api/v1/admin/settings');
      setItems(d);
      setDraft({});
    } catch (e) {
      setErr(e instanceof Error ? e.message : '조회 실패(관리자 권한 필요)');
      setItems([]);
    }
  }, []);

  useEffect(() => { if (!getToken()) router.push('/'); else load(); }, [router, load]);

  /**
   * 저장. `clear=true`(해제 버튼)일 때만 빈 값을 보낸다.
   * 입력칸이 비어 있는 채로 저장을 누른 것은 "해제 의도"가 아니라 대개 실수다 —
   * URL·서명 키는 마스킹돼 표시되므로 입력칸을 비워 두는 것이 정상 상태이기도 하다.
   */
  async function save(s: Setting, clear = false) {
    // 체크박스는 'off'가 정당한 값이라 빈 값 가드에서 제외한다
    const value = clear ? '' : s.kind === 'bool' ? (draft[s.key] ?? s.display ?? 'off') || 'off' : (draft[s.key] ?? '');
    if (!clear && s.kind !== 'bool' && value.trim() === '') {
      toast('값을 입력하세요 — 해제하려면 해제 버튼을 쓰세요', 'error');
      return;
    }
    // 자동 정리를 켜는 것은 되돌릴 수 없는 삭제를 예약하는 행위다.
    if (s.key === 'LIFECYCLE_PURGE' && value === 'on') {
      const ok = await confirm({
        title: '경과 데이터 자동 정리 실행',
        message: '매일 04:00에 보존기간이 지난 감사·연계·알림 로그가 영구 삭제됩니다(임상 결과는 대상 아님). 삭제된 기록은 복구할 수 없습니다. 보존일이 법무 확정값인지 먼저 확인하세요.',
        danger: true,
        confirmLabel: '실행 켜기',
      });
      if (!ok) return;
    }
    // 통보 채널을 끄는 것은 위험치가 어디에도 도달하지 않게 만드는 행위다.
    if (clear && (s.kind === 'url' || s.kind === 'secret')) {
      const ok = await confirm({
        title: `${s.label} 해제`,
        message: s.key === 'CRITICAL_WEBHOOK_URL'
          ? '위험치 통보가 외부로 나가지 않게 됩니다. 통보는 LIS 안에만 남고 담당의에게 도달하지 않으므로 유선 통보가 필요합니다.'
          : '이 설정을 해제합니다.',
        danger: true,
        confirmLabel: '해제',
      });
      if (!ok) return;
    }
    setBusy(s.key);
    try {
      await apiFetch(`/api/v1/admin/settings/${s.key}`, { method: 'PUT', body: JSON.stringify({ value }) });
      toast(`${s.label} 저장됨`);
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : '저장 실패', 'error');
    } finally { setBusy(''); }
  }

  async function runTest(channel: 'critical' | 'ops') {
    setBusy(`test-${channel}`);
    try {
      const r = await apiFetch<TestResult>(`/api/v1/admin/settings/test/${channel}`, { method: 'POST', body: '{}' });
      setTest((t) => ({ ...t, [channel]: r }));
      toast(r.ok ? '테스트 발송 도달' : '테스트 발송 실패', r.ok ? 'success' : 'error');
    } catch (e) {
      toast(e instanceof Error ? e.message : '실패', 'error');
    } finally { setBusy(''); }
  }

  if (items === null) return <Loading />;

  const groups = Array.from(new Set(items.map((i) => i.group)));
  const inp = 'px-2 py-1.5 rounded-lg border border-line bg-bg text-sm';
  const criticalSet = items.find((i) => i.key === 'CRITICAL_WEBHOOK_URL')?.configured;

  return (
    <main className="page">
      <h1 className="t-page mb-1">운영 설정</h1>
      <p className="t-meta text-ink-2 mb-4">저장 즉시 반영됩니다(재기동 불필요). 변경은 감사 기록에 남습니다.</p>
      {err && <ErrorText message={err} />}

      {!criticalSet && (
        <div className="card mb-4 border-l-4 border-l-crit">
          <p className="t-body font-semibold text-crit">위험치 통보 채널이 설정되지 않았습니다</p>
          <p className="t-meta text-ink-2 mt-1">
            지금은 위험치가 발생해도 LIS 안에만 기록되고 담당의에게 자동으로 도달하지 않습니다(유선 통보 필요).
            개시 전 반드시 설정하세요.
          </p>
        </div>
      )}

      {groups.map((g) => (
        <section key={g} className="card mb-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="t-section">{g}</h2>
            {g === '보존기간·정리' && (
              <a href="/admin/lifecycle" className="text-xs text-teal underline">현황·모의 실행 보기</a>
            )}
            {(g === '위험치 통보' || g === '운영 감시') && (
              <button
                onClick={() => runTest(g === '위험치 통보' ? 'critical' : 'ops')}
                disabled={busy !== ''}
                title="입력창의 미저장 값이 아니라 이미 저장된 채널로 발송합니다 — 새 URL은 먼저 저장 후 테스트하세요"
                className="py-1.5 px-3 rounded-lg border border-line text-xs font-semibold hover:bg-bg disabled:opacity-50"
              >
                저장된 값으로 테스트
              </button>
            )}
          </div>

          {(() => {
            const ch = g === '위험치 통보' ? 'critical' : 'ops';
            const r = test[ch];
            if (!r) return null;
            return (
              <p className={`t-meta mb-3 ${r.ok ? 'text-good' : 'text-crit'}`}>
                {r.ok
                  ? `도달 확인 — HTTP ${r.httpStatus} · ${r.elapsedMs}ms${r.signed ? ' · 서명 포함' : ' · 서명 없음(서명 키 미설정)'}`
                  : `실패 — ${r.error}`}
              </p>
            );
          })()}

          <div className="flex flex-col gap-4">
            {items.filter((i) => i.group === g).map((s) => (
              <div key={s.key} className="border-b border-line last:border-0 pb-3 last:pb-0">
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  <span className="t-body font-semibold">{s.label}</span>
                  <span className="mono t-micro text-ink-3">{s.key}</span>
                  {s.source === 'ENV' && (
                    <span className="t-micro px-1.5 py-0.5 rounded bg-bg text-ink-2" title="환경변수 값으로 동작 중 — 여기서 저장하면 이 값이 우선합니다">환경변수</span>
                  )}
                  {s.source === 'NONE' && <span className="t-micro text-ink-3">미설정</span>}
                </div>

                {s.kind === 'bool' ? (
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-1.5 text-sm">
                      <input
                        type="checkbox"
                        checked={(draft[s.key] ?? s.display) === 'on'}
                        onChange={(e) => setDraft({ ...draft, [s.key]: e.target.checked ? 'on' : 'off' })}
                      />
                      켜기
                    </label>
                    <button onClick={() => save(s)} disabled={busy === s.key} className="py-1 px-2.5 rounded-lg bg-indigo text-white font-semibold text-xs disabled:opacity-50">저장</button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      aria-label={s.label}
                      type={s.kind === 'secret' ? 'password' : 'text'}
                      inputMode={s.kind === 'number' ? 'numeric' : undefined}
                      min={s.kind === 'number' && s.min != null ? s.min : undefined}
                      max={s.kind === 'number' && s.max != null ? s.max : undefined}
                      /* URL·시크릿은 마스킹해 표시하므로 입력칸에 채우지 않는다 —
                         채워 두면 편집 없이 저장할 때 마스킹 문자열이 진짜 값을 덮어쓴다. */
                      value={draft[s.key] ?? (s.kind === 'number' ? s.display : '')}
                      onChange={(e) => setDraft({ ...draft, [s.key]: e.target.value })}
                      placeholder={s.configured && s.kind !== 'number' ? '바꾸려면 새 값을 전체 입력' : (s.placeholder ?? '')}
                      className={`${inp} flex-1 min-w-[18rem] ${s.kind !== 'number' ? 'mono' : 'w-24'}`}
                    />
                    {s.kind === 'number' && (s.min != null || s.max != null) && (
                      <span className="t-micro text-ink-3">허용 {s.min ?? '−∞'}~{s.max ?? '∞'}</span>
                    )}
                    <button onClick={() => save(s)} disabled={busy === s.key} className="py-1.5 px-3 rounded-lg bg-indigo text-white font-semibold text-xs disabled:opacity-50">저장</button>
                    {s.configured && (
                      <button onClick={() => save(s, true)} disabled={busy === s.key} className="py-1.5 px-3 rounded-lg border border-line text-xs disabled:opacity-50">해제</button>
                    )}
                  </div>
                )}

                {s.configured && s.kind !== 'bool' && (
                  <p className="t-micro text-ink-2 mt-1.5">현재 <span className="mono">{s.display}</span></p>
                )}
                {/* 파일럿 시드 sink는 실제로 전달되지 않음 — 개시 준비도/콘솔과 동일하게 이 화면에서도 경고(seed 플래그는 서버가 원값에서 계산) */}
                {s.seed && (
                  <p className="t-micro text-warn mt-1 font-semibold"><IconWarn className="mr-1" />파일럿 시드 sink — 실제 전달 안 됨. 개시 전 실 채널 URL로 교체하세요.</p>
                )}
                <p className="t-micro text-ink-3 mt-1.5 leading-relaxed">{s.help}</p>
                {s.updatedDt && (
                  <p className="t-micro text-ink-3 mt-0.5">최종 변경 {new Date(s.updatedDt).toLocaleString('ko-KR')}{s.updatedBy ? ` · ${s.updatedBy}` : ''}</p>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}

      <p className="t-micro text-ink-3">
        값은 마스킹해서 표시합니다(URL 쿼리·서명 키는 저장 후 다시 볼 수 없습니다).
        환경변수로 설정된 값은 그대로 동작하며, 여기서 저장하면 저장한 값이 우선합니다.
      </p>
    </main>
  );
}
