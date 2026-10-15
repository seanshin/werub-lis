'use client';

/**
 * AppShell.tsx — 웹 공용 컴포넌트.
 *
 * 제공: AppShell.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Sidebar from '@/components/Sidebar';
import CommandPalette from '@/components/CommandPalette';
import { getToken } from '@/lib/api';

/**
 * 사이드바 + 본문 셸. 로그인('/')은 모바일 상단바가 없으므로 pt-12 오프셋을 제거.
 * 인증 가드 정본(Q10) — 미인증 접근은 여기서 로그인으로 돌려보낸다(정적 export라 Next
 * 미들웨어 불가). 각 페이지의 `if (!getToken())` 체크는 로드 호출 게이트로만 남는다
 * (미인증 상태에서 API 호출이 나가 401 소음을 만들지 않게).
 */
export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isLogin = pathname === '/';
  useEffect(() => {
    if (!isLogin && !getToken()) router.replace('/');
  }, [isLogin, pathname, router]);

  // 밀도(§1-7) — 검사실은 목록을 길게 본다. 행 높이만 줄이고 글자 크기는 유지한다.
  useEffect(() => {
    const d = localStorage.getItem('lis_density');
    if (d === 'compact') document.documentElement.dataset.density = 'compact';
  }, []);
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      {!isLogin && <CommandPalette />}
      <div className={`flex-1 min-w-0 ${isLogin ? '' : 'pt-12 md:pt-0'}`}>{children}</div>
    </div>
  );
}
