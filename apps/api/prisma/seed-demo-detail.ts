/**
 * 디테일 데모 시드 — 각 화면이 실제처럼 채워지도록 도메인별 풍부한 합성 데이터.
 * ★전부 합성(가상) 데이터. 멱등(createMany skipDuplicates / upsert)이라 반복 실행 안전.
 * base seed(seed.ts)가 만든 마스터(testCode·container·referenceRange·provider)를 참조한다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { PrismaClient } from '@prisma/client';

const D = (s: string) => new Date(s);

export async function seedDemoDetail(prisma: PrismaClient): Promise<void> {
  // ── 진료의(처방/판독) 보강 ──
  await prisma.provider.createMany({
    data: [
      { providerId: 'D003', name: '이신경', dept: '신경과', roleType: '처방의' },
      { providerId: 'D004', name: '한감염', dept: '감염내과', roleType: '처방의' },
      { providerId: 'D005', name: '오혈액', dept: '혈액종양내과', roleType: '처방의' },
      { providerId: 'D011', name: '서병리', dept: '병리과', roleType: '판독의' },
    ],
    skipDuplicates: true,
  });

  // ── 환자 12명(합성) ──
  const patients: { patientId: string; name: string; sex: 'M' | 'F'; birthDate: string }[] = [
    { patientId: '3001001', name: '이영희', sex: 'F', birthDate: '1958-11-20' },
    { patientId: '3001002', name: '박준형', sex: 'M', birthDate: '1991-02-14' },
    { patientId: '3001003', name: '최수민', sex: 'F', birthDate: '2015-06-30' },
    { patientId: '3001004', name: '강대호', sex: 'M', birthDate: '1949-09-01' },
    { patientId: '3001005', name: '윤서연', sex: 'F', birthDate: '1983-12-25' },
    { patientId: '3001006', name: '임재현', sex: 'M', birthDate: '1976-04-18' },
    { patientId: '3001007', name: '한지우', sex: 'F', birthDate: '2001-08-08' },
    { patientId: '3001008', name: '조성찬', sex: 'M', birthDate: '1962-01-05' },
    { patientId: '3001009', name: '노은정', sex: 'F', birthDate: '1995-03-22' },
    { patientId: '3001010', name: '배창수', sex: 'M', birthDate: '1988-07-11' },
    { patientId: '3001011', name: '신미래', sex: 'F', birthDate: '1970-10-02' },
    { patientId: '3001012', name: '황도윤', sex: 'M', birthDate: '2019-05-16' },
  ];
  await prisma.patient.createMany({ data: patients, skipDuplicates: true });

  // ── 진단검사: 오더·검체·결과(정상/이상/위험치) ──
  // (검체번호 SD-*, 오더 OD-*) — Result는 specimen+testCode 참조
  const dxOrders: { patientId: string; provider: string; dept: string; pri: 'R' | 'S' }[] = [
    { patientId: '3001001', provider: 'D001', dept: '내과', pri: 'R' },
    { patientId: '3001002', provider: 'D003', dept: '신경과', pri: 'R' },
    { patientId: '3001004', provider: 'D001', dept: '내과', pri: 'S' },
    { patientId: '3001005', provider: 'D002', dept: '유방외과', pri: 'R' },
    { patientId: '3001008', provider: 'D005', dept: '혈액종양내과', pri: 'S' },
    { patientId: '3001011', provider: 'D001', dept: '내과', pri: 'R' },
  ];
  let n = 0;
  for (const o of dxOrders) {
    n += 1;
    const oid = `OD-${String(n).padStart(3, '0')}`;
    const sno = `SD-${String(n).padStart(3, '0')}`;
    await prisma.labOrder.upsert({
      where: { orderId: oid }, update: {},
      create: { orderId: oid, hisOrderNo: `HD..${n}`, patientId: o.patientId, orderingProvider: o.provider, orderDt: D('2026-07-24T08:30:00+09:00'), priority: o.pri, status: 'COMPLETED' },
    });
    await prisma.specimen.upsert({
      where: { specimenNo: sno }, update: {},
      create: { specimenNo: sno, orderId: oid, containerCode: 'SST', specimenType: 'Serum', receivedDt: D('2026-07-24T09:00:00+09:00'), status: 'COMPLETED' },
    });
  }
  // 결과(값·플래그·검증상태) — 정상 다수 + 이상 + 위험치(보류) 섞기
  const results: { specimenNo: string; testCode: string; value: string; unit: string; flag: 'N' | 'H' | 'L' | 'HH' | 'LL'; verifyState: 'AUTO' | 'VERIFIED' | 'PENDING'; hold?: string }[] = [
    { specimenNo: 'SD-001', testCode: 'CHE-GLU', value: '96', unit: 'mg/dL', flag: 'N', verifyState: 'AUTO' },
    { specimenNo: 'SD-001', testCode: 'CHE-K', value: '4.4', unit: 'mmol/L', flag: 'N', verifyState: 'AUTO' },
    { specimenNo: 'SD-001', testCode: 'CHE-NA', value: '139', unit: 'mmol/L', flag: 'N', verifyState: 'AUTO' },
    { specimenNo: 'SD-002', testCode: 'CHE-GLU', value: '148', unit: 'mg/dL', flag: 'H', verifyState: 'VERIFIED' },
    { specimenNo: 'SD-002', testCode: 'CHE-HBA1C', value: '7.8', unit: '%', flag: 'H', verifyState: 'VERIFIED' },
    { specimenNo: 'SD-003', testCode: 'CHE-K', value: '6.6', unit: 'mmol/L', flag: 'HH', verifyState: 'PENDING', hold: 'CRITICAL' },
    { specimenNo: 'SD-003', testCode: 'CHE-NA', value: '131', unit: 'mmol/L', flag: 'L', verifyState: 'VERIFIED' },
    { specimenNo: 'SD-004', testCode: 'IMM-CRP', value: '2.1', unit: 'mg/L', flag: 'N', verifyState: 'AUTO' },
    { specimenNo: 'SD-005', testCode: 'CHE-K', value: '2.3', unit: 'mmol/L', flag: 'LL', verifyState: 'PENDING', hold: 'CRITICAL' },
    { specimenNo: 'SD-005', testCode: 'IMM-CRP', value: '84', unit: 'mg/L', flag: 'H', verifyState: 'VERIFIED' },
    { specimenNo: 'SD-006', testCode: 'IMM-TSH', value: '6.9', unit: 'mIU/L', flag: 'H', verifyState: 'VERIFIED' },
  ];
  let ri = 0;
  for (const r of results) {
    ri += 1;
    await prisma.result.upsert({
      where: { resultId: `RD-${String(ri).padStart(3, '0')}` }, update: {},
      create: {
        resultId: `RD-${String(ri).padStart(3, '0')}`, specimenNo: r.specimenNo, testCode: r.testCode, value: r.value, unit: r.unit,
        flag: r.flag, status: 'F', verifyState: r.verifyState, holdReason: r.hold ?? null, source: 'INSTRUMENT', instrument: '화학1호기',
        verifier: r.verifyState === 'VERIFIED' ? 'U02' : null, reportedDt: r.verifyState !== 'PENDING' ? D('2026-07-24T10:30:00+09:00') : null,
      },
    });
  }

  // ── 병리: 7 케이스(부위·상태 다양) + 보고서 ──
  const pathCases = [
    { spNo: 'SP-2026-1001', patientId: '3001005', site: '유방 (침생검, 좌측)', status: '판독대기', caseType: 'SURGICAL', prov: 'D002' },
    { spNo: 'SP-2026-1002', patientId: '3001001', site: '대장 (내시경 용종절제)', status: '판독', caseType: 'SURGICAL', prov: 'D001' },
    { spNo: 'SP-2026-1003', patientId: '3001008', site: '전립선 (침생검)', status: '완료', caseType: 'SURGICAL', prov: 'D005' },
    { spNo: 'SP-2026-1004', patientId: '3001004', site: '폐 (쐐기절제)', status: '그로싱', caseType: 'SURGICAL', prov: 'D001' },
    { spNo: 'SP-2026-1005', patientId: '3001011', site: '갑상선 (미세침흡인)', status: '판독대기', caseType: 'CYTOLOGY', prov: 'D001' },
    { spNo: 'SP-2026-1006', patientId: '3001009', site: '자궁경부 (Pap)', status: '완료', caseType: 'CYTOLOGY', prov: 'D002' },
    { spNo: 'SP-2026-1007', patientId: '3001006', site: '위 (내시경 생검)', status: '접수', caseType: 'SURGICAL', prov: 'D001' },
  ];
  for (const c of pathCases) {
    await prisma.pathologyCase.upsert({
      where: { spNo: c.spNo }, update: {},
      create: { spNo: c.spNo, patientId: c.patientId, specimenSite: c.site, receivedDate: '2026-07-22', status: c.status, caseType: c.caseType, requestingProvider: c.prov, clinicalInfo: '임상 병력 참조' },
    });
  }
  // 완료/판독 케이스 보고서
  await prisma.pathologyReport.upsert({
    where: { spNo: 'SP-2026-1003' }, update: {},
    create: { spNo: 'SP-2026-1003', findings: '전립선 침생검 12코어 중 3코어에서 선암.', diagnosis: '전립선 선암 (Gleason 3+4=7)', snomed: '399068003', status: '최종', signer: 'D010', signedDt: D('2026-07-23T14:00:00+09:00'), accessionNo: 'ACC-SP-26-1003', synopticProtocol: 'PROSTATE', synoptic: JSON.stringify({ 조직학적유형: '선암', 등급: 'Gleason 3+4=7', 병기: 'pT2c' }) },
  });
  await prisma.pathologyReport.upsert({
    where: { spNo: 'SP-2026-1006' }, update: {},
    create: { spNo: 'SP-2026-1006', findings: '편평상피세포, 반응성 변화. 악성세포 없음.', diagnosis: 'NILM (음성)', status: '최종', signer: 'D010', signedDt: D('2026-07-22T16:00:00+09:00'), accessionNo: 'ACC-SP-26-1006' },
  });
  await prisma.pathologyReport.upsert({
    where: { spNo: 'SP-2026-1002' }, update: {},
    create: { spNo: 'SP-2026-1002', findings: '관상선종, 저등급 이형성.', diagnosis: '관상선종 (tubular adenoma)', snomed: '68453008', status: '예비', draftBy: 'D011', draftDt: D('2026-07-23T11:00:00+09:00') },
  });

  // 병리 그로싱·MWL·블록·슬라이드(추적 메타데이터) — 병리 워크플로 화면 채움.
  //   ★실제 WSI 픽셀은 외부 PACS 몫이라 시드 못 만듦(scanStatus/wsiRef는 참조 메타데이터일 뿐).
  const pathDetail: { spNo: string; gross: string; blocks: { id: string; label: string; tissue: string; slides: { stain: string; detail?: string }[] }[] }[] = [
    { spNo: 'SP-2026-1003', gross: '전립선 침생검 12코어, 각 1.0~1.5cm.', blocks: [
      { id: 'BLK-1003-A', label: 'A', tissue: '좌엽 코어 1-6', slides: [{ stain: 'HE' }, { stain: 'IHC', detail: 'AMACR/p63' }] },
      { id: 'BLK-1003-B', label: 'B', tissue: '우엽 코어 7-12', slides: [{ stain: 'HE' }] },
    ] },
    { spNo: 'SP-2026-1002', gross: '대장 용종 1.5cm, 유경성.', blocks: [
      { id: 'BLK-1002-A', label: 'A', tissue: '용종 전체', slides: [{ stain: 'HE' }] },
    ] },
    { spNo: 'SP-2026-1004', gross: '폐 쐐기절제 3.0×2.0cm, 흉막 함몰(+).', blocks: [
      { id: 'BLK-1004-A', label: 'A', tissue: '종괴 중심', slides: [{ stain: 'HE' }] },
      { id: 'BLK-1004-B', label: 'B', tissue: '절제연', slides: [] },
    ] },
  ];
  for (const c of pathDetail) {
    await prisma.pathologyCase.update({
      where: { spNo: c.spNo },
      // ★`mwlStatus`/`mwlSentDt`는 시드가 넣지 않는다(2026-08-03 PACS 조사에서 드러남).
      //   이 두 필드는 "PACS에 워크리스트를 만들어 놓았다"는 **교차 시스템 사실**이고,
      //   `sendOrm`이 ACK=AA를 받았을 때만 쓴다. 시드가 지어내면 LIS는 있다고 하는데 PACS엔 없다 —
      //   실제로 PACS가 SP-2026-1002~1004를 "송신 실패가 조용히 SENT로 기록된 것 아니냐"며
      //   리스너 로그까지 뒤졌다(결론: 시드였다). **시드는 우리 쪽 사실만 적는다.**
      data: { grossDesc: c.gross, grossedBy: 'D010', grossedDt: D('2026-07-22T13:00:00+09:00') },
    });
    for (const b of c.blocks) {
      await prisma.pathologyBlock.upsert({ where: { blockId: b.id }, update: {}, create: { blockId: b.id, spNo: c.spNo, label: b.label, tissue: b.tissue, status: 'CUT' } });
      let si = 0;
      for (const s of b.slides) {
        si += 1;
        const sid = `${b.id}-S${si}`;
        await prisma.pathologySlide.upsert({
          where: { slideId: sid }, update: {},
          create: { slideId: sid, spNo: c.spNo, blockId: b.id, stain: s.stain, stainDetail: s.detail ?? null, scanStatus: 'SCANNED', scannedDt: D('2026-07-22T15:00:00+09:00'), wsiRef: `${c.spNo}/${b.label}` },
        });
      }
    }
  }

  // ── 미생물: 배양 5건 + 균주·감수성 + 최종보고 + 법정신고 ──
  const micSpec = [
    { sno: 'SM-101', pid: '3001008', type: '혈액', src: '혈액배양', cid: 'C-101', organism: 'Escherichia coli', mdro: null, disease: null },
    { sno: 'SM-102', pid: '3001004', type: '객담', src: '객담배양', cid: 'C-102', organism: 'Klebsiella pneumoniae (CRE)', mdro: 'CRE', disease: 'CRE' },
    { sno: 'SM-103', pid: '3001001', type: '소변', src: '요배양', cid: 'C-103', organism: 'Staphylococcus aureus (MRSA)', mdro: 'MRSA', disease: null },
    { sno: 'SM-104', pid: '3001006', type: '객담', src: '항산균검사', cid: 'C-104', organism: 'Mycobacterium tuberculosis', mdro: null, disease: '결핵' },
    { sno: 'SM-105', pid: '3001011', type: '창상', src: '창상배양', cid: 'C-105', organism: 'Pseudomonas aeruginosa', mdro: null, disease: null },
  ];
  for (const m of micSpec) {
    await prisma.labOrder.upsert({ where: { orderId: `OM-${m.cid}` }, update: {}, create: { orderId: `OM-${m.cid}`, patientId: m.pid, orderDt: D('2026-07-21T08:00:00+09:00'), status: 'IN_PROCESS' } });
    await prisma.specimen.upsert({ where: { specimenNo: m.sno }, update: {}, create: { specimenNo: m.sno, orderId: `OM-${m.cid}`, specimenType: m.type, receivedDt: D('2026-07-21T09:00:00+09:00'), status: 'IN_PROCESS' } });
    await prisma.culture.upsert({
      where: { cultureId: m.cid }, update: {},
      create: { cultureId: m.cid, specimenNo: m.sno, medium: '혈액한천', stage: 'AST_FINAL', status: '완료', gramStain: '그람 결과 참조', gramDt: D('2026-07-22T09:00:00+09:00'), reportStatus: 'FINAL' },
    });
    await prisma.isolate.upsert({ where: { isolateId: `I-${m.cid}` }, update: {}, create: { isolateId: `I-${m.cid}`, cultureId: m.cid, organism: m.organism } });
    await prisma.cultureReport.upsert({
      where: { reportId: `CR-${m.cid}` }, update: {},
      create: { reportId: `CR-${m.cid}`, cultureId: m.cid, stage: 'FINAL', status: 'FINAL', content: `${m.organism} 동정. 감수성 결과 참조.`, reporter: 'U03', reportedDt: D('2026-07-23T10:00:00+09:00') },
    });
    // 감수성 몇 종
    const abx = [
      { antibiotic: 'Ampicillin', mic: '>32', interpretation: 'R' },
      { antibiotic: 'Ceftriaxone', mic: m.mdro ? '>64' : '1', interpretation: m.mdro ? 'R' : 'S' },
      { antibiotic: 'Meropenem', mic: m.mdro === 'CRE' ? '>8' : '0.5', interpretation: m.mdro === 'CRE' ? 'R' : 'S' },
    ];
    let ai = 0;
    for (const a of abx) {
      ai += 1;
      await prisma.susceptibility.upsert({ where: { susId: `S-${m.cid}-${ai}` }, update: {}, create: { susId: `S-${m.cid}-${ai}`, isolateId: `I-${m.cid}`, antibiotic: a.antibiotic, mic: a.mic, interpretation: a.interpretation, method: 'MIC', standard: 'CLSI M100' } });
    }
    // 법정감염병 신고 대기(결핵·CRE)
    if (m.disease) {
      const grade = m.disease === '결핵' ? '제2급' : '의료관련감염 표본감시';
      const pt = patients.find((p) => p.patientId === m.pid);
      await prisma.infectiousReport.upsert({
        where: { reportId: `IR-${m.cid}` }, update: {},
        create: { reportId: `IR-${m.cid}`, isolateId: `I-${m.cid}`, patientId: m.pid, patientName: pt?.name ?? null, organism: m.organism, disease: m.disease === '결핵' ? '결핵' : '카바페넴내성장내세균속균종(CRE) 등', grade, specimenNo: m.sno, status: 'PENDING' },
      });
    }
  }

  // ── 분자진단(PCR) 3건 ──
  await prisma.molecularResult.upsert({ where: { molId: 'MOL-201' }, update: {}, create: { molId: 'MOL-201', specimenNo: 'SM-104', panelCode: 'TB-PANEL', target: 'Mycobacterium tuberculosis', assay: 'GeneXpert MTB/RIF', detection: 'DETECTED', interpretation: 'MTB 검출, RIF 내성 미검출', reportedBy: 'U03', status: 'FINAL' } });
  await prisma.molecularResult.upsert({ where: { molId: 'MOL-202' }, update: {}, create: { molId: 'MOL-202', specimenNo: 'SD-002', panelCode: 'RESP-PANEL', target: 'SARS-CoV-2', assay: 'RT-PCR', detection: 'NOT_DETECTED', ct: null, reportedBy: 'U03', status: 'FINAL' } });
  await prisma.molecularResult.upsert({ where: { molId: 'MOL-203' }, update: {}, create: { molId: 'MOL-203', specimenNo: 'SD-005', panelCode: 'RESP-PANEL', target: 'Influenza A', assay: 'RT-PCR', detection: 'DETECTED', ct: 24.5, reportedBy: 'U03', status: 'FINAL' } });

  // ── 수혈: 혈액형·제제·교차 ──
  await prisma.bloodTyping.createMany({
    data: [
      { typingId: 'BT-3001004-1', patientId: '3001004', abo: 'O', rhD: 'POS', antibodyScreen: 'NEG', tester: 'U05' },
      { typingId: 'BT-3001004-2', patientId: '3001004', abo: 'O', rhD: 'POS', antibodyScreen: 'NEG', tester: 'U05' },
      { typingId: 'BT-3001008-1', patientId: '3001008', abo: 'B', rhD: 'POS', antibodyScreen: 'NEG', tester: 'U05' },
      { typingId: 'BT-3001008-2', patientId: '3001008', abo: 'B', rhD: 'POS', antibodyScreen: 'NEG', tester: 'U05' },
    ],
    skipDuplicates: true,
  });
  await prisma.bloodUnit.createMany({
    data: [
      { unitNo: 'W2026070100201', productType: 'RBC', bloodGroup: 'O+', drawnDate: '2026-07-05', expiryDate: '2026-08-09', status: 'IN_STOCK' },
      { unitNo: 'W2026070100202', productType: 'RBC', bloodGroup: 'O+', drawnDate: '2026-07-06', expiryDate: '2026-08-10', status: 'IN_STOCK' },
      { unitNo: 'W2026070100203', productType: 'RBC', bloodGroup: 'B+', drawnDate: '2026-07-07', expiryDate: '2026-08-11', status: 'IN_STOCK' },
      { unitNo: 'W2026070100204', productType: 'PLT', bloodGroup: 'A+', drawnDate: '2026-07-20', expiryDate: '2026-07-25', status: 'IN_STOCK' },
      { unitNo: 'W2026070100205', productType: 'FFP', bloodGroup: 'O+', drawnDate: '2026-07-01', expiryDate: '2027-07-01', status: 'IN_STOCK' },
    ],
    skipDuplicates: true,
  });
  await prisma.crossmatch.createMany({
    data: [
      { xmId: 'XM-3001004', patientId: '3001004', unitNo: 'W2026070100201', method: '항글로불린법(AHG)', result: '적합' },
      { xmId: 'XM-3001008', patientId: '3001008', unitNo: 'W2026070100203', method: '생리식염수법', result: '적합' },
    ],
    skipDuplicates: true,
  });

  // ── QC 결과(레이-제닝스용) ──
  await prisma.qcResult.createMany({
    data: [
      { qcResultId: 'QR-1', qcCode: 'QC-CH1', instrument: '화학1호기', testCode: 'CHE-GLU', measuredValue: 101, measuredDt: D('2026-07-24T07:00:00+09:00') },
      { qcResultId: 'QR-2', qcCode: 'QC-CH1', instrument: '화학1호기', testCode: 'CHE-GLU', measuredValue: 99, measuredDt: D('2026-07-24T07:05:00+09:00') },
      { qcResultId: 'QR-3', qcCode: 'QC-CH1', instrument: '화학1호기', testCode: 'CHE-K', measuredValue: 4.25, measuredDt: D('2026-07-24T07:10:00+09:00') },
    ],
    skipDuplicates: true,
  });

  // eslint-disable-next-line no-console
  console.log('디테일 데모 시드 완료: 환자 +12 · 진단결과 11 · 병리 7 · 배양 5(신고 2) · 분자 3 · 수혈(형/제제/교차) · QC 3');
}
