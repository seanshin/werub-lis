/**
 * 운영 설정 카탈로그 — 화면에서 바꿀 수 있는 키의 **허용 목록**.
 *
 * 여기 없는 키는 어떤 경로로도 설정되지 않는다. 화이트리스트가 아니라 자유 키였다면
 * 관리자 화면 하나가 `JWT_SECRET`·`DATABASE_URL`까지 덮어쓰는 통로가 된다.
 *
 * 왜 만들었나: 위험치 통보 채널(CRITICAL_WEBHOOK_URL)이 env 전용이라, 담당 부서가 URL을
 * 주더라도 **서버 파일 수정 + 재기동**이 필요했다. 개시를 막는 유일한 항목이 배포 작업에
 * 묶여 있던 셈이다. 운영자가 화면에서 직접 넣고 테스트 발송으로 도달까지 확인하게 한다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export type SettingKind = 'url' | 'secret' | 'number' | 'bool';

export interface SettingDef {
  key: string;
  label: string;
  kind: SettingKind;
  group: string;
  help: string;
  /** 값 자체를 절대 응답에 싣지 않는다(설정 여부만). */
  sensitive?: boolean;
  /** https 강제(PHI가 나가는 경로) */
  requireHttps?: boolean;
  min?: number;
  max?: number;
  placeholder?: string;
}

export const SETTING_DEFS: SettingDef[] = [
  {
    key: 'CRITICAL_WEBHOOK_URL',
    label: '위험치 통보 채널 URL',
    kind: 'url',
    group: '위험치 통보',
    requireHttps: true,
    placeholder: 'https://메신저-게이트웨이/lis/critical',
    help: '위험치가 발생하면 이 주소로 즉시 통보가 나갑니다. 비어 있으면 통보가 LIS 안에만 남고 담당의에게 도달하지 않습니다(유선 통보 필요). 환자 식별정보가 나가므로 https만 허용합니다.',
  },
  {
    key: 'CRITICAL_WEBHOOK_SECRET',
    label: '위험치 채널 서명 키',
    kind: 'secret',
    group: '위험치 통보',
    sensitive: true,
    help: '설정하면 통보 본문을 HMAC-SHA256으로 서명해 수신측이 진위를 검증할 수 있습니다(위조 통보 주입 차단). 저장 후에는 값을 다시 볼 수 없고, 설정 여부만 표시됩니다.',
  },
  {
    key: 'CRITICAL_WEBHOOK_ALLOW_HTTP',
    label: '원내 http 게이트웨이 허용',
    kind: 'bool',
    group: '위험치 통보',
    help: '⚠ 켜면 평문(http)으로도 통보가 나갑니다. 환자명·검사값이 암호화 없이 전송되므로, 원내 폐쇄망 게이트웨이를 부득이 써야 할 때만 켭니다.',
  },
  {
    key: 'CRITICAL_WEBHOOK_FULL_NAME',
    label: '외부 채널에 환자 실명 전송',
    kind: 'bool',
    group: '위험치 통보',
    help: '기본은 마스킹(홍*동)입니다. 켜면 실명이 그대로 나갑니다. 담당의가 환자를 특정하기 쉬워지지만, 메신저 이력에 실명이 남습니다.',
  },
  {
    key: 'CRITICAL_ESCALATION_MINUTES',
    label: '미확인 상향 간격(분)',
    kind: 'number',
    group: '위험치 통보',
    min: 1,
    max: 240,
    placeholder: '15',
    help: '통보 후 이 시간이 지나도 확인(ack)이 없으면 담당의 → 수간호사 → 당직전문의 순으로 상향합니다. 너무 길면 미확인이 방치되고, 너무 짧으면 상향이 남발됩니다.',
  },
  {
    key: 'OPS_WEBHOOK_URL',
    label: '운영 이상 알림 채널 URL',
    kind: 'url',
    group: '운영 감시',
    requireHttps: true,
    placeholder: 'https://메신저-게이트웨이/lis/ops',
    help: '연계 지연·DLQ 적재·위험치 미전달 같은 운영 이상을 통보합니다. 임상 위험치 채널과 분리해 두는 것을 권장합니다. 비어 있으면 이상이 LIS 알림함에만 표시되어 무인 시간대에 아무도 모릅니다.',
  },
  {
    key: 'OPS_STUCK_MINUTES',
    label: '발신 정체 판정(분)',
    kind: 'number',
    group: '운영 감시',
    min: 1,
    max: 1440,
    placeholder: '30',
    help: '결과 발신이 이 시간 넘게 처리되지 않으면 정체로 보고 알립니다.',
  },
  {
    key: 'RETENTION_DAYS_audit_log',
    label: '감사 로그 보존일',
    kind: 'number',
    group: '보존기간·정리',
    min: 730,
    max: 3650,
    placeholder: '1095',
    help: '누가 무엇을 열람·변경했는지의 기록입니다. 개인정보보호법 시행령 §30은 접속기록을 일반 1년, 민감·고유식별정보 취급 시 2년 이상 보존하도록 합니다 — 감사 로그는 유전정보 등 민감접근을 포함하므로 730일 미만으로는 내릴 수 없습니다. 최종값은 법무 확정 대상입니다.',
  },
  {
    key: 'RETENTION_DAYS_interface_log',
    label: '연계 로그 보존일',
    kind: 'number',
    group: '보존기간·정리',
    min: 90,
    max: 3650,
    placeholder: '365',
    help: 'HIS·PACS와 주고받은 원문 기록입니다. 오더 유실·결과 미전송 소명에 쓰이므로 너무 짧으면 사고 조사가 불가능해집니다.',
  },
  {
    key: 'RETENTION_DAYS_notification',
    label: '알림 보존일',
    kind: 'number',
    group: '보존기간·정리',
    min: 180,
    max: 3650,
    placeholder: '365',
    help: '위험치 통보·확인(ack) 이력을 포함합니다. "통보했는가"를 나중에 소명해야 할 수 있습니다.',
  },
  {
    key: 'LIFECYCLE_PURGE',
    label: '보존기간 경과 자동 정리 실행',
    kind: 'bool',
    group: '보존기간·정리',
    help: '⚠ 켜면 매일 04:00에 보존기간이 지난 운영 로그가 **영구 삭제**됩니다(임상 결과는 대상 아님). 법무 확정 전에는 꺼 둡니다. 끈 상태에서도 화면에서 모의 실행(dryRun)으로 대상 건수는 확인할 수 있습니다.',
  },
];

