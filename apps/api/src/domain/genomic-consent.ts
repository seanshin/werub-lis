/**
 * 유전체 동의 게이트 — 근거: 05 §3, 07 §12.2.
 * 동의 완료(미철회) 전에는 수탁 발송/Run 생성 불가.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export interface ConsentState {
  exists: boolean;
  signedDate: string | null;
  withdrawn: boolean;
}

export interface ConsentGateResult {
  allowed: boolean;
  reason: string | null;
}

export function canSendout(consent: ConsentState): ConsentGateResult {
  if (!consent.exists || !consent.signedDate) {
    return { allowed: false, reason: '동의 미완료(발송 불가)' };
  }
  if (consent.withdrawn) {
    return { allowed: false, reason: '동의 철회됨(발송 불가)' };
  }
  return { allowed: true, reason: null };
}
