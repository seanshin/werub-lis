/**
 * 채번(numbering) — count() 기반 채번의 두 가지 사고를 막는 정본.
 *
 * ① 동시성: 동시 접수 2건이 같은 count를 읽어 같은 번호 생성 → P2002(사용자에게 500).
 * ② 삭제 후 역행: 중간 삭제 시 count가 줄어 **기존 번호를 재사용**한다. 물리 검체 라벨과
 *    충돌하고, 병리 블록/슬라이드는 `{케이스}-B{n}` 규칙이라 중간 삭제 후 count+1이
 *    항상 기존 ID와 충돌해 **채번이 영구 고장**났다(재검토 P2).
 *
 * 대응: 번호는 **기존 최대값+1**(단조증가 — 삭제돼도 역행하지 않음)로 만들고,
 * 호출부는 생성 시 유니크 위반(P2002)이면 재채번-재시도한다(동시성 창 흡수).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

/** `${prefix}` 뒤 숫자 접미를 파싱해 최대값을 구한다. 매칭 없으면 0. */
export function maxSuffixSeq(ids: readonly string[], prefix: string): number {
  let max = 0;
  for (const id of ids) {
    if (!id.startsWith(prefix)) continue;
    const tail = id.slice(prefix.length);
    // 순수 숫자 접미만 채번 계열로 인정(B1-S2 같은 하위 ID 오인 방지)
    if (!/^\d+$/.test(tail)) continue;
    const n = Number(tail);
    if (n > max) max = n;
  }
  return max;
}

/** 다음 일련번호 — 기존 최대값+1(없으면 1). */
export function nextSuffixSeq(ids: readonly string[], prefix: string): number {
  return maxSuffixSeq(ids, prefix) + 1;
}

/**
 * 고정폭 일련 채번 문자열 — `${prefix}${seq(pad자리)}`.
 * pad 자리를 넘으면 그대로 길어진다(채번 중단보다 낫다). 문자열 정렬 최대값 탐색은
 * 고정폭 안에서만 유효하므로, 호출부는 접두사 전체 목록 파싱(maxSuffixSeq)을 쓴다.
 */
export function formatSeq(prefix: string, seq: number, pad: number): string {
  return `${prefix}${String(seq).padStart(pad, '0')}`;
}
