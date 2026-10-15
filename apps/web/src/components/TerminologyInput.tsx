'use client';

/**
 * TerminologyInput.tsx — 웹 공용 컴포넌트.
 *
 * 제공: TerminologyInput.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { apiFetch } from '@/lib/api';
import { IconChevron } from '@/components/Icon';

export interface TermItem {
  codeId: string;
  system: string;
  code: string;
  term: string;
  termKo: string | null;
  category: string | null;
}

const CAT_LABEL: Record<string, string> = { MORPHOLOGY: '형태', TOPOGRAPHY: '부위', DIAGNOSIS: '진단' };

/**
 * 진단·SNOMED 코드 자동완성 콤보박스.
 * - value/onChange: 자유 입력 유지(마스터에 없는 값도 허용)
 * - onPick: 목록에서 코드 선택 시 콜백(진단 자동채움·SNOMED 결속 등)
 */
export default function TerminologyInput({
  value, onChange, onPick, category, system, placeholder, className, mono, ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  onPick?: (item: TermItem) => void;
  category?: string;
  system?: string;
  placeholder?: string;
  className?: string;
  mono?: boolean;
  ariaLabel?: string;
}) {
  const [items, setItems] = useState<TermItem[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doSearch = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set('q', q.trim());
      if (category) params.set('category', category);
      if (system) params.set('system', system);
      const res = await apiFetch<TermItem[]>(`/api/v1/terminology?${params.toString()}`);
      setItems(res ?? []);
    } catch { setItems([]); } finally { setLoading(false); }
  }, [category, system]);

  // 디바운스 검색
  useEffect(() => {
    if (!open) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void doSearch(value), 200);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [value, open, doSearch]);

  // 바깥 클릭 닫기
  useEffect(() => {
    function onDoc(e: MouseEvent) { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  function pick(it: TermItem) {
    onPick?.(it);
    setOpen(false);
    setActive(-1);
  }

  function onKey(e: React.KeyboardEvent) {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { setOpen(true); return; }
    if (!open) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { if (active >= 0 && items[active]) { e.preventDefault(); pick(items[active]); } }
    else if (e.key === 'Escape') { setOpen(false); setActive(-1); }
  }

  return (
    <div className="relative" ref={boxRef}>
      <svg aria-hidden viewBox="0 0 20 20" fill="none" className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-3 pointer-events-none">
        <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="1.6" />
        <path d="M13.5 13.5 L17 17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <input
        value={value}
        aria-label={ariaLabel}
        onChange={(e) => { onChange(e.target.value); if (!open) setOpen(true); }}
        onFocus={() => { setOpen(true); doSearch(value); }}
        onKeyDown={onKey}
        placeholder={placeholder}
        autoComplete="off"
        className={className ?? `w-full ${mono ? 'mono ' : ''}pl-8 pr-2 py-1.5 rounded-lg border border-line bg-bg text-sm`}
      />
      <IconChevron open className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" />
      {open && (
        <div className="absolute z-20 left-0 right-0 mt-1 max-h-60 overflow-y-auto bg-surface border border-line rounded-lg shadow-lg text-sm">
          {loading && items.length === 0 ? (
            <div className="px-3 py-2 text-xs text-ink-3">검색 중…</div>
          ) : items.length === 0 ? (
            <div className="px-3 py-2 text-xs text-ink-3">일치 코드 없음 — 자유 입력 가능. 코드 등록은 관리 &gt; 용어 코드</div>
          ) : items.map((it, i) => (
            <button
              type="button"
              key={it.codeId}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(it)}
              className={`w-full text-left px-3 py-1.5 border-b border-line last:border-0 flex items-center gap-2 ${i === active ? 'bg-teal/10' : 'hover:bg-bg'}`}
            >
              <span className="mono text-xs text-teal shrink-0">{it.code}</span>
              <span className="truncate">{it.termKo || it.term}</span>
              {it.termKo && <span className="text-xs text-ink-3 truncate hidden sm:inline">{it.term}</span>}
              {it.category && <span className="ml-auto text-[11px] px-1.5 py-0.5 rounded bg-bg border border-line text-ink-2 shrink-0">{CAT_LABEL[it.category] ?? it.category}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
