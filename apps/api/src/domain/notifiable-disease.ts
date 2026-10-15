/**
 * 법정감염병·의료관련감염 신고 대상 판정(Domain, 순수 함수) — 스타터셋.
 * 근거: 감염병예방법 신고 의무. **최종 대상·등급은 감염관리·검사실 확정 필요**(개시 전).
 * 균명 + MDRO 분류로 신고 대상 여부·질병명·등급 도출.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export interface NotifiableResult {
  reportable: boolean;
  disease: string | null;
  grade: string | null; // 제1급/제2급/의료관련감염 표본감시 등
}

function norm(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 신고 등급을 정본 문자열로 정규화 — 담당의 폐루프 통보 게이트가 등급 문자열 정확일치(제1·2급)에 의존하는데,
 * 카탈로그 등급은 관리자 자유입력이라 '2급'·전각 '제２급'·'Class 2' 같은 변형이면 게이트가 조용히 빠진다.
 * 변형을 정본(제1~4급 / 의료관련감염 표본감시)으로 수렴. 매핑 불가 시 null(상위에서 검증·경고).
 */
export function normalizeNotifiableGrade(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  if (/표본\s*감시|surveillance/i.test(s)) return '의료관련감염 표본감시';
  const half = s.replace(/[０-９]/g, (d) => '０１２３４５６７８９'.indexOf(d).toString());
  const m = half.match(/[1-4]/);
  if (m && /급|class|grade|^\s*[1-4]\s*$/i.test(half)) return `제${m[0]}급`;
  return null;
}

/** 신고 규칙 행(카탈로그) — type=ORGANISM이면 균명 부분일치, MDRO이면 분류코드 부분일치. */
export interface NotifiableRule { type: string; match: string; disease: string; grade: string }

/**
 * 스타터 규칙 — 코드 내장 판정(아래 classifyNotifiable)과 같은 대상을 카탈로그 행 형태로 표현.
 * 첫 반입 시 "무엇이 달라지는지" 비교 기준으로 쓴다.
 */
export const STARTER_NOTIFIABLE: NotifiableRule[] = [
  { type: 'ORGANISM', match: 'tuberculosis', disease: '결핵', grade: '제2급' },
  { type: 'ORGANISM', match: 'mtb', disease: '결핵', grade: '제2급' },
  // 분자(PCR) 바이러스·STI — ⚠등급 감염관리 확정 대상
  { type: 'ORGANISM', match: 'cov-2', disease: '코로나바이러스감염증-19', grade: '제4급' },
  { type: 'ORGANISM', match: 'covid', disease: '코로나바이러스감염증-19', grade: '제4급' },
  { type: 'ORGANISM', match: 'influenza', disease: '인플루엔자', grade: '제4급' },
  { type: 'ORGANISM', match: 'hiv', disease: '후천성면역결핍증(HIV)', grade: '제3급' },
  { type: 'ORGANISM', match: 'hepatitis b', disease: 'B형간염', grade: '제3급' },
  { type: 'ORGANISM', match: 'hepatitis c', disease: 'C형간염', grade: '제3급' },
  { type: 'ORGANISM', match: 'measles', disease: '홍역', grade: '제2급' },
  { type: 'ORGANISM', match: 'gonorrho', disease: '임질', grade: '제4급' },
  { type: 'ORGANISM', match: 'trachomatis', disease: '클라미디아감염증', grade: '제4급' },
  { type: 'ORGANISM', match: 'pallidum', disease: '매독', grade: '제4급' },
  { type: 'ORGANISM', match: 'diphtheriae', disease: '디프테리아', grade: '제1급' },
  { type: 'ORGANISM', match: 'cholerae', disease: '콜레라', grade: '제2급' },
  { type: 'ORGANISM', match: 'typhi', disease: '장티푸스', grade: '제2급' },
  { type: 'ORGANISM', match: 'paratyphi', disease: '파라티푸스', grade: '제2급' },
  { type: 'ORGANISM', match: 'shigella', disease: '세균성이질', grade: '제2급' },
  { type: 'ORGANISM', match: 'meningitidis', disease: '수막구균 감염증', grade: '제2급' },
  { type: 'ORGANISM', match: 'brucella', disease: '브루셀라증', grade: '제3급' },
  { type: 'MDRO', match: 'VRSA', disease: 'VRSA/VISA 감염증', grade: '제2급' },
  { type: 'MDRO', match: 'VISA', disease: 'VRSA/VISA 감염증', grade: '제2급' },
  { type: 'MDRO', match: 'CRE', disease: '카바페넴내성장내세균속균종(CRE) 등', grade: '의료관련감염 표본감시' },
  { type: 'MDRO', match: 'VRE', disease: '반코마이신내성장알균(VRE) 감염증', grade: '의료관련감염 표본감시' },
];

/**
 * 카탈로그 규칙으로 판정 — 활성 카탈로그가 있을 때. ORGANISM은 균명 부분일치, MDRO는 코드 부분일치.
 * `paratyphi`가 `typhi`를 포함하므로, **더 긴(구체적인) match를 먼저** 본다(파라티푸스가 장티푸스로 오분류되면 안 된다).
 */
