/**
 * 식별자 생성 — 충돌 내성 ID(`genId`).
 *
 * ⚠ 과거에는 `count()+1` 방식이었는데, 동시 생성 시 같은 번호가 나와 P2002(유니크 위반)로
 *   터졌다. 삭제가 섞이면 이미 쓴 번호를 재발급하기도 했다. 그래서 카운트 기반을 버리고
 *   충돌 내성 생성으로 전환했다(13곳). 정렬이 필요한 곳은 ID가 아니라 시간 필드를 쓴다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { randomBytes } from 'node:crypto';

/**
 * 충돌 내성 ID 생성 — 가독 접두사 + 날짜 + 랜덤.
 * count() 기반 생성의 동시성 충돌(동일 count→동일 ID→P2002)·삭제 후 역행 문제를 제거.
 *
 * 난수는 CSPRNG(randomBytes)를 쓴다. Math.random()은 예측 가능한 PRNG라, 자기 것 몇 개를
 * 만들어 상태를 복원하면 타 도메인 리소스 ID(예: 첨부 attachmentId)를 유도할 수 있다.
 * ID는 접근제어가 아니지만(도메인 격리는 별도 검증), 추측 가능성을 낮춰 둔다.
 * 근거: 기획 22 §6-1 잔여 하드닝(시퀀스/UUID 전환).
 */
export function genId(prefix: string, now: Date = new Date()): string {
  const yy = String(now.getFullYear()).slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const rand = randomBytes(5).toString('hex').slice(0, 8).toUpperCase();
  return `${prefix}-${yy}${mm}${dd}-${rand}`;
}
