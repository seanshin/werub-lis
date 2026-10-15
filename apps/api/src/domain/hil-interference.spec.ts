/**
 * hilInterference — 검체 품질 간섭 경고 — 단위 테스트 7건.
 *
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { hilInterference } from './hil-interference';

/**
 * HIL 간섭 경고는 **용혈 검체의 거짓 상승을 그대로 보고하는 것**을 막는 마지막 신호다.
 * (가성 고칼륨혈증이 대표 사례 — 실제로는 정상인데 K가 높게 나온다)
 * 근거: docs/재검토_2026-07-21_발견목록.md Q5
 */
describe('hilInterference — 검체 품질 간섭 경고', () => {
  it('영향 analyte가 아니면 경고하지 않는다', () => {
    expect(hilInterference('CBC-HGB', { hemolysis: '3+' })).toBeNull();
  });

  it('★2+ 이상만 유의 — 1+는 경고하지 않는다', () => {
    expect(hilInterference('CHE-K', { hemolysis: '1+' })).toBeNull();
    expect(hilInterference('CHE-K', { hemolysis: '2+' })).not.toBeNull();
    expect(hilInterference('CHE-K', { hemolysis: '3+' })).not.toBeNull();
  });

  it('NONE·미측정·null은 경고하지 않는다', () => {
    expect(hilInterference('CHE-K', { hemolysis: 'NONE' })).toBeNull();
    expect(hilInterference('CHE-K', {})).toBeNull();
    expect(hilInterference('CHE-K', { hemolysis: null })).toBeNull();
  });

  it('칼륨은 용혈에만 반응한다(황달·지질혈은 무관)', () => {
    expect(hilInterference('CHE-K', { icterus: '3+', lipemia: '3+' })).toBeNull();
    expect(hilInterference('CHE-K', { hemolysis: '2+' })?.factors).toEqual(['용혈(2+)']);
  });

  it('복수 인자에 영향받는 검사는 해당 인자를 모두 알린다', () => {
    const r = hilInterference('CHE-TP', { lipemia: '2+', icterus: '3+' });
    expect(r?.factors).toHaveLength(2);
    expect(r?.message).toContain('CHE-TP');
  });

  it('영향 인자 중 하나만 유의해도 경고한다', () => {
    const r = hilInterference('CHE-TBIL', { hemolysis: '2+', lipemia: 'NONE' });
    expect(r?.factors).toEqual(['용혈(2+)']);
  });

  it('알 수 없는 등급 문자열은 0으로 취급해 경고하지 않는다(오탐 방지)', () => {
    expect(hilInterference('CHE-K', { hemolysis: '알수없음' as never })).toBeNull();
  });
});
