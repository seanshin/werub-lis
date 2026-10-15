/**
 * 비밀번호 정책·계정 잠금 (Domain, 순수 함수) — 보안 하드닝.
 * 근거: 기획 22 §6-6.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

export const LOCK_THRESHOLD = 5; // 연속 실패 허용 횟수
export const LOCK_MINUTES = 15; // 잠금 유지(분)

/** 비밀번호 강도 검증 — 통과 시 null, 위반 시 사유 메시지. */
export function validatePasswordStrength(pw: string): string | null {
  if (!pw || pw.length < 10) return '비밀번호는 10자 이상이어야 합니다';
  if (!/[a-z]/.test(pw)) return '소문자를 포함해야 합니다';
  if (!/[A-Z]/.test(pw)) return '대문자를 포함해야 합니다';
  if (!/[0-9]/.test(pw)) return '숫자를 포함해야 합니다';
  const weak = ['password', 'demo1234', '12345678', 'qwerty'];
  if (weak.some((w) => pw.toLowerCase().includes(w))) return '취약한 비밀번호입니다';
  return null;
}

/** 로그인 실패 누적 → 잠금 여부·다음 상태 계산. */
export function nextLockState(
  currentAttempts: number,
): { attempts: number; lockedUntilMs: number | null } {
  const attempts = currentAttempts + 1;
  if (attempts >= LOCK_THRESHOLD) {
    return { attempts, lockedUntilMs: LOCK_MINUTES * 60_000 };
  }
  return { attempts, lockedUntilMs: null };
}

/** 현재 잠금 상태인지(잠금 해제 시각 대비 nowMs). */
export function isLocked(lockedUntil: Date | null, nowMs: number): boolean {
  return lockedUntil != null && lockedUntil.getTime() > nowMs;
}
