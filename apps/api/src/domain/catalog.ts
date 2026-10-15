/**
 * 카탈로그 반입 파서·검증(Domain, 순수 함수).
 *
 * 반입 대상은 발행기관 개정판(CLSI M100 등)이다. 화면에서 한 줄씩 고치는 값이 아니라
 * 통째로 갈아 끼우는 값이라, 파싱·검증·차이계산을 순수 함수로 분리해 두면 반입 전에
 * "무엇이 바뀌는지"를 부작용 없이 보여줄 수 있다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { normalizeNotifiableGrade } from './notifiable-disease';

export interface CatalogDef {
  catalogId: string;
  label: string;
  /** CSV 헤더(순서 무관, 대소문자 무시) */
  columns: string[];
  keyColumns: string[];
  help: string;
  sample: string;
  /**
   * 카탈로그별 행 검증·정규화. payload는 헤더 문자열이 채워진 상태로 들어온다.
   * 오류 문자열을 반환하면 그 행은 반입에서 빠지고 사유가 표시된다(null이면 통과).
   * payload를 직접 수정해 정규화한다(예: 소문자화, 숫자 변환).
   */
  validateRow?: (payload: Record<string, string | number | string[]>) => string | null;
}

export const CATALOG_DEFS: CatalogDef[] = [
  {
    catalogId: 'AST_BREAKPOINT',
    label: 'AST 브레이크포인트(CLSI M100)',
    columns: ['group', 'antibiotic', 's', 'r'],
    keyColumns: ['group', 'antibiotic'],
    help:
      'MIC를 S/I/R로 가르는 경계값입니다. `s` 이하가 감수성(S), `r` 이상이 내성(R), 그 사이가 중간(I)입니다. ' +
      '한 줄이 바뀌면 그 약제의 판정이 뒤집히고 곧 항생제 선택이 달라지므로, 활성화 전에 차이를 반드시 확인하세요. ' +
      'group은 균군 키(Enterobacterales · Staphylococcus · Enterococcus · Pseudomonas aeruginosa)입니다.',
    sample: 'group,antibiotic,s,r\nEnterobacterales,ceftriaxone,1,4\nStaphylococcus,oxacillin,2,4',
    validateRow: (p) => {
      const s = Number(p.s), r = Number(p.r);
      if (!Number.isFinite(s) || !Number.isFinite(r)) return 's·r은 숫자여야 합니다';
      if (s <= 0 || r <= 0) return 'MIC 경계값은 양수여야 합니다';
      // s >= r이면 중간(I) 구간이 사라지거나 뒤집혀, 모든 MIC가 S 또는 R로 잘못 판정된다
      if (s >= r) return `감수성 경계(${s})는 내성 경계(${r})보다 작아야 합니다 — 같거나 크면 중간(I) 구간이 사라져 판정이 뒤집힙니다`;
      p.s = s; p.r = r;
      p.group = String(p.group);
      p.antibiotic = String(p.antibiotic).toLowerCase().replace(/\//g, '-');
      return null;
    },
  },
  {
    catalogId: 'NOTIFIABLE_DISEASE',
    label: '법정감염병 신고 대상',
    columns: ['type', 'match', 'disease', 'grade'],
    keyColumns: ['type', 'match'],
    help:
      '균명(ORGANISM) 또는 내성분류(MDRO)로 신고 대상을 판정합니다. `match`가 균명/MDRO 코드에 포함되면 해당 질병·등급으로 신고 대상이 됩니다. ' +
      '한 줄을 놓치면 법정 신고를 빠뜨리게 되고, 잘못 넣으면 신고가 남발됩니다. `type`은 ORGANISM 또는 MDRO입니다.',
    sample: 'type,match,disease,grade\nORGANISM,tuberculosis,결핵,제2급\nORGANISM,cholerae,콜레라,제2급\nMDRO,CRE,카바페넴내성장내세균속균종(CRE),의료관련감염 표본감시',
    validateRow: (p) => {
      const type = String(p.type).toUpperCase();
      if (type !== 'ORGANISM' && type !== 'MDRO') return 'type은 ORGANISM 또는 MDRO여야 합니다';
      if (!String(p.disease).trim()) return 'disease가 비어 있습니다';
      p.type = type;
      p.match = String(p.match).trim();
      p.disease = String(p.disease).trim();
      // 등급은 담당의 폐루프 통보 게이트(제1·2급)가 정확일치로 쓰므로 반입 시 정본으로 강제 —
      // 자유입력 변형('2급'·'Class 2')이 새어들면 게이트가 조용히 빠진다.
      const gradeRaw = String(p.grade).trim();
      if (!gradeRaw) return 'grade가 비어 있습니다(제1~4급 또는 "의료관련감염 표본감시")';
      const grade = normalizeNotifiableGrade(gradeRaw);
      if (!grade) return `grade 형식 불명: "${gradeRaw}" — 제1~4급 또는 "의료관련감염 표본감시"만 허용`;
      p.grade = grade;
      return null;
    },
  },
  {
    catalogId: 'CYTOLOGY_CATEGORY',
    label: '세포병리 분류(Bethesda 등)',
    columns: ['code', 'system', 'label'],
    keyColumns: ['code'],
    help:
      '세포병리 보고에 쓰는 분류 코드입니다. `code`가 실제 보고에 저장되는 값이고, `system`은 분류체계(BETHESDA 또는 GENERAL), `label`은 표시명입니다. ' +
      '여기 없는 코드는 세포병리 보고에서 거부됩니다.',
    sample: 'code,system,label\nNILM,BETHESDA,음성(정상)\nASC-US,BETHESDA,비정형 편평세포(의미불명)\n악성,GENERAL,악성',
    validateRow: (p) => {
      const sys = String(p.system).toUpperCase();
      if (sys !== 'BETHESDA' && sys !== 'GENERAL') return 'system은 BETHESDA 또는 GENERAL이어야 합니다';
      p.code = String(p.code).trim();
      p.system = sys;
      p.label = String(p.label).trim();
      return null;
    },
  },
  {
    catalogId: 'SYNOPTIC_PROTOCOL',
    label: 'CAP synoptic 프로토콜',
    columns: ['key', 'label', 'required'],
    keyColumns: ['key'],
    help:
      '암종별 구조화 보고의 필수요소입니다. `required`는 세미콜론(;)으로 구분한 필수 항목 목록이고, 서명 시 이 요소들이 채워졌는지 검사합니다. ' +
      '필수요소를 빠뜨리면 불완전한 보고가 서명될 수 있습니다. `key`는 암종 키(STOMACH·COLON·BREAST 등)입니다.',
    sample: 'key,label,required\nSTOMACH,위암,종양부위;조직학적유형;분화도;침윤깊이(pT);절제연;림프절(pN);림프혈관침윤\nBREAST,유방암,조직학적유형;조직학적등급;종양크기;절제연;림프절(pN);ER;PR;HER2;Ki-67',
    validateRow: (p) => {
      const req = String(p.required).split(';').map((x) => x.trim()).filter(Boolean);
      if (req.length === 0) return 'required(필수요소)가 비어 있습니다 — 최소 1개 필요';
      p.key = String(p.key).trim().toUpperCase();
      p.label = String(p.label).trim();
      p.required = req;
      return null;
    },
  },
  {
    catalogId: 'ICDO',
    label: 'ICD-O-3 형태·국소부위 코드',
    columns: ['kind', 'code', 'name'],
    keyColumns: ['kind', 'code'],
    help:
      '종양분류 코드북입니다. `kind`는 MORPHOLOGY(형태 NNNN/N) 또는 TOPOGRAPHY(국소부위 Cnn.n)이며, 활성화하면 병기 등록 시 이 코드북에 있는 코드만 허용됩니다. ' +
      '활성 버전이 없으면 형식만 검사합니다.',
    sample: 'kind,code,name\nMORPHOLOGY,8140/3,선암종(NOS)\nMORPHOLOGY,8070/3,편평세포암종(NOS)\nTOPOGRAPHY,C16.9,위(NOS)',
    validateRow: (p) => {
      const kind = String(p.kind).toUpperCase();
      const code = String(p.code).trim();
      if (kind === 'MORPHOLOGY') { if (!/^\d{4}\/\d$/.test(code)) return `형태코드는 NNNN/N 형식이어야 합니다: ${code}`; }
      else if (kind === 'TOPOGRAPHY') { if (!/^C\d{2}(\.\d)?$/.test(code)) return `국소부위는 Cnn(.n) 형식이어야 합니다: ${code}`; }
      else return 'kind는 MORPHOLOGY 또는 TOPOGRAPHY여야 합니다';
      p.kind = kind; p.code = code;
      p.name = String(p.name).trim();
      return null;
    },
  },
  {
    catalogId: 'VARIANT_EVIDENCE',
    label: '변이 임상근거(ClinVar·gnomAD·OncoKB)',
    columns: ['gene', 'variant', 'significance', 'stars', 'gnomad_af', 'condition', 'source', 'citation', 'oncokb_level'],
    keyColumns: ['gene', 'variant'],
    help:
      '변이별 임상 근거입니다. `significance`(ClinVar 유의성)·`stars`(검토상태 0~4)·`gnomad_af`(집단 대립빈도)·' +
      '`source`(ClinVar/OncoKB/CIViC)·`citation`(VCV·PMID 등)·`oncokb_level`(종양 actionability). ' +
      'AI 해석이 이 근거를 **인용**해 분류·집단빈도·표적치료를 제시하고, 근거가 바뀌면 재해석 대상으로 표시합니다. ' +
      '`variant`는 HGVS(p. 또는 c.)입니다. 비어 있는 열은 `-`로 두세요.',
    sample:
      'gene,variant,significance,stars,gnomad_af,condition,source,citation,oncokb_level\n' +
      'BRCA1,p.Q1756fs,Pathogenic,3,0.00001,유전성 유방·난소암,ClinVar,VCV000017661,-\n' +
      'EGFR,p.L858R,Pathogenic,4,0,비소세포폐암,OncoKB,PMID:15118073,Level 1',
    validateRow: (p) => {
      const stars = Number(p.stars);
      if (p.stars !== '-' && (!Number.isInteger(stars) || stars < 0 || stars > 4)) return 'stars는 0~4 정수여야 합니다(미상은 -)';
      if (p.gnomad_af !== '-' && p.gnomad_af !== '') {
        const af = Number(p.gnomad_af);
        if (!Number.isFinite(af) || af < 0 || af > 1) return 'gnomad_af는 0~1 대립빈도여야 합니다(미상은 -)';
        p.gnomad_af = af;
      } else p.gnomad_af = '';
      p.gene = String(p.gene).trim().toUpperCase();
      p.variant = String(p.variant).trim();
      p.significance = String(p.significance).trim();
      p.stars = p.stars === '-' ? '' : stars;
      for (const k of ['condition', 'source', 'citation', 'oncokb_level'] as const) {
        p[k] = p[k] === '-' ? '' : String(p[k]).trim();
      }
      return null;
    },
  },
];

export const CATALOG_BY_ID = new Map(CATALOG_DEFS.map((d) => [d.catalogId, d]));

export interface ParsedRow {
  key: string;
  payload: Record<string, string | number | string[]>;
}
export interface ParseResult {
  rows: ParsedRow[];
  errors: { line: number; message: string }[];
}

/** CSV 한 줄 분해(따옴표 없는 단순 형식 — 표준 코드셋은 값에 쉼표가 없다). */
function splitLine(line: string): string[] {
  return line.split(',').map((c) => c.trim());
}

/**
 * CSV → 행. 헤더 이름으로 매핑하므로 열 순서가 달라도 된다.
 * 오류는 던지지 않고 모아서 돌려준다 — 한 줄 때문에 전체 반입이 막히면 어디가 틀렸는지 모른다.
 */
/**
 * 반입 행 상한 — 실제 표준 코드셋은 수천 행을 넘지 않는다(CLSI M100도 균군×약제 수백 규모).
 * 상한이 없으면 큰 붙여넣기 하나가 메모리·DB createMany 파라미터 한계를 넘겨 500을 낸다.
 * 넉넉히 두되 명확한 400으로 막는다(실수·악의 양쪽 차단).
 */
export const CATALOG_MAX_ROWS = 5000;

export function parseCatalogCsv(def: CatalogDef, text: string): ParseResult {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const errors: { line: number; message: string }[] = [];
  if (lines.length === 0) return { rows: [], errors: [{ line: 0, message: '내용이 비어 있습니다' }] };
  if (lines.length - 1 > CATALOG_MAX_ROWS) {
    return { rows: [], errors: [{ line: 0, message: `행이 너무 많습니다(${lines.length - 1} > ${CATALOG_MAX_ROWS}) — 표준 코드셋 한 종은 이보다 작습니다. 파일을 확인하세요` }] };
  }

  const header = splitLine(lines[0]).map((h) => h.toLowerCase());
  const missing = def.columns.filter((c) => !header.includes(c));
  if (missing.length) {
    return { rows: [], errors: [{ line: 1, message: `필수 열 누락: ${missing.join(', ')} (헤더: ${header.join(', ')})` }] };
  }
  const idx = Object.fromEntries(def.columns.map((c) => [c, header.indexOf(c)]));

  const rows: ParsedRow[] = [];
  const seen = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i]);
    const payload: Record<string, string | number | string[]> = {};
    let bad = false;
    for (const c of def.columns) {
      const raw = cells[idx[c]] ?? '';
      if (raw === '') { errors.push({ line: i + 1, message: `${c} 값이 비어 있습니다` }); bad = true; continue; }
      payload[c] = raw;
    }
    if (bad) continue;

    if (def.validateRow) {
      const err = def.validateRow(payload);
      if (err) { errors.push({ line: i + 1, message: err }); continue; }
    }

    const key = def.keyColumns.map((c) => String(payload[c])).join('|');
    if (seen.has(key)) { errors.push({ line: i + 1, message: `중복 항목: ${key}` }); continue; }
    seen.add(key);
    rows.push({ key, payload });
  }
  return { rows, errors };
}

