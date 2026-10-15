/**
 * next.config.ts — web 모듈 구성요소.
 *
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import type { NextConfig } from 'next';

/**
 * 보안 헤더 — 운영에서는 nginx에도 동일 헤더를 두지만, 앱 자체에서도 내보내
 * 개발·직접 접근·프록시 설정 누락 시에도 보호가 유지되게 한다.
 *
 * CSP 주의: Next.js는 인라인 스크립트·스타일을 쓰므로 'unsafe-inline'이 필요하다.
 * 그럼에도 frame-ancestors·connect-src·object-src 제한만으로 클릭재킹과 외부 유출 경로는 막힌다.
 * (nonce 기반으로 더 조이려면 미들웨어에서 요청마다 nonce를 발급해야 한다 — 별도 작업)
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'", // 클릭재킹 차단(결과 승인·수혈 출고 버튼 오버레이 방지)
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // @lis/shared는 빌드 산출물이 아니라 원시 TS(main: src/index.ts)를 노출한다.
  // Next가 직접 트랜스파일해야 import가 동작한다.
  transpilePackages: ['@lis/shared'],
  // next/image 사용처가 없는데도 /_next/image 최적화 API는 기본으로 열려 있고,
  // 그 처리기(sharp/libvips)에 미해결 CVE가 남는다. 표면 자체를 닫는다.
  images: { unoptimized: true },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // ★HSTS — 프록시(nginx add_header)에만 있다가 2026-09-09 서버 이관에서 프록시가 Caddy로
          //   바뀌며 **웹 응답에서만** 사라졌다. API는 helmet이 같은 값을 자체 발급해 살아남았고,
          //   나머지 보안헤더도 이 파일이 이중으로 심어 살아남았다 — 프록시 전용이던 것만 정확히 죽었다.
          //   TLS가 CF 엣지에서 끝나도 이 헤더는 브라우저까지 그대로 전달된다(실측).
          //   ⚠ 평문 HTTP 응답에 실려도 브라우저가 무시하므로(RFC 6797) 로컬 개발에 영향 없다.
          //   ⚠ preload는 넣지 않는다 — 등록은 사실상 되돌릴 수 없고 도메인 전체에 영향을 준다.
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          { key: 'Content-Security-Policy', value: CSP },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Permissions-Policy', value: 'geolocation=(), microphone=(), camera=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
