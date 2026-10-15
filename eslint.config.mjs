// LIS ESLint flat config (D2/C1) — 활성화 완료(2026-07-20). api+web 통합, 위반 0, ci.sh 차단 게이트.
// 비-type-checked 권장 규칙(빠름) + 고가치 correctness 규칙 + web react-hooks. 스타일은 관대(warn/off).
// 실행: `npx eslint "apps/api/src/**/*.ts" "apps/api/test/**/*.ts" "apps/web/src/**/*.{ts,tsx}"`
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**', '**/.turbo/**', '**/*.config.*', '**/prisma/migrations/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended, // 비-type-checked
  {
    // React 컴포넌트(web) — 훅 규칙(rules-of-hooks는 error, deps는 warn). 인라인 disable 지시 해소.
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // 접근성 회귀 차단(UX 기획 §4) — 임상 화면은 키보드·스크린리더 사용자도 쓴다.
      // 라벨 없는 입력·클릭 가능한 비대화형 요소가 다시 들어오면 CI가 막는다.
      'jsx-a11y/alt-text': 'error',
      'jsx-a11y/anchor-has-content': 'error',
      'jsx-a11y/aria-props': 'error',
      'jsx-a11y/aria-role': 'error',
      'jsx-a11y/role-has-required-aria-props': 'error',
      'jsx-a11y/no-redundant-roles': 'error',
      // 오버레이 backdrop을 실제 button으로 전환·Escape 보장 후 승격(2026-07-24). 임상 화면은 키보드 사용자도 쓴다.
      'jsx-a11y/click-events-have-key-events': 'error',
      'jsx-a11y/no-noninteractive-element-interactions': 'error',
    },
  },
  {
    rules: {
      // 고가치(버그성) 규칙만 error, 스타일성은 완화(초기 클린업 최소화)
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Q12: 프로덕션 any 0건 확인 후 재활성화 — any가 다시 들어오면 CI가 막는다(테스트는 아래서 완화)
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-fallthrough': 'error',
      'no-unsafe-optional-chaining': 'error',
      'no-control-regex': 'off', // HL7/ASTM 등 바이너리 프로토콜 파서의 제어문자 정규식은 정상
      'no-useless-assignment': 'off', // 방어적 초기화(예: let ok=false) 오탐 회피 — 관대하게 시작
    },
  },
  {
    // ── Q12 타입인지(type-checked) 트리아지(2026-07-24) ──
    // 562건 전수 측정 후, **버그를 실제로 잡는 저노이즈 규칙만** 켠다. 나머지는 근거를 남기고 보류.
    //
    //   측정 결과:
    //   · no-misused-promises 256건 → **99%가 JSX 핸들러(onClick 등) 오탐**. `checksVoidReturn.attributes:false`로
    //     끄면 3건만 남고, 그 3건이 진짜다(setTimeout/Interval에 async 함수 → reject 미처리). 셋 다 수정 완료.
    //   · no-floating-promises 110건 → **전부 web 클라이언트의 fire-and-forget 로더**(자체 try/catch 보유).
    //     서버(apps/api)는 0건 — 크론 가드로 이미 규율됨. 그래서 **서버에만 error로 강제**해 규율을 고정하고,
    //     web 110건 일괄 `void` 스윕은 회귀 위험 대비 이득이 낮아 보류(불필요한 대량 변경 금지).
    //   · no-unsafe-*(assignment/member-access/call/return/argument) 60건 → apiFetch<T>()·JSON.parse 등
    //     **API 경계의 any**에서 발생. 노이즈 대비 버그 포착이 낮아 보류.
    //   · restrict-template-expressions 28·no-unnecessary-type-assertion 32 → 스타일성, 보류.
    //   · no-base-to-string 6건 → **실제 "[object Object]" 위험**(unknown 스트링화). 전건 수정 후 error 강제.
    //
    // ⚠ 타입인지 규칙은 tsconfig에 포함된 파일만 파싱된다. 스펙/테스트는 프로젝트에 없어 파싱 오류가 나므로
    //   이 블록은 프로덕션 src로만 한정한다(specs 제외). 테스트 override는 아래.
    files: ['apps/api/src/**/*.ts', 'apps/web/src/**/*.ts', 'apps/web/src/**/*.tsx'],
    ignores: ['**/*.spec.ts', '**/*.spec.tsx'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      // 잘못 스트링화되면 조용히 "[object Object]"가 보고서·로그에 박힌다 — 회귀 차단
      '@typescript-eslint/no-base-to-string': 'error',
      // JSX 핸들러 오탐은 끄고(attributes:false), setTimeout/Interval에 async를 넘기는 실 케이스만 잡는다
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
    },
  },
  {
    // 서버는 floating promise가 곧 unhandledRejection(프로세스 위험) — 이미 0건인 상태를 error로 고정한다.
    files: ['apps/api/src/**/*.ts'],
    rules: { '@typescript-eslint/no-floating-promises': 'error' },
  },
  {
    // 테스트는 더 관대(타입인지 규칙도 끈다 — 스텁·목이 많아 노이즈)
    files: ['**/*.spec.ts', '**/test/**'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
);
