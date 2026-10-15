/**
 * AST expert-rule 검증(순수 함수) — 감수성 결과의 고유내성·비정상 표현형 감지.
 * 목적: 데이터 입력 오류·오판독을 잡아 부적절한 항생제 선택을 예방(CLSI 전문가 규칙 간소화).
 * 반환: 경고 목록(치명적이지 않음 — 검토 유도). 확정은 미생물 검사자/전문가 판단.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export interface SusEntry {
  antibiotic: string | null;
  interpretation: string | null; // S/I/R
}
export interface AstWarning {
  antibiotic: string;
  rule: string;
  message: string;
}

// 균종(부분일치) → 고유내성 항생제(부분일치). 이들에 S/I가 보고되면 오류 의심(CLSI M100 고유내성 간소화).
const INTRINSIC_R: { org: string[]; drugs: string[]; note: string }[] = [
  { org: ['klebsiella', 'enterobacter', 'citrobacter', 'serratia', 'providencia', 'morganella', 'hafnia'], drugs: ['ampicillin', 'amoxicillin'], note: 'Ampicillin 고유내성' },
  { org: ['enterobacter', 'citrobacter freundii', 'serratia', 'hafnia', 'providencia', 'morganella'], drugs: ['cefazolin', 'cefoxitin', 'cephalexin'], note: '1세대 Cef/Cefoxitin 고유내성(AmpC)' },
  { org: ['enterococcus'], drugs: ['cephalexin', 'cefazolin', 'ceftriaxone', 'cefotaxime', 'ceftazidime', 'cefepime', 'clindamycin', 'trimethoprim', 'gentamicin', 'tobramycin', 'aztreonam'], note: '세팔로스포린/Clindamycin/TMP/저농도 Aminoglycoside/Aztreonam 고유내성' },
  { org: ['enterococcus faecium'], drugs: ['ampicillin'], note: 'E. faecium은 흔히 Ampicillin 내성(S 재확인)' },
  { org: ['pseudomonas'], drugs: ['ampicillin', 'amoxicillin', 'cefazolin', 'cefoxitin', 'ceftriaxone', 'cefotaxime', 'ertapenem', 'trimethoprim', 'tetracycline', 'chloramphenicol'], note: 'Ampicillin/1·3세대(non-antipseudomonal) Cef/Ertapenem/TMP/Tetracycline 고유내성' },
  { org: ['acinetobacter'], drugs: ['ampicillin', 'amoxicillin', 'cefazolin', 'ertapenem', 'trimethoprim', 'fosfomycin'], note: 'Ampicillin/1세대 Cef/Ertapenem/TMP 고유내성' },
  { org: ['stenotrophomonas'], drugs: ['imipenem', 'meropenem', 'ertapenem', 'aztreonam', 'gentamicin', 'tobramycin', 'amikacin'], note: 'Carbapenem/Aztreonam/Aminoglycoside 고유내성' },
  { org: ['proteus mirabilis', 'proteus vulgaris', 'providencia', 'morganella'], drugs: ['colistin', 'polymyxin', 'nitrofurantoin', 'tetracycline', 'tigecycline'], note: 'Colistin/Nitrofurantoin/Tetracycline 고유내성' },
  { org: ['serratia'], drugs: ['colistin', 'polymyxin'], note: 'Colistin 고유내성' },
  { org: ['burkholderia'], drugs: ['colistin', 'polymyxin', 'aminoglycoside', 'gentamicin'], note: 'Colistin/Aminoglycoside 고유내성' },
  { org: ['salmonella', 'shigella'], drugs: ['cefazolin', 'cefuroxime', 'cephalexin', 'gentamicin', 'tobramycin', 'amikacin'], note: '장관병원균 — 1·2세대 Cef/Aminoglycoside는 in vitro S여도 임상 무효(보고 금지)' },
  { org: ['listeria'], drugs: ['cephalexin', 'cefazolin', 'ceftriaxone', 'cefotaxime', 'ceftazidime', 'cefepime'], note: 'Listeria는 모든 세팔로스포린 고유내성' },
  { org: ['bacteroides', 'clostridioides', 'clostridium'], drugs: ['aminoglycoside', 'gentamicin', 'aztreonam', 'ciprofloxacin', 'trimethoprim'], note: '혐기성균 — Aminoglycoside/Aztreonam 고유내성' },
];

// 정규화: 소문자·마침표 제거·공백 정리 → 'S. aureus'/'E. coli' 등 축약형 매칭
const norm = (s: string): string => (s ?? '').toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
const isR = (i: string | null): boolean => (i ?? '').trim().toUpperCase().startsWith('R');
const isS = (i: string | null): boolean => (i ?? '').trim().toUpperCase().startsWith('S');
const isSorI = (i: string | null): boolean => { const u = (i ?? '').trim().toUpperCase(); return u.startsWith('S') || u.startsWith('I'); };
const includesAny = (s: string, subs: string[]) => subs.some((x) => s.includes(x));
const hasR = (sus: SusEntry[], names: string[]): boolean =>
  sus.some((s) => isR(s.interpretation) && includesAny(norm(s.antibiotic ?? ''), names));
// β-lactam/억제제 병합(pip-tazo·amox-clav·amp-sulbactam)은 ESBL여도 S 가능 → ESBL 불일치 대상에서 제외
const isBetaLactamaseInhibitorCombo = (ab: string): boolean => includesAny(ab, ['tazobactam', 'clavulan', 'sulbactam']);
const isSaureus = (o: string): boolean => includesAny(o, ['aureus', 'mrsa', 'mssa']);
const isEcoliKleb = (o: string): boolean => includesAny(o, ['escherichia', 'coli', 'klebsiella']);

export function validateAst(organism: string | null, sus: SusEntry[]): AstWarning[] {
  const o = norm(organism ?? '');
  const warnings: AstWarning[] = [];
  if (!o) return warnings;

  // 1) 고유내성 위반 — 고유내성 약제에 S/I 보고
  for (const rule of INTRINSIC_R) {
    if (!includesAny(o, rule.org)) continue;
    for (const s of sus) {
      const ab = norm(s.antibiotic ?? '');
      // Enterococcus 고유내성 gentamicin은 '고농도(High-level, synergy)' 검사와 구분 — HLG S는 정당(제외)
      if (includesAny(ab, ['high', 'synerg', 'hlg', 'hlar'])) continue;
      if (includesAny(ab, rule.drugs) && isSorI(s.interpretation)) {
        warnings.push({ antibiotic: s.antibiotic ?? '', rule: '고유내성', message: `${organism}은(는) ${rule.note} — ${s.antibiotic} ${s.interpretation} 재확인 필요` });
      }
    }
  }

  // 2) MRSA 표현형 불일치 — Oxacillin/Cefoxitin R이면 다른 β-lactam도 R이어야
  if (isSaureus(o)) {
    const mrsa = sus.some((s) => isR(s.interpretation) && includesAny(norm(s.antibiotic ?? ''), ['oxacillin', 'cefoxitin', 'methicillin']));
    if (mrsa) {
      for (const s of sus) {
        const ab = norm(s.antibiotic ?? '');
        // ceftaroline 등 MRSA-active 세팔로스포린은 제외(정당한 S)
        if (isS(s.interpretation) && includesAny(ab, ['penicillin', 'ampicillin', 'amoxicillin', 'cefazolin', 'ceftriaxone', 'cefepime', 'imipenem', 'meropenem']) && !ab.includes('ceftaroline')) {
          warnings.push({ antibiotic: s.antibiotic ?? '', rule: 'MRSA 표현형', message: `MRSA(Oxacillin R)는 β-lactam 내성 — ${s.antibiotic} S 재확인 필요` });
        }
      }
    }
  }

  // 3) VRSA(Vancomycin 내성 황색포도상구균) — 극히 드묾. 확인검사+감염관리·보건당국 보고 필요(치명적).
  if (isSaureus(o) && hasR(sus, ['vancomycin'])) {
    warnings.push({ antibiotic: 'Vancomycin', rule: 'VRSA(중대)', message: '⚠ Vancomycin 내성 S.aureus는 극히 드묾 — 확인검사 필수, 감염관리·보건당국 보고' });
  }

  // 4) ESBL 표현형 — E.coli/Klebsiella가 3세대 Cef 내성인데 Penicillin/Aztreonam S면 불일치(ESBL은 모두 R)
  if (isEcoliKleb(o)) {
    const ceph3R = hasR(sus, ['ceftriaxone', 'cefotaxime', 'ceftazidime']);
    if (ceph3R) {
      for (const s of sus) {
        const ab = norm(s.antibiotic ?? '');
        // pip-tazo·amox-clav 등 β-lactamase 억제제 병합은 ESBL이라도 정당한 S → 제외
        if (isS(s.interpretation) && includesAny(ab, ['ampicillin', 'piperacillin', 'aztreonam', 'cefotaxime', 'ceftazidime']) && !isBetaLactamaseInhibitorCombo(ab)) {
          warnings.push({ antibiotic: s.antibiotic ?? '', rule: 'ESBL 표현형', message: `3세대 Cef 내성(ESBL 의심) — ${s.antibiotic} S 불일치, ESBL 확인·전 penicillin/aztreonam 내성 보고 검토` });
        }
      }
    }
  }

  // 5) CRE 불일치 — 장내세균이 Carbapenem 내성인데 3세대 Cef S면 이례적(CRE는 통상 광범위 내성)
  if (includesAny(o, ['escherichia', 'coli', 'klebsiella', 'enterobacter', 'citrobacter', 'serratia', 'morganella', 'providencia'])) {
    const carbaR = hasR(sus, ['imipenem', 'meropenem', 'ertapenem']);
    if (carbaR && sus.some((s) => isS(s.interpretation) && includesAny(norm(s.antibiotic ?? ''), ['ceftriaxone', 'cefotaxime', 'ceftazidime']))) {
      warnings.push({ antibiotic: 'Carbapenem', rule: 'CRE 이례적', message: 'Carbapenem 내성인데 3세대 Cef 감수성 — 이례적 표현형, 카바페넴분해효소 확인' });
    }
  }

  // 6) Penicillin 감수성 S.aureus — 대부분 penicillinase 생산으로 드묾. β-lactamase 확인 후 보고.
  if (isSaureus(o) && sus.some((s) => isS(s.interpretation) && norm(s.antibiotic ?? '').includes('penicillin') && !norm(s.antibiotic ?? '').includes('penicillinase'))) {
    warnings.push({ antibiotic: 'Penicillin', rule: 'Penicillin-S 확인', message: 'S.aureus의 Penicillin 감수성은 드묾 — β-lactamase(nitrocefin/유도) 확인 필요' });
  }

  return warnings;
}
