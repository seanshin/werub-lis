/**
 * 개시 조직/외부 결정 레지스트리(순수) — 시스템 상태로 추론할 수 없는 '사람·조직 결정' 목록.
 * 콘솔이 이 레지스트리 × DecisionRecord를 합쳐 상태·다음행동을 보여준다. (마크다운 체크리스트를 시스템으로)
 * blocking=true는 결정 전 개시 불가(콘솔 blockingOpen에 계수). owner는 결정 주체 부서.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export interface DecisionItem {
  key: string;
  axis: string; // 콘솔 축(⑤ 조직·외부 결정)
  label: string;
  owner: string;
  blocking: boolean;
  hint: string; // 무엇을 결정·기입해야 하는지
}

export const DECISION_AXIS = '5';

export const DECISION_ITEMS: DecisionItem[] = [
  { key: 'infra_aws', axis: DECISION_AXIS, label: 'AWS 서울 인프라 이전', owner: '인프라', blocking: true, hint: '실 서비스 리전(서울) EC2·RDS·S3 이전 완료 확정(법적 요건)' },
  { key: 'cred_cutover', axis: DECISION_AXIS, label: 'dev→운영 자격증명 컷오버', owner: '보안', blocking: true, hint: 'JWT/DB/HIS/PACS 운영 시크릿 적용·dev 자격 폐기 확정' },
  // §H 실서비스 개시 선행 결정(체크리스트 "착수 조건: H1~H5 결정 완료") — 문서(docs/실서비스_결정요청_H1-H5.md)에만
  //   있던 것을 시스템 결정으로 승격. H1·H2·H5는 하드게이트(법무·VPN 리드타임·네트워크 이중화 의존), H3·H4는 목표승인·범위결정(정리).
  { key: 'h1_legal', axis: DECISION_AXIS, label: 'H1 법무·정보보호 회신(EMR 해당여부·보안인증·백업기준)', owner: '법무', blocking: true, hint: '전자의무기록 해당 여부·보안인증 요건·백업 저장소 기준 회신 확정(docs/실서비스_결정요청_H1-H5.md)' },
  { key: 'h2_vpn', axis: DECISION_AXIS, label: 'H2 HIS·PACS Site-to-Site VPN 방식 합의', owner: '인프라', blocking: true, hint: 'VPN 방식·회선 합의 — 리드타임 최장, 최우선 착수. 2026-07-29 HIS·PACS에 연결정보 4건 질의 발송(소재·VPN종단·허용목록·MLLP TLS) — 회신 결과별 진행경로 docs/LIS_질의_2026-07-29_H2_VPN_연결정보.md' },
  { key: 'h5_single_az', axis: DECISION_AXIS, label: 'H5 RDS Single-AZ 승인', owner: '인프라', blocking: true, hint: 'RDS Single-AZ 승인 — H1의 이중화 네트워크 해석에 의존' },
  { key: 'h3_rpo_rto', axis: DECISION_AXIS, label: 'H3 RPO 5분·RTO 1시간 목표 승인', owner: '인프라', blocking: false, hint: 'RTO 1시간은 실측 뒷받침(기술구간 1분 미만) → 원안 승인 권고. RPO는 개시 인프라 조건부 — AWS면 5분 그대로, 현 서버면 최대 24시간(archive_mode off·일1회)이라 백업주기 1~4시간 상향 권고. 결정요청서 §H3 갱신됨(docs/실서비스_결정요청_H1-H5.md·복구리허설_2026-07-29_결과.md)' },
  { key: 'h4_s5_scope', axis: DECISION_AXIS, label: 'H4 S5(첨부 S3 분리) 개시 포함 여부', owner: '인프라', blocking: false, hint: 'S5 개시 포함 결정 — RDS 스토리지 산정에 영향' },
  { key: 'retention_legal', axis: DECISION_AXIS, label: '감사 보존기간 법무 확정값', owner: '법무', blocking: false, hint: '법정 최소 보존기간 최종값 확정(확정 후 LIFECYCLE_PURGE on)' },
  { key: 'pacs_cutover', axis: DECISION_AXIS, label: 'PACS 컷오버 일정·PID', owner: 'PACS·병리', blocking: false, hint: '실 PID·컷오버 일정 확정, cutover-preflight 실행' },
  { key: 'khis_license', axis: DECISION_AXIS, label: 'KHIS 용어 라이선스', owner: '규제', blocking: false, hint: '라이선스 발급 후 정식 SNOMED/용어 코드셋 반영(현 스타터셋)' },
  { key: 'pathology_edi', axis: DECISION_AXIS, label: '병리 EDI 코드셋 확정', owner: '병리', blocking: false, hint: '병리과 공식 확정 코드로 HIS 프리픽스·라우팅 정합' },
  { key: 'edi_hira', axis: DECISION_AXIS, label: '심평원 수가코드 확정', owner: '원무·규제', blocking: false, hint: '실 수가코드·산정규칙 확정 후 seed 교체(미적재도 캡처·전송 정상)' },
  { key: 'backup_offsite_decision', axis: DECISION_AXIS, label: '오프사이트 백업 경로 확정', owner: '운영', blocking: false, hint: 'LIS_BACKUP_OFFSITE 경로·보관정책 확정(설정 반영은 백업 항목)' },
  // 2026-07-29 추가 — 잔여 의뢰 항목 중 캡처 표면이 없어 문서에만 있던 2건(docs/개시_잔여항목_의뢰_검증서.md).
  //   문서에만 두면 회신 여부를 아무도 추적하지 않는다(§H를 결정으로 승격한 것과 같은 이유).
  { key: 'his_newtrack_reply', axis: DECISION_AXIS, label: 'HIS 신규 트랙 LIS 접점 회신(119·NHIS·NIMS/KIDS·모바일)', owner: '연동', blocking: false, hint: '✅2026-07-29 회신 수령 — 4트랙 전부 미해당(개시 범위 증가 없음). A 시크릿 무창회전 순서 확정·LIS 준비 완료(①대기), C 병합 재전파는 HIS #2 배포 후 왕복검증 필요(docs/HIS_회신_2026-07-29_요청3건_회신.md)' },
  { key: 'license_legal', axis: DECISION_AXIS, label: '라이선스 법무 검토', owner: '법무', blocking: false, hint: 'LICENSE 제3조(고객 사용권) 범위·제8조(책임 제한) 한도·의료기기 해당성 추가 의무 검토 후 확정' },
];

export const DECISION_STATUSES = ['PENDING', 'IN_PROGRESS', 'DECIDED', 'HOLD'] as const;
export function isDecisionStatus(s: string): boolean {
  return (DECISION_STATUSES as readonly string[]).includes(s);
}
