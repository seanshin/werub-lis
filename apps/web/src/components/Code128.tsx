'use client';

/**
 * Code128.tsx — 웹 공용 컴포넌트.
 *
 * 제공: Code128Svg.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { code128Widths } from '@lis/shared';

/**
 * 실물 Code128 바코드 SVG(P1-19) — 스캐너로 읽히는 규격 심볼로지.
 * 이전 화면 라벨은 문자코드 기반 장식 막대라 스캔되지 않았다(ZPL 출력만 실물).
 * quiet zone 포함, 모듈 단위 viewBox라 인쇄 크기와 무관하게 비율 유지.
 */
export function Code128Svg({ value, height = 36 }: { value: string; height?: number }) {
  let widths: number[];
  try {
    widths = code128Widths(value);
  } catch {
    return null; // 인코딩 불가 문자(비ASCII 등) — 바코드 없이 텍스트만 인쇄
  }
  const quiet = 10; // 규격 최소 quiet zone(10모듈)
  const total = widths.reduce((s, w) => s + w, 0) + quiet * 2;
  const bars: { x: number; w: number }[] = [];
  let x = quiet;
  widths.forEach((w, i) => {
    if (i % 2 === 0) bars.push({ x, w }); // 짝수 인덱스=막대, 홀수=공백
    x += w;
  });
  return (
    <svg viewBox={`0 0 ${total} ${height}`} style={{ width: '100%', height }} preserveAspectRatio="none" shapeRendering="crispEdges" aria-hidden className="my-1">
      {bars.map((b, i) => (
        <rect key={i} x={b.x} y={0} width={b.w} height={height} fill="#000" />
      ))}
    </svg>
  );
}
