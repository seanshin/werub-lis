/**
 * setup.ts — test 모듈 구성요소.
 *
 * 제공: TEST_PW, createTestApp, seedTestData.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import * as bcrypt from 'bcrypt';
import { AppModule } from '../src/app.module';
import { requestIdMiddleware } from '../src/common/request-id';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';

export const TEST_PW = 'e2e-only-Pw-2026'; // 공개판: 테스트 전용 값(테스트가 직접 해시해 계정을 만든다)

/** E2E용 Nest 앱 부트스트랩. rate limit은 별도 검증 대상이라 e2e에선 비활성화. */
export async function createTestApp(): Promise<{ app: INestApplication; prisma: PrismaService }> {
  process.env.THROTTLER_DISABLED = 'true'; // E2E: 로그인 rate limit 비활성화(계정잠금·비번변경 테스트)
  process.env.JWT_SECRET ??= 'e2e-test-secret-min-32-chars-padding-000'; // fail-fast 시크릿 정책 충족
  // ERP 청구는 '미구성' 경로(PENDING·skip)를 검증한다 — 스모크 스크립트가 .env에 남긴 값이 --env-file로
  // 새어들면 실제 전송(SENT)돼 테스트가 깨진다. 미구성 전제를 결정적으로 고정.
  delete process.env.ERP_BILLING_URL;
  delete process.env.ERP_BILLING_SECRET;
  // 위험치/운영 웹훅·HIS 통합 키도 동일 — 운영 .env에 실 채널이 들어가는 순간
  // 테스트가 실 온콜 채널·실 HIS로 발신하게 된다(2026-07-30 보안 검토 HIGH).
  // 셸(e2e-server.sh)에서도 unset하지만, 로컬 실행·다른 진입점 대비 이중 방어.
  delete process.env.CRITICAL_WEBHOOK_URL;
  delete process.env.CRITICAL_WEBHOOK_SECRET;
  delete process.env.CRITICAL_WEBHOOK_ALLOW_HTTP;
  delete process.env.OPS_WEBHOOK_URL;
  delete process.env.HIS_INTEGRATION_BASE;
  delete process.env.HIS_INTEGRATION_KEY;
  delete process.env.HIS_TARGET_TOKEN_SECRET;
  delete process.env.HIS_REFLEX_WEBHOOK_TOKEN;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideGuard(ThrottlerGuard)
    .useValue({ canActivate: () => true })
    .compile();
  const app = moduleRef.createNestApplication();
  app.use(requestIdMiddleware); // main.ts와 동일 배선 — correlation id 회귀를 E2E가 커버
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  const prisma = app.get(PrismaService);
  return { app, prisma };
}

/**
 * 최소 시드 — 마스터(검사·참고치·역할·사용자) + 데모(환자·오더·검체).
 * 멱등(upsert/skipDuplicates)이라 반복 실행 안전.
 */
