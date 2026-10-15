/**
 * LIS 시드 데이터 (Prisma) — dev/seed.sql 시나리오 이전.
 * 홍길동 Hb 위험치 / 김철수 K 위험치 / Klebsiella / 병리 / 수혈 / BRCA 유전체
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { withSeedTracking, flushSeedArtifacts } from './seed-artifact';
import { seedSignoffPending } from './seed-signoff';
import { seedLabMenu } from './seed-lab-menu';
import { seedDemoDetail } from './seed-demo-detail';

const base = new PrismaClient();

/**
 * 시드 프로파일 — 배포 형태(사이트별 단독 설치)에 맞춘 분리.
 *
 * `site-starter` : 신규 사이트에 **반드시 필요한 것**(역할·관리자 계정·컨테이너·검사 마스터·
 *                  참고치·코드매핑·QC 목표·서명 대기값). 개시 후에도 남는다.
 * `product-demo` : 평가·교육·화면 확인용 합성 데이터(데모 계정 U01~U08·환자·오더·결과·
 *                  병리·수혈·유전체·배양). **개시 전환 시 전량 삭제 대상.**
 *
 * 실행: `SEED_PROFILE=starter|demo|all npm run seed` (기본 all — 기존 개발·파일럿 동작 보존)
 * 근거: docs/개시전환센터_기획서.md §6.2c(시드 배치 규약)
 */
type SeedProfile = 'starter' | 'demo' | 'all';

