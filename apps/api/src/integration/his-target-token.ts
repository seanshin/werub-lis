/**
 * S-3 대상 토큰 — HIS 참조 조회 시 "이 요청이 어느 환자를 향하는가"를 서명으로 결속한다.
 *
 * `HMAC(<식별자>.<만료>)` 형식. 토큰 없이 식별자만 보내면 유효한 자격증명을 가진 쪽이
 * 임의 환자를 조회할 수 있다. HIS enforce 플립 후 교차검증 4케이스(정상 200 / 위조·만료·
 * 대상불일치 401)를 양측 실측으로 확인했다(2026-07-24).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { createHmac } from 'node:crypto';

/**
 * HIS S-3 대상 토큰(X-Target-Token) — consent/status 대상별 인가(2026-07-22 HIS 공지).
 * 형식: `<patientId>.<expEpochSec>.<hmacHex>`, hmac = HMAC-SHA256(`<patientId>.<exp>`, secret).
 * secret은 HIS `lis.targetTokenSecret`(미설정 시 lis.integrationKey 폴백) — LIS는 공유 시크릿으로 서명.
 * 현재 HIS permissive(미동봉 통과) — LIS가 동봉을 시작하면 enforce 플립을 통지하기로 합의.
 */
export const TARGET_TOKEN_TTL_SEC = 300;

export function buildTargetToken(patientId: string, secret: string, expEpochSec: number): string {
  const payload = `${patientId}.${expEpochSec}`;
  const hmac = createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${hmac}`;
}