export async function seedTestData(prisma: PrismaService): Promise<void> {
  const pw = await bcrypt.hash(TEST_PW, 10);

  await prisma.role.createMany({
    data: [
      { roleCode: 'RCP', name: '접수담당' },
      { roleCode: 'TEC', name: '검사자' },
      { roleCode: 'PHY', name: '검증의' },
      { roleCode: 'PAT', name: '병리판독의' },
      { roleCode: 'GEN', name: '유전체판독의' },
      { roleCode: 'MIC', name: '미생물검사자' },
      { roleCode: 'ADM', name: '관리자' },
    ],
    skipDuplicates: true,
  });
  await prisma.appUser.createMany({
    data: [
      { userId: 'U00', name: '관리자', passwordHash: pw },
      { userId: 'U04', name: '병리판독의', passwordHash: pw },
      { userId: 'U06', name: '유전체판독의', passwordHash: pw },
      { userId: 'U02', name: '검증의', passwordHash: pw },
      { userId: 'U09', name: '검증의2', passwordHash: pw }, // 2인 검증(자가검증 차단)용 두 번째 PHY
      { userId: 'U03', name: '미생물검사자', passwordHash: pw },
      { userId: 'U07', name: '접수', passwordHash: pw },
      { userId: 'U-PWD', name: '비번변경', passwordHash: pw }, // 비밀번호 변경 테스트
      { userId: 'U-LOCK', name: '잠금테스트', passwordHash: pw }, // 계정 잠금 테스트
    ],
    skipDuplicates: true,
  });
  await prisma.userRole.createMany({
    data: [
      { userId: 'U00', roleCode: 'ADM' },
      { userId: 'U02', roleCode: 'PHY' },
      { userId: 'U09', roleCode: 'PHY' },
      { userId: 'U04', roleCode: 'PAT' },
      { userId: 'U06', roleCode: 'GEN' },
      { userId: 'U03', roleCode: 'MIC' },
      { userId: 'U07', roleCode: 'RCP' },
    ],
    skipDuplicates: true,
  });

  await prisma.testMaster.createMany({
    data: [
      { testCode: 'CHE-K', name: '칼륨', loinc: '2823-3', domain: 'DIAGNOSTIC', unitUcum: 'mmol/L' },
      { testCode: 'CHE-NA', name: '나트륨', loinc: '2951-2', domain: 'DIAGNOSTIC', unitUcum: 'mmol/L' },
      { testCode: 'CBC-HGB', name: '혈색소', loinc: '718-7', domain: 'DIAGNOSTIC', unitUcum: 'g/dL', specimenType: 'Whole blood' },
      // 외부위탁(sendout) 전용 — 원내 결과를 만들지 않는 검사여야 위탁 회신 적재를 격리 검증할 수 있다.
      { testCode: 'IMM-TSH', name: 'TSH', loinc: '3016-3', domain: 'DIAGNOSTIC', unitUcum: 'mIU/L' },
    ],
    skipDuplicates: true,
  });
  // IMM-TSH 참고치 — 없으면 위탁 결과가 NO_RANGE로 보류돼 SENDOUT 보류사유를 확인할 수 없다.
  await prisma.referenceRange.createMany({
    data: [{ rrId: 'T-RR-TSH', testCode: 'IMM-TSH', sex: 'A', ageMin: 0, ageMax: 200, low: 0.4, high: 4.0, panicLow: 0.01, panicHigh: 100 }],
    skipDuplicates: true,
  });
  await prisma.container.createMany({
    data: [
      { containerCode: 'EDTA', name: 'EDTA관', additive: 'EDTA' },
      { containerCode: 'SST', name: '혈청분리관', additive: '응고촉진제' },
    ],
    skipDuplicates: true,
  });
  await prisma.panel.createMany({
    data: [{ panelCode: 'CBC', name: '일반혈액검사' }],
    skipDuplicates: true,
  });
  await prisma.panelItem.createMany({
    data: [{ panelCode: 'CBC', testCode: 'CBC-HGB' }],
    skipDuplicates: true,
  });
  await prisma.codeMapping.createMany({
    data: [{ lisCode: 'CBC-HGB', hisCode: 'CBC', loinc: '718-7' }],
    skipDuplicates: true,
  });
  await prisma.referenceRange.createMany({
    data: [
      { rrId: 'T-RR-K', testCode: 'CHE-K', sex: 'A', ageMin: 0, ageMax: 200, low: 3.5, high: 5.1, panicLow: 2.5, panicHigh: 6.5 },
      { rrId: 'T-RR-NA', testCode: 'CHE-NA', sex: 'A', ageMin: 0, ageMax: 200, low: 135, high: 145, panicLow: 120, panicHigh: 160 },
    ],
    skipDuplicates: true,
  });

  // 데모 환자·오더·검체 (결과 등록 대상)
  await prisma.patient.createMany({
    data: [{ patientId: 'T-2345678', name: '김테스트', sex: 'M', birthDate: '1972-05-03' }],
    skipDuplicates: true,
  });
  await prisma.labOrder.upsert({
    where: { orderId: 'T-O-1' },
    update: {},
    create: { orderId: 'T-O-1', hisOrderNo: 'T-H1', patientId: 'T-2345678', priority: 'S', status: 'IN_PROCESS' },
  });
  await prisma.orderItem.createMany({
    data: [
      { orderItemId: 'T-OI-1', orderId: 'T-O-1', testCode: 'CHE-K' },
      { orderItemId: 'T-OI-2', orderId: 'T-O-1', testCode: 'CHE-NA' },
    ],
    skipDuplicates: true,
  });
  await prisma.specimen.upsert({
    where: { specimenNo: 'T-S-1' },
    update: {},
    create: { specimenNo: 'T-S-1', orderId: 'T-O-1', specimenType: 'Serum', status: 'IN_PROCESS', receivedDt: new Date('2026-07-13T00:00:00Z') },
  });

  // 수혈(출고 게이트) — BB 역할 + 제제 + 교차적합
  await prisma.role.createMany({ data: [{ roleCode: 'BB', name: '수혈담당' }], skipDuplicates: true });
  await prisma.appUser.createMany({ data: [{ userId: 'U05', name: '수혈', passwordHash: pw }], skipDuplicates: true });
  await prisma.userRole.createMany({ data: [{ userId: 'U05', roleCode: 'BB' }], skipDuplicates: true });
  // U08: 2번째 관리자(Reflex 직무분리 테스트용 — 위원회 의결자)
  await prisma.appUser.createMany({ data: [{ userId: 'U08', name: '관리자2', passwordHash: pw }], skipDuplicates: true });
  await prisma.userRole.createMany({ data: [{ userId: 'U08', roleCode: 'ADM' }], skipDuplicates: true });
  await prisma.patient.createMany({ data: [{ patientId: 'T-BB', name: '수혈환자', sex: 'M', birthDate: '1970-01-01' }], skipDuplicates: true });
  await prisma.bloodUnit.createMany({
    data: [{ unitNo: 'T-UNIT-1', productType: 'RBC', bloodGroup: 'A+', drawnDate: '2026-07-01', expiryDate: '2026-12-31', status: 'IN_STOCK' }],
    skipDuplicates: true,
  });
  await prisma.crossmatch.createMany({
    data: [{ xmId: 'T-XM-1', patientId: 'T-BB', unitNo: 'T-UNIT-1', method: '생리식염수법', result: '적합' }],
    skipDuplicates: true,
  });
  // 서버측 ABO 검증(C3): 동일 판정 2회 이력(A/POS 일치) — 출고 게이트 통과 근거
  await prisma.bloodTyping.createMany({
    data: [
      { typingId: 'T-TYP-1', patientId: 'T-BB', abo: 'A', rhD: 'POS', antibodyScreen: 'NEG', tester: 'U05' },
      { typingId: 'T-TYP-2', patientId: 'T-BB', abo: 'A', rhD: 'POS', antibodyScreen: 'NEG', tester: 'U05' },
    ],
    skipDuplicates: true,
  });

  // 유전체(동의 게이트)
  await prisma.testMaster.createMany({
    data: [{ testCode: 'T-GEN', name: '유전성패널', domain: 'GENOMIC', specimenType: 'Blood' }],
    skipDuplicates: true,
  });
  await prisma.labOrder.upsert({
    where: { orderId: 'T-GO-1' }, update: {},
    create: { orderId: 'T-GO-1', patientId: 'T-2345678', status: 'IN_PROCESS' },
  });
  await prisma.genomicOrder.upsert({
    where: { orderId: 'T-GO-1' }, update: {},
    create: { genomicOrderId: 'T-G-1', orderId: 'T-GO-1', panelCode: 'T-GEN', testType: 'GERMLINE', status: '접수' },
  });
  // 근거번들(체세포) 테스트용 SOMATIC 오더 — 인접 테스트가 변형하는 GERMLINE T-G-1과 격리.
  await prisma.labOrder.upsert({
    where: { orderId: 'T-GO-2S' }, update: {},
    create: { orderId: 'T-GO-2S', patientId: 'T-2345678', status: 'IN_PROCESS' },
  });
  await prisma.genomicOrder.upsert({
    where: { orderId: 'T-GO-2S' }, update: {},
    create: { genomicOrderId: 'G-0002', orderId: 'T-GO-2S', panelCode: 'T-GEN', testType: 'SOMATIC', status: '접수' },
  });
  // 수기 변이 입력(전사)은 원본 결과지 첨부가 선행돼야 하므로, 시드 오더에 외부 결과지 1건 첨부.
  await prisma.resultAttachment.createMany({
    data: [
      { attachmentId: 'T-ATT-G1', genomicOrderId: 'T-G-1', filename: 'sendout-report.pdf', mimeType: 'application/pdf', sizeBytes: 12, data: new Uint8Array(Buffer.from('%PDF-1.4 g1')), uploadedBy: 'U06' },
      { attachmentId: 'T-ATT-G2', genomicOrderId: 'G-0002', filename: 'sendout-report.pdf', mimeType: 'application/pdf', sizeBytes: 12, data: new Uint8Array(Buffer.from('%PDF-1.4 g2')), uploadedBy: 'U06' },
    ],
    skipDuplicates: true,
  });

  // QC 목표치
  await prisma.qcMaterial.createMany({ data: [{ qcCode: 'T-QC', name: 'QC', lot: 'L1', expiry: '2026-12-31' }], skipDuplicates: true });
  await prisma.qcTarget.createMany({
    data: [{ qcTargetId: 'T-QT', qcCode: 'T-QC', instrument: 'inst1', testCode: 'CHE-K', mean: 4.2, sd: 0.15 }],
    skipDuplicates: true,
  });

  // 2차검증·델타·리플렉스 전용 데이터 (다른 테스트와 격리)
  await prisma.testMaster.createMany({
    data: [
      { testCode: 'CHE-GLU', name: '포도당', loinc: '2345-7', domain: 'DIAGNOSTIC', unitUcum: 'mg/dL' },
      { testCode: 'CHE-HBA1C', name: '당화혈색소', loinc: '4548-4', domain: 'DIAGNOSTIC', unitUcum: '%' },
      // Reflex 거버넌스 테스트 트리거·후속(assertTestCodesExist가 실재 코드를 요구)
      { testCode: 'CHE-TSH', name: '갑상선자극호르몬', loinc: '3016-3', domain: 'DIAGNOSTIC', unitUcum: 'mIU/L' },
      { testCode: 'CHE-FT4', name: '유리티록신', loinc: '3024-7', domain: 'DIAGNOSTIC', unitUcum: 'ng/dL' },
    ],
    skipDuplicates: true,
  });
  await prisma.referenceRange.createMany({
    data: [{ rrId: 'T-RR-GLU', testCode: 'CHE-GLU', sex: 'A', ageMin: 0, ageMax: 200, low: 70, high: 110, panicLow: 40, panicHigh: 500 }],
    skipDuplicates: true,
  });
  await prisma.patient.createMany({
    data: [{ patientId: 'T-DLT', name: '델타환자', sex: 'M', birthDate: '1980-01-01' }],
    skipDuplicates: true,
  });
  await prisma.labOrder.upsert({
    where: { orderId: 'T-O-DLT' }, update: {},
    create: { orderId: 'T-O-DLT', patientId: 'T-DLT', status: 'IN_PROCESS' },
  });
  await prisma.specimen.upsert({
    where: { specimenNo: 'T-S-DLT' }, update: {},
    create: { specimenNo: 'T-S-DLT', orderId: 'T-O-DLT', specimenType: 'Serum', status: 'IN_PROCESS' },
  });

  // 장비 인터페이스(자동 수집) 전용 — 매핑 + 격리 검체
  await prisma.instrumentMapping.createMany({
    data: [{ instrument: 'CHEM1', rawCode: 'GLU', testCode: 'CHE-GLU' }],
    skipDuplicates: true,
  });
  await prisma.patient.createMany({
    data: [{ patientId: 'T-INS', name: '장비환자', sex: 'F', birthDate: '1990-02-02' }],
    skipDuplicates: true,
  });
  await prisma.labOrder.upsert({
    where: { orderId: 'T-O-INS' }, update: {},
    create: { orderId: 'T-O-INS', patientId: 'T-INS', status: 'IN_PROCESS' },
  });
  await prisma.specimen.upsert({
    where: { specimenNo: 'T-S-INS' }, update: {},
    create: { specimenNo: 'T-S-INS', orderId: 'T-O-INS', specimenType: 'Serum', status: 'IN_PROCESS' },
  });

  // 통계(antibiogram) 전용 — 배양·균주·감수성
  await prisma.culture.createMany({
    data: [{ cultureId: 'T-CUL', specimenNo: 'T-S-1', medium: 'Blood agar', stage: '최종', status: '완료' }],
    skipDuplicates: true,
  });
  await prisma.isolate.createMany({
    data: [{ isolateId: 'T-ISO', cultureId: 'T-CUL', organism: 'E. coli', snomed: '112283007' }],
    skipDuplicates: true,
  });
  // 단계보고용 신선 배양(그람→최종 흐름)
  await prisma.culture.createMany({
    data: [{ cultureId: 'T-CUL2', specimenNo: 'T-S-1', medium: 'Blood agar', stage: 'INOCULATED', status: '진행' }],
    skipDuplicates: true,
  });

  // 병리 표본추적용 — 판독의(Provider) + 병리 검사
  await prisma.provider.createMany({ data: [{ providerId: 'PRV1', name: '병리전공의', roleType: '병리' }, { providerId: 'PRV2', name: '병리판독전문의', roleType: '병리' }], skipDuplicates: true });
  // 병리 사인아웃 서명자는 계정에 연결된 Provider로 서버가 유도한다(클라이언트 지정 불가).
  await prisma.appUser.update({ where: { userId: 'U00' }, data: { providerId: 'PRV1' } });
  await prisma.appUser.update({ where: { userId: 'U04' }, data: { providerId: 'PRV2' } });
  await prisma.pathologyCase.createMany({
    data: [{ spNo: 'T-SP-1', patientId: 'T-2345678', specimenSite: '위', receivedDate: '2026-07-13', status: '접수' }],
    skipDuplicates: true,
  });
  await prisma.susceptibility.createMany({
    data: [
      { susId: 'T-SUS1', isolateId: 'T-ISO', antibiotic: 'Ampicillin', mic: '>32', interpretation: 'R' },
      { susId: 'T-SUS2', isolateId: 'T-ISO', antibiotic: 'Meropenem', mic: '0.5', interpretation: 'S' },
    ],
    skipDuplicates: true,
  });
}
