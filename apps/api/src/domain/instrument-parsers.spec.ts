/**
 * parseAstm (E1394) — 단위 테스트 7건.
 *
 * 묶음: parseInstrumentCsv, parseInstrumentPayload.
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { parseAstm, parseInstrumentCsv, parseInstrumentPayload } from './instrument-parsers';

describe('parseAstm (E1394)', () => {
  it('O 검체 + 복수 R 결과 정규화', () => {
    const raw = [
      'H|\\^&|||CHEM1',
      'P|1||PAT001',
      'O|1||S-0088|^^^GLU',
      'R|1|^^^GLU^|105|mg/dL|N||F',
      'R|2|^^^K^|4.2|mmol/L|N||F',
      'L|1|N',
    ].join('\r');
    const out = parseAstm(raw);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ specimenId: 'S-0088', rawCode: 'GLU', value: '105', unit: 'mg/dL' });
    expect(out[1]).toEqual({ specimenId: 'S-0088', rawCode: 'K', value: '4.2', unit: 'mmol/L' });
  });

  it('O-3 없으면 O-2를 검체ID로', () => {
    const raw = ['O|1|S-9|', 'R|1|^^^GLU^|90|mg/dL', 'L|1'].join('\r');
    expect(parseAstm(raw)[0].specimenId).toBe('S-9');
  });

  it('STX/체크섬·프레임 시퀀스 제거 후 파싱', () => {
    const raw = '\x022O|1||S-1|\r3R|1|^^^GLU^|88|mg/dL\x03A2';
    const out = parseAstm(raw);
    expect(out[0]).toMatchObject({ specimenId: 'S-1', rawCode: 'GLU', value: '88' });
  });

  it('값 없는 R은 제외', () => {
    const raw = ['O|1||S-1', 'R|1|^^^GLU^||mg/dL', 'L|1'].join('\r');
    expect(parseAstm(raw)).toHaveLength(0);
  });
});

describe('parseInstrumentCsv', () => {
  it('헤더 유연 매칭 + 단위 선택', () => {
    const raw = 'sample,code,result,unit\nS-0088,GLU,105,mg/dL\nS-0088,K,4.2,mmol/L';
    const out = parseInstrumentCsv(raw);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ specimenId: 'S-0088', rawCode: 'GLU', value: '105', unit: 'mg/dL' });
  });

  it('필수 열 없으면 빈 배열', () => {
    expect(parseInstrumentCsv('a,b\n1,2')).toEqual([]);
  });
});

describe('parseInstrumentPayload', () => {
  it('포맷 분기', () => {
    expect(parseInstrumentPayload('CSV', 'specimen,test,value\nS-1,GLU,9')).toHaveLength(1);
    expect(parseInstrumentPayload('ASTM', 'O|1||S-1\rR|1|^^^GLU^|9|')).toHaveLength(1);
  });
});
