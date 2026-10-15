/**
 * 루트 레이아웃 — 전 화면 공통 껍데기(테마·토스트·확인창·AppShell).
 *
 * 여기서 하는 일은 셋이다: ①페인트 전에 저장된 테마를 적용해 흰 화면 깜빡임을 막고
 * ②본문 서체를 미리 받아 글꼴 교체(FOUT)를 줄이며 ③전역 프로바이더를 건다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import type { Metadata } from 'next';
import './globals.css';
import { ConfirmProvider } from '@/components/confirm';
import { ToastProvider } from '@/components/toast';
import AppShell from '@/components/AppShell';

export const metadata: Metadata = {
  title: 'LIS — 검사정보시스템',
  description: 'HIS·PACS 연계 및 유전체 검사 통합 LIS',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <head>
        {/* FOUC 방지 — 페인트 전에 저장된 테마 적용 */}
        {/* 본문 서체 선행 로드 — 표 중심 화면이라 글꼴이 늦게 바뀌면 행 높이가 흔들린다.
            자체 호스팅(내부망 대비)이므로 crossOrigin은 same-origin 기본값을 쓴다. */}
        <link rel="preload" href="/fonts/PretendardVariable.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        {/* FOUC 방지 — 페인트 전에 저장된 테마 적용 */}
        <script dangerouslySetInnerHTML={{ __html: `try{var t=localStorage.getItem('lis_theme');if(t)document.documentElement.dataset.theme=t;}catch(e){}` }} />
      </head>
      <body>
        <ToastProvider>
          <ConfirmProvider>
            <AppShell>{children}</AppShell>
          </ConfirmProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
