'use client';

/**
 * /admin/signoff 화면 (`/admin/signoff`).
 *
 * 사이드바 GROUPS에 없는 경로(로그인·도움말·상세 진입 등).
 * 데이터는 `lib/api.ts`의 `apiFetch`로만 가져온다(HTTP 호출 정본).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// 통합됨: 서명 워크시트는 '서명·결재'(/admin/gates)의 탭으로 이동. 북마크 호환용 리다이렉트.
export default function SignoffRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/admin/gates'); }, [router]);
  return null;
}
