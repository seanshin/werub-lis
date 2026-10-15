/**
 * 유전체 큐레이션 도메인 (순수 함수) — VCF 파싱·ACMG 분류.
 * 근거: 기획 22 §5(유전체 큐레이션: 수탁 VCF 수신·변이 해석·재분류).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

export interface ParsedVariant {
  chrom: string;
  pos: number;
  refAllele: string;
  altAllele: string;
  gene: string | null;
  vaf: number | null;
  zygosity: string | null;
}

/** INFO 필드에서 key=value 추출. */
function infoValue(info: string, key: string): string | null {
  const m = info.split(';').find((kv) => kv.startsWith(`${key}=`));
  return m ? m.slice(key.length + 1) : null;
}

/** GT(genotype)로 접합성 판정. */
function zygosityOf(gt: string): string | null {
  const alleles = gt.replace('|', '/').split('/');
  if (alleles.length < 2) return null;
  if (alleles[0] === alleles[1]) return alleles[0] === '0' ? 'REF' : 'HOM';
  return 'HET';
}

/**
 * 수탁 VCF 파싱 → 변이 배열. 헤더(#) 제외, 데이터 라인의 CHROM/POS/REF/ALT +
 * INFO(GENE·AF) + FORMAT/sample(GT)에서 접합성 추출. 멀티 ALT는 첫 대립만.
 */
export function parseVcf(vcf: string): ParsedVariant[] {
  const out: ParsedVariant[] = [];
  for (const line of vcf.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const f = line.split('\t');
    if (f.length < 8) continue;
    const [chrom, posStr, , ref, altField, , , info, , sample] = f;
    const pos = Number(posStr);
    if (!chrom || Number.isNaN(pos)) continue;
    const alt = altField.split(',')[0];
    const afStr = infoValue(info, 'AF');
    let zygosity: string | null = null;
    if (sample) {
      const gt = sample.split(':')[0];
      zygosity = zygosityOf(gt);
    }
    out.push({
      chrom,
      pos,
      refAllele: ref,
      altAllele: alt,
      gene: infoValue(info, 'GENE'),
      vaf: afStr != null && !Number.isNaN(Number(afStr)) ? Number(afStr) : null,
      zygosity,
    });
  }
  return out;
}

export const ACMG_CLASSES = ['Pathogenic', 'Likely Pathogenic', 'VUS', 'Likely Benign', 'Benign'];

/** 재분류가 임상적 재접촉(recontact) 대상인지 — P/LP 소속이 바뀌면(획득/상실) 의뢰의 통보 필요. */
export function needsRecontact(oldClass: string | null | undefined, newClass: string): boolean {
  const plp = (c: string | null | undefined) => c === 'Pathogenic' || c === 'Likely Pathogenic';
  return plp(newClass) !== plp(oldClass);
}

export interface AcmgEvidence {
  pvs?: number; // very strong pathogenic
  strongP?: number;
  moderateP?: number;
  supportingP?: number;
  standaloneB?: number; // stand-alone benign (BA1)
  strongB?: number;
  supportingB?: number;
}

/**
 * ACMG/AMP 규칙(단순화) → 5단계 분류.
 * 실제 조합규칙을 간소화한 것으로, 큐레이션 보조용 제안값.
 */
export function acmgClassify(e: AcmgEvidence): string {
  const pvs = e.pvs ?? 0, sp = e.strongP ?? 0, mp = e.moderateP ?? 0, pp = e.supportingP ?? 0;
  const ba = e.standaloneB ?? 0, sb = e.strongB ?? 0, bp = e.supportingB ?? 0;

  // Benign 우선(BA1 stand-alone)
  if (ba >= 1) return 'Benign';
  if (sb >= 2) return 'Benign';
  if (sb >= 1 && bp >= 1) return 'Likely Benign';
  if (bp >= 2) return 'Likely Benign';

  // Pathogenic (ACMG/AMP 2015 조합규칙 간소화)
  if (pvs >= 1 && sp >= 1) return 'Pathogenic';
  if (pvs >= 1 && mp >= 2) return 'Pathogenic';
  if (sp >= 2) return 'Pathogenic';
  if (sp >= 1 && mp >= 3) return 'Pathogenic';
  // Likely Pathogenic
  if (pvs >= 1 && (mp >= 1 || pp >= 2)) return 'Likely Pathogenic';
  if (sp >= 1 && (mp >= 1 || pp >= 2)) return 'Likely Pathogenic';
  if (mp >= 3) return 'Likely Pathogenic';

  return 'VUS';
}

export function isValidClassification(c: string): boolean {
  return ACMG_CLASSES.includes(c);
}
