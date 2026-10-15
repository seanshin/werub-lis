/**
 * 환자 성명 마스킹 — 브라우즈/목록 화면의 개인정보 최소열람.
 * 안전 확인 지점(접수 확인·수혈 출고·보고서·위험치 통보·선택 상세)은 전체 성명 사용.
 * 홍길동→홍*동, 김수→김*, 남궁민수→남**수, 1자→*, 빈값→'-'.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export function maskName(name: string | null | undefined): string {
  const s = (name ?? '').trim();
  if (!s) return '-';
  if (s.length === 1) return '*';
  if (s.length === 2) return s[0] + '*';
  return s[0] + '*'.repeat(s.length - 2) + s[s.length - 1];
}
