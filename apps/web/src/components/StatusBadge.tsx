'use client';

/**
 * StatusBadge.tsx — 웹 공용 컴포넌트.
 *
 * 제공: FlagBadge, HoldBadge, VerifyBadge.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { statusLabel } from '@lis/shared';

/**
 * 결과 플래그/상태 배지 — 전 화면 공통(UX-P1 상태 강조 일관화).
 * 색만으로 의미를 전하지 않는다 — **화살표 기호를 함께 표시**해 색맹 사용자도 방향을 읽는다(기획 §1-6).
 */
const FLAG: Record<string, { cls: string; label: string; sign: string }> = {
  HH: { cls: 'bg-crit/15 text-crit', label: '위험치 상한 초과', sign: '↑↑' },
  LL: { cls: 'bg-crit/15 text-crit', label: '위험치 하한 미만', sign: '↓↓' },
  H: { cls: 'bg-warn/20 text-warn', label: '참고치보다 높음', sign: '↑' },
  L: { cls: 'bg-warn/20 text-warn', label: '참고치보다 낮음', sign: '↓' },
  N: { cls: 'bg-good/15 text-good', label: '정상 범위', sign: '' },
};

// 보류 사유 — crit는 위험치에만(§1-3), 나머지는 주의 등급
const HOLD: Record<string, string> = {
  CRITICAL: 'bg-crit/15 text-crit', INSTRUMENT: 'bg-warn/20 text-warn',
  QC: 'bg-warn/20 text-warn', DELTA: 'bg-warn/20 text-warn', NONNUMERIC: 'bg-bg text-ink-2',
  NO_RANGE: 'bg-warn/20 text-warn', POLICY: 'bg-bg text-ink-2', SENDOUT: 'bg-bg text-ink-2',
};

const VERIFY: Record<string, string> = {
  AUTO: 'bg-good/15 text-good', VERIFIED: 'bg-good/15 text-good', PENDING: 'bg-warn/15 text-warn',
};

export function FlagBadge({ flag }: { flag: string | null | undefined }) {
  if (!flag) return <span className="text-ink-3">—</span>;
  const f = FLAG[flag] ?? { cls: 'bg-bg text-ink-2', label: flag, sign: '' };
  return (
    <span className={`px-1.5 py-0.5 r-chip t-micro ${f.cls}`} aria-label={`${flag} — ${f.label}`}>
      {flag}{f.sign && <span aria-hidden className="ml-0.5">{f.sign}</span>}
    </span>
  );
}

/** 보류 사유 — 원시 코드(NO_RANGE 등) 대신 한글 라벨(§2-3). 정본은 shared statusLabel. */
export function HoldBadge({ reason }: { reason: string | null | undefined }) {
  if (!reason) return null;
  return <span className={`px-1.5 py-0.5 r-chip t-micro ${HOLD[reason] ?? 'bg-bg text-ink-2'}`}>{statusLabel(reason)}</span>;
}

/** 검증 상태 — AUTO/VERIFIED/PENDING을 한글로. */
export function VerifyBadge({ state }: { state: string | null | undefined }) {
  if (!state) return null;
  return <span className={`px-1.5 py-0.5 r-chip t-micro ${VERIFY[state] ?? 'bg-bg text-ink-2'}`}>{statusLabel(state)}</span>;
}
