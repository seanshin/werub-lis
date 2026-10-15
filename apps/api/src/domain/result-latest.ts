/**
 * 검사별 "최신 결과" 선택 (Domain, 순수 함수).
 *
 * ★재검(rerun)·정정(correct)이 원본에 가려지던 것(P1-1).
 *   과거 여러 경로가 `version >`로만 최신을 골랐는데, rerun은 새 행을 **version 1**로 만들어
 *   원본과 동률이 됐다. 동률이면 `>`는 거짓이라 **먼저 만난 행(원본)이 남고 재검값이 버려졌다**.
 *   희석 입력이 자동으로 `rerun:true`를 보내므로, 희석 재검 결과가 구조적으로 가려졌다.
 *
 *   근본 수정은 rerun 결과의 version을 올려(정정과 동일) tie를 없애는 것이다(result.service).
 *   이 함수는 그 선택 규칙을 **한 곳으로 통일**하고, 만약의 동률에도 안전하게 하는 보조 방어다:
 *     1) version 큰 것 우선(단조증가하므로 정상 경로에선 이걸로 결정된다)
 *     2) version 동률이면 reportedDt 늦은 것(둘 다 확정된 드문 경합)
 *     3) 그래도 동률이면 **나중에 배열에 온 것**(입력이 시간순이면 더 최근 = 재검)
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

export interface VersionedResult {
  version: number;
  reportedDt: Date | string | null;
}

function reportedMs(r: VersionedResult): number | null {
  if (!r.reportedDt) return null;
  const t = r.reportedDt instanceof Date ? r.reportedDt.getTime() : new Date(r.reportedDt).getTime();
  return Number.isNaN(t) ? null : t;
}

/** a보다 b가 "더 최신"이면 true. 위 규칙 순서대로 비교. */
export function isNewerResult(a: VersionedResult, b: VersionedResult): boolean {
  if (b.version !== a.version) return b.version > a.version;
  const am = reportedMs(a);
  const bm = reportedMs(b);
  // 확정 시각이 둘 다 있으면 늦은 쪽. 한쪽만 있으면 확정된 쪽을 우선(미확정보다 확정이 대표값).
  if (am != null && bm != null && bm !== am) return bm > am;
  if (am == null && bm != null) return true;
  if (am != null && bm == null) return false;
  // 완전 동률(정상 경로에선 발생하지 않음) — 나중 원소를 최신으로 본다. 호출부에서 순서대로 넣는다.
  return true;
}

/**
 * 결과 배열을 키별 최신 1건으로 축약. keyOf로 그룹 키를 정한다(검사코드 또는 검사코드|검체 등).
 * 입력 순서가 시간순(오래된→최근)이면 마지막 방어 규칙이 올바르게 작동한다.
 */
export function pickLatestByKey<T extends VersionedResult>(rows: T[], keyOf: (r: T) => string): Map<string, T> {
  const latest = new Map<string, T>();
  for (const r of rows) {
    const k = keyOf(r);
    const cur = latest.get(k);
    if (!cur || isNewerResult(cur, r)) latest.set(k, r);
  }
  return latest;
}