export interface CatalogDiff {
  added: { key: string; after: Record<string, unknown> }[];
  removed: { key: string; before: Record<string, unknown> }[];
  changed: { key: string; before: Record<string, unknown>; after: Record<string, unknown> }[];
  unchanged: number;
}

/**
 * 활성 버전과의 차이. **활성화 전에 이걸 보여주는 것이 이 기능의 핵심**이다 —
 * 무엇이 바뀌는지 모른 채 판정 기준을 바꾸면, 어제 S였던 균이 오늘 R이 되는 이유를 아무도 모른다.
 */
export function diffCatalog(
  before: { key: string; payload: Record<string, unknown> }[],
  after: { key: string; payload: Record<string, unknown> }[],
): CatalogDiff {
  const b = new Map(before.map((x) => [x.key, x.payload]));
  const a = new Map(after.map((x) => [x.key, x.payload]));
  const diff: CatalogDiff = { added: [], removed: [], changed: [], unchanged: 0 };
  for (const [k, v] of a) {
    const prev = b.get(k);
    if (!prev) diff.added.push({ key: k, after: v });
    else if (JSON.stringify(prev) !== JSON.stringify(v)) diff.changed.push({ key: k, before: prev, after: v });
    else diff.unchanged++;
  }
  for (const [k, v] of b) if (!a.has(k)) diff.removed.push({ key: k, before: v });
  return diff;
}
