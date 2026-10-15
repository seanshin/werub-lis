/**
 * JWT 시크릿 해석 — 하드코딩 폴백 제거(토큰 위조 방지).
 * 미설정 또는 기존 노출 기본값이면 부팅 차단(fail-fast). 운영 compose는 `:?`로 강제 주입.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
const BURNED = new Set(['lis-dev-secret', 'lis-dev-secret-change-in-prod', 'change-me', 'secret']);

export function getJwtSecret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET 미설정 — 강력한 시크릿(32자↑)을 .env에 주입하세요(운영 필수).');
  if (BURNED.has(s)) throw new Error('JWT_SECRET이 노출된 기본값입니다 — 새 시크릿으로 교체하세요.');
  if (s.length < 32) {
    // 부팅은 허용하되 경고(운영은 32자↑ 강제 권장)
    console.warn('[auth] 경고: JWT_SECRET이 32자 미만입니다. 운영에서는 32자 이상을 사용하세요.');
  }
  return s;
}
