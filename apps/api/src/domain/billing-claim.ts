/**
 * ERP 청구 전송 메시지 조립(Domain, 순수 함수).
 *
 * ERP 회신·LIS 답신(docs/ERP_회신_LIS답신_청구연동_2026-07-24.md) 확정 규격:
 *  - 1메시지 = 1오더, `lisBillingId = LIS-<orderId>`(멱등키·source_ref)
 *  - E-3 (A): LIS는 검사코드·수량·실시일·검체·결과상태만. **금액·EDI 수가코드는 미포함**(ERP 산정)
 *  - `performedOn` = ⚠ **검사 실시일(채취/접수일)** — 보고일 아님(월 경계·단가 틀어짐 방지, ERP 확정)
 *  - `resultStatus` = FINAL만 청구 대상. 정정은 revision++(ERP 역분개)
 *  - `patientId` = 현재 chartNo, Phase0 가명화 컷오버 후 patientRef passthrough
 *  - `visitId` = 선택(HIS 오더 방문식별자 있으면 동봉)
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

export interface ClaimItem {
  testCode: string;      // 원내 검사코드 — ERP가 EDI 매핑
  testName: string | null;
  quantity: number;
  specimen: string | null;   // 검체종류
  resultStatus: string;      // FINAL 등
}

export interface ClaimInput {
  orderId: string;
  patientId: string | null;
  revision: number;
  visitId?: string | null;
  performedOn: string | null; // 실시일 YYYY-MM-DD
  items: ClaimItem[];
}

export interface ClaimMessage {
  lisBillingId: string;
  revision: number;
  patientId: string | null;
  visitId?: string;
  performedOn: string | null;
  items: ClaimItem[];
  // ★금액·ediCode 필드 없음 — E-3 (A): ERP 산정
}

export function claimIdFor(orderId: string): string {
  return `LIS-${orderId}`;
}

export function buildClaimMessage(input: ClaimInput): ClaimMessage {
  const msg: ClaimMessage = {
    lisBillingId: claimIdFor(input.orderId),
    revision: input.revision,
    patientId: input.patientId,
    performedOn: input.performedOn,
    items: input.items.map((i) => ({
      testCode: i.testCode,
      testName: i.testName,
      quantity: i.quantity,
      specimen: i.specimen,
      resultStatus: i.resultStatus,
    })),
  };
  if (input.visitId) msg.visitId = input.visitId; // 선택 필드는 값 있을 때만
  return msg;
}
