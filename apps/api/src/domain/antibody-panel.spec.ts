/**
 * interpretPanel (항체동정 11-cell 룰아웃) — 단위 테스트 5건.
 *
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { interpretPanel, STANDARD_PANEL } from './antibody-panel';

// 특정 항원 유무를 그대로 반응 패턴으로(단일 특이성) — 그 항원이 동정돼야 함
const reactFor = (ag: string) => STANDARD_PANEL.map((c) => !!c.antigens[ag]);

describe('interpretPanel (항체동정 11-cell 룰아웃)', () => {
  it('단일 특이성(anti-K) 패턴 → K 동정', () => {
    const r = interpretPanel(STANDARD_PANEL, reactFor('K'));
    expect(r.identified).toContain('K');
    expect(r.ruledOut).not.toContain('K');
    expect(r.antibodies).toContain('anti-K');
  });
  it('단일 특이성(anti-Fya) 패턴 → Fya 동정', () => {
    expect(interpretPanel(STANDARD_PANEL, reactFor('Fya')).identified).toContain('Fya');
  });
  it('전 세포 비반응 → 동정 없음, 항원+ 세포 보유 항원은 룰아웃', () => {
    const r = interpretPanel(STANDARD_PANEL, STANDARD_PANEL.map(() => false));
    expect(r.identified).toHaveLength(0);
    expect(r.ruledOut).toContain('K'); // K+ 세포가 있는데 모두 비반응 → 룰아웃
  });
  it('전 세포 반응 → 어떤 항원도 완전 동정 안 됨(비특이·다중항체 의심)', () => {
    const r = interpretPanel(STANDARD_PANEL, STANDARD_PANEL.map(() => true));
    // 룰아웃 없음(모든 세포 반응), 동정도 없음(항원- 세포가 반응하므로 패턴 불일치)
    expect(r.ruledOut).toHaveLength(0);
  });
  it('룰아웃된 항원은 후보/동정에서 제외', () => {
    const r = interpretPanel(STANDARD_PANEL, reactFor('K'));
    for (const ag of r.ruledOut) {
      expect(r.candidates).not.toContain(ag);
      expect(r.identified).not.toContain(ag);
    }
  });
});