export function classifyNotifiableFrom(organism: string | null, mdro: string | null, rules: NotifiableRule[]): NotifiableResult {
  const o = norm(organism);
  const m = (mdro ?? '').toUpperCase();
  const org = rules.filter((r) => r.type === 'ORGANISM').sort((a, b) => b.match.length - a.match.length);
  for (const r of org) if (o.includes(norm(r.match))) return { reportable: true, disease: r.disease, grade: normalizeNotifiableGrade(r.grade) ?? r.grade };
  const md = rules.filter((r) => r.type === 'MDRO').sort((a, b) => b.match.length - a.match.length);
  for (const r of md) if (m.includes(r.match.toUpperCase())) return { reportable: true, disease: r.disease, grade: normalizeNotifiableGrade(r.grade) ?? r.grade };
  return { reportable: false, disease: null, grade: null };
}

/** 균명·MDRO분류 → 신고 대상 판정. mdro는 classifyMdro().mdro(예: 'CRE','VRE','VRSA') 문자열. */
export function classifyNotifiable(organism: string | null, mdro: string | null): NotifiableResult {
  const o = norm(organism);
  const m = (mdro ?? '').toUpperCase();

  // 균명 기반 법정감염병(제1·2급 일부). \bmtb\b: GeneXpert MTB/RIF 등 분자 PCR 표기 대응(예전엔 미매칭)
  if (/mycobacterium tuberculosis|m tuberculosis|\bmtb\b|\btb\b|tuberculosis|결핵/.test(o)) return { reportable: true, disease: '결핵', grade: '제2급' };
  // 분자(PCR) 바이러스·STI 법정감염병 — 배양 중심 목록이 놓치던 분자 고빈도 타깃. ⚠등급은 개정이 잦아 감염관리 확정 대상.
  //   미분류로 방치하면 COVID·인플루엔자·HIV·간염 등 양성이 조용히 법정신고 누락(reportable=true가 안전 핵심).
  if (/sars-cov-2|cov-2|covid|코로나/.test(o)) return { reportable: true, disease: '코로나바이러스감염증-19', grade: '제4급' };
  if (/influenza|인플루엔자/.test(o)) return { reportable: true, disease: '인플루엔자', grade: '제4급' };
  if (/\bhiv\b|후천성면역결핍|면역결핍/.test(o)) return { reportable: true, disease: '후천성면역결핍증(HIV)', grade: '제3급' };
  if (/hepatitis b|\bhbv\b|b형간염/.test(o)) return { reportable: true, disease: 'B형간염', grade: '제3급' };
  if (/hepatitis c|\bhcv\b|c형간염/.test(o)) return { reportable: true, disease: 'C형간염', grade: '제3급' };
  if (/measles|홍역/.test(o)) return { reportable: true, disease: '홍역', grade: '제2급' };
  if (/gonorrho|임질/.test(o)) return { reportable: true, disease: '임질', grade: '제4급' };
  if (/trachomatis|클라미디아/.test(o)) return { reportable: true, disease: '클라미디아감염증', grade: '제4급' };
  if (/pallidum|syphilis|매독/.test(o)) return { reportable: true, disease: '매독', grade: '제4급' };
  if (/corynebacterium diphtheriae|diphtheriae|디프테리아/.test(o)) return { reportable: true, disease: '디프테리아', grade: '제1급' };
  if (/vibrio cholerae|cholerae|콜레라/.test(o)) return { reportable: true, disease: '콜레라', grade: '제2급' };
  if (/salmonella .*typhi\b|salmonella typhi|장티푸스/.test(o) && !/paratyphi/.test(o)) return { reportable: true, disease: '장티푸스', grade: '제2급' };
  if (/paratyphi|파라티푸스/.test(o)) return { reportable: true, disease: '파라티푸스', grade: '제2급' };
  if (/shigella|이질/.test(o)) return { reportable: true, disease: '세균성이질', grade: '제2급' };
  if (/neisseria meningitidis|meningitidis|수막구균/.test(o)) return { reportable: true, disease: '수막구균 감염증', grade: '제2급' };
  if (/brucella|브루셀라/.test(o)) return { reportable: true, disease: '브루셀라증', grade: '제3급' };

  // MDRO 기반 — VRSA/VISA는 제2급, CRE/VRE 등은 의료관련감염 표본감시
  if (/VRSA|VISA/.test(m) || /vancomycin.*resistant.*(aureus|황색)/.test(o)) return { reportable: true, disease: 'VRSA/VISA 감염증', grade: '제2급' };
  if (/CRE|CPE|CRAB|CRPA/.test(m)) return { reportable: true, disease: '카바페넴내성장내세균속균종(CRE) 등', grade: '의료관련감염 표본감시' };
  if (/VRE/.test(m)) return { reportable: true, disease: '반코마이신내성장알균(VRE) 감염증', grade: '의료관련감염 표본감시' };

  return { reportable: false, disease: null, grade: null };
}
