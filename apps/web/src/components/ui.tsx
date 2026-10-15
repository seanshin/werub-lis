'use client';

/**
 * ui.tsx — 웹 공용 컴포넌트.
 *
 * 제공: EmptyState, Loading, ErrorText, Content, BTN, Section, PageHeader, StatBadge, Field, TableSkeleton.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import Link from 'next/link';
import { ReactNode, ReactElement, isValidElement, cloneElement } from 'react';
import { IconWarn } from '@/components/Icon';

/** 빈 상태 — 일관된 안내 + 다음 액션 유도. */
export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: { label: string; href: string } }) {
  return (
    <div className="py-10 text-center">
      <div className="w-10 h-10 mx-auto mb-2 rounded-full bg-bg grid place-items-center text-ink-3" aria-hidden>◔</div>
      <p className="text-sm text-ink-2 font-medium">{title}</p>
      {hint && <p className="text-xs text-ink-3 mt-1">{hint}</p>}
      {action && <Link href={action.href} className="inline-block mt-3 text-sm text-teal font-semibold underline">{action.label}</Link>}
    </div>
  );
}

/** 로딩 상태 — empty와 구분되는 명시적 스피너(aria-live). */
export function Loading({ label = '불러오는 중…' }: { label?: string }) {
  return (
    <div className="py-10 flex flex-col items-center gap-2 text-ink-3" role="status" aria-live="polite">
      <span className="w-6 h-6 rounded-full border-2 border-line border-t-teal animate-spin" aria-hidden />
      <span className="text-xs">{label}</span>
    </div>
  );
}

/** 에러 배너 — 스크린리더 알림(aria-live) 포함. */
export function ErrorText({ message }: { message: string }) {
  if (!message) return null;
  return <p role="alert" aria-live="assertive" className="text-sm text-crit mb-3"><IconWarn className="mr-1" />{message}</p>;
}

/** 페이지 콘텐츠 래퍼 — 스킵 링크 대상 landmark. */
export function Content({ children }: { children: ReactNode }) {
  return <div id="main">{children}</div>;
}

/**
 * 버튼 톤 정본(UX 기획 §1-3) — **crit(빨강) 채움은 "환자에게 즉시 위험한 임상 행위"에만.**
 *
 * 위험 색이 흔해지면 진짜 위험치(HH/LL)가 화면에서 묻힌다. 실측에서 crit가 병합·정리·반려 등
 * 업무 액션에도 채워져 있었다(118곳). 파괴적이지만 환자 위험이 아닌 동작은 **외곽선형**으로
 * 표현하고, 빨강 채움은 확인 다이얼로그에서만 쓴다.
 */
export const BTN = {
  /** 화면의 주 액션(teal 채움) — 화면당 1개 원칙 */
  primary: 'py-1.5 px-3 rounded-lg bg-teal text-white font-semibold text-sm transition-colors duration-150 hover:bg-teal-2',
  /** 보조 액션(중립 외곽선) */
  neutral: 'py-1.5 px-3 rounded-lg border border-line text-ink-2 font-semibold text-sm transition-colors duration-150 hover:border-teal hover:text-teal',
  /** 파괴적이지만 환자 위험 아님(삭제·병합·정리·거부) — 외곽선형 */
  danger: 'py-1.5 px-3 rounded-lg border border-crit text-crit font-semibold text-sm transition-colors duration-150 hover:bg-crit/10',
  /** 환자에게 즉시 위험한 임상 행위(수혈 출고·회수 등) — 유일하게 crit 채움 */
  critical: 'py-1.5 px-3 rounded-lg bg-crit text-white font-semibold text-sm transition-colors duration-150 hover:brightness-95',
} as const;

/**
 * 섹션 카드(§1-2) — 24화면이 각자 조립하던 `<section className="bg-surface border …">`의 정본.
 * 제목·한 줄 설명·본문 배치를 통일한다(설명은 "이 섹션에서 무엇을 하는가").
 */
export function Section({ title, hint, action, children, className = '' }: {
  title?: ReactNode; hint?: ReactNode; action?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={`bg-surface border border-line r-card e-raised p-5 ${className}`}>
      {(title || action) && (
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            {title && <h2 className="t-section">{title}</h2>}
            {hint && <p className="t-meta mt-0.5">{hint}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

/** 화면 헤더(§3-1) — 제목 + 한 줄 설명 + 액션. 모든 화면이 같은 골격을 갖게 한다. */
export function PageHeader({ title, hint, action }: { title: ReactNode; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
      <div>
        <h1 className="t-page">{title}</h1>
        {hint && <p className="t-meta mt-1">{hint}</p>}
      </div>
      {action && <div className="flex items-center gap-2">{action}</div>}
    </div>
  );
}

/** 상태 배지(§1-2) — 클래스 문자열 인라인 조립을 대체. 색 규칙(§1-3)을 강제한다. */
export function StatBadge({ tone = 'neutral', children }: { tone?: 'neutral' | 'good' | 'warn' | 'crit' | 'info'; children: ReactNode }) {
  const cls = {
    neutral: 'bg-bg text-ink-2',
    good: 'bg-good/15 text-good',
    warn: 'bg-warn/20 text-warn',
    crit: 'bg-crit/15 text-crit', // 환자에게 즉시 위험한 상태에만(§1-3)
    info: 'bg-indigo/15 text-indigo',
  }[tone];
  return <span className={`px-2 py-0.5 r-chip t-micro ${cls}`}>{children}</span>;
}

/** 입력 필드(§1-2) — 라벨·설명·오류 배치 통일. 오류는 aria-describedby로 연결한다. */
export function Field({ label, hint, error, htmlFor, children }: {
  label: ReactNode; hint?: ReactNode; error?: string; htmlFor?: string; children: ReactNode;
}) {
  const errId = htmlFor ? `${htmlFor}-err` : undefined;
  // htmlFor를 주지 않은 호출도 스크린리더가 읽도록, 자식 입력에 aria-label을 주입한다.
  const labelText = typeof label === 'string' ? label : undefined;
  const child = !htmlFor && labelText && isValidElement(children) && !(children.props as { 'aria-label'?: string })['aria-label']
    ? cloneElement(children as ReactElement<{ 'aria-label'?: string }>, { 'aria-label': labelText })
    : children;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="t-meta font-semibold text-ink">{label}</label>
      {child}
      {hint && !error && <span className="t-micro">{hint}</span>}
      {error && <span id={errId} role="alert" className="t-micro text-crit">{error}</span>}
    </div>
  );
}

/** 표 스켈레톤(§3-4) — 스피너 대신. 레이아웃 이동이 적어 체감이 낫다. */
export function TableSkeleton({ rows = 3, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div role="status" aria-label="불러오는 중" className="flex flex-col gap-2 py-2">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-2">
          {Array.from({ length: cols }).map((_, c) => (
            <span key={c} className="skeleton h-4 r-chip flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}
