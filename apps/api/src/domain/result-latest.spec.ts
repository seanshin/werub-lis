/**
 * pickLatestByKey — 재검·정정이 원본에 가려지지 않는다(P1-1 회귀 금지) — 단위 테스트 7건.
 *
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { isNewerResult, pickLatestByKey } from './result-latest';

/**
 * 근거: docs/재검토_2026-07-21_발견목록.md P1-1
 * "재검(rerun) 결과가 원본에 가려진다 — 동률이면 먼저 만난 행(원본)이 이긴다."
 */
describe('pickLatestByKey — 재검·정정이 원본에 가려지지 않는다(P1-1 회귀 금지)', () => {
  const mk = (version: number, reportedDt: string | null, tag: string) => ({ version, reportedDt, tag });

  it('version이 크면 최신', () => {
    const rows = [mk(1, '2026-07-21T01:00:00Z', 'orig'), mk(2, '2026-07-21T02:00:00Z', 'corrected')];
    expect(pickLatestByKey(rows, () => 'k').get('k')?.tag).toBe('corrected');
  });

  it('★version 동률이면 reportedDt 늦은 것 — 원본이 이기지 않는다', () => {
    // rerun이 version을 안 올리던 옛 버그 재현: 둘 다 version 1, 재검이 나중
    const rows = [mk(1, '2026-07-21T01:00:00Z', 'orig'), mk(1, '2026-07-21T03:00:00Z', 'rerun')];
    expect(pickLatestByKey(rows, () => 'k').get('k')?.tag).toBe('rerun');
  });

  it('배열 순서가 뒤바뀌어도 결과는 같다(먼저 만난 행이 이기지 않는다)', () => {
    const rows = [mk(1, '2026-07-21T03:00:00Z', 'rerun'), mk(1, '2026-07-21T01:00:00Z', 'orig')];
    expect(pickLatestByKey(rows, () => 'k').get('k')?.tag).toBe('rerun');
  });

  it('확정(reportedDt 있음)이 미확정(null)보다 대표값 — 단 version 동률일 때만', () => {
    const finalized = mk(1, '2026-07-21T01:00:00Z', 'final');
    const pending = mk(1, null, 'pending');
    expect(isNewerResult(finalized, pending)).toBe(false); // pending이 더 최신 아님
    expect(isNewerResult(pending, finalized)).toBe(true); // finalized가 더 최신
  });

  it('version이 크면 미확정이라도 최신 — 재검은 아직 PENDING이어도 원본을 가린다', () => {
    // 재검 결과가 방금 들어와 아직 확정 전(reportedDt null)이지만 version은 +1
    const orig = mk(1, '2026-07-21T01:00:00Z', 'orig-final');
    const rerun = mk(2, null, 'rerun-pending');
    expect(pickLatestByKey([orig, rerun], () => 'k').get('k')?.tag).toBe('rerun-pending');
  });

  it('키별로 독립 축약된다', () => {
    const rows = [mk(1, '2026-07-21T01:00:00Z', 'A1'), mk(2, '2026-07-21T02:00:00Z', 'A2'), mk(1, '2026-07-21T01:00:00Z', 'B1')];
    const keys = ['a', 'a', 'b'];
    let i = 0;
    const m = pickLatestByKey(rows, () => keys[i++]);
    expect(m.get('a')?.tag).toBe('A2');
    expect(m.get('b')?.tag).toBe('B1');
  });

  it('빈 배열은 빈 맵', () => {
    expect(pickLatestByKey([], () => 'k').size).toBe(0);
  });
});
