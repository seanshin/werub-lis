/**
 * maxSuffixSeq / nextSuffixSeq — 삭제·결번에도 단조증가 — 단위 테스트 8건.
 *
 * 묶음: formatSeq.
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { maxSuffixSeq, nextSuffixSeq, formatSeq } from './numbering';

describe('maxSuffixSeq / nextSuffixSeq — 삭제·결번에도 단조증가', () => {
  it('빈 목록이면 1부터', () => {
    expect(nextSuffixSeq([], 'SP-2026-B')).toBe(1);
  });

  it('중간 삭제 후에도 기존 번호를 재사용하지 않는다(count+1 사고 재현 케이스)', () => {
    // B1,B2,B3에서 B2 삭제 → count+1이면 B3 재발급(기존 B3과 충돌·영구 고장)
    expect(nextSuffixSeq(['SP-1-B1', 'SP-1-B3'], 'SP-1-B')).toBe(4);
  });

  it('10 이상에서 문자열 정렬에 속지 않는다(B9 > B10 사전순 함정)', () => {
    expect(nextSuffixSeq(['C-B9', 'C-B10', 'C-B2'], 'C-B')).toBe(11);
  });

  it('하위 ID(슬라이드 등 비숫자 접미)는 채번 계열로 오인하지 않는다', () => {
    expect(nextSuffixSeq(['SP-1-B2', 'SP-1-B2-S5'], 'SP-1-B')).toBe(3);
  });

  it('다른 접두사는 무시한다', () => {
    expect(nextSuffixSeq(['SP-2-B7', 'SP-1-B1'], 'SP-1-B')).toBe(2);
  });

  it('고정폭 패딩 접미(검체번호·병리번호)도 파싱한다', () => {
    expect(nextSuffixSeq(['S2607220001', 'S2607220012'], 'S260722')).toBe(13);
  });
});

describe('formatSeq', () => {
  it('고정폭 패딩', () => {
    expect(formatSeq('S260722', 13, 4)).toBe('S2607220013');
    expect(formatSeq('SP-2026-', 5, 4)).toBe('SP-2026-0005');
  });

  it('자리 초과 시 채번을 멈추지 않고 길어진다', () => {
    expect(formatSeq('S260722', 10001, 4)).toBe('S26072210001');
  });
});
