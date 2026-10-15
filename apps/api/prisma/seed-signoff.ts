/**
 * seed-signoff.ts — prisma 모듈 구성요소.
 *
 * 제공: seedSignoffPending.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { PrismaClient } from '@prisma/client';

/**
 * 검사실·법무 서명 대기값의 개발 시드(dev seed) — 서명 전 대체 예정.
 * ⚠ §F 임상 참고치·검사별 자동검증/델타 설정·EDI 수가코드는 **검사실/법무 최종 서명 후 실값으로 교체**.
 *   서명 진행 중 개발·파일럿이 막히지 않도록 대표값을 채운다(멱등 — skipDuplicates/update).
 * (AST 브레이크포인트·법정감염병 대상·CAP synoptic 요소·ACMG SF는 domain 코드의 스타터셋이 이 역할을 함.)
 */
export async function seedSignoffPending(prisma: PrismaClient): Promise<void> {
  // (1) §F·추가 화학/면역 검사 마스터
  await prisma.testMaster.createMany({
    data: [
      { testCode: 'CHE-CL', name: '염소', loinc: '2075-0', domain: 'DIAGNOSTIC', unitUcum: 'mmol/L', specimenType: 'Serum' },
      { testCode: 'CHE-CO2', name: '중탄산(HCO3)', loinc: '1963-8', domain: 'DIAGNOSTIC', unitUcum: 'mmol/L', specimenType: 'Serum' },
      { testCode: 'CHE-AGAP', name: '음이온차(Anion Gap)', loinc: '1863-0', domain: 'DIAGNOSTIC', unitUcum: 'mmol/L', specimenType: 'Serum' },
      { testCode: 'CHE-CRE', name: '크레아티닌', loinc: '2160-0', domain: 'DIAGNOSTIC', unitUcum: 'mg/dL', specimenType: 'Serum' },
      { testCode: 'CHE-BUN', name: '요소질소(BUN)', loinc: '3094-0', domain: 'DIAGNOSTIC', unitUcum: 'mg/dL', specimenType: 'Serum' },
      { testCode: 'CHE-CA', name: '칼슘', loinc: '17861-6', domain: 'DIAGNOSTIC', unitUcum: 'mg/dL', specimenType: 'Serum' },
      { testCode: 'CHE-ALB', name: '알부민', loinc: '1751-7', domain: 'DIAGNOSTIC', unitUcum: 'g/dL', specimenType: 'Serum' },
      { testCode: 'IMM-CRP', name: 'CRP', loinc: '1988-5', domain: 'DIAGNOSTIC', unitUcum: 'mg/L', specimenType: 'Serum' },
    ],
    skipDuplicates: true,
  });

  // (2) §F 임상값 참고치 — ⚠서명 대기 대표값. AG는 K포함식 기준 10–20(회귀-금지 불변식).
  //   이 8개 검사 참고치는 시드가 권위적으로 소유 — 재실행·기존값(예: AG 8-16 오류) 중복 방지 위해
  //   해당 testCode 기존 참고치를 먼저 정리 후 생성(멱등). 서명 시 실값으로 교체.
  const rangeTests = ['CHE-CL', 'CHE-CO2', 'CHE-AGAP', 'CHE-CRE', 'CHE-BUN', 'CHE-CA', 'CHE-ALB', 'IMM-CRP'];
  await prisma.referenceRange.deleteMany({ where: { testCode: { in: rangeTests } } });
  await prisma.referenceRange.createMany({
    data: [
      { rrId: 'RRF-CL', testCode: 'CHE-CL', sex: 'A', ageMin: 0, ageMax: 200, low: 98, high: 107, panicLow: 80, panicHigh: 120 },
      { rrId: 'RRF-CO2', testCode: 'CHE-CO2', sex: 'A', ageMin: 0, ageMax: 200, low: 22, high: 29, panicLow: 10, panicHigh: 40 },
      { rrId: 'RRF-AGAP', testCode: 'CHE-AGAP', sex: 'A', ageMin: 0, ageMax: 200, low: 10, high: 20 },
      { rrId: 'RRF-CRE', testCode: 'CHE-CRE', sex: 'A', ageMin: 18, ageMax: 200, low: 0.6, high: 1.3, panicHigh: 10 },
      { rrId: 'RRF-BUN', testCode: 'CHE-BUN', sex: 'A', ageMin: 0, ageMax: 200, low: 8, high: 20 },
      { rrId: 'RRF-CA', testCode: 'CHE-CA', sex: 'A', ageMin: 0, ageMax: 200, low: 8.6, high: 10.2, panicLow: 6, panicHigh: 14 },
      { rrId: 'RRF-ALB', testCode: 'CHE-ALB', sex: 'A', ageMin: 0, ageMax: 200, low: 3.5, high: 5.2 },
      { rrId: 'RRF-CRP', testCode: 'IMM-CRP', sex: 'A', ageMin: 0, ageMax: 200, low: 0, high: 5 },
    ],
    skipDuplicates: true,
  });

  // (3) 검사별 자동검증·델타 설정(B5) — ⚠서명 대기 대표값(analyte별 델타 한계·look-back 창).
  const cfg: { testCode: string; autoVerify?: boolean; deltaPctLimit?: number; deltaAbsLimit?: number; deltaWindowDays?: number }[] = [
    { testCode: 'CHE-K', deltaPctLimit: 20, deltaAbsLimit: 1.0, deltaWindowDays: 7 },
    { testCode: 'CHE-NA', deltaPctLimit: 5, deltaAbsLimit: 10, deltaWindowDays: 7 },
    { testCode: 'CHE-GLU', deltaPctLimit: 50, deltaWindowDays: 3 },
    { testCode: 'CHE-CRE', deltaPctLimit: 30, deltaAbsLimit: 0.5, deltaWindowDays: 30 },
    { testCode: 'CHE-CA', deltaPctLimit: 15, deltaAbsLimit: 1.5, deltaWindowDays: 14 },
    { testCode: 'IMM-CRP', deltaPctLimit: 100, deltaWindowDays: 3 }, // CRP 급변 흔함 → 완화
  ];
  for (const c of cfg) {
    await prisma.testMaster.update({
      where: { testCode: c.testCode },
      data: { autoVerify: c.autoVerify ?? true, deltaPctLimit: c.deltaPctLimit ?? null, deltaAbsLimit: c.deltaAbsLimit ?? null, deltaWindowDays: c.deltaWindowDays ?? null },
    }).catch(() => undefined);
  }

  // (4) EDI 수가코드(codeMapping) — ⚠서명 대기 대표값(청구 파운데이션 D3용). 실 수가코드는 심평원·원무 확정.
  const edi: { lisCode: string; hisCode?: string; ediCode: string; loinc?: string }[] = [
    { lisCode: 'CHE-GLU', hisCode: 'GLU', ediCode: 'B0010', loinc: '1558-6' },
    { lisCode: 'CHE-NA', hisCode: 'NA', ediCode: 'B0020', loinc: '2951-2' },
    { lisCode: 'CHE-K', hisCode: 'K', ediCode: 'B0011', loinc: '2823-3' },
    { lisCode: 'CHE-CL', hisCode: 'CL', ediCode: 'B0030', loinc: '2075-0' },
    { lisCode: 'CHE-CRE', hisCode: 'CRE', ediCode: 'B0040', loinc: '2160-0' },
    { lisCode: 'CHE-CA', hisCode: 'CA', ediCode: 'B0050', loinc: '17861-6' },
    { lisCode: 'IMM-CRP', hisCode: 'CRP', ediCode: 'C0100', loinc: '1988-5' },
  ];
  for (const m of edi) {
    await prisma.codeMapping.upsert({
      where: { lisCode: m.lisCode },
      update: { ediCode: m.ediCode, ...(m.hisCode ? { hisCode: m.hisCode } : {}), ...(m.loinc ? { loinc: m.loinc } : {}) },
      create: { lisCode: m.lisCode, hisCode: m.hisCode ?? null, ediCode: m.ediCode, loinc: m.loinc ?? null },
    }).catch(() => undefined);
  }

  // (5) 검사실 QC 마스터 — 추가 화학검사 QcTarget(로트 DEFAULT). ⚠서명 대기 대표 mean/SD.
  //   기존 QC 물질(QC-CH1·화학1호기) 재사용. 참고치 중앙값 근처로 설정 — Westgard/LJ 즉시 동작.
  const qc: { id: string; testCode: string; mean: number; sd: number }[] = [
    { id: 'QTF-NA', testCode: 'CHE-NA', mean: 140, sd: 1.5 },
    { id: 'QTF-CL', testCode: 'CHE-CL', mean: 102, sd: 1.5 },
    { id: 'QTF-CO2', testCode: 'CHE-CO2', mean: 25, sd: 1.0 },
    { id: 'QTF-CRE', testCode: 'CHE-CRE', mean: 1.0, sd: 0.06 },
    { id: 'QTF-BUN', testCode: 'CHE-BUN', mean: 14, sd: 0.8 },
    { id: 'QTF-CA', testCode: 'CHE-CA', mean: 9.4, sd: 0.2 },
    { id: 'QTF-CRP', testCode: 'IMM-CRP', mean: 3.0, sd: 0.3 },
  ];
  await prisma.qcTarget.createMany({
    data: qc.map((q) => ({ qcTargetId: q.id, qcCode: 'QC-CH1', instrument: '화학1호기', testCode: q.testCode, lot: 'DEFAULT', mean: q.mean, sd: q.sd })),
    skipDuplicates: true,
  });

  // (6) 조직 게이트(A-1/A-2/A-3/PACS 컷오버) — dev 플레이스홀더 seed(PENDING).
  //   ⚠ 실결재 아님 — 개시 준비도 추적용. 실결재 완료 시 status=APPROVED + 문서번호·결재일·결재자 기입.
  const gates: { gateCode: string; title: string; owner: string; scope: string; note: string }[] = [
    { gateCode: 'A-1', title: '수용·청구 정책', owner: '진료부·원무', scope: '검사 수용·청구 정책 승인', note: 'DEV 플레이스홀더 — 실결재 대기' },
    { gateCode: 'A-2', title: '프로토콜 승인 주관', owner: '진단검사의학과', scope: '검사 프로토콜·Reflex 프로토콜 승인', note: 'DEV 플레이스홀더 — 실결재 대기' },
    { gateCode: 'A-3', title: '실운영 write 스코프', owner: '보안팀', scope: 'LIS ServiceRequest.write 운영 자격 발급', note: 'DEV 플레이스홀더 — 실결재 대기(다른 방향 정리 중). 완료 시 문서번호·결재일·결재자 기입 → 운영 자격 발급 트리거' },
    { gateCode: 'PACS-CUTOVER', title: 'PACS 컷오버', owner: '영상의학·PACS', scope: '실 PID·일정 확정·cutover-preflight', note: 'DEV 플레이스홀더 — 실 PID·일정 대기' },
  ];
  for (const g of gates) {
    await prisma.orgApproval.upsert({
      where: { gateCode: g.gateCode },
      update: {}, // 기존(실결재 기입분) 보존 — 재시드가 실값을 덮지 않음
      create: { gateCode: g.gateCode, title: g.title, owner: g.owner, scope: g.scope, status: 'PENDING', docNo: null, approver: '(미결재)', note: g.note },
    }).catch(() => undefined);
  }
}
