#!/usr/bin/env node
/**
 * 색 토큰 사용 게이트 — 코드가 쓰는 색 유틸이 실제로 정의된 토큰인지 대조한다.
 *
 * 왜 필요한가: Tailwind v4는 `@theme`에 없는 색으로 유틸을 만들면 **클래스를 아예
 * 생성하지 않는다**. 오류도 경고도 없다. 그래서 `bg-brand text-white` 버튼은
 * **배경이 없는 흰 글자** — 흰 카드 위에서 보이지 않는 버튼이 된다.
 * 실제로 `--color-brand`는 정의된 적이 없는데 8곳에서 쓰이고 있었고, 그중 4곳이
 * 솔리드 버튼이었다(수혈 '적합 혈액 조회'·'판정', QC '리뷰 사인오프'·'목표 확립').
 * 화면을 열어보지 않으면 알 수 없고, 열어봐도 "버튼이 없네" 정도로 지나친다.
 *
 * `check-contrast.mjs`는 **정의된 팔레트의 대비**를 보지만, 코드가 그 팔레트를
 * 실제로 쓰는지는 보지 않는다. 이 게이트가 그 빈틈을 메운다.
 *
 * 판정 방식: 색 계열 접두어(bg-/text-/border-/…) 뒤 이름을 뽑아,
 *   ① globals.css의 `--color-*` 토큰이거나
 *   ② CSS 기본 색어(white/black/transparent/current/inherit)이거나
 *   ③ 색이 아닌 Tailwind 유틸(text-left, border-b, text-sm …)
 * 중 하나여야 한다. 셋 다 아니면 **정의되지 않은 색**으로 보고 실패시킨다.
 * ③은 아래 NON_COLOR에 열거한다 — 새 유틸을 쓰면 게이트가 막고 여기 추가하게 된다
 * (fail-closed: 조용히 통과하느니 한 번 막히는 편이 낫다).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const CSS = readFileSync(join(ROOT, 'apps/web/src/app/globals.css'), 'utf8');

const tokens = new Set([...CSS.matchAll(/--color-([\w-]+):/g)].map((m) => m[1]));
if (tokens.size < 8) {
  console.error(`토큰 파싱 실패(${tokens.size}개) — globals.css 구조가 바뀌었다면 파서를 함께 고칠 것.`);
  process.exit(1);
}

/** 색 유틸을 만드는 접두어 */
const PREFIXES = ['bg', 'text', 'border', 'ring', 'divide', 'fill', 'stroke', 'outline', 'accent', 'caret', 'decoration', 'shadow', 'from', 'via', 'to'];

/** 같은 접두어를 쓰지만 색이 아닌 값들 — 크기·방향·정렬·굵기 등 */
const NON_COLOR = new Set([
  // 색 키워드(토큰 아님)
  'white', 'black', 'transparent', 'current', 'inherit', 'none',
  // 크기 스케일 (text-sm, shadow-lg, ring-2 …)
  'xs', 'sm', 'base', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl',
  '0', '1', '2', '3', '4', '6', '8',
  // 방향·측면 (border-b, border-t-0, divide-y …)
  't', 'b', 'l', 'r', 'x', 'y',
  't-0', 'b-0', 'l-0', 'r-0', 'x-0', 'y-0',
  't-2', 'b-2', 'l-2', 'r-2', 'x-2', 'y-2',
  'l-4', 'b-4', 't-4', 'r-4',
  // 정렬·자간·변형 (text-left, text-center …)
  'left', 'right', 'center', 'justify', 'start', 'end',
  'wrap', 'nowrap', 'balance', 'pretty', 'ellipsis', 'clip', 'top', 'bottom', 'middle',
  'solid', 'dashed', 'dotted', 'double', 'hidden', 'collapse', 'separate', 'auto',
  'gradient-to-r', 'gradient-to-l', 'gradient-to-t', 'gradient-to-b',
  'gradient-to-br', 'gradient-to-bl', 'gradient-to-tr', 'gradient-to-tl',
]);

/** tsx/ts 전부 훑기 */
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx|ts)$/.test(e)) files.push(p);
  }
})(join(ROOT, 'apps/web/src'));

const bad = new Map(); // "bg-brand" → [file:line, …]
// 접두어-이름[/불투명도] — 이름은 소문자로 시작(변수 보간 `${x}`는 제외됨)
const RE = new RegExp(`\\b(${PREFIXES.join('|')})-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?:/\\d{1,3})?\\b`, 'g');

for (const f of files) {
  const lines = readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(RE)) {
      const [, prefix, raw] = m;
      // `border-l-crit`·`divide-y-line`처럼 **면을 지정한 테두리 색**은 정상이다.
      //   접두어 다음의 방향 조각을 떼고 색 이름만 본다.
      const name = /^(border|divide)$/.test(prefix) ? raw.replace(/^[tblrxy]-/, '') : raw;
      if (tokens.has(name) || NON_COLOR.has(name)) continue;
      const key = `${prefix}-${raw}`;
      if (!bad.has(key)) bad.set(key, []);
      bad.get(key).push(`${f.replace(ROOT, '')}:${i + 1}`);
    }
  });
}

if (bad.size) {
  console.error('❌ 정의되지 않은 색 토큰 사용 — Tailwind가 클래스를 생성하지 않아 화면에서 조용히 사라진다:\n');
  for (const [cls, where] of [...bad].sort()) {
    console.error(`  ${cls}  (${where.length}곳)`);
    where.slice(0, 4).forEach((w) => console.error(`    ${w}`));
    if (where.length > 4) console.error(`    … 외 ${where.length - 4}곳`);
  }
  console.error(`\n정의된 토큰: ${[...tokens].sort().join(', ')}`);
  console.error('색이 아닌 새 유틸이라면 이 스크립트의 NON_COLOR에 추가하세요.');
  process.exit(1);
}
console.log(`색 토큰 사용 OK (${files.length}개 파일 · 정의 토큰 ${tokens.size}종)`);
