/**
 * buildAccession (2자리 연도 헤드룸, PACS 결정1) — 단위 테스트 5건.
 *
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { buildAccession, accessionOverflow, DICOM_ACCESSION_MAX } from './accession.util';

describe('buildAccession (2자리 연도 헤드룸, PACS 결정1)', () => {
  it('SP-2026-0456 → ACC-SP-26-0456 (14자)', () => {
    const acc = buildAccession('SP-2026-0456');
    expect(acc).toBe('ACC-SP-26-0456');
    expect(acc.length).toBe(14);
  });

  it('세포검사 접두: C-2026-0042 → ACC-C-26-0042', () => {
    expect(buildAccession('C-2026-0042')).toBe('ACC-C-26-0042');
  });

  it('헤드룸: 5자리 일련 SP-2026-10000 → 15자(16 이내)', () => {
    const acc = buildAccession('SP-2026-10000');
    expect(acc).toBe('ACC-SP-26-10000');
    expect(acc.length).toBeLessThanOrEqual(DICOM_ACCESSION_MAX);
  });

  it('4자리 연도 패턴 없으면 원본 유지(ACC-{spNo})', () => {
    expect(buildAccession('X123')).toBe('ACC-X123');
  });

  it('accessionOverflow: 16자 이내 null, 초과 시 사유', () => {
    expect(accessionOverflow('ACC-SP-26-0456')).toBeNull();
    expect(accessionOverflow('ACC-SP-2026-999999')).toContain('초과');
  });
});
