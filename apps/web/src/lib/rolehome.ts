'use client';

/**
 * 역할별 첫 화면(P2: 전 역할이 대시보드로 가던 것) — 로그인 직후 주 업무 화면으로.
 * 복수 역할은 도메인 전담 → 검증/입력 → 접수 → 감사 → 관리자 순으로 우선한다
 * (전담 업무가 있는 사용자는 그 워크리스트가 첫 화면이어야 한다).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
const ROLE_HOME: readonly (readonly [string, string])[] = [
  ['PAT', '/pathology'],
  ['BB', '/transfusion'],
  ['MIC', '/microbiology'],
  ['GEN', '/genomic'],
  ['GC', '/genomic'],
  ['PHY', '/verify'],
  ['TEC', '/results/entry'],
  ['RCP', '/orders'],
  ['AUD', '/audit'],
  ['ADM', '/dashboard'],
] as const;

export function roleHome(roles: string[]): string {
  for (const [role, href] of ROLE_HOME) if (roles.includes(role)) return href;
  return '/dashboard';
}
