/**
 * Prisma 오류 판별 헬퍼 — 드라이버 오류 코드를 도메인 의미로 번역한다.
 *
 * 유니크 위반(P2002)은 "실패"가 아니라 **정상 흐름의 신호**로 쓰이는 곳이 있다:
 * 채번 재시도, 연계 메시지 멱등 스킵(같은 MSH-10 재수신) 등. 그래서 예외를
 * 삼키지 않고 이 헬퍼로 판별해 분기한다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
/** Prisma 유니크 제약 위반(P2002) 여부 — 채번 재시도·멱등 스킵 판정용 공용 헬퍼. */
export function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}
