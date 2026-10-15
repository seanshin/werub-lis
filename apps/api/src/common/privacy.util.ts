/**
 * 환자 성명 마스킹(서버측) — 브라우즈/검색 응답의 최소열람 강제.
 * 프론트 마스킹에만 의존하지 않고 API 자체가 브라우즈 목록에서 성명을 마스킹한다.
 * 안전 확인 지점(상세·수혈·보고서 등)은 전체 성명 사용.
 * 홍길동→홍*동, 김수→김*, 남궁민수→남**수, 1자→*, 빈값→''.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export function maskName(name: string | null | undefined): string {
  const s = (name ?? '').trim();
  if (!s) return '';
  if (s.length === 1) return '*';
  if (s.length === 2) return s[0] + '*';
  return s[0] + '*'.repeat(s.length - 2) + s[s.length - 1];
}