async function seedStarter(): Promise<void> {
  // 이 함수가 만드는 행은 전부 site-starter 배치로 등록된다(정리 시 보존 대상 식별).
  const prisma = withSeedTracking(base, 'site-starter');
  // 역할/사용자/권한 (dev 비밀번호: demo1234)
  await prisma.role.createMany({
    data: [
      { roleCode: 'RCP', name: '접수담당' },
      { roleCode: 'TEC', name: '검사자' },
      { roleCode: 'PHY', name: '검증의' },
      { roleCode: 'PAT', name: '병리판독의' },
      { roleCode: 'BB', name: '수혈담당' },
      { roleCode: 'MIC', name: '미생물검사자' },
      { roleCode: 'GEN', name: '유전체판독의' },
      { roleCode: 'GC', name: '유전상담사' },
      { roleCode: 'ADM', name: '관리자' },
      { roleCode: 'AUD', name: '감사자' },
    ],
    skipDuplicates: true,
  });
  // 시드 비밀번호: SEED_PASSWORD 환경변수 우선, 없으면 무작위 생성(로그 출력).
  // (운영 배포에서 약한 고정 비밀번호 재생성 방지)
  const seedPw =
    process.env.SEED_PASSWORD || randomBytes(8).toString('hex');
  const pw = await bcrypt.hash(seedPw, 10);
  if (!process.env.SEED_PASSWORD) {
    // eslint-disable-next-line no-console
    console.log(`[seed] 계정 비밀번호(무작위 생성): ${seedPw} — 안전히 보관 후 변경 권장`);
  }
  // ★관리자 1개만 starter — 나머지 직무 계정(U01~U07)은 **데모**다(개시 시 폐기 대상, 체크리스트 B1).
  //   신규 사이트에는 실 직원 계정을 만들고, 이 부트스트랩 계정은 비밀번호 변경 후 사용한다.
  await prisma.appUser.createMany({
    data: [{ userId: 'U00', name: '관리자', dept: '전산', passwordHash: pw }],
    skipDuplicates: true,
  });
  await prisma.userRole.createMany({
    data: [{ userId: 'U00', roleCode: 'ADM' }],
    skipDuplicates: true,
  });

  // 마스터: 의료진/용기
  await prisma.provider.createMany({
    data: [
      { providerId: 'D001', name: '김의사', dept: '내과', roleType: '처방의' },
      { providerId: 'D002', name: '박의사', dept: '유방외과', roleType: '처방의' },
      { providerId: 'D010', name: '정판독', dept: '병리과', roleType: '판독의' },
    ],
    skipDuplicates: true,
  });
  await prisma.container.createMany({
    data: [
      { containerCode: 'SST', name: '혈청분리관', additive: '응고촉진제', color: '금색' },
      { containerCode: 'EDTA', name: 'EDTA관', additive: 'EDTA', color: '보라색' },
      { containerCode: 'SPUTUM', name: '객담용기', color: '투명' },
      { containerCode: 'TISSUE', name: '조직용기', additive: '포르말린', color: '흰색' },
    ],
    skipDuplicates: true,
  });

  // 검사항목
  await prisma.testMaster.createMany({
    data: [
      { testCode: 'CBC-HGB', name: '혈색소', loinc: '718-7', domain: 'DIAGNOSTIC', unitUcum: 'g/dL', specimenType: 'Whole blood' },
      { testCode: 'CBC-WBC', name: '백혈구수', loinc: '6690-2', domain: 'DIAGNOSTIC', unitUcum: '10*3/uL', specimenType: 'Whole blood' },
      { testCode: 'CHE-GLU', name: '공복혈당', loinc: '1558-6', domain: 'DIAGNOSTIC', unitUcum: 'mg/dL', specimenType: 'Serum' },
      { testCode: 'CHE-K', name: '칼륨', loinc: '2823-3', domain: 'DIAGNOSTIC', unitUcum: 'mmol/L', specimenType: 'Serum' },
      { testCode: 'CHE-NA', name: '나트륨', loinc: '2951-2', domain: 'DIAGNOSTIC', unitUcum: 'mmol/L', specimenType: 'Serum' },
      { testCode: 'MIC-CUL', name: '일반세균배양', loinc: '600-7', domain: 'MICROBIOLOGY', specimenType: '각종' },
      { testCode: 'PAT-SURG', name: '외과병리(조직검사)', loinc: '33746-0', domain: 'PATHOLOGY', specimenType: '조직' },
      { testCode: 'GEN-HRD', name: '유전성유방암패널', domain: 'GENOMIC', specimenType: 'Blood' },
    ],
    skipDuplicates: true,
  });

  // 패널
  await prisma.panel.createMany({
    data: [
      { panelCode: 'CBC', name: '일반혈액검사' },
      { panelCode: 'CHEM', name: '임상화학패널' },
    ],
    skipDuplicates: true,
  });
  await prisma.panelItem.createMany({
    data: [
      { panelCode: 'CBC', testCode: 'CBC-HGB' },
      { panelCode: 'CBC', testCode: 'CBC-WBC' },
      { panelCode: 'CHEM', testCode: 'CHE-GLU' },
      { panelCode: 'CHEM', testCode: 'CHE-K' },
      { panelCode: 'CHEM', testCode: 'CHE-NA' },
    ],
    skipDuplicates: true,
  });

  // 참고치(성별/연령 분기)
  await prisma.referenceRange.createMany({
    data: [
      { rrId: 'RR01', testCode: 'CBC-HGB', sex: 'M', ageMin: 18, ageMax: 200, low: 13.0, high: 17.0, panicLow: 7.0, panicHigh: 20.0 },
      { rrId: 'RR02', testCode: 'CBC-HGB', sex: 'F', ageMin: 18, ageMax: 200, low: 12.0, high: 16.0, panicLow: 7.0, panicHigh: 20.0 },
      { rrId: 'RR03', testCode: 'CBC-WBC', sex: 'A', ageMin: 0, ageMax: 200, low: 4.0, high: 10.0, panicLow: 1.0, panicHigh: 30.0 },
      { rrId: 'RR05', testCode: 'CHE-GLU', sex: 'A', ageMin: 18, ageMax: 200, low: 70, high: 100, panicLow: 40, panicHigh: 500 },
      { rrId: 'RR06', testCode: 'CHE-K', sex: 'A', ageMin: 0, ageMax: 200, low: 3.5, high: 5.1, panicLow: 2.5, panicHigh: 6.5 },
      { rrId: 'RR07', testCode: 'CHE-NA', sex: 'A', ageMin: 0, ageMax: 200, low: 135, high: 145, panicLow: 120, panicHigh: 160 },
    ],
    skipDuplicates: true,
  });

  // 코드매핑
  await prisma.codeMapping.createMany({
    data: [
      { lisCode: 'CBC-HGB', hisCode: 'CBC', loinc: '718-7' },
      { lisCode: 'CHE-K', hisCode: 'K', loinc: '2823-3' },
      { lisCode: 'GEN-HRD', hisCode: 'HEREDNGS' },
    ],
    skipDuplicates: true,
  });

  // ── 마스터: HIS 폴링 코드매핑 · QC 목표치 ──
  //   ★starter에 속한다 — 데모가 아니라 사이트 운영에 필요한 기준정보이고,
  //     seedSignoffPending이 QC 목표를 참조하므로 그보다 앞서야 한다(FK).
  // ── HIS 오더 폴링용 코드매핑 (HIS procedure 코드 → LIS) ──
  await prisma.testMaster.createMany({
    data: [
      { testCode: 'IMM-CRP', name: 'CRP', loinc: '1988-5', domain: 'DIAGNOSTIC', unitUcum: 'mg/L' },
      { testCode: 'CHE-CL', name: '염소', loinc: '2075-0', domain: 'DIAGNOSTIC', unitUcum: 'mmol/L' },
      { testCode: 'IMM-TSH', name: 'TSH', loinc: '3016-3', domain: 'DIAGNOSTIC', unitUcum: 'mIU/L' },
      { testCode: 'COA-PT', name: 'PT', loinc: '5902-2', domain: 'DIAGNOSTIC', unitUcum: 's' },
      { testCode: 'COA-APTT', name: 'aPTT', loinc: '3173-2', domain: 'DIAGNOSTIC', unitUcum: 's' },
      { testCode: 'CHE-HBA1C', name: 'HbA1c', loinc: '4548-4', domain: 'DIAGNOSTIC', unitUcum: '%' },
      { testCode: 'UA-PROT', name: '요단백', loinc: '2888-6', domain: 'DIAGNOSTIC' },
      { testCode: 'MIC-BC', name: '혈액배양', loinc: '600-7', domain: 'MICROBIOLOGY' },
      // 갑상선 반사검사(TSH→Free T4) add-on 대상 — Reflex 발신 LOINC 정합
      { testCode: 'CHE-TSH', name: '갑상선자극호르몬(TSH)', loinc: '3016-3', domain: 'DIAGNOSTIC', unitUcum: 'mIU/L', specimenType: 'Serum' },
      { testCode: 'CHE-FT4', name: '유리티록신(Free T4)', loinc: '3024-7', domain: 'DIAGNOSTIC', unitUcum: 'ng/dL', specimenType: 'Serum' },
    ],
    skipDuplicates: true,
  });
  // 패널(HIS 패널코드 = 패널코드): E6512 전해질, E6532 PT/aPTT
  await prisma.panel.createMany({
    data: [
      { panelCode: 'E6512', name: '전해질검사(Na/K/Cl)' },
      { panelCode: 'E6532', name: 'PT/aPTT(혈액응고)' },
    ],
    skipDuplicates: true,
  });
  await prisma.panelItem.createMany({
    data: [
      { panelCode: 'E6512', testCode: 'CHE-NA' },
      { panelCode: 'E6512', testCode: 'CHE-K' },
      { panelCode: 'E6512', testCode: 'CHE-CL' },
      { panelCode: 'E6532', testCode: 'COA-PT' },
      { panelCode: 'E6532', testCode: 'COA-APTT' },
    ],
    skipDuplicates: true,
  });
  // 단일 검사 코드매핑(HIS→LIS)
  await prisma.codeMapping.createMany({
    data: [
      { lisCode: 'IMM-CRP', hisCode: 'E6502', loinc: '1988-5' },
      { lisCode: 'IMM-TSH', hisCode: 'E6522', loinc: '3016-3' },
      { lisCode: 'CHE-HBA1C', hisCode: 'E6591', loinc: '4548-4' },
      { lisCode: 'UA-PROT', hisCode: 'E6601', loinc: '2888-6' },
      { lisCode: 'MIC-BC', hisCode: 'E6701', loinc: '600-7' },
      // 갑상선 반사검사 add-on: LOINC만(트리거/add-on이라 인바운드 hisCode 불필요 — E6522는 IMM-TSH 소유, 충돌 회피)
      { lisCode: 'CHE-TSH', loinc: '3016-3' },
      { lisCode: 'CHE-FT4', loinc: '3024-7' },
    ],
    skipDuplicates: true,
  });
  // 참고치(수치 자동평가용)
  await prisma.referenceRange.createMany({
    data: [
      { rrId: 'RR-CL', testCode: 'CHE-CL', sex: 'A', ageMin: 0, ageMax: 200, low: 98, high: 107, panicLow: 80, panicHigh: 120 },
      { rrId: 'RR-CRP', testCode: 'IMM-CRP', sex: 'A', ageMin: 0, ageMax: 200, low: 0, high: 5, panicHigh: 100 },
      { rrId: 'RR-TSH', testCode: 'IMM-TSH', sex: 'A', ageMin: 0, ageMax: 200, low: 0.4, high: 4.0 },
      { rrId: 'RR-A1C', testCode: 'CHE-HBA1C', sex: 'A', ageMin: 0, ageMax: 200, low: 4, high: 6, panicHigh: 15 },
      { rrId: 'RR-TSH2', testCode: 'CHE-TSH', sex: 'A', ageMin: 0, ageMax: 200, low: 0.4, high: 4.0, panicLow: 0.01, panicHigh: 100 },
      { rrId: 'RR-FT4', testCode: 'CHE-FT4', sex: 'A', ageMin: 0, ageMax: 200, low: 0.8, high: 1.8, panicLow: 0.1, panicHigh: 10 },
    ],
    skipDuplicates: true,
  });

  // ── QC 데모(목표치) ──
  await prisma.qcMaterial.createMany({
    data: [{ qcCode: 'QC-CH1', name: '화학 QC Level1', lot: 'LOT-A1', expiry: '2026-12-31' }],
    skipDuplicates: true,
  });
  await prisma.qcTarget.createMany({
    data: [
      { qcTargetId: 'QT-GLU', qcCode: 'QC-CH1', instrument: '화학1호기', testCode: 'CHE-GLU', mean: 100, sd: 2 },
      { qcTargetId: 'QT-K', qcCode: 'QC-CH1', instrument: '화학1호기', testCode: 'CHE-K', mean: 4.2, sd: 0.15 },
    ],
    skipDuplicates: true,
  });


  // 검사실·법무 서명 대기값 + 검사실 전 메뉴(dev seed — 서명 전 실값 교체 대상)
  await seedSignoffPending(prisma);
  await seedLabMenu(prisma);

  // eslint-disable-next-line no-console
  await flushSeedArtifacts(prisma);
  console.log('[seed:starter] 역할·관리자·마스터(검사·참고치·코드매핑·QC)·서명 대기값 반영');
}

