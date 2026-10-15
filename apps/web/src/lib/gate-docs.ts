/**
 * gate-docs.ts — lib 모듈 구성요소.
 *
 * 제공: GateDoc, GATE_DOCS, GATE_DOCS_MAP.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

// 조직 게이트 상신 첨부 근거(권장 기준선). ✅=LIS 산출물 제공 · ☐=주관 부서 작성.
// 정본: docs/조직게이트_상신첨부체크리스트.md — 이 데이터와 동기 유지.

export interface GateDoc {
  gateCode: string;
  title: string;
  owner: string;
  scope: string;
  lis: string[]; // LIS가 산출물로 제공(첨부 근거)
  org: string[]; // 결재 주관 부서가 작성하는 조직 문서
}

export const GATE_DOCS: GateDoc[] = [
  {
    gateCode: 'A-1', title: '수용·청구 정책', owner: '진료부·원무', scope: '검사 수용·청구 정책 승인',
    lis: ['검사 수가·EDI 수가코드 매핑표(서명워크시트 C)'],
    org: ['검사 수용 기준서(대상·경로·급여구분)', '청구 정책서(산정·비급여·삭감대응)', '심평원 수가 고시 근거'],
  },
  {
    gateCode: 'A-2', title: '프로토콜 승인 주관', owner: '진단검사의학과', scope: '검사·Reflex 프로토콜 승인',
    lis: ['검사 프로토콜값 — 참고치·자동검증/델타·QC(서명워크시트 A/B/D)', 'Reflex 프로토콜 이력(위원회번호·HIS-ref)'],
    org: ['SOP(표준작업지침)', 'method validation·참고치 검증 자료', '전문의 검토서·부서 의결서'],
  },
  {
    gateCode: 'A-3', title: '실운영 write 스코프', owner: '보안팀', scope: 'LIS ServiceRequest.write 운영 자격 발급',
    lis: ['API 스코프 명세(운영 write 최소권한)', '감사 근거 — 해시체인+UPDATE 차단·접근추적(/audit)'],
    org: ['접근권한 신청서', '보안 위험평가(RA)/개인정보영향평가(DPIA)', '자격증명 관리 정책(보관·로테이션)', '망분리·보안 검토 결과'],
  },
  {
    gateCode: 'PACS-CUTOVER', title: 'PACS 컷오버', owner: '영상의학·PACS', scope: '실 PID·일정 확정·cutover-preflight',
    lis: ['cutover-preflight 리포트(Accession≤16·PID 바이트보존)', '왕복 스모크 3구간 PASS'],
    org: ['컷오버 계획서(일정·롤백·리허설·비상)', 'MWL/WSI 연동 규격·테스트 결과', '실 PID 매핑표'],
  },
];

export const GATE_DOCS_MAP: Record<string, GateDoc> = Object.fromEntries(GATE_DOCS.map((g) => [g.gateCode, g]));
