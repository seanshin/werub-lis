'use client';

/**
 * 비밀번호 변경 화면 (`/settings/password`).
 *
 * 사이드바 GROUPS에 없는 경로(로그인·도움말·상세 진입 등).
 * 데이터는 `lib/api.ts`의 `apiFetch`로만 가져온다(HTTP 호출 정본).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { apiFetch, getToken } from '@/lib/api';
import { useToast } from '@/components/toast';

const inp = 'w-full px-2 py-1.5 pr-10 rounded-lg border border-line bg-bg text-sm';

// 서버 정책(password-policy.ts)과 동기 — 클라 사전검증·힌트용.
const WEAK = ['password', 'demo1234', '12345678', 'qwerty'];
function checkRules(pw: string) {
  return [
    { ok: pw.length >= 10, label: '10자 이상' },
    { ok: /[a-z]/.test(pw), label: '소문자 포함' },
    { ok: /[A-Z]/.test(pw), label: '대문자 포함' },
    { ok: /[0-9]/.test(pw), label: '숫자 포함' },
    { ok: pw.length > 0 && !WEAK.some((w) => pw.toLowerCase().includes(w)), label: '취약단어 아님' },
  ];
}

function PwField({ label, value, onChange, autoComplete }: { label: string; value: string; onChange: (v: string) => void; autoComplete: string }) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <label className="block text-xs text-ink-2 mb-1">{label}</label>
      <div className="relative">
        <input aria-label="{label}" type={show ? 'text' : 'password'} className={inp} value={value} onChange={(e) => onChange(e.target.value)} autoComplete={autoComplete} />
        <button type="button" onClick={() => setShow((s) => !s)} className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-ink-3 hover:text-ink" aria-label={show ? '숨기기' : '표시'}>
          {show ? '🙈' : '👁'}
        </button>
      </div>
    </div>
  );
}

function ChangePasswordForm() {
  const router = useRouter();
  const toast = useToast();
  const [cur, setCur] = useState('');
  const [nw, setNw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  const params = useSearchParams();
  // 관리자 발급·재설정 직후(first=1): 변경 전까지 다른 기능이 서버에서 403으로 막혀 있다.
  const first = params.get('first') === '1';

  useEffect(() => { if (!getToken()) router.push('/'); }, [router]);

  const rules = checkRules(nw);
  const allOk = rules.every((r) => r.ok);
  const match = nw.length > 0 && nw === confirm;
  const canSubmit = cur.length > 0 && allOk && match && nw !== cur && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    try {
      await apiFetch('/api/v1/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: cur, newPassword: nw }) });
      toast('비밀번호가 변경되었습니다', 'success');
      setCur(''); setNw(''); setConfirm('');
      if (first) {
        // 강제 변경 상태였으므로 새 토큰이 필요하다(기존 토큰은 비번 변경 시점 이전 발급 → 무효).
        toast('다시 로그인해 주세요', 'info');
        setTimeout(() => router.push('/'), 800);
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : '변경 실패', 'error');
    } finally { setBusy(false); }
  }

  return (
    <main className="max-w-md mx-auto p-6">
      <h1 className="t-page mb-1">비밀번호 변경</h1>
      {first ? (
        <p className="text-xs text-warn bg-warn/10 rounded-lg px-3 py-2 mb-4">
          관리자가 발급한 초기 비밀번호입니다. <b>변경해야 다른 기능을 사용할 수 있습니다.</b>
        </p>
      ) : (
        <p className="text-xs text-ink-3 mb-4">본인 비밀번호를 직접 변경합니다. 변경 후 다음 로그인부터 새 비밀번호가 적용됩니다.</p>
      )}

      <form onSubmit={submit} className="card flex flex-col gap-3">
        <PwField label="현재 비밀번호" value={cur} onChange={setCur} autoComplete="current-password" />
        <div>
          <PwField label="새 비밀번호" value={nw} onChange={setNw} autoComplete="new-password" />
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5">
            {rules.map((r) => (
              <span key={r.label} className={`text-[11px] ${r.ok ? 'text-good' : 'text-ink-3'}`}>{r.ok ? '' : '○'} {r.label}</span>
            ))}
            {nw.length > 0 && nw === cur && <span className="text-[11px] text-crit">✕ 현재 비밀번호와 달라야 함</span>}
          </div>
        </div>
        <div>
          <PwField label="새 비밀번호 확인" value={confirm} onChange={setConfirm} autoComplete="new-password" />
          {confirm.length > 0 && !match && <span className="text-[11px] text-crit mt-1 inline-block">✕ 새 비밀번호와 일치하지 않음</span>}
        </div>
        <button type="submit" disabled={!canSubmit} className="py-2 rounded-lg bg-teal text-white font-semibold text-sm disabled:opacity-40 disabled:cursor-not-allowed">
          {busy ? '변경 중…' : '비밀번호 변경'}
        </button>
      </form>
    </main>
  );
}

// useSearchParams는 Suspense 경계가 필요하다(Next 앱 라우터 정적 렌더링 제약).
export default function ChangePasswordPage() {
  return (
    <Suspense fallback={<main className="max-w-md mx-auto p-6 text-sm text-ink-3">불러오는 중…</main>}>
      <ChangePasswordForm />
    </Suspense>
  );
}
