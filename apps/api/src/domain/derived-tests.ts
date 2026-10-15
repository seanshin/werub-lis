/**
 * 계산검사(파생검사) 엔진 — 입력 검사값으로 자동 산출하는 검사(순수 함수).
 * 각 정의: 출력 검사코드, 입력 검사코드 목록, 산출식. 입력이 모두 있으면 계산.
 * 근거: CKD-EPI 2021(eGFR, race-free), Friedewald(LDL), anion gap, 보정칼슘.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export interface DerivedContext {
  age: number | null;
  sex: string | null; // M/F
}
export interface DerivedTestDef {
  testCode: string;
  name: string;
  unit: string;
  inputs: string[]; // 입력 검사코드
  compute: (vals: Record<string, number>, ctx: DerivedContext) => number | null;
}

const round = (n: number, d = 1): number => Math.round(n * 10 ** d) / 10 ** d;

/**
 * 계산검사 산출식 설명(UX 기획 §2-5) — 화면이 "이 값이 무엇으로 계산됐는가"를 보여줄 때 쓴다.
 * 결과에 CALCULATED 배지만 있고 출처를 알 수 없던 것을 해소. 사람이 읽는 식 그대로.
 */
export const DERIVED_FORMULA: Record<string, string> = {
  'CHE-EGFR': 'CKD-EPI 2021 (크레아티닌·나이·성별) — 성인(≥18세) 전용',
  'CHE-LDLC': 'LDL = 총콜레스테롤 − HDL − (중성지방 ÷ 5) — Friedewald, TG ≥ 400이면 산출 안 함',
  'CHE-AGAP': 'Anion Gap = (Na + K) − (Cl + HCO₃)',
  'CHE-CACORR': '보정칼슘 = 측정칼슘 + 0.8 × (4.0 − 알부민)',
};

export const DERIVED_TESTS: DerivedTestDef[] = [
  {
    testCode: 'CHE-EGFR',
    name: 'eGFR(추정 사구체여과율)',
    unit: 'mL/min/1.73m²',
    inputs: ['CHE-CREA'],
    compute: (v, ctx) => {
      const scr = v['CHE-CREA'];
      // CKD-EPI 2021은 성인(≥18세) 전용 — 소아는 Schwartz 식이 필요하므로 산출하지 않음
      if (!scr || scr <= 0 || ctx.age == null || ctx.age < 18 || !ctx.sex) return null;
      const female = ctx.sex === 'F';
      const kappa = female ? 0.7 : 0.9;
      const alpha = female ? -0.241 : -0.302;
      const ratio = scr / kappa;
      const egfr =
        142 *
        Math.pow(Math.min(ratio, 1), alpha) *
        Math.pow(Math.max(ratio, 1), -1.2) *
        Math.pow(0.9938, ctx.age) *
        (female ? 1.012 : 1);
      return round(egfr, 0);
    },
  },
  {
    testCode: 'CHE-LDLC',
    name: 'LDL 콜레스테롤(계산)',
    unit: 'mg/dL',
    inputs: ['CHE-CHOL', 'CHE-HDL', 'CHE-TG'],
    compute: (v) => {
      const tc = v['CHE-CHOL'], hdl = v['CHE-HDL'], tg = v['CHE-TG'];
      if (tc == null || hdl == null || tg == null) return null;
      if (tg >= 400) return null; // Friedewald 유효범위 초과 → 계산 안 함
      const ldl = tc - hdl - tg / 5;
      if (ldl < 0) return null; // 음수 LDL(고HDL/저TC)은 임상적으로 무의미 → 미산출
      return round(ldl, 0);
    },
  },
  {
    testCode: 'CHE-AGAP',
    name: 'Anion Gap(음이온차)',
    unit: 'mmol/L',
    inputs: ['CHE-NA', 'CHE-K', 'CHE-CL', 'CHE-CO2'],
    compute: (v) => {
      const { 'CHE-NA': na, 'CHE-K': k, 'CHE-CL': cl, 'CHE-CO2': co2 } = v;
      if ([na, k, cl, co2].some((x) => x == null)) return null;
      return round(na + k - (cl + co2), 1);
    },
  },
  {
    testCode: 'CHE-CACORR',
    name: '보정 칼슘',
    unit: 'mg/dL',
    inputs: ['CHE-CA', 'CHE-ALB'],
    compute: (v) => {
      const ca = v['CHE-CA'], alb = v['CHE-ALB'];
      if (ca == null || alb == null) return null;
      return round(ca + 0.8 * (4.0 - alb), 1);
    },
  },
];

/** 검체의 결과값(검사코드→수치)과 컨텍스트로 산출 가능한 파생검사 계산. */
export function computeDerived(values: Record<string, number>, ctx: DerivedContext): { testCode: string; name: string; unit: string; value: number }[] {
  const out: { testCode: string; name: string; unit: string; value: number }[] = [];
  for (const d of DERIVED_TESTS) {
    if (!d.inputs.every((i) => values[i] != null)) continue; // 입력 부족
    const val = d.compute(values, ctx);
    if (val == null || Number.isNaN(val)) continue;
    out.push({ testCode: d.testCode, name: d.name, unit: d.unit, value: val });
  }
  return out;
}