export const SETTING_BY_KEY = new Map(SETTING_DEFS.map((d) => [d.key, d]));

/**
 * 웹훅 대상이 될 수 없는 호스트 — 루프백·링크로컬·비특정 주소.
 * IP 리터럴과 localhost만 본다(DNS 재결속까지 막으려면 해석 시점 검사가 필요하지만,
 * 이 표면은 ADM 전용+감사 대상이라 저장 시점 리터럴 차단으로 위험을 낮춘다).
 */
export function isForbiddenWebhookHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, ''); // IPv6 대괄호 제거
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '::' || h === '0.0.0.0') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true; // 루프백 전 대역
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(h)) return true; // 링크로컬(클라우드 메타데이터 포함)
  if (/^fe80:/i.test(h)) return true; // IPv6 링크로컬
  if (/^::ffff:127\./i.test(h) || /^::ffff:169\.254\./i.test(h)) return true; // v4-mapped
  return false;
}

/**
 * 저장 전 값 검증. 잘못된 값이 들어가면 **통보가 조용히 안 나가는** 상태가 되므로
 * 저장 시점에 막는다(런타임에 로그로만 알리면 아무도 안 본다).
 * 반환: 정규화된 값. 위반 시 예외 메시지 문자열을 throw 하지 않고 `{ error }`로 돌려준다.
 */
export function validateSetting(
  def: SettingDef,
  raw: string,
  allowHttp: boolean,
): { value: string } | { error: string } {
  const v = raw.trim();
  if (v === '') return { value: '' }; // 빈 값 = 해제
  switch (def.kind) {
    case 'url': {
      let u: URL;
      try {
        u = new URL(v);
      } catch {
        return { error: 'URL 형식이 아닙니다(예: https://호스트/경로)' };
      }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') {
        return { error: `지원하지 않는 프로토콜입니다(${u.protocol})` };
      }
      // SSRF 완화(2026-07-30 보안 검토): 루프백·링크로컬(클라우드 메타데이터 169.254.169.254 포함)은
      // 통보 대상일 수 없다 — 서버 자신/인프라 내부로의 발신 원시요소가 되므로 저장 시점에 차단.
      // 원내 사설대역(10./172.16./192.168.)은 정당한 게이트웨이 소재라 허용한다.
      // 운영에서만 강제한다 — E2E는 루프백 목 서버로 '실제 도달·서명'을 검증해야 하고,
      // 그 검증을 포기하면 통보가 정말 나가는지 아무도 확인하지 않게 된다.
      if (process.env.NODE_ENV === 'production' && isForbiddenWebhookHost(u.hostname)) {
        return { error: `루프백·링크로컬 주소는 통보 대상이 될 수 없습니다(${u.hostname})` };
      }
      if (def.requireHttps && u.protocol === 'http:' && !allowHttp) {
        return {
          error:
            'https가 아닙니다 — 환자 정보가 평문으로 전송됩니다. 원내 폐쇄망 게이트웨이라면 "원내 http 게이트웨이 허용"을 먼저 켜세요.',
        };
      }
      return { value: v };
    }
    case 'number': {
      const n = Number(v);
      if (!Number.isFinite(n)) return { error: '숫자가 아닙니다' };
      if (def.min != null && n < def.min) return { error: `${def.min} 이상이어야 합니다` };
      if (def.max != null && n > def.max) return { error: `${def.max} 이하여야 합니다` };
      return { value: String(n) };
    }
    case 'bool':
      if (v !== 'on' && v !== 'off') return { error: "'on' 또는 'off'만 허용됩니다" };
      return { value: v };
    case 'secret':
      if (v.length < 16) return { error: '서명 키는 16자 이상이어야 합니다(추측 방지)' };
      return { value: v };
  }
}

/**
 * 화면 표시용 마스킹. URL은 자격증명·쿼리·**경로**에 토큰이 실려 오는 일이 흔해서
 * (Slack/Teams 등은 토큰이 path에 있다) 그 부분을 가린다. 호스트+첫 경로 세그먼트만 노출해
 * 운영자가 맞는 채널인지는 알되 토큰은 안 보이게 한다.
 */
export function maskSettingValue(def: SettingDef, value: string): string {
  if (!value) return '';
  if (def.sensitive) return '설정됨';
  if (def.kind !== 'url') return value;
  try {
    const u = new URL(value);
    const q = u.search ? '?···' : '';
    const cred = u.username ? '···@' : '';
    const segs = u.pathname.split('/').filter(Boolean);
    let path = '';
    if (segs.length) {
      const head = segs[0].length > 16 ? `${segs[0].slice(0, 6)}…` : segs[0]; // 첫 세그먼트도 길면 토큰류로 보고 축약
      path = segs.length > 1 ? `/${head}/···` : `/${head}`; // 나머지 세그먼트(토큰 가능)는 가림
    }
    return `${u.protocol}//${cred}${u.host}${path}${q}`;
  } catch {
    return value;
  }
}
