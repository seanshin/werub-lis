/**
 * HL7 파서 (MSH 오프셋) — 단위 테스트 25건.
 *
 * 묶음: mapOml (OML → 오더), buildOru / buildAck, ORM^O01 빌더 (PACS MWL 정본 §3), ORM^O01 취소 (ORC-1=CA, PACS 결정2), buildLabOrm — Reflex 검사 신규오더 ORM^O01(HIS)….
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { parseHl7, mapOml, buildOru, buildAck, buildOrm, buildLabOrm, field, seg, escHl7 } from './hl7';

const OML = [
  'MSH|^~\\&|HIS|HOSP|LIS|HOSP|20260712091500||OML^O21|MSG20260712001|P|2.5.1',
  'PID|1||1234567^^^HOSP^MR||홍^길동||19800101|M',
  'PV1|1|O|외래^내과||||D001^김의사',
  'ORC|NW|H2026071200123|||||^^^20260712091500',
  'OBR|1|H2026071200123||CBC^일반혈액검사^L|||20260712091500|||||||||D001^김의사|||||||||R',
  'OBR|2|H2026071200123||CHEM^임상화학^L|||20260712091500|||||||||D001^김의사|||||||||S',
].join('\r');

describe('HL7 파서 (MSH 오프셋)', () => {
  const msg = parseHl7(OML);
  it('MSH-9/10 정확 파싱', () => {
    expect(field(seg(msg, 'MSH'), 9)).toBe('OML^O21');
    expect(field(seg(msg, 'MSH'), 10)).toBe('MSG20260712001');
  });
  it('MSH-1은 구분자 |', () => {
    expect(field(seg(msg, 'MSH'), 1)).toBe('|');
  });
});

describe('mapOml (OML → 오더)', () => {
  const parsed = mapOml(parseHl7(OML));
  it('환자 정보 매핑', () => {
    expect(parsed.patient.patientId).toBe('1234567');
    expect(parsed.patient.familyName).toBe('홍');
    expect(parsed.patient.givenName).toBe('길동');
    expect(parsed.patient.birthDate).toBe('1980-01-01');
    expect(parsed.patient.sex).toBe('M');
  });
  it('오더/검사코드 매핑(반복 OBR)', () => {
    expect(parsed.hisOrderNo).toBe('H2026071200123');
    expect(parsed.orderControl).toBe('NW');
    expect(parsed.testCodes).toEqual(['CBC', 'CHEM']);
  });
  it('내원 정보', () => {
    expect(parsed.visit.type).toBe('O');
    expect(parsed.visit.dept).toBe('내과');
    expect(parsed.visit.provider).toBe('D001');
  });
  it('처방의(ordering provider) — OBR-16 포착(ORC-12 공백 폴백)', () => {
    expect(parsed.orderingProvider.id).toBe('D001');
    expect(parsed.orderingProvider.name).toBe('김의사');
  });
  it('처방의 ORC-12 우선', () => {
    const withOrc12 = OML.replace('ORC|NW|H2026071200123|||||^^^20260712091500', 'ORC|NW|H2026071200123|||||^^^20260712091500|||||D999^박과장');
    const p = mapOml(parseHl7(withOrc12));
    expect(p.orderingProvider.id).toBe('D999');
    expect(p.orderingProvider.name).toBe('박과장');
  });
});

describe('buildOru / buildAck', () => {
  it('ORU 메시지 생성(OBX 포함)', () => {
    const oru = buildOru({
      sendingApp: 'LIS', receivingApp: 'HIS', facility: 'HOSP',
      messageControlId: 'M1', nowStamp: '20260712104500',
      patientId: '1234567', patientName: '홍^길동',
      hisOrderNo: 'H..123', specimenNo: 'S-0088', orderCode: 'CBC', orderName: '일반혈액',
      results: [
        { loinc: '718-7', testName: 'Hemoglobin', value: '6.5', unit: 'g/dL', refRange: '13-17', flag: 'LL', status: 'F' },
      ],
    });
    expect(oru).toContain('ORU^R01');
    expect(oru).toContain('OBX|1|NM|718-7^Hemoglobin^LN||6.5|g/dL|13-17|LL');
    expect(oru.split('\r')[0].startsWith('MSH')).toBe(true);
  });
  it('ACK 생성', () => {
    expect(buildAck('MSG1', 'AA')).toContain('MSA|AA|MSG1');
  });
});

describe('ORM^O01 빌더 (PACS MWL 정본 §3)', () => {
  const orm = buildOrm({
    messageControlId: 'MSG0001', nowStamp: '20260713101500',
    patientId: '100023456', patientFamily: '홍', patientGiven: '길동',
    birthDate: '19700101', sex: 'M',
    accession: 'ACC-SP-2026-0456', procedureId: 'PATH', procedureDesc: '병리 슬라이드 스캔',
    scheduledTs: '20260713101500', modality: 'SM',
  });
  const msg = parseHl7(orm);

  it('MSH: ORM^O01 · v2.3 · OPENPACS 수신', () => {
    expect(field(seg(msg, 'MSH'), 9)).toBe('ORM^O01');
    expect(field(seg(msg, 'MSH'), 12)).toBe('2.3');
    expect(field(seg(msg, 'MSH'), 5)).toBe('OPENPACS');
  });
  it('ORC-2·ORC-3 = AccessionNumber(동일값)', () => {
    expect(field(seg(msg, 'ORC'), 2)).toBe('ACC-SP-2026-0456');
    expect(field(seg(msg, 'ORC'), 3)).toBe('ACC-SP-2026-0456');
  });
  it('OBR-3=Accession, OBR-4=Procedure, OBR-7=Scheduled, OBR-24=Modality(SM)', () => {
    const obr = seg(msg, 'OBR');
    expect(field(obr, 3)).toBe('ACC-SP-2026-0456');
    expect(field(obr, 4)).toBe('PATH^병리 슬라이드 스캔');
    expect(field(obr, 7)).toBe('20260713101500');
    expect(field(obr, 24)).toBe('SM');
  });
  it('AccessionNumber 16자 이내', () => {
    expect('ACC-SP-2026-0456'.length).toBeLessThanOrEqual(16);
  });
  it('ORC-1 기본 NW', () => {
    expect(field(seg(msg, 'ORC'), 1)).toBe('NW');
  });
});

describe('ORM^O01 취소 (ORC-1=CA, PACS 결정2)', () => {
  const cancel = buildOrm({
    messageControlId: 'MSG0002', nowStamp: '20260713101500',
    patientId: '100023456', patientFamily: '홍', patientGiven: '길동',
    birthDate: '19700101', sex: 'M',
    accession: 'ACC-SP-26-0456', procedureId: 'PATH', procedureDesc: '병리 슬라이드 스캔',
    scheduledTs: '20260713101500', modality: 'SM', orderControl: 'CA',
  });
  const cmsg = parseHl7(cancel);
  it('ORC-1 = CA', () => {
    expect(field(seg(cmsg, 'ORC'), 1)).toBe('CA');
  });
  it('취소도 accession 동일값 유지(ORC-2/3·OBR-3)', () => {
    expect(field(seg(cmsg, 'ORC'), 2)).toBe('ACC-SP-26-0456');
    expect(field(seg(cmsg, 'OBR'), 3)).toBe('ACC-SP-26-0456');
  });
});

describe('buildLabOrm — Reflex 검사 신규오더 ORM^O01(HIS)', () => {
  const msg = parseHl7(buildLabOrm({
    messageControlId: 'RX-O-1-CHE-FT4', nowStamp: '20260714120000', patientId: 'P-100',
    placerOrderNo: 'RX-O-1-CHE-FT4', parentOrderId: 'O-1', testCode: 'CHE-FT4', testName: 'Free T4', loinc: '3024-7',
    reason: 'Reflex: 갑상선 반사(TSH→FT4) (RP-1)',
  }));
  it('MSH ORM^O01 · MSH-3=LIS/MSH-4=WEVE', () => {
    expect(field(seg(msg, 'MSH'), 9)).toBe('ORM^O01');
    expect(field(seg(msg, 'MSH'), 3)).toBe('LIS');
    expect(field(seg(msg, 'MSH'), 4)).toBe('WEVE');
  });
  it('ORC-1=NW(신규)·ORC-2=placer·ORC-4=원오더·ORC-16=사유', () => {
    const orc = seg(msg, 'ORC');
    expect(field(orc, 1)).toBe('NW');
    expect(field(orc, 2)).toBe('RX-O-1-CHE-FT4');
    expect(field(orc, 4)).toBe('O-1');
    expect(field(orc, 16)).toContain('Reflex');
  });
  it('OBR-4 서비스식별자(검사코드·LOINC)·PID-3 환자', () => {
    expect(field(seg(msg, 'OBR'), 4)).toContain('CHE-FT4');
    expect(field(seg(msg, 'OBR'), 4)).toContain('3024-7');
    expect(field(seg(msg, 'PID'), 3)).toBe('P-100');
  });
});

describe('escHl7 (구분자 주입 방지)', () => {
  it('구분자를 이스케이프 시퀀스로 치환(\\ 먼저)', () => {
    expect(escHl7('a|b^c~d&e\\f')).toBe('a\\F\\b\\S\\c\\R\\d\\T\\e\\E\\f');
  });
  it('null/undefined → 빈 문자열', () => {
    expect(escHl7(null)).toBe('');
    expect(escHl7(undefined)).toBe('');
  });
  it('OBX 값의 파이프 주입이 무력화됨', () => {
    const oru = buildOru({
      sendingApp: 'LIS', facility: 'H', receivingApp: 'HIS', nowStamp: '20260716',
      messageControlId: 'M1', patientId: 'P1', patientName: '홍길동', hisOrderNo: 'O1', specimenNo: 'S1',
      orderCode: 'C', orderName: 'CBC', results: [{ loinc: '1', testName: 'X', value: '>13|POS', unit: 'g/dL', refRange: '', flag: 'H', status: 'F' }],
    });
    const obx = oru.split('\r').find((l) => l.startsWith('OBX'))!;
    expect(obx).toContain('\\F\\POS'); // 파이프가 이스케이프되어 필드 분리 안 됨
    expect(obx.split('|').length).toBe(15); // 주입으로 필드가 늘지 않음(미이스케이프면 16)
  });
});
