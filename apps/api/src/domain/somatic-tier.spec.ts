/**
 * suggestSomaticTier (근거→AMP/ASCO tier) — 단위 테스트 6건.
 *
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { suggestSomaticTier } from './somatic-tier';

describe('suggestSomaticTier (근거→AMP/ASCO tier)', () => {
  it('OncoKB Level 1/2 → Tier I', () => {
    expect(suggestSomaticTier({ oncokb_level: 'Level 1', significance: 'Pathogenic' })?.tier).toBe('TIER_I');
    expect(suggestSomaticTier({ oncokb_level: 'Level 2', significance: 'Pathogenic' })?.tier).toBe('TIER_I');
  });
  it('OncoKB Level 3/4 → Tier II', () => {
    expect(suggestSomaticTier({ oncokb_level: 'Level 3A' })?.tier).toBe('TIER_II');
    expect(suggestSomaticTier({ oncokb_level: 'Level 4' })?.tier).toBe('TIER_II');
  });
  it('OncoKB 없고 Pathogenic → Tier II(재확인 경고)', () => {
    const s = suggestSomaticTier({ significance: 'Pathogenic', oncokb_level: '-' });
    expect(s?.tier).toBe('TIER_II');
    expect(s?.caution).toBeTruthy();
  });
  it('VUS → Tier III, Benign → Tier IV', () => {
    expect(suggestSomaticTier({ significance: 'VUS' })?.tier).toBe('TIER_III');
    expect(suggestSomaticTier({ significance: 'Likely benign' })?.tier).toBe('TIER_IV');
  });
  it('근거 없으면 null(임의 추정 금지)', () => {
    expect(suggestSomaticTier(null)).toBeNull();
    expect(suggestSomaticTier({})).toBeNull();
  });
  it('citation은 그대로 전달', () => {
    expect(suggestSomaticTier({ oncokb_level: 'Level 1', citation: 'PMID:123' })?.citation).toBe('PMID:123');
  });
});
