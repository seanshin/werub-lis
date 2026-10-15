/**
 * billing-claim buildClaimMessage (ERP 확정 규격) — 단위 테스트 2건.
 *
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { buildClaimMessage, claimIdFor } from './billing-claim';

describe('billing-claim buildClaimMessage (ERP 확정 규격)', () => {
  it('lisBillingId=LIS-<orderId> · 금액/ediCode 미포함 · visitId는 값 있을 때만', () => {
    const msg = buildClaimMessage({
      orderId: 'O-1', patientId: 'P-1', revision: 1, visitId: null, performedOn: '2026-07-24',
      items: [{ testCode: 'CHE-NA', testName: '나트륨', quantity: 1, specimen: 'SST', resultStatus: 'FINAL' }],
    });
    expect(msg.lisBillingId).toBe('LIS-O-1');
    expect(claimIdFor('O-1')).toBe('LIS-O-1');
    expect(msg.performedOn).toBe('2026-07-24'); // 실시일(보고일 아님)
    expect(msg).not.toHaveProperty('visitId'); // null이면 생략
    // E-3 (A): LIS는 금액·EDI 수가코드를 보내지 않는다
    const json = JSON.stringify(msg);
    expect(json).not.toContain('amount');
    expect(json).not.toContain('ediCode');
    expect(json).not.toContain('edi_code');
    expect(msg.items[0]).toEqual({ testCode: 'CHE-NA', testName: '나트륨', quantity: 1, specimen: 'SST', resultStatus: 'FINAL' });
  });

  it('visitId·revision은 그대로 반영', () => {
    const msg = buildClaimMessage({ orderId: 'O-2', patientId: 'P', revision: 3, visitId: 'V-9', performedOn: null, items: [] });
    expect(msg.visitId).toBe('V-9');
    expect(msg.revision).toBe(3);
    expect(msg.items).toEqual([]);
  });
});
