'use client';

/**
 * LIS 화면 (`/`).
 *
 * 사이드바 GROUPS에 없는 경로(로그인·도움말·상세 진입 등).
 * 데이터는 `lib/api.ts`의 `apiFetch`로만 가져온다(HTTP 호출 정본).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, setToken, getToken, getRoles } from '@/lib/api';
import { roleHome } from '@/lib/rolehome';
import { APP_VERSION } from '@/lib/version';
import { ErrorText } from '@/components/ui';

interface LoginResult {
  accessToken: string;
  user: { userId: string; name: string; roles: string[]; mustChangePassword?: boolean };
}

// 데모 계정·자동입력은 NEXT_PUBLIC_DEMO=1 빌드에서만 노출(프로덕션은 빈 폼).
const DEMO = process.env.NEXT_PUBLIC_DEMO === '1';
// 공개판: 데모 패널 자동 입력 비밀번호는 빌드 시 지정(SEED_PASSWORD 와 같은 값). 지정하지 않으면 빈 칸.
const DEMO_PW = process.env.NEXT_PUBLIC_DEMO_PASSWORD ?? '';
const DEMO_ACCOUNTS = [
  { id: 'U00', label: '관리자' },
  { id: 'U02', label: '검증의' },
  { id: 'U01', label: '검사자' },
  { id: 'U07', label: '접수' },
  { id: 'U04', label: '병리' },
  { id: 'U06', label: '유전체' },
];

export default function LoginPage() {
  const router = useRouter();
  const [userId, setUserId] = useState(DEMO ? 'U02' : '');
  const [password, setPassword] = useState(DEMO ? DEMO_PW : '');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('expired') === '1') {
      setExpired(true);
    }
    // 이미 로그인된 사용자가 '/'로 오면 로그인 폼 대신 역할별 첫 화면으로(역할 랜딩과 일관)
    if (getToken() && typeof window !== 'undefined' && !new URLSearchParams(window.location.search).get('expired')) {
      router.replace(roleHome(getRoles()));
    }
  }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch<LoginResult>('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ userId, password }),
      });
      setToken(res.accessToken);
      localStorage.setItem('lis_user', JSON.stringify(res.user));
      // 관리자가 발급·재설정한 비밀번호는 본인이 바꾸기 전까지 다른 기능이 막혀 있다(서버 403).
      // 바로 변경 화면으로 보내 막힌 이유를 알 수 없는 상태를 만들지 않는다.
      // 역할별 첫 화면(P2) — 전담 업무가 있는 역할은 대시보드가 아니라 자기 워크리스트로.
      router.push(res.user?.mustChangePassword ? '/settings/password?first=1' : roleHome(res.user?.roles ?? []));
    } catch (err) {
      setError(err instanceof Error ? err.message : '로그인 실패');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <form
        onSubmit={submit}
        className="w-full max-w-sm card p-8"
      >
        <div className="flex items-center gap-2 mb-1">
          <span className="w-6 h-6 rounded-md bg-gradient-to-br from-teal to-indigo inline-block" />
          <h1 className="text-xl font-extrabold text-teal tracking-tight">LIS</h1>
        </div>
        <p className="text-sm text-ink-2 mb-6">검사정보시스템 로그인</p>
        {expired && <p className="text-sm text-warn bg-warn/10 rounded-lg px-3 py-2 mb-4">세션이 만료되었습니다. 다시 로그인해 주세요.</p>}

        <label className="block text-xs font-semibold text-ink-2 mb-1">사용자 ID</label>
        <input
          className="mono w-full mb-4 px-3 py-2 rounded-lg border border-line bg-bg text-sm"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          aria-label="사용자 ID"
        />
        <label className="block text-xs font-semibold text-ink-2 mb-1">비밀번호</label>
        <input
          type="password"
          className="mono w-full mb-5 px-3 py-2 rounded-lg border border-line bg-bg text-sm"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-label="비밀번호"
        />

        {error && <ErrorText message={error} />}

        <button
          type="submit"
          disabled={loading}
          className="w-full py-2.5 rounded-lg bg-teal text-white font-semibold text-sm disabled:opacity-60"
        >
          {loading ? '로그인 중…' : '로그인'}
        </button>
        <div className="mt-5" hidden={!DEMO}>
          <p className="text-xs text-ink-2 mb-2">테스트 계정 (클릭하면 자동 입력)</p>
          <div className="flex flex-wrap gap-1.5">
            {DEMO && DEMO_ACCOUNTS.map((a) => {
              const active = userId === a.id;
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => {
                    setUserId(a.id);
                    setPassword(DEMO_PW);
                    setError('');
                  }}
                  className={`mono text-xs px-2.5 py-1.5 rounded-lg border transition ${
                    active
                      ? 'bg-teal text-white border-teal'
                      : 'bg-bg text-ink-2 border-line hover:border-teal'
                  }`}
                >
                  {a.id}·{a.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="mt-6 pt-4 border-t border-line text-center">
          <p className="text-xs text-ink-3">LIS v{APP_VERSION}</p>
          <p className="text-xs text-ink-3 mt-0.5">© 2026 위루비 (Weruby)</p>
        </div>
      </form>
    </main>
  );
}
