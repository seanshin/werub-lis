'use client';

/**
 * 전역 에러 바운더리 — 렌더 예외를 잡아 앱이 흰 화면으로 죽지 않게 한다.
 *
 * 배포 직후 이전 빌드의 청크를 참조하다 깨지는 경우가 실제로 있었다. 그때 사용자가
 * 아무 안내 없이 빈 화면을 보지 않도록, 여기서 복구 경로(새로고침)를 제시한다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useEffect } from 'react';

/**
 * 전역 에러 바운더리(정본) — 이전엔 없어서, 새 배포로 청크 해시가 바뀌면 열려 있던 탭이
 * 옛 청크를 404로 받아(ChunkLoadError) 화면이 조용히 깨지거나 사라진 것처럼 보였다("작업 중 사라짐").
 * 청크/로드류 오류는 새 빌드가 나온 것이므로 자동 새로고침으로 회복하고, 그 외 오류는 사용자에게
 * 명확한 복구 버튼을 준다(작업 손실·혼란 방지).
 */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const isStaleBuild = /ChunkLoadError|Loading chunk|dynamically imported module|Failed to fetch dynamically/i.test(
    `${error?.name} ${error?.message}`,
  );

  useEffect(() => {
    if (isStaleBuild && typeof window !== 'undefined') {
      // 새 버전 배포 감지 — 한 번만 자동 새로고침(루프 방지 플래그)
      const KEY = 'lis_stale_reload';
      if (!sessionStorage.getItem(KEY)) {
        sessionStorage.setItem(KEY, '1');
        window.location.reload();
      }
    } else {
      sessionStorage.removeItem('lis_stale_reload');
    }
  }, [isStaleBuild]);

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-md card p-8 text-center">
        <h1 className="text-lg font-bold text-ink mb-2">{isStaleBuild ? '새 버전이 배포되었습니다' : '문제가 발생했습니다'}</h1>
        <p className="text-sm text-ink-2 mb-5">
          {isStaleBuild
            ? '화면을 새로고침하면 최신 버전으로 이어집니다.'
            : '일시적 오류일 수 있습니다. 다시 시도하거나 새로고침해 주세요.'}
        </p>
        <div className="flex gap-2 justify-center">
          <button onClick={() => reset()} className="py-2 px-4 rounded-lg border border-line text-sm font-semibold hover:bg-bg">다시 시도</button>
          <button onClick={() => window.location.reload()} className="py-2 px-4 rounded-lg bg-teal text-white text-sm font-semibold">새로고침</button>
        </div>
      </div>
    </main>
  );
}
