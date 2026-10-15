/**
 * LIS 로고 마크 — 검사실 삼각플라스크(Erlenmeyer) 라인아트 + teal→indigo 그라디언트 배지.
 * 작은 크기에서도 또렷하게 읽히도록 선 굵기·라운드 조정. 파비콘(app/icon.svg)과 동일 디자인.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { useId } from 'react';

export function Logo({ size = 26, className }: { size?: number; className?: string }) {
  // ★인스턴스별 고유 id — 사이드바에 데스크톱·모바일 두 번 렌더되는데, 같은 그라디언트 id면
  //   먼저 오는(display:none 모바일) 정의로 해석돼 데스크톱 배지가 칠해지지 않는다.
  const gid = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} role="img" aria-label="LIS" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="#0c7a84" />
          <stop offset="1" stopColor="#6244c9" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${gid})`} />
      {/* 플라스크 외곽선 */}
      <path d="M13 7 h6 M14 7 v6.2 L9 22.5 a2 2 0 0 0 1.8 3 h10.4 a2 2 0 0 0 1.8 -3 L18 13.2 V7"
        fill="none" stroke="#fff" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
      {/* 액체 */}
      <path d="M11.4 19 h9.2 l2 3.5 a2 2 0 0 1 -1.8 3 H11.2 a2 2 0 0 1 -1.8 -3 Z" fill="#fff" fillOpacity={0.9} />
      {/* 기포 */}
      <circle cx="14.5" cy="22.6" r="1" fill={`url(#${gid})`} />
      <circle cx="18.4" cy="23.8" r="0.7" fill={`url(#${gid})`} />
    </svg>
  );
}
