/**
 * 아이콘 세트 — 인라인 SVG, 외부 의존 없음.
 *
 * 왜 이모지를 걷어내는가: ⚠ 같은 이모지는 OS·브라우저마다 서체가 달라 같은 화면이
 * 기기마다 다르게 보이고(윈도우에선 컬러 이모지, 맥에선 다른 모양), 크기·정렬을
 * 제어할 수 없어 글줄에서 위아래로 튄다. 임상 화면에서 경고 표시가 기기마다
 * 달라 보이는 것은 곤란하다.
 *
 * 규칙
 *  - `currentColor`만 쓴다 — 색은 부모(text-warn/text-crit …)가 정한다.
 *    아이콘이 자기 색을 가지면 색 역할 체계(crit=환자 즉시 위험)가 무너진다.
 *  - 기본 크기는 `1em` — 글자 크기를 따라간다. 글줄에 섞여도 튀지 않게 정렬 보정.
 *  - 선 굵기 1.75 고정. 굵기가 섞이면 아이콘이 제각각으로 보인다.
 *  - 장식용 기본값 `aria-hidden` — 의미는 옆 텍스트가 전달한다. 텍스트 없이 단독으로
 *    쓸 때만 `label`을 주면 접근성 이름이 붙는다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import type { SVGProps } from 'react';

interface Props extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  /** 단독 사용 시 접근성 이름. 생략하면 장식(aria-hidden)으로 처리한다. */
  label?: string;
}

function base({ label, className = '', ...rest }: Props) {
  return {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    width: '1em',
    height: '1em',
    // 글줄 가운데에 맞춘다 — baseline 정렬이면 아이콘이 아래로 처진다
    className: `inline-block shrink-0 align-[-0.125em] ${className}`,
    ...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true }),
    ...rest,
  };
}

/** 주의·경고 — 업무 이상(warn)과 임상 위험(crit) 양쪽에서 쓴다. 색으로 구분한다. */
export function IconWarn(p: Props) {
  return (
    <svg {...base(p)}>
      <path d="M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  );
}

/** 정보·안내 */
export function IconInfo(p: Props) {
  return (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-4M12 8h.01" />
    </svg>
  );
}

/** 완료·정상 */
export function IconCheck(p: Props) {
  return (
    <svg {...base(p)}>
      <path d="m4 12.5 5 5L20 6.5" />
    </svg>
  );
}

/** 차단·불가 */
export function IconBlock(p: Props) {
  return (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="9" />
      <path d="m5.6 5.6 12.8 12.8" />
    </svg>
  );
}

/** 대기·경과 시간 */
export function IconClock(p: Props) {
  return (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5.2l3.2 1.9" />
    </svg>
  );
}

/** 잠김·보호(권한·서명 고정) */
export function IconLock(p: Props) {
  return (
    <svg {...base(p)}>
      <rect x="4" y="10.5" width="16" height="10" rx="2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

/** 라이트 모드(해) */
export function IconSun(p: Props) {
  return (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

/** 다크 모드(달) */
export function IconMoon(p: Props) {
  return (
    <svg {...base(p)}>
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
    </svg>
  );
}

/** 밀도(행 간격) 전환 */
export function IconDensity(p: Props) {
  return (
    <svg {...base(p)}>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

/** 접힘/펼침 표시 — `open`이면 아래, 아니면 오른쪽. */
export function IconChevron({ open, ...p }: Props & { open?: boolean }) {
  return (
    <svg {...base(p)}>
      <path d={open ? 'm6 9 6 6 6-6' : 'm9 6 6 6-6 6'} />
    </svg>
  );
}
