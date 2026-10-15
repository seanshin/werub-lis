/**
 * vitest.e2e.config.ts — api 모듈 구성요소.
 *
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';
import { fileURLToPath } from 'node:url';

// E2E 전용 설정 — NestJS DI를 위해 SWC로 데코레이터 메타데이터 방출.
export default defineConfig({
  // @lis/shared는 런타임(컨테이너)용으로 CJS dist를 정본(main)으로 노출한다.
  // 테스트는 빌드 산출물에 의존하지 않고 **원본 소스**를 직접 본다 —
  // dist가 없다고 테스트 전체가 죽거나(실제로 겪음), 오래된 dist로 통과하는 일을 막는다.
  resolve: {
    alias: {
      '@lis/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.e2e-spec.ts'],
    testTimeout: 30000,
    hookTimeout: 40000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
  plugins: [swc.vite()],
});
