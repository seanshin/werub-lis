/**
 * 증분 폴링 워터마크 전진 판단 (Domain, 순수 함수).
 *
 * ★워터마크는 **성공적으로 적용된 지점까지만** 전진해야 한다.
 *   과거 HIS 오더 폴링은 조회된 항목의 시각으로 워터마크를 먼저 올려놓고 적용 루프를
 *   통째로 catch로 삼켰다. 그래서 취소 적용이 실패하면 그 취소는 다음 폴링 대상에서
 *   빠지고 — **임상의가 취소한 오더를 LIS가 계속 수행·보고**했다.
 *
 * 재폴링은 멱등이므로(생성은 외부오더번호 중복검사, 취소는 status 조건부 갱신)
 * 경계를 되돌려 다시 보는 쪽이 누락보다 항상 안전하다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

export interface WatermarkInput {
  since: string | null; // 현재 저장된 워터마크(ISO). 최초 폴링은 null
  maxProcessed: string; // 이번 주기에 **처리 성공한** 항목의 최대 시각(ISO). 없으면 ''
  earliestFailure: string | null; // 실패한 항목 중 가장 이른 시각(ISO). 없으면 null
  hold: boolean; // 시각을 알 수 없는 실패·목록 조회 자체 실패 → 전진 보류
}

/**
 * 저장할 워터마크를 결정한다. `null`이면 이번 주기에는 전진하지 않는다.
 *
 * 경계 시각이 같은 항목이 함께 누락되지 않도록 1초 백오프한다(재조회는 멱등).
 */
export function nextWatermark(input: WatermarkInput, backoffMs = 1000): string | null {
  // 어디서 멈춰야 할지 모르는 실패 → 전진하지 않는다(다음 주기에 같은 구간을 다시 본다).
  if (input.hold) return null;

  let advanceTo = input.maxProcessed;
  // 실패분이 있으면 그 앞에서 멈춘다 — 실패한 항목이 반드시 재조회 범위에 들어오도록.
  if (input.earliestFailure && (!advanceTo || advanceTo >= input.earliestFailure)) {
    advanceTo = input.earliestFailure;
  }
  if (!advanceTo) return null;

  const backoff = new Date(new Date(advanceTo).getTime() - backoffMs).toISOString();
  // 값이 그대로면 쓰기를 아낀다(같은 구간 반복 폴링은 정상 — 멱등).
  if (backoff === input.since) return null;
  return backoff;
}
