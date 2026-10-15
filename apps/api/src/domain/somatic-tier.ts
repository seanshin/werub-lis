/**
 * 체세포(NGS) 변이 tier 제안(DRAFT) — 근거 DB(VARIANT_EVIDENCE의 OncoKB level·유의성)로 AMP/ASCO tier 초안.
 *
 * ⚠ 확정 아님 — 판독 전문가가 검토·수정·확정한다. 근거가 없으면 제안하지 않는다(임의 추정 금지).
 * (C-대 스텁 "tier 자동판정"의 로컬 구현 — 근거 DB 개정 시 반입으로 반영, 실 파이프라인 규격은 별도)
 *
 * AMP/ASCO/CAP 4-tier:
 *  - Tier I  : 강한 임상적 의미(FDA 승인·가이드라인 표적치료) ← OncoKB level 1·2
 *  - Tier II : 잠재적 의미(임상시험·타 암종 근거)           ← OncoKB level 3·4, 또는 Pathogenic(치료근거 미상)
 *  - Tier III: 불확실(VUS)
 *  - Tier IV : 양성/likely benign
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export interface EvidenceLike {
  significance?: string;
  oncokb_level?: string;
  citation?: string;
  source?: string;
  condition?: string;
}
export interface TierSuggestion {
  tier: string;
  basis: string;
  citation: string | null;
  caution: string | null;
}

export function suggestSomaticTier(ev: EvidenceLike | null | undefined): TierSuggestion | null {
  if (!ev) return null;
  const level = (ev.oncokb_level ?? '').toUpperCase().replace(/\s+/g, '');
  const sig = (ev.significance ?? '').toLowerCase();
  const cite = ev.citation ?? null;

  // OncoKB level 우선(치료 근거 강도)
  if (/(LEVEL_?)?1\b|^1$|^R1$/.test(level) || /(LEVEL_?)?2A?B?\b|^2$/.test(level)) {
    return { tier: 'TIER_I', basis: `OncoKB ${ev.oncokb_level} — FDA 승인/가이드라인 표적치료`, citation: cite, caution: null };
  }
  if (/(LEVEL_?)?3A?B?\b|^3$|(LEVEL_?)?4\b|^4$|^R2$/.test(level)) {
    return { tier: 'TIER_II', basis: `OncoKB ${ev.oncokb_level} — 임상시험/타 암종 근거`, citation: cite, caution: null };
  }
  // OncoKB level 없으면 유의성으로
  if (/pathogenic/.test(sig)) {
    return { tier: 'TIER_II', basis: `유의성 ${ev.significance}(표적치료 근거 미상)`, citation: cite, caution: 'OncoKB level 없음 — tier 재확인' };
  }
  if (/vus|uncertain/.test(sig)) {
    return { tier: 'TIER_III', basis: `유의성 ${ev.significance}(불확실)`, citation: cite, caution: null };
  }
  if (/benign/.test(sig)) {
    return { tier: 'TIER_IV', basis: `유의성 ${ev.significance}(양성)`, citation: cite, caution: null };
  }
  return null;
}
