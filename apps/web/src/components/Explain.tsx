'use client';

/**
 * Explain.tsx — 웹 공용 컴포넌트.
 *
 * 제공: Popover, Explain, Term, StatusChip.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useState, useRef, useEffect, useId, ReactNode } from 'react';
import { apiFetch } from '@/lib/api';
import { UNIT_DICT, unitDisplay, GLOSSARY_BY_KEY, STATUS_LABEL } from '@lis/shared';
import { IconWarn } from '@/components/Icon';

/**
 * 설명 팝오버(UX 기획 §2-5) — "이 값·이 목록이 무엇으로 이루어졌는가"를 같은 방식으로 답한다.
 *
 * 사용자에게 남는 규칙은 하나뿐이다: **점선 밑줄 = 누르면 설명이 나온다.**
 * 용어(정적 사전)와 구성(서버 데이터) 모두 이 컴포넌트를 쓴다 — 내용 소스만 다르다.
 *
 * 네이티브 `title=`을 쓰지 않는 이유: 모바일·태블릿에서 표시되지 않고 스크린리더 지원이 불균일하다.
 */
export function Popover({ label, children, wide }: { label: ReactNode; children: ReactNode; wide?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <span ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        className="underline decoration-dotted decoration-ink-3 underline-offset-2 hover:decoration-teal transition-colors duration-150"
      >
        {label}
      </button>
      {open && (
        <span
          id={id}
          role="dialog"
          className={`absolute z-30 left-0 top-full mt-1.5 ${wide ? 'w-80' : 'w-64'} rounded-xl border border-line bg-surface p-3 text-left shadow-lg`}
        >
          {children}
        </span>
      )}
    </span>
  );
}

interface ExplainData {
  kind: string; id: string; title: string; summary: string;
  formula?: string | null; unit?: string | null; specimenType?: string | null;
  items?: { code: string; name: string; unit: string | null }[];
  ranges?: { sex: string; ageMin: number; ageMax: number; normal: string | null; panic: string | null }[];
}

/**
 * 구성 설명 — 패널(전개 검사)·계산검사(산출식·입력)·검사(단위·참고치).
 * 서버 `/master/explain/:kind/:id`를 **열 때 한 번만** 조회한다(목록 렌더 시 대량 호출 방지).
 */
export function Explain({ kind, id, label }: { kind: 'panel' | 'derived' | 'test'; id: string; label?: ReactNode }) {
  const [data, setData] = useState<ExplainData | null>(null);
  const [err, setErr] = useState('');
  const [loaded, setLoaded] = useState(false);

  async function ensure() {
    if (loaded) return;
    setLoaded(true);
    try { setData(await apiFetch<ExplainData>(`/api/v1/master/explain/${kind}/${encodeURIComponent(id)}`)); }
    catch (e) { setErr(e instanceof Error ? e.message : '설명을 불러오지 못했습니다'); }
  }

  return (
    <span onMouseEnter={ensure} onFocus={ensure}>
      <Popover label={label ?? id} wide={kind !== 'test'}>
        {!data && !err && <span className="text-xs text-ink-3">불러오는 중…</span>}
        {err && <span className="text-xs text-warn">{err}</span>}
        {data && (
          <span className="block text-xs leading-relaxed">
            <span className="block font-bold text-ink mb-1">{data.title}</span>
            <span className="block text-ink-2 mb-1.5">{data.summary}</span>
            {data.formula && <span className="block mono bg-bg rounded px-1.5 py-1 mb-1.5 text-ink">{data.formula}</span>}
            {data.unit && (
              <span className="block text-ink-2">
                단위 <span className="mono">{unitDisplay(data.unit)}</span>
                {UNIT_DICT[data.unit]?.meaning ? <span className="text-ink-3"> — {UNIT_DICT[data.unit].meaning}</span> : null}
                {data.specimenType ? ` · 검체 ${data.specimenType}` : ''}
                {UNIT_DICT[data.unit]?.caution && (
                  <span className="block text-warn mt-0.5"><IconWarn className="mr-1" />{UNIT_DICT[data.unit].caution}</span>
                )}
              </span>
            )}
            {!!data.items?.length && (
              <span className="block mt-1.5">
                <span className="block text-ink-3 mb-0.5">{data.kind === 'derived' ? '입력 검사' : '구성 검사'} {data.items.length}종</span>
                {data.items.map((it) => (
                  <span key={it.code} className="block">· {it.name} <span className="mono text-ink-3">{it.code}</span>{it.unit ? <span className="text-ink-3"> ({it.unit})</span> : null}</span>
                ))}
              </span>
            )}
            {!!data.ranges?.length && (
              <span className="block mt-1.5">
                <span className="block text-ink-3 mb-0.5">참고치</span>
                {data.ranges.map((r, i) => (
                  <span key={i} className="block">
                    · {r.sex === 'A' ? '공통' : r.sex === 'M' ? '남' : '여'} {r.ageMin}–{r.ageMax}세 · <span className="mono">{r.normal ?? '—'}</span>
                    {r.panic && <span className="text-crit"> (위험 {r.panic})</span>}
                  </span>
                ))}
              </span>
            )}
          </span>
        )}
      </Popover>
    </span>
  );
}

/**
 * 용어 칩(§2-2) — 정적 사전 기반 팝오버. 서버 호출 없음.
 * 화면 어디서나 `<Term k="delta-check" />`로 쓰고, "자세히"는 용어집 앵커로 간다.
 */
export function Term({ k, label }: { k: string; label?: ReactNode }) {
  const g = GLOSSARY_BY_KEY[k];
  if (!g) return <>{label ?? k}</>;
  return (
    <Popover label={label ?? g.term}>
      <span className="block text-xs leading-relaxed">
        <span className="block font-bold text-ink mb-1">{g.term}</span>
        <span className="block text-ink-2">{g.short}</span>
        {g.why && <span className="block text-ink-3 mt-1">{g.why}</span>}
        <a href={`/help/glossary#${g.key}`} className="block mt-1.5 text-teal underline">용어집에서 자세히 →</a>
      </span>
    </Popover>
  );
}

/**
 * 상태 칩(§2-3) — 원시 코드(NO_RANGE·DLQ…) 대신 한글 라벨 + 뜻 팝오버.
 * 라벨만 있고 용어가 없는 코드는 평문 칩으로 표시한다.
 */
export function StatusChip({ code, tone = 'neutral' }: { code: string | null | undefined; tone?: 'neutral' | 'warn' | 'crit' | 'good' }) {
  if (!code) return <span className="text-ink-3">—</span>;
  const meta = STATUS_LABEL[code];
  const cls = tone === 'crit' ? 'bg-crit/15 text-crit' : tone === 'warn' ? 'bg-warn/20 text-warn' : tone === 'good' ? 'bg-good/15 text-good' : 'bg-bg text-ink-2';
  const chip = <span className={`px-2 py-0.5 rounded text-xs font-bold ${cls}`}>{meta?.label ?? code}</span>;
  return meta?.termKey ? <Term k={meta.termKey} label={chip} /> : chip;
}
