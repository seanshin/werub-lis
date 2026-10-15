/**
 * vitest.config.ts — api 모듈 구성요소.
 *
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// 단위 테스트 설정. 이전에는 설정 파일 없이 기본값으로 돌았는데,
// @lis/shared가 CJS dist를 main으로 노출하면서 별칭이 필요해졌다.
export default defineConfig({
  // @lis/shared는 런타임(컨테이너)용으로 CJS dist를 정본(main)으로 노출한다.
  // 테스트는 빌드 산출물에 의존하지 않고 **원본 소스**를 직접 본다 —
  // dist가 없다고 테스트가 죽거나, 오래된 dist로 통과하는 일을 막는다.
  resolve: {
    alias: {
      '@lis/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.spec.ts'], // e2e는 vitest.e2e.config.ts가 따로 담당
  },
});