async function seedDemo(): Promise<void> {
  // 이 함수가 만드는 행은 전부 product-demo 배치로 등록된다(개시 전환 시 선택 삭제 대상).
  const prisma = withSeedTracking(base, 'product-demo');
  // 데모 직무 계정 — starter가 아니라 여기서 만든다(개시 전환 시 폐기 대상).
  const demoPw = await bcrypt.hash(
    process.env.SEED_PASSWORD || randomBytes(8).toString('hex'),
    10,
  );
  await prisma.appUser.createMany({
    data: [
      { userId: 'U01', name: '이검사', dept: '진단검사의학과', passwordHash: demoPw },
      { userId: 'U02', name: '최검증', dept: '진단검사의학과', passwordHash: demoPw },
      { userId: 'U03', name: '한미생', dept: '진단검사의학과', passwordHash: demoPw },
      { userId: 'U04', name: '정판독', dept: '병리과', passwordHash: demoPw },
      { userId: 'U06', name: '유전판독', dept: '진단검사의학과', passwordHash: demoPw },
      { userId: 'U07', name: '조접수', dept: '진단검사의학과', passwordHash: demoPw },
    ],
    skipDuplicates: true,
  });
  await prisma.userRole.createMany({
    data: [
      { userId: 'U01', roleCode: 'TEC' }, { userId: 'U02', roleCode: 'PHY' },
      { userId: 'U03', roleCode: 'MIC' }, { userId: 'U04', roleCode: 'PAT' },
      { userId: 'U06', roleCode: 'GEN' }, { userId: 'U07', roleCode: 'RCP' },
    ],
    skipDuplicates: true,
  });

  // 환자
  await prisma.patient.createMany({
    data: [
      { patientId: '1234567', name: '홍길동', sex: 'M', birthDate: '1980-01-01' },
      { patientId: '2345678', name: '김철수', sex: 'M', birthDate: '1972-05-03' },
      { patientId: '4567890', name: '박지은', sex: 'F', birthDate: '1979-07-15' },
      { patientId: '5678901', name: '정민호', sex: 'M', birthDate: '1965-03-09' },
    ],
    skipDuplicates: true,
  });
  await prisma.visit.createMany({
    data: [
      { visitId: 'V001', patientId: '1234567', type: 'O', dept: '내과', attending: 'D001' },
      { visitId: 'V002', patientId: '2345678', type: 'E', dept: '응급실', attending: 'D001' },
      { visitId: 'V004', patientId: '4567890', type: 'O', dept: '유방외과', attending: 'D002' },
      { visitId: 'V005', patientId: '5678901', type: 'I', dept: '외과', ward: '5W', attending: 'D001' },
    ],
    skipDuplicates: true,
  });

  // 오더/항목/검체 — 홍길동 CBC, 김철수 CHEM
  await prisma.labOrder.createMany({
    data: [
      { orderId: 'O-0001', hisOrderNo: 'H..00123', patientId: '1234567', visitId: 'V001', orderingProvider: 'D001', orderDt: new Date('2026-07-12T09:15:00+09:00'), priority: 'R', status: 'COMPLETED' },
      { orderId: 'O-0002', hisOrderNo: 'H..00201', patientId: '2345678', visitId: 'V002', orderingProvider: 'D001', orderDt: new Date('2026-07-12T09:20:00+09:00'), priority: 'S', status: 'COMPLETED' },
    ],
    skipDuplicates: true,
  });
  await prisma.orderItem.createMany({
    data: [
      { orderItemId: 'OI-0001', orderId: 'O-0001', testCode: 'CBC-HGB', status: 'COMPLETED' },
      { orderItemId: 'OI-0002', orderId: 'O-0001', testCode: 'CBC-WBC', status: 'COMPLETED' },
      { orderItemId: 'OI-0004', orderId: 'O-0002', testCode: 'CHE-GLU', status: 'COMPLETED' },
      { orderItemId: 'OI-0005', orderId: 'O-0002', testCode: 'CHE-K', status: 'COMPLETED' },
    ],
    skipDuplicates: true,
  });
  await prisma.specimen.createMany({
    data: [
      { specimenNo: 'S-0088', orderId: 'O-0001', containerCode: 'EDTA', specimenType: 'Whole blood', receivedDt: new Date('2026-07-12T09:15:00+09:00'), status: 'COMPLETED' },
      { specimenNo: 'S-0090', orderId: 'O-0002', containerCode: 'SST', specimenType: 'Serum', receivedDt: new Date('2026-07-12T09:22:00+09:00'), status: 'COMPLETED' },
    ],
    skipDuplicates: true,
  });

  // 수혈: 정민호 제제/교차/출고
  await prisma.bloodUnit.createMany({
    data: [
      { unitNo: 'W1234567890123', productType: 'RBC', bloodGroup: 'A+', drawnDate: '2026-07-01', expiryDate: '2026-08-05', status: 'IN_STOCK' },
    ],
    skipDuplicates: true,
  });
  await prisma.crossmatch.createMany({
    data: [
      { xmId: 'XM-01', patientId: '5678901', unitNo: 'W1234567890123', method: '생리식염수법', result: '적합' },
    ],
    skipDuplicates: true,
  });

  // 유전체: 박지은 오더/동의/변이/해석
  await prisma.labOrder.upsert({
    where: { orderId: 'O-0005' },
    update: {},
    create: { orderId: 'O-0005', hisOrderNo: 'H..00401', patientId: '4567890', visitId: 'V004', orderingProvider: 'D002', orderDt: new Date('2026-07-15T10:00:00+09:00'), status: 'IN_PROCESS' },
  });
  await prisma.orderItem.createMany({
    data: [{ orderItemId: 'OI-0009', orderId: 'O-0005', testCode: 'GEN-HRD', status: 'IN_PROCESS', sendoutFlag: true }],
    skipDuplicates: true,
  });
  await prisma.genomicOrder.upsert({
    where: { orderId: 'O-0005' },
    update: {},
    create: { genomicOrderId: 'G-0045', orderId: 'O-0005', panelCode: 'GEN-HRD', testType: 'GERMLINE', sendoutCenter: '○○유전체수탁', tatTarget: '2주', status: '해석중' },
  });
  await prisma.consent.createMany({
    data: [{ consentId: 'CONS-01', genomicOrderId: 'G-0045', consentType: '생식세포검사', secondaryFindingsOptin: false, signedDate: '2026-07-15', withdrawn: false }],
    skipDuplicates: true,
  });
  await prisma.variant.createMany({
    data: [
      { variantId: 'VAR-01', genomicOrderId: 'G-0045', gene: 'BRCA1', hgvsC: 'c.68_69delAG', hgvsP: 'p.Glu23fs', vaf: 45.0, zygosity: 'Heterozygous' },
      { variantId: 'VAR-02', genomicOrderId: 'G-0045', gene: 'BRCA2', hgvsC: 'c.1234A>G', hgvsP: 'p.Ile412Val', vaf: 48.0, zygosity: 'Heterozygous' },
    ],
    skipDuplicates: true,
  });
  await prisma.interpretation.createMany({
    data: [
      { interpId: 'INT-01', variantId: 'VAR-01', classification: 'Pathogenic', evidence: 'PVS1,PM2', classifiedDate: '2026-07-20', status: '확정' },
      { interpId: 'INT-02', variantId: 'VAR-02', classification: 'VUS', evidence: 'PP3', classifiedDate: '2026-07-20', status: '검토중' },
    ],
    skipDuplicates: true,
  });

  // ── 미생물 데모(배양) ──
  await prisma.labOrder.upsert({
    where: { orderId: 'O-MIC1' }, update: {},
    create: { orderId: 'O-MIC1', hisOrderNo: 'H..MIC1', patientId: '2345678', orderDt: new Date(), status: 'IN_PROCESS' },
  });
  await prisma.orderItem.createMany({
    data: [{ orderItemId: 'OI-MIC1', orderId: 'O-MIC1', testCode: 'MIC-CUL', status: 'IN_PROCESS' }],
    skipDuplicates: true,
  });
  await prisma.specimen.upsert({
    where: { specimenNo: 'S-MIC1' }, update: {},
    create: { specimenNo: 'S-MIC1', orderId: 'O-MIC1', specimenType: '객담', status: 'IN_PROCESS' },
  });
  await prisma.culture.upsert({
    where: { cultureId: 'CUL-DEMO' }, update: {},
    create: { cultureId: 'CUL-DEMO', specimenNo: 'S-MIC1', medium: '혈액한천', stage: '배양', status: 'IN_PROCESS' },
  });

  // 병리 (뷰어 링크·MWL 데모)
  await prisma.pathologyCase.upsert({
    where: { spNo: 'SP-2026-0456' },
    update: {},
    create: { spNo: 'SP-2026-0456', patientId: '1234567', specimenSite: '위 (내시경 생검)', receivedDate: '2026-07-11', status: '판독대기' },
  });
  await prisma.pathologyReport.upsert({
    where: { spNo: 'SP-2026-0456' },
    update: {},
    create: {
      spNo: 'SP-2026-0456', findings: '위 점막의 만성 염증, 장상피화생 동반.',
      diagnosis: '만성 위염', snomed: '233604007', status: '최종',
      signer: 'D010', accessionNo: 'ACC-SP-26-0456',
    },
  });

  await seedDemoDetail(prisma); // 디테일 데모 데이터(합성) — 각 화면 채움

  // eslint-disable-next-line no-console
  await flushSeedArtifacts(prisma);
  console.log('[seed:demo] 데모 계정 6 · 환자 4 · 오더 3 · 검체 2 · 유전체 변이 2 · 병리 1 · 배양 반영');
}

async function main(): Promise<void> {
  const profile = (process.env.SEED_PROFILE ?? 'all') as SeedProfile;
  if (!['starter', 'demo', 'all'].includes(profile)) {
    throw new Error(`SEED_PROFILE은 starter|demo|all 중 하나여야 합니다: ${profile}`);
  }
  // eslint-disable-next-line no-console
  console.log(`[seed] profile=${profile}`);
  if (profile === 'starter' || profile === 'all') await seedStarter();
  if (profile === 'demo' || profile === 'all') await seedDemo();
  // eslint-disable-next-line no-console
  console.log(`[seed] 완료(profile=${profile})`);
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  })
  .finally(() => base.$disconnect());
