#!/usr/bin/env node
/**
 * 색 대비 게이트 — globals.css의 디자인 토큰을 파싱해 WCAG 대비를 실측한다.
 *
 * 왜 자동화하는가: 토큰을 손으로 고치면 대비가 조용히 깨진다. 실제로 라이트 warn이
 * bg 위에서 2.96:1이던 적이 있고, 그 상태로 11px 배지(t-micro)가 판독 불가였다.
 * "바꿀 때 재측정" 규칙을 사람 기억에 맡기지 않고 CI가 강제한다.
 *
 * 기준(WCAG 2.1):
 *   - 본문·작은 글자(<18.66px bold / <24px) → AA 4.5:1
 *   - 굵은 큰 글자 → 3:1  (여기서는 보수적으로 전부 4.5 요구)
 * 검사 대상: 전경 토큰 × 배경 토큰(bg·surface·surface-2) 조합, 라이트/다크 각각.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { readFileSync } from 'node:fs';

const CSS = readFileSync(new URL('../../apps/web/src/app/globals.css', import.meta.url), 'utf8');

/** `--color-x: #hex;` 를 블록 단위로 수집 */
function tokensIn(block) {
  const out = {};
  for (const m of block.matchAll(/--color-([\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) out[m[1]] = m[2];
  return out;
}
/** 선언 블록을 잘라낸다 — 여는 `{` 부터 짝이 맞는 `}` 까지. */
function blockAt(idx) {
  const open = CSS.indexOf('{', idx);
  let depth = 0;
  for (let i = open; i < CSS.length; i++) {
    if (CSS[i] === '{') depth++;
    else if (CSS[i] === '}' && --depth === 0) return CSS.slice(open, i);
  }
  return '';
}
const light = tokensIn(blockAt(CSS.indexOf('@theme')));
// `:root[data-theme="dark"]`는 여러 번 나온다(플래그용 스텁 포함) — 실제 색이 든 블록을 고른다.
let dark = {};
for (const m of CSS.matchAll(/:root\[data-theme="dark"\]/g)) {
  const t = tokensIn(blockAt(m.index));
  if (Object.keys(t).length > Object.keys(dark).length) dark = t;
}

if (Object.keys(light).length < 8 || Object.keys(dark).length < 8) {
  console.error(`토큰 파싱 실패 — 라이트 ${Object.keys(light).length}개 / 다크 ${Object.keys(dark).length}개.`);
  console.error('globals.css 구조가 바뀌었다면 이 스크립트의 파서를 함께 고쳐야 한다(조용히 검사 누락 방지).');
  process.exit(1);
}

const hex = (h) => {
  let s = h.slice(1);
  if (s.length === 3) s = [...s].map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
};
const lum = (h) => {
  const [r, g, b] = hex(h).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

const BACKGROUNDS = ['bg', 'surface', 'surface-2'];
// 전경으로 쓰이는 토큰(배경·라인 제외). ink는 본문, 나머지는 상태·강조색.
const FOREGROUNDS = ['ink', 'ink-2', 'ink-3', 'teal', 'indigo', 'good', 'warn', 'crit'];
const MIN = 4.5;

/**
 * ★기대한 토큰이 없으면 **조용히 검사를 건너뛰지 않고 실패**시킨다.
 *   예전엔 `if (!T[fg]) continue`로 넘겨서, 토큰을 지우거나 이름을 바꾸면 조합 수만
 *   줄어든 채 "OK"가 나왔다(58→55). 게이트가 스스로 약해지는 것을 막는다.
 */
let failed = 0, checked = 0;
for (const [mode, T] of [['라이트', light], ['다크', dark]]) {
  const missing = [...FOREGROUNDS, ...BACKGROUNDS, 'teal-fill', 'good-fill', 'warn-fill', 'crit-fill', 'indigo-fill']
    .filter((k) => !T[k]);
  if (missing.length) {
    console.error(`  ❌ ${mode} 토큰 누락: ${missing.join(', ')} — 이름을 바꿨다면 이 스크립트의 목록도 함께 고칠 것`);
    failed += missing.length;
  }
}
for (const [mode, T] of [['라이트', light], ['다크', dark]]) {
  for (const fg of FOREGROUNDS) {
    if (!T[fg]) continue;
    for (const bgName of BACKGROUNDS) {
      if (!T[bgName]) continue;
      const r = ratio(T[fg], T[bgName]);
      checked++;
      if (r < MIN) {
        failed++;
        console.error(`  ❌ ${mode} ${fg}(${T[fg]}) on ${bgName}(${T[bgName]}) = ${r.toFixed(2)}:1 (기준 ${MIN})`);
      }
    }
  }
}

// 채움 배지(흰 글자 on 상태색)도 검사 — crit/good/warn 배지는 흰 글자를 얹는다.
for (const [mode, T] of [['라이트', light], ['다크', dark]]) {
  for (const fill of ['teal-fill', 'good-fill', 'warn-fill', 'crit-fill', 'indigo-fill']) {
    if (!T[fill]) continue;
    const r = ratio('#ffffff', T[fill]);
    checked++;
    if (r < MIN) {
      failed++;
      console.error(`  ❌ ${mode} 흰 글자 on ${fill} 채움(${T[fill]}) = ${r.toFixed(2)}:1 (기준 ${MIN})`);
    }
  }
}

if (failed) {
  console.error(`\n색 대비 실패 ${failed}건 / ${checked}건 검사 — 토큰을 조정하고 다시 실행하세요.`);
  process.exit(1);
}
console.log(`색 대비 OK (${checked}개 조합 · 전부 ${MIN}:1 이상)`);
