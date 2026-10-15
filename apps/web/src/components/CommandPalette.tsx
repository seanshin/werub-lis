'use client';

/**
 * CommandPalette.tsx — 웹 공용 컴포넌트.
 *
 * 제공: CommandPalette.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { searchGlossary, GLOSSARY } from '@lis/shared';
import { getRoles } from '@/lib/api';

/**
 * 커맨드 팔레트(UX 기획 §3-2) — ⌘K/Ctrl+K.
 *
 * 사이드바 검색이 검체번호 전용이던 것을 넓힌다: 화면 이동·검체/오더/환자 조회·용어 검색을
 * 한 입력에서. 임상 사용자는 마우스로 메뉴를 훑는 대신 손을 키보드에 둔 채 이동한다.
 */
interface Cmd { id: string; label: string; hint?: string; run: () => void; group: '이동' | '조회' | '용어'; roles?: string[] }

const NAV: { label: string; href: string; roles?: string[] }[] = [
  { label: '대시보드', href: '/dashboard' },
  { label: '오더·접수', href: '/orders' },
  { label: '다운타임 오더', href: '/orders/downtime', roles: ['RCP', 'TEC', 'ADM'] },
  { label: '결과입력', href: '/results/entry', roles: ['TEC', 'PHY', 'MIC', 'ADM'] },
  { label: '검증', href: '/verify' },
  { label: '결과보고서', href: '/results/report' },
  { label: '외부위탁', href: '/sendout', roles: ['TEC', 'PHY', 'MIC', 'ADM'] },
  { label: '수혈', href: '/transfusion' },
  { label: '병리', href: '/pathology' },
  { label: '미생물', href: '/microbiology' },
  { label: '감염관리', href: '/microbiology/notifiable', roles: ['MIC', 'PHY', 'ADM'] },
  { label: 'QC 정도관리', href: '/qc' },
  { label: '유전체', href: '/genomic' },
  { label: '분자진단', href: '/molecular', roles: ['MIC', 'ADM'] },
  { label: '종양 NGS', href: '/ngs', roles: ['GEN', 'ADM'] },
  { label: '알림센터', href: '/notifications' },
  { label: 'EQA', href: '/eqa', roles: ['TEC', 'PHY', 'MIC', 'ADM'] },
  { label: '통계', href: '/stats', roles: ['TEC', 'PHY', 'MIC', 'ADM', 'AUD'] },
  { label: '환자', href: '/patients' },
  { label: '마스터', href: '/master', roles: ['TEC', 'ADM', 'AUD'] },
  { label: '연계콘솔', href: '/admin/integration', roles: ['ADM'] },
  { label: '청구', href: '/billing', roles: ['ADM', 'AUD'] },
  { label: '감사', href: '/audit', roles: ['ADM', 'AUD'] },
  { label: '용어집', href: '/help/glossary' },
  { label: '도움말', href: '/help' },
];

export default function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((v) => !v); }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => { if (open) { setQ(''); setIdx(0); setTimeout(() => inputRef.current?.focus(), 20); } }, [open]);

  const cmds = useMemo<Cmd[]>(() => {
    // getRoles()는 호출할 때마다 새 배열을 준다 — 밖에 두면 deps가 매 렌더 바뀌어
    // useMemo가 사실상 무효화된다. 안에서 읽으면 q·router가 바뀔 때만 재계산된다.
    const roles = typeof window !== 'undefined' ? getRoles() : [];
    const s = q.trim();
    const go = (href: string) => () => { setOpen(false); router.push(href); };
    const list: Cmd[] = NAV
      .filter((n) => !n.roles || n.roles.some((r) => roles.includes(r)))
      .filter((n) => !s || n.label.includes(s))
      .map((n) => ({ id: `nav:${n.href}`, label: n.label, hint: n.href, run: go(n.href), group: '이동' }));

    if (s) {
      // 검체/오더/환자 번호로 보이는 입력 — 해당 화면으로 바로
      list.push({ id: 'lookup:sp', label: `검체 ${s} 보고서 열기`, run: go(`/results/report?sp=${encodeURIComponent(s)}`), group: '조회' });
      list.push({ id: 'lookup:pt', label: `환자 ${s} 검색`, run: go(`/patients?q=${encodeURIComponent(s)}`), group: '조회' });
      // 용어 — 용어집 앵커로
      for (const g of searchGlossary(s).slice(0, 5)) {
        list.push({ id: `term:${g.key}`, label: g.term, hint: g.short.slice(0, 40), run: go(`/help/glossary#${g.key}`), group: '용어' });
      }
    } else {
      list.push({ id: 'term:all', label: `용어집 (${GLOSSARY.length}개 용어)`, run: go('/help/glossary'), group: '용어' });
    }
    return list;
  }, [q, router]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-24 px-4 no-print">
      {/* 배경 클릭으로 닫기 — 실제 button이라 키보드(Enter/Space)로도 닫힌다(Escape는 입력창에서 처리) */}
      <button type="button" aria-label="닫기" className="fixed inset-0 bg-ink/20" onClick={() => setOpen(false)} />
      <div
        role="dialog"
        aria-label="명령 팔레트"
        className="relative z-10 w-full max-w-lg bg-surface border border-line r-card e-overlay m-pop overflow-hidden"
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => { setQ(e.target.value); setIdx(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(i + 1, cmds.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
            if (e.key === 'Enter') { e.preventDefault(); cmds[idx]?.run(); }
            if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
          }}
          placeholder="화면 이동 · 검체/환자 번호 · 용어 검색"
          aria-label="명령 검색"
          className="w-full px-4 py-3 t-body bg-transparent border-b border-line outline-none"
        />
        <ul className="max-h-80 overflow-y-auto py-1">
          {cmds.length === 0 && <li className="px-4 py-3 t-meta">결과가 없습니다</li>}
          {cmds.map((c, i) => (
            <li key={c.id}>
              <button
                onClick={c.run}
                onMouseEnter={() => setIdx(i)}
                className={`w-full text-left px-4 py-2 flex items-center gap-2 m-hover ${i === idx ? 'bg-teal/10' : ''}`}
              >
                <span className="t-micro w-9 shrink-0 text-ink-3">{c.group}</span>
                <span className="t-body flex-1 truncate">{c.label}</span>
                {c.hint && <span className="t-micro truncate max-w-[45%]">{c.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
        <div className="px-4 py-2 border-t border-line t-micro flex gap-3">
          <span>↑↓ 이동</span><span>Enter 실행</span><span>Esc 닫기</span>
        </div>
      </div>
    </div>
  );
}
