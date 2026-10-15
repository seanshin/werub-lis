'use client';

/**
 * 사이드바 알림 배지 즉시 갱신(Q9) — 배지는 60초 폴링이라, 알림/위험치 확인 직후에는
 * 다음 폴링까지 틀린 숫자가 남는다. 확인 처리한 화면이 이 이벤트를 쏘면 사이드바가 즉시 재조회.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export const BADGE_REFRESH_EVENT = 'lis:badge-refresh';

export function refreshBadge(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(BADGE_REFRESH_EVENT));
}
