'use client';

/**
 * /admin/readiness 화면 (`/admin/readiness`).
 *
 * 사이드바 GROUPS에 없는 경로(로그인·도움말·상세 진입 등).
 * 데이터는 `lib/api.ts`의 `apiFetch`로만 가져온다(HTTP 호출 정본).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// 통합됨(P1): 개시 준비도는 '운영 관리 콘솔'(/admin/console)의 개시차단 필터로 승격. 북마크 호환 리다이렉트.
export default function ReadinessRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/admin/console'); }, [router]);
  return null;
}
