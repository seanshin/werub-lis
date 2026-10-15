/**
 * normalizeBarcode(정본) — 단위 테스트 11건.
 *
 * 묶음: escapeHtml(정본) — 보고서 XSS 방어의 유일한 지점, 상태 라벨(정본).
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { normalizeBarcode, escapeHtml, ORDER_STATUS_LABEL, GATE_STATUS_LABEL, labelOf } from '@lis/shared';

/**
 * `@lis/shared` 공용 계약 회귀 가드.
 *
 * 이 함수들은 **API와 웹이 함께 쓴다**. 과거에 normalizeBarcode가 양쪽에 복제돼 있었고
 * 테스트된 사본은 죽고 실제로 도는 사본은 무테스트였다. 여기서 정본을 검증한다.
 * 근거: docs/재검토_2026-07-21_발견목록.md Q6
 */
const cfg = {
  trimWhitespace: true, prefixStrip: null, suffixStrip: null,
  stripPattern: null, minLength: null, maxLength: null,
};

describe('normalizeBarcode(정본)', () => {
  it('공백 제거', () => {
    expect(normalizeBarcode('  S-001  ', cfg).value).toBe('S-001');
  });

  it('접두·접미 제거는 해당할 때만', () => {
    expect(normalizeBarcode('LIS-S001', { ...cfg, prefixStrip: 'LIS-' }).value).toBe('S001');
    expect(normalizeBarcode('S001', { ...cfg, prefixStrip: 'LIS-' }).value).toBe('S001');
    expect(normalizeBarcode('S001#', { ...cfg, suffixStrip: '#' }).value).toBe('S001');
  });

  it('정규식 전역 제거', () => {
    expect(normalizeBarcode('S-0-0-1', { ...cfg, stripPattern: '-' }).value).toBe('S001');
  });

  it('★잘못된 정규식은 스캔을 막지 않고 원문을 유지한다', () => {
    // 설정 오류가 검사실 스캔 전체를 멈추게 해서는 안 된다(오류는 저장 시점에 검증).
    const r = normalizeBarcode('S001', { ...cfg, stripPattern: '(' });
    expect(r.value).toBe('S001');
    expect(r.valid).toBe(true);
  });

  it('길이 규칙 위반은 valid=false + 사유', () => {
    expect(normalizeBarcode('S1', { ...cfg, minLength: 4 }).valid).toBe(false);
    expect(normalizeBarcode('S1', { ...cfg, minLength: 4 }).warning).toContain('길이 부족');
    expect(normalizeBarcode('S123456', { ...cfg, maxLength: 4 }).warning).toContain('길이 초과');
  });

  it('빈 값은 valid=false', () => {
    expect(normalizeBarcode('   ', cfg).valid).toBe(false);
  });
});

describe('escapeHtml(정본) — 보고서 XSS 방어의 유일한 지점', () => {
  it('HTML 특수문자 5종을 모두 이스케이프', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
  it('null·undefined는 빈 문자열', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
  it('스크립트 태그가 실행 가능한 형태로 남지 않는다', () => {
    expect(escapeHtml('<script>alert(1)</script>')).not.toContain('<script>');
  });
});

describe('상태 라벨(정본)', () => {
  it('오더·게이트 라벨이 정의돼 있다', () => {
    expect(ORDER_STATUS_LABEL.RECEIVED).toBe('접수');
    expect(GATE_STATUS_LABEL.APPROVED).toBe('완료(승인)');
  });
  it('미등록 값은 원문을 그대로 보여준다(빈칸 방지)', () => {
    expect(labelOf(ORDER_STATUS_LABEL, '알수없음')).toBe('알수없음');
    expect(labelOf(ORDER_STATUS_LABEL, null)).toBe('');
  });
});
