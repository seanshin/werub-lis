'use client';

/**
 * 용어집 화면 (`/help/glossary`).
 *
 * 사이드바 GROUPS에 없는 경로(로그인·도움말·상세 진입 등).
 * 데이터는 `lib/api.ts`의 `apiFetch`로만 가져온다(HTTP 호출 정본).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useState, useMemo, useEffect, useRef } from 'react';
import Link from 'next/link';
import { GLOSSARY, searchGlossary, GlossaryTerm } from '@lis/shared';
import { EmptyState, PageHeader, StatBadge } from '@/components/ui';

const CATEGORIES = ['전체', '결과판정', '품질(QC)', '수혈', '미생물', '병리', '유전체', '운영·연계'] as const;
type Category = (typeof CATEGORIES)[number];

/** 용어집(UX 기획 §2-2) — 화면에 뜨는 임상·운영 용어의 뜻과 "왜 중요한가"를 카테고리 탭으로. */
export default function GlossaryPage() {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<Category>('전체');
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // 카테고리별 총 개수(탭 배지) — 검색과 무관하게 전체 기준으로 고정
  const counts = useMemo(() => {
    const m: Record<string, number> = { 전체: GLOSSARY.length };
    for (const g of GLOSSARY) m[g.category] = (m[g.category] ?? 0) + 1;
    return m;
  }, []);

  // 앵커 진입(/help/glossary#delta-check) 시 해당 용어 탭으로 전환 후 스크롤
  useEffect(() => {
    const hash = typeof window !== 'undefined' ? window.location.hash.slice(1) : '';
    if (!hash) return;
    const target = GLOSSARY.find((g) => g.key === hash);
    if (target) setCat(target.category as Category);
    setTimeout(() => document.getElementById(hash)?.scrollIntoView({ block: 'center' }), 80);
  }, []);

  const items = useMemo(() => {
    const found = searchGlossary(q);
    return cat === '전체' ? found : found.filter((g) => g.category === cat);
  }, [q, cat]);

  // 전체 탭에서만 카테고리별로 묶어 보여준다(개별 탭은 그 자체가 카테고리라 평면 목록)
  const grouped = useMemo(() => {
    if (cat !== '전체') return null;
    const m = new Map<string, GlossaryTerm[]>();
    for (const g of items) m.set(g.category, [...(m.get(g.category) ?? []), g]);
    return [...m.entries()];
  }, [items, cat]);

  // 탭 키보드 이동(← → Home End) — WAI-ARIA tabs 패턴
  const onTabKey = (e: React.KeyboardEvent, idx: number) => {
    const last = CATEGORIES.length - 1;
    let next = -1;
    if (e.key === 'ArrowRight') next = idx === last ? 0 : idx + 1;
    else if (e.key === 'ArrowLeft') next = idx === 0 ? last : idx - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    if (next < 0) return;
    e.preventDefault();
    setCat(CATEGORIES[next]);
    tabRefs.current[next]?.focus();
  };

  const renderTerm = (g: GlossaryTerm) => (
    <div key={g.key} id={g.key} className="border-b border-line last:border-0 pb-3 last:pb-0 scroll-mt-24">
      <dt className="font-semibold text-sm flex items-center gap-2 flex-wrap">
        {g.term}
        {g.abbr && <StatBadge>약어</StatBadge>}
        {!!g.synonyms?.length && <span className="t-micro font-normal mono">{g.synonyms.slice(0, 3).join(' · ')}</span>}
      </dt>
      <dd className="t-body text-ink-2 mt-1">{g.short}</dd>
      {g.why && <dd className="t-meta text-ink-3 mt-1">왜 중요한가 — {g.why}</dd>}
    </div>
  );

  return (
    <main className="page-doc">
      <PageHeader
        title="용어집"
        hint={<>화면에 나오는 임상·운영 용어의 뜻과 왜 중요한지. 값 옆의 점선 밑줄을 눌러도 같은 설명이 나옵니다. <Link href="/help" className="text-teal underline">도움말로</Link></>}
      />

      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="용어·약어 검색 (예: 델타, MDRO, panic)"
        aria-label="용어 검색"
        className="px-3 py-2 rounded-lg border border-line bg-bg text-sm w-full mb-3"
      />

      {/* 카테고리 탭 */}
      <div role="tablist" aria-label="용어 카테고리" className="flex gap-1 overflow-x-auto border-b border-line mb-4 -mx-1 px-1">
        {CATEGORIES.map((c, i) => {
          const active = cat === c;
          return (
            <button
              key={c}
              ref={(el) => { tabRefs.current[i] = el; }}
              role="tab"
              id={`gtab-${i}`}
              aria-selected={active}
              aria-controls="glossary-panel"
              tabIndex={active ? 0 : -1}
              onClick={() => setCat(c)}
              onKeyDown={(e) => onTabKey(e, i)}
              className={`shrink-0 flex items-center gap-1.5 px-3 py-2 text-sm font-semibold border-b-2 -mb-px transition-colors duration-150 whitespace-nowrap ${
                active ? 'border-teal text-teal' : 'border-transparent text-ink-2 hover:text-teal'
              }`}
            >
              {c}
              <span className={`inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full text-[11px] font-semibold ${
                active ? 'bg-teal/15 text-teal' : 'bg-line/60 text-ink-3'
              }`}>{counts[c] ?? 0}</span>
            </button>
          );
        })}
      </div>

      <div
        id="glossary-panel"
        role="tabpanel"
        aria-labelledby={`gtab-${CATEGORIES.indexOf(cat)}`}
      >
        <p className="t-meta mb-3">{q ? `${items.length}개 결과` : `${items.length}개 용어`}{q && cat !== '전체' ? ` · ${cat}` : ''}</p>

        {items.length === 0 ? (
          <EmptyState title="검색 결과가 없습니다" hint={cat === '전체' ? '다른 표현이나 약어로 찾아보세요(동의어도 검색됩니다).' : `‘${cat}’ 탭에 해당 용어가 없습니다. 전체 탭에서 찾아보세요.`} />
        ) : grouped ? (
          // 전체 탭 — 카테고리별 소제목으로 구분
          <div className="flex flex-col gap-6">
            {grouped.map(([category, list]) => (
              <section key={category} aria-label={category}>
                <h2 className="t-section text-sm text-ink-3 mb-2 pb-1 border-b border-line/70">{category} <span className="t-micro">({list.length})</span></h2>
                <dl className="flex flex-col gap-3">{list.map(renderTerm)}</dl>
              </section>
            ))}
          </div>
        ) : (
          // 개별 카테고리 탭 — 평면 목록
          <dl className="flex flex-col gap-3">{items.map(renderTerm)}</dl>
        )}
      </div>
    </main>
  );
}
