/**
 * 카탈로그 반입 파서 — 단위 테스트 16건.
 *
 * 묶음: 카탈로그 차이, 카탈로그 4종 검증 분기, 법정감염병 카탈로그 판정, 반입 상한(DoS·실수 방어).
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { CATALOG_BY_ID, parseCatalogCsv, diffCatalog, CATALOG_MAX_ROWS } from './catalog';
import { classifyNotifiableFrom } from './notifiable-disease';

const AST = CATALOG_BY_ID.get('AST_BREAKPOINT')!;

describe('카탈로그 반입 파서', () => {
  it('헤더 이름으로 매핑하므로 열 순서가 달라도 된다', () => {
    const r = parseCatalogCsv(AST, 'antibiotic,group,r,s\nceftriaxone,Enterobacterales,4,1');
    expect(r.errors).toEqual([]);
    expect(r.rows[0]).toEqual({ key: 'Enterobacterales|ceftriaxone', payload: { group: 'Enterobacterales', antibiotic: 'ceftriaxone', s: 1, r: 4 } });
  });

  it('★감수성 경계가 내성 경계 이상이면 거부 — 중간(I) 구간이 사라져 판정이 뒤집힌다', () => {
    const r = parseCatalogCsv(AST, 'group,antibiotic,s,r\nEnterobacterales,ceftriaxone,8,4');
    expect(r.rows).toHaveLength(0);
    expect(r.errors[0].message).toContain('중간(I) 구간이 사라져');
  });

  it('한 줄이 틀려도 나머지는 계속 읽고 오류를 모아 돌려준다(어디가 틀렸는지 알아야 고친다)', () => {
    const r = parseCatalogCsv(AST, 'group,antibiotic,s,r\nA,drug1,1,4\nA,drug2,-1,4\nA,drug3,2,8');
    expect(r.rows.map((x) => x.payload.antibiotic)).toEqual(['drug1', 'drug3']);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].line).toBe(3);
  });

  it('중복 키는 거부 — 같은 균군·약제가 두 값을 가질 수 없다', () => {
    const r = parseCatalogCsv(AST, 'group,antibiotic,s,r\nA,drug1,1,4\nA,drug1,2,8');
    expect(r.rows).toHaveLength(1);
    expect(r.errors[0].message).toContain('중복');
  });

  it('필수 열이 없으면 한 줄도 읽지 않는다', () => {
    const r = parseCatalogCsv(AST, 'group,antibiotic,s\nA,drug1,1');
    expect(r.rows).toHaveLength(0);
    expect(r.errors[0].message).toContain('필수 열 누락');
  });

  it('약제명은 소문자·하이픈으로 정규화 — 판정엔진 조회 키와 맞춘다', () => {
    const r = parseCatalogCsv(AST, 'group,antibiotic,s,r\nA,Trimethoprim/Sulfamethoxazole,2,4');
    expect(r.rows[0].payload.antibiotic).toBe('trimethoprim-sulfamethoxazole');
  });
});

describe('카탈로그 차이', () => {
  it('추가·변경·삭제를 항목 단위로 가른다', () => {
    const before = [{ key: 'a', payload: { s: 1, r: 4 } }, { key: 'b', payload: { s: 2, r: 8 } }];
    const after = [{ key: 'a', payload: { s: 1, r: 4 } }, { key: 'b', payload: { s: 1, r: 8 } }, { key: 'c', payload: { s: 4, r: 16 } }];
    const d = diffCatalog(before, after);
    expect(d.unchanged).toBe(1);
    expect(d.changed.map((c) => c.key)).toEqual(['b']);
    expect(d.added.map((c) => c.key)).toEqual(['c']);
    expect(d.removed).toEqual([]);
  });
});

describe('카탈로그 4종 검증 분기', () => {
  it('NOTIFIABLE — type은 ORGANISM/MDRO만', () => {
    const def = CATALOG_BY_ID.get('NOTIFIABLE_DISEASE')!;
    expect(parseCatalogCsv(def, 'type,match,disease,grade\nWRONG,x,결핵,제2급').errors[0].message).toContain('ORGANISM');
    const ok = parseCatalogCsv(def, 'type,match,disease,grade\nORGANISM,tuberculosis,결핵,제2급');
    expect(ok.rows[0].key).toBe('ORGANISM|tuberculosis');
  });

  it('NOTIFIABLE — 등급 형식 불명은 반입 거부, 변형은 정본으로 강제(폐루프 게이트 방어)', () => {
    const def = CATALOG_BY_ID.get('NOTIFIABLE_DISEASE')!;
    // 매핑 불가 등급 → 거부(활성 카탈로그에 못 들어감)
    expect(parseCatalogCsv(def, 'type,match,disease,grade\nORGANISM,tuberculosis,결핵,urgent').errors[0].message).toContain('grade');
    expect(parseCatalogCsv(def, 'type,match,disease,grade\nORGANISM,tuberculosis,결핵,').errors[0].message).toContain('grade');
    // 변형('2급')은 정본('제2급')으로 저장 → 통보 게이트 정확일치 보장
    const v = parseCatalogCsv(def, 'type,match,disease,grade\nORGANISM,tuberculosis,결핵,2급');
    expect(v.errors.length).toBe(0);
    expect(v.rows[0].payload.grade).toBe('제2급');
  });

  it('CYTOLOGY — system은 BETHESDA/GENERAL만, code가 키', () => {
    const def = CATALOG_BY_ID.get('CYTOLOGY_CATEGORY')!;
    expect(parseCatalogCsv(def, 'code,system,label\nNILM,X,음성').errors[0].message).toContain('BETHESDA');
    expect(parseCatalogCsv(def, 'code,system,label\nNILM,BETHESDA,음성').rows[0].key).toBe('NILM');
  });

  it('SYNOPTIC — required는 세미콜론 목록, 비면 거부', () => {
    const def = CATALOG_BY_ID.get('SYNOPTIC_PROTOCOL')!;
    expect(parseCatalogCsv(def, 'key,label,required\nSTOMACH,위암,;;').errors.length).toBeGreaterThan(0);
    const ok = parseCatalogCsv(def, 'key,label,required\nstomach,위암,종양부위;절제연');
    expect(ok.rows[0].key).toBe('STOMACH');
    expect(ok.rows[0].payload.required).toEqual(['종양부위', '절제연']);
  });

  it('ICDO — 형태/국소부위 형식 검증', () => {
    const def = CATALOG_BY_ID.get('ICDO')!;
    expect(parseCatalogCsv(def, 'kind,code,name\nMORPHOLOGY,ABCD,선암종').errors[0].message).toContain('NNNN/N');
    expect(parseCatalogCsv(def, 'kind,code,name\nTOPOGRAPHY,X16,위').errors[0].message).toContain('Cnn');
    const ok = parseCatalogCsv(def, 'kind,code,name\nMORPHOLOGY,8140/3,선암종\nTOPOGRAPHY,C16.9,위');
    expect(ok.rows.map((r) => r.key)).toEqual(['MORPHOLOGY|8140/3', 'TOPOGRAPHY|C16.9']);
  });
});

describe('법정감염병 카탈로그 판정', () => {
  it('paratyphi가 typhi로 오분류되지 않는다(더 구체적인 match 우선)', () => {
    const rules = [
      { type: 'ORGANISM', match: 'typhi', disease: '장티푸스', grade: '제2급' },
      { type: 'ORGANISM', match: 'paratyphi', disease: '파라티푸스', grade: '제2급' },
    ];
    expect(classifyNotifiableFrom('Salmonella Paratyphi A', null, rules).disease).toBe('파라티푸스');
    expect(classifyNotifiableFrom('Salmonella Typhi', null, rules).disease).toBe('장티푸스');
  });

  it('MDRO 코드 부분일치', () => {
    const rules = [{ type: 'MDRO', match: 'CRE', disease: 'CRE 등', grade: '표본감시' }];
    expect(classifyNotifiableFrom(null, 'CRE', rules).reportable).toBe(true);
    expect(classifyNotifiableFrom(null, 'MSSA', rules).reportable).toBe(false);
  });
});

describe('반입 상한(DoS·실수 방어)', () => {
  it('상한을 넘는 행은 파싱 전에 400으로 막는다(500 방지)', () => {
    const def = CATALOG_BY_ID.get('AST_BREAKPOINT')!;
    const rows = Array.from({ length: CATALOG_MAX_ROWS + 1 }, (_, i) => `G${i},drug${i},1,4`).join('\n');
    const r = parseCatalogCsv(def, `group,antibiotic,s,r\n${rows}`);
    expect(r.rows).toHaveLength(0);
    expect(r.errors[0].message).toContain('너무 많습니다');
  });

  it('상한 이내는 정상 처리', () => {
    const def = CATALOG_BY_ID.get('AST_BREAKPOINT')!;
    const rows = Array.from({ length: 100 }, (_, i) => `G${i},drug${i},1,4`).join('\n');
    expect(parseCatalogCsv(def, `group,antibiotic,s,r\n${rows}`).rows).toHaveLength(100);
  });
});
