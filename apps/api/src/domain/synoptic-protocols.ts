/**
 * 병리 구조화 보고(synoptic) 암종별 CAP 프로토콜(Domain, 순수 함수) — 스타터셋.
 * ⚠ 정식 프로토콜(CAP 최신판 요소·코드)은 병리과가 확정. 여기선 대표 암종의 필수요소만.
 * 자유 JSON이던 synoptic에 암종 프로토콜별 필수요소 검증을 부여.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export interface SynopticProtocol {
  key: string;
  label: string;
  required: string[]; // 필수 discrete 요소 키
  // 요소별 허용값(콤보박스 선행 제시) — CAP 표준 방향. datalist라 목록에서 고르거나 직접 입력('기타' 등) 가능.
  // ⚠스타터셋(대표값) — 정식 응답 목록·코드는 병리과가 CAP 최신판으로 확정.
  options?: Record<string, string[]>;
}

// 여러 프로토콜이 공유하는 요소 값(중복 정의 방지)
const DIFF = ['고분화(G1)', '중분화(G2)', '저분화(G3)', '미분화(G4)'];
const MARGIN = ['음성', '근접(<1mm)', '양성'];
const PRESENT = ['없음', '있음'];

export const SYNOPTIC_PROTOCOLS: SynopticProtocol[] = [
  {
    key: 'STOMACH', label: '위암',
    required: ['종양부위', '조직학적유형', '분화도', '침윤깊이(pT)', '절제연', '림프절(pN)', '림프혈관침윤'],
    options: {
      '종양부위': ['분문부', '위저부', '위체부', '전정부', '유문부', '문합부', '전체'],
      '조직학적유형': ['관상선암', '유두상선암', '점액선암', '저응집성암(인환세포 포함)', '미분화암', '신경내분비종양', '기타'],
      '분화도': DIFF,
      '침윤깊이(pT)': ['pT1a', 'pT1b', 'pT2', 'pT3', 'pT4a', 'pT4b'],
      '절제연': MARGIN,
      '림프절(pN)': ['pN0', 'pN1', 'pN2', 'pN3a', 'pN3b'],
      '림프혈관침윤': PRESENT,
    },
  },
  {
    key: 'COLON', label: '대장암',
    required: ['종양부위', '조직학적유형', '분화도', '침윤깊이(pT)', '절제연', '림프절(pN)', '림프혈관침윤', '신경주위침윤'],
    options: {
      '종양부위': ['맹장', '상행결장', '간만곡부', '횡행결장', '비만곡부', '하행결장', 'S상결장', '직장'],
      '조직학적유형': ['선암', '점액선암', '인환세포암', '수질암', '신경내분비종양', '기타'],
      '분화도': DIFF,
      '침윤깊이(pT)': ['pT1', 'pT2', 'pT3', 'pT4a', 'pT4b'],
      '절제연': MARGIN,
      '림프절(pN)': ['pN0', 'pN1a', 'pN1b', 'pN1c', 'pN2a', 'pN2b'],
      '림프혈관침윤': PRESENT,
      '신경주위침윤': PRESENT,
    },
  },
  {
    key: 'BREAST', label: '유방암',
    required: ['조직학적유형', '조직학적등급', '종양크기', '절제연', '림프절(pN)', 'ER', 'PR', 'HER2', 'Ki-67'],
    options: {
      '조직학적유형': ['침윤성 유관암종(NST)', '침윤성 소엽암종', '관상피내암(DCIS)', '점액암종', '수질양상암종', '기타'],
      '조직학적등급': ['I등급(고분화)', 'II등급(중분화)', 'III등급(저분화)'],
      '절제연': MARGIN,
      '림프절(pN)': ['pN0', 'pN1mi', 'pN1', 'pN2', 'pN3'],
      'ER': ['음성(<1%)', '양성', 'Allred(기재)'],
      'PR': ['음성(<1%)', '양성', 'Allred(기재)'],
      'HER2': ['0', '1+', '2+(경계·ISH 필요)', '3+'],
      // 종양크기(cm)·Ki-67(%)는 연속값이라 자유 입력
    },
  },
  {
    key: 'LUNG', label: '폐암',
    required: ['조직학적유형', '종양크기', '침윤깊이(pT)', '절제연', '림프절(pN)', '흉막침윤'],
    options: {
      '조직학적유형': ['선암', '편평세포암', '대세포암', '소세포암', '선편평암', '기타'],
      '침윤깊이(pT)': ['pT1a', 'pT1b', 'pT1c', 'pT2a', 'pT2b', 'pT3', 'pT4'],
      '절제연': MARGIN,
      '림프절(pN)': ['pN0', 'pN1', 'pN2', 'pN3'],
      '흉막침윤': ['없음(PL0)', 'PL1', 'PL2', 'PL3'],
    },
  },
  {
    key: 'PROSTATE', label: '전립선암',
    required: ['조직학적유형', 'Gleason점수', 'ISUP등급군', '종양체적', '절제연', '피막외침범'],
    options: {
      '조직학적유형': ['선암(acinar)', '관상선암', '기타'],
      'Gleason점수': ['3+3=6', '3+4=7', '4+3=7', '4+4=8', '3+5=8', '5+3=8', '4+5=9', '5+4=9', '5+5=10'],
      'ISUP등급군': ['1군', '2군', '3군', '4군', '5군'],
      '절제연': MARGIN,
      '피막외침범': ['없음', '있음(국소)', '있음(광범위)'],
      // 종양체적(%)은 연속값이라 자유 입력
    },
  },
];

export function getProtocol(key: string | null | undefined): SynopticProtocol | undefined {
  return SYNOPTIC_PROTOCOLS.find((p) => p.key === (key ?? '').toUpperCase());
}

export interface SynopticValidation {
  valid: boolean;
  missing: string[];
}

/**
 * 프로토콜 필수요소가 synoptic 값에 모두 있는지 검증(빈 문자열=미기재).
 * 알 수 없는 프로토콜은 valid=true(자유 synoptic 허용, 검증 생략).
 * protocols를 넘기면 그 목록(활성 카탈로그)에서, 없으면 스타터셋에서 프로토콜을 찾는다.
 */
export function validateSynoptic(
  protocolKey: string | null | undefined,
  values: Record<string, string> | null | undefined,
  protocols?: SynopticProtocol[] | null,
): SynopticValidation {
  const key = (protocolKey ?? '').toUpperCase();
  const proto = protocols ? protocols.find((p) => p.key === key) : getProtocol(protocolKey);
  if (!proto) return { valid: true, missing: [] };
  const v = values ?? {};
  const missing = proto.required.filter((k) => !((v[k] ?? '').toString().trim()));
  return { valid: missing.length === 0, missing };
}
