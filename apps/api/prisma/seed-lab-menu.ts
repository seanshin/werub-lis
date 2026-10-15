/**
 * seed-lab-menu.ts — prisma 모듈 구성요소.
 *
 * 제공: seedLabMenu.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { PrismaClient } from '@prisma/client';

/**
 * 검사실 전 항목 대표 메뉴 dev seed(검사실→LIS→HIS 흐름 — 검사실 도메인은 LIS seed로 자족).
 * ⚠ **대표값(서명 대기)** — 검사항목·참고치·검사별 설정·EDI 수가코드·QC 타깃·패널을 실 검사실 관례로
 *   최종 서명 후 교체. 개발/파일럿이 실 lab 메뉴 없이 막히지 않도록 채운다(멱등 — skipDuplicates/upsert).
 * 참고치는 이 함수가 소유(testCode별 delete-then-create) — 중복·구 오류값 방지.
 */
export async function seedLabMenu(prisma: PrismaClient): Promise<void> {
  const D = 'DIAGNOSTIC';
  // ── 검사항목 마스터(진단검사의학 전 메뉴 + 타 도메인 대표) ──
  await prisma.testMaster.createMany({
    data: [
      // 혈액(CBC) — Whole blood
      { testCode: 'CBC-RBC', name: '적혈구수', loinc: '789-8', domain: D, unitUcum: '10*6/uL', specimenType: 'Whole blood' },
      { testCode: 'CBC-HCT', name: '헤마토크릿', loinc: '4544-3', domain: D, unitUcum: '%', specimenType: 'Whole blood' },
      { testCode: 'CBC-PLT', name: '혈소판수', loinc: '777-3', domain: D, unitUcum: '10*3/uL', specimenType: 'Whole blood' },
      { testCode: 'CBC-MCV', name: '평균적혈구용적', loinc: '787-2', domain: D, unitUcum: 'fL', specimenType: 'Whole blood' },
      // 화학 — Serum
      { testCode: 'CHE-TP', name: '총단백', loinc: '2885-2', domain: D, unitUcum: 'g/dL', specimenType: 'Serum' },
      { testCode: 'CHE-AST', name: 'AST(GOT)', loinc: '1920-8', domain: D, unitUcum: 'U/L', specimenType: 'Serum' },
      { testCode: 'CHE-ALT', name: 'ALT(GPT)', loinc: '1742-6', domain: D, unitUcum: 'U/L', specimenType: 'Serum' },
      { testCode: 'CHE-ALP', name: 'ALP', loinc: '6768-6', domain: D, unitUcum: 'U/L', specimenType: 'Serum' },
      { testCode: 'CHE-GGT', name: 'GGT', loinc: '2324-2', domain: D, unitUcum: 'U/L', specimenType: 'Serum' },
      { testCode: 'CHE-TBIL', name: '총빌리루빈', loinc: '1975-2', domain: D, unitUcum: 'mg/dL', specimenType: 'Serum' },
      { testCode: 'CHE-UA', name: '요산', loinc: '3084-1', domain: D, unitUcum: 'mg/dL', specimenType: 'Serum' },
      { testCode: 'CHE-CHOL', name: '총콜레스테롤', loinc: '2093-3', domain: D, unitUcum: 'mg/dL', specimenType: 'Serum' },
      { testCode: 'CHE-HDL', name: 'HDL 콜레스테롤', loinc: '2085-9', domain: D, unitUcum: 'mg/dL', specimenType: 'Serum' },
      { testCode: 'CHE-TG', name: '중성지방', loinc: '2571-8', domain: D, unitUcum: 'mg/dL', specimenType: 'Serum' },
      { testCode: 'CHE-LDLC', name: 'LDL 콜레스테롤(계산)', loinc: '13457-7', domain: D, unitUcum: 'mg/dL', specimenType: 'Serum' },
      { testCode: 'CHE-PHOS', name: '인(Phosphorus)', loinc: '2777-1', domain: D, unitUcum: 'mg/dL', specimenType: 'Serum' },
      { testCode: 'CHE-MG', name: '마그네슘', loinc: '19123-9', domain: D, unitUcum: 'mg/dL', specimenType: 'Serum' },
      { testCode: 'CHE-HBA1C', name: '당화혈색소(HbA1c)', loinc: '4548-4', domain: D, unitUcum: '%', specimenType: 'Whole blood' },
      // HIS 실오더 유래(2026-07-22, D3030002Z) — 참고치 대표값·검사실 서명 대상. LOINC은 서명 시 확정.
      { testCode: 'CHE-15AG', name: '1,5-Anhydroglucitol(1,5-AG)', domain: D, unitUcum: 'ug/mL', specimenType: 'Serum' },
      // 내분비/면역
      { testCode: 'END-TSH', name: 'TSH', loinc: '3016-3', domain: D, unitUcum: 'uIU/mL', specimenType: 'Serum' },
      { testCode: 'END-FT4', name: 'Free T4', loinc: '3024-7', domain: D, unitUcum: 'ng/dL', specimenType: 'Serum' },
      // 응고 — Plasma
      { testCode: 'COA-PT', name: 'PT(INR)', loinc: '6301-6', domain: D, unitUcum: '{INR}', specimenType: 'Plasma' },
      { testCode: 'COA-APTT', name: 'aPTT', loinc: '3173-2', domain: D, unitUcum: 's', specimenType: 'Plasma' },
      // 미생물 대표
      { testCode: 'MIC-BLD', name: '혈액배양', loinc: '600-7', domain: 'MICROBIOLOGY', specimenType: 'Blood' },
      { testCode: 'MIC-AFB', name: '항산균 도말', loinc: '11545-1', domain: 'MICROBIOLOGY', specimenType: 'Sputum' },
      // 병리 대표
      { testCode: 'PAT-CYTO', name: '세포병리검사', loinc: '47527-7', domain: 'PATHOLOGY', specimenType: '체액/도말' },
      { testCode: 'PAT-FROZEN', name: '동결절편검사', loinc: '33723-9', domain: 'PATHOLOGY', specimenType: '조직' },
      // 수혈 대표
      { testCode: 'TRF-ABO', name: 'ABO/RhD 혈액형', loinc: '883-9', domain: 'TRANSFUSION', specimenType: 'Whole blood' },
      { testCode: 'TRF-AB', name: '비예기항체 선별', loinc: '890-4', domain: 'TRANSFUSION', specimenType: 'Serum' },
      // 유전체 대표
      { testCode: 'GEN-SOMATIC', name: '고형암 NGS 패널', domain: 'GENOMIC', specimenType: 'Tissue' },
    ],
    skipDuplicates: true,
  });

  // ── 참고치(성별/연령) — 이 함수 소유 testCode는 정리 후 생성(멱등·중복방지) ──
  type RR = { rrId: string; testCode: string; sex: string; ageMin: number; ageMax: number; low?: number; high?: number; panicLow?: number; panicHigh?: number };
  const ranges: RR[] = [
    { rrId: 'RRL-RBC-M', testCode: 'CBC-RBC', sex: 'M', ageMin: 18, ageMax: 200, low: 4.5, high: 5.9 },
    { rrId: 'RRL-RBC-F', testCode: 'CBC-RBC', sex: 'F', ageMin: 18, ageMax: 200, low: 4.0, high: 5.2 },
    { rrId: 'RRL-HCT-M', testCode: 'CBC-HCT', sex: 'M', ageMin: 18, ageMax: 200, low: 40, high: 52, panicLow: 20, panicHigh: 60 },
    { rrId: 'RRL-HCT-F', testCode: 'CBC-HCT', sex: 'F', ageMin: 18, ageMax: 200, low: 36, high: 48, panicLow: 20, panicHigh: 60 },
    { rrId: 'RRL-PLT', testCode: 'CBC-PLT', sex: 'A', ageMin: 0, ageMax: 200, low: 150, high: 400, panicLow: 20, panicHigh: 1000 },
    { rrId: 'RRL-MCV', testCode: 'CBC-MCV', sex: 'A', ageMin: 0, ageMax: 200, low: 80, high: 100 },
    { rrId: 'RRL-TP', testCode: 'CHE-TP', sex: 'A', ageMin: 0, ageMax: 200, low: 6.4, high: 8.3 },
    { rrId: 'RRL-AST', testCode: 'CHE-AST', sex: 'A', ageMin: 0, ageMax: 200, low: 0, high: 40, panicHigh: 1000 },
    { rrId: 'RRL-ALT', testCode: 'CHE-ALT', sex: 'A', ageMin: 0, ageMax: 200, low: 0, high: 41, panicHigh: 1000 },
    { rrId: 'RRL-ALP', testCode: 'CHE-ALP', sex: 'A', ageMin: 0, ageMax: 200, low: 40, high: 129 },
    { rrId: 'RRL-GGT-M', testCode: 'CHE-GGT', sex: 'M', ageMin: 0, ageMax: 200, low: 8, high: 61 },
    { rrId: 'RRL-GGT-F', testCode: 'CHE-GGT', sex: 'F', ageMin: 0, ageMax: 200, low: 5, high: 36 },
    { rrId: 'RRL-TBIL', testCode: 'CHE-TBIL', sex: 'A', ageMin: 0, ageMax: 200, low: 0.2, high: 1.2, panicHigh: 15 },
    { rrId: 'RRL-UA-M', testCode: 'CHE-UA', sex: 'M', ageMin: 0, ageMax: 200, low: 3.4, high: 7.0 },
    { rrId: 'RRL-UA-F', testCode: 'CHE-UA', sex: 'F', ageMin: 0, ageMax: 200, low: 2.4, high: 6.0 },
    { rrId: 'RRL-CHOL', testCode: 'CHE-CHOL', sex: 'A', ageMin: 0, ageMax: 200, low: 0, high: 200 },
    { rrId: 'RRL-HDL', testCode: 'CHE-HDL', sex: 'A', ageMin: 0, ageMax: 200, low: 40, high: 100 },
    { rrId: 'RRL-TG', testCode: 'CHE-TG', sex: 'A', ageMin: 0, ageMax: 200, low: 0, high: 150 },
    { rrId: 'RRL-LDL', testCode: 'CHE-LDLC', sex: 'A', ageMin: 0, ageMax: 200, low: 0, high: 130 },
    { rrId: 'RRL-PHOS', testCode: 'CHE-PHOS', sex: 'A', ageMin: 0, ageMax: 200, low: 2.5, high: 4.5 },
    { rrId: 'RRL-MG', testCode: 'CHE-MG', sex: 'A', ageMin: 0, ageMax: 200, low: 1.7, high: 2.2 },
    { rrId: 'RRL-HBA1C', testCode: 'CHE-HBA1C', sex: 'A', ageMin: 0, ageMax: 200, low: 4.0, high: 5.6 },
    { rrId: 'RRL-15AG-M', testCode: 'CHE-15AG', sex: 'M', ageMin: 0, ageMax: 200, low: 10.7, high: 32.0 },
    { rrId: 'RRL-15AG-F', testCode: 'CHE-15AG', sex: 'F', ageMin: 0, ageMax: 200, low: 6.8, high: 29.3 },
    { rrId: 'RRL-TSH', testCode: 'END-TSH', sex: 'A', ageMin: 0, ageMax: 200, low: 0.4, high: 4.0 },
    { rrId: 'RRL-FT4', testCode: 'END-FT4', sex: 'A', ageMin: 0, ageMax: 200, low: 0.8, high: 1.8 },
    { rrId: 'RRL-PT', testCode: 'COA-PT', sex: 'A', ageMin: 0, ageMax: 200, low: 0.8, high: 1.2, panicHigh: 5 },
    { rrId: 'RRL-APTT', testCode: 'COA-APTT', sex: 'A', ageMin: 0, ageMax: 200, low: 25, high: 35, panicHigh: 150 },
  ];
  const rangeTests = [...new Set(ranges.map((r) => r.testCode))];
  await prisma.referenceRange.deleteMany({ where: { testCode: { in: rangeTests } } });
  await prisma.referenceRange.createMany({ data: ranges, skipDuplicates: true });

  // ── 검사별 자동검증·델타 설정(B5) — 대표값 ──
  const cfg: { testCode: string; deltaPctLimit?: number; deltaAbsLimit?: number; deltaWindowDays?: number }[] = [
    { testCode: 'CBC-HGB', deltaAbsLimit: 2.0, deltaWindowDays: 7 },
    { testCode: 'CBC-PLT', deltaPctLimit: 50, deltaWindowDays: 7 },
    { testCode: 'CHE-AST', deltaPctLimit: 100, deltaWindowDays: 3 },
    { testCode: 'CHE-ALT', deltaPctLimit: 100, deltaWindowDays: 3 },
    { testCode: 'CHE-TBIL', deltaPctLimit: 50, deltaWindowDays: 3 },
    { testCode: 'CHE-CHOL', deltaPctLimit: 30, deltaWindowDays: 30 },
    { testCode: 'CHE-HBA1C', deltaAbsLimit: 1.0, deltaWindowDays: 60 },
    { testCode: 'END-TSH', deltaPctLimit: 50, deltaWindowDays: 30 },
  ];
  for (const c of cfg) {
    await prisma.testMaster.update({
      where: { testCode: c.testCode },
      data: { autoVerify: true, deltaPctLimit: c.deltaPctLimit ?? null, deltaAbsLimit: c.deltaAbsLimit ?? null, deltaWindowDays: c.deltaWindowDays ?? null },
    }).catch(() => undefined);
  }

  // ── 패널 ──
  await prisma.panel.createMany({
    data: [
      { panelCode: 'LFT', name: '간기능검사' },
      { panelCode: 'LIPID', name: '지질검사' },
      { panelCode: 'ELECTRO', name: '전해질' },
      { panelCode: 'THYROID', name: '갑상선기능' },
      { panelCode: 'RENAL', name: '신장기능' },
      { panelCode: 'COAG', name: '응고검사' },
    ],
    skipDuplicates: true,
  });
  await prisma.panelItem.createMany({
    data: [
      ...['CHE-AST', 'CHE-ALT', 'CHE-ALP', 'CHE-GGT', 'CHE-TBIL', 'CHE-TP', 'CHE-ALB'].map((t) => ({ panelCode: 'LFT', testCode: t })),
      ...['CHE-CHOL', 'CHE-HDL', 'CHE-TG', 'CHE-LDLC'].map((t) => ({ panelCode: 'LIPID', testCode: t })),
      ...['CHE-NA', 'CHE-K', 'CHE-CL', 'CHE-CO2'].map((t) => ({ panelCode: 'ELECTRO', testCode: t })),
      ...['END-TSH', 'END-FT4'].map((t) => ({ panelCode: 'THYROID', testCode: t })),
      ...['CHE-BUN', 'CHE-CRE', 'CHE-UA'].map((t) => ({ panelCode: 'RENAL', testCode: t })),
      ...['COA-PT', 'COA-APTT'].map((t) => ({ panelCode: 'COAG', testCode: t })),
    ],
    skipDuplicates: true,
  });

  // ── EDI 수가코드(청구 파운데이션 D3) — 대표값 ──
  const edi: { lisCode: string; hisCode: string; ediCode: string; loinc?: string }[] = [
    { lisCode: 'CBC-HGB', hisCode: 'HGB', ediCode: 'A0010', loinc: '718-7' },
    { lisCode: 'CBC-WBC', hisCode: 'WBC', ediCode: 'A0011', loinc: '6690-2' },
    { lisCode: 'CBC-PLT', hisCode: 'PLT', ediCode: 'A0012', loinc: '777-3' },
    { lisCode: 'CHE-AST', hisCode: 'AST', ediCode: 'B0100', loinc: '1920-8' },
    { lisCode: 'CHE-ALT', hisCode: 'ALT', ediCode: 'B0101', loinc: '1742-6' },
    { lisCode: 'CHE-TBIL', hisCode: 'TBIL', ediCode: 'B0102' },
    { lisCode: 'CHE-CHOL', hisCode: 'CHOL', ediCode: 'B0200', loinc: '2093-3' },
    { lisCode: 'CHE-TG', hisCode: 'TG', ediCode: 'B0201', loinc: '2571-8' },
    { lisCode: 'CHE-HBA1C', hisCode: 'HBA1C', ediCode: 'B0300', loinc: '4548-4' },
    // D3030002Z = HIRA EDI 측정법 세분 변형(HIS 회신 2026-07-22) — his/edi 동일 코드
    { lisCode: 'CHE-15AG', hisCode: 'D3030002Z', ediCode: 'D3030002Z' },
    { lisCode: 'END-TSH', hisCode: 'TSH', ediCode: 'D0100', loinc: '3016-3' },
    { lisCode: 'END-FT4', hisCode: 'FT4', ediCode: 'D0101', loinc: '3024-7' },
    { lisCode: 'COA-PT', hisCode: 'PT', ediCode: 'E0100' },
    { lisCode: 'COA-APTT', hisCode: 'APTT', ediCode: 'E0101' },
  ];
  for (const m of edi) {
    await prisma.codeMapping.upsert({
      where: { lisCode: m.lisCode },
      update: { ediCode: m.ediCode, hisCode: m.hisCode, ...(m.loinc ? { loinc: m.loinc } : {}) },
      create: { lisCode: m.lisCode, hisCode: m.hisCode, ediCode: m.ediCode, loinc: m.loinc ?? null },
    }).catch(() => undefined);
  }

  // ── QC 타깃(화학1호기·QC-CH1, 로트 DEFAULT) — 참고치 중앙값 근처 대표값 ──
  const qc: { id: string; testCode: string; mean: number; sd: number }[] = [
    { id: 'QTL-TP', testCode: 'CHE-TP', mean: 7.2, sd: 0.15 },
    { id: 'QTL-AST', testCode: 'CHE-AST', mean: 25, sd: 2 },
    { id: 'QTL-ALT', testCode: 'CHE-ALT', mean: 25, sd: 2 },
    { id: 'QTL-ALP', testCode: 'CHE-ALP', mean: 80, sd: 4 },
    { id: 'QTL-TBIL', testCode: 'CHE-TBIL', mean: 0.7, sd: 0.05 },
    { id: 'QTL-CHOL', testCode: 'CHE-CHOL', mean: 180, sd: 5 },
    { id: 'QTL-HDL', testCode: 'CHE-HDL', mean: 55, sd: 3 },
    { id: 'QTL-TG', testCode: 'CHE-TG', mean: 120, sd: 6 },
    { id: 'QTL-UA', testCode: 'CHE-UA', mean: 5.0, sd: 0.25 },
    { id: 'QTL-HBA1C', testCode: 'CHE-HBA1C', mean: 5.4, sd: 0.15 },
    { id: 'QTL-TSH', testCode: 'END-TSH', mean: 2.0, sd: 0.15 },
    { id: 'QTL-FT4', testCode: 'END-FT4', mean: 1.2, sd: 0.06 },
  ];
  await prisma.qcTarget.createMany({
    data: qc.map((q) => ({ qcTargetId: q.id, qcCode: 'QC-CH1', instrument: '화학1호기', testCode: q.testCode, lot: 'DEFAULT', mean: q.mean, sd: q.sd })),
    skipDuplicates: true,
  });
}
