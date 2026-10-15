'use client';

/**
 * Sidebar.tsx — 웹 공용 컴포넌트.
 *
 * 제공: Sidebar.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { apiFetch, clearToken, getRoles, getToken } from '@/lib/api';
import { BADGE_REFRESH_EVENT } from '@/lib/badge';
import { APP_VERSION } from '@/lib/version';
import { Logo } from '@/components/Logo';
import { IconSun, IconMoon, IconDensity, IconChevron } from '@/components/Icon';

// roles 미지정 = 전 역할 노출. 지정 시 해당 역할 보유자에게만 노출.
const GROUPS: { title: string; links: { href: string; label: string; roles?: string[] }[] }[] = [
  {
    title: '검사',
    links: [
      { href: '/dashboard', label: '대시보드' },
      { href: '/patients', label: '환자' },
      { href: '/orders', label: '오더·접수' },
      { href: '/orders/downtime', label: '다운타임 오더', roles: ['RCP', 'TEC', 'ADM'] },
      { href: '/results/entry', label: '결과입력', roles: ['TEC', 'PHY', 'MIC', 'ADM'] },
      // 검증·보고서는 F-RES:R(검사계열+감사)만 API 허용 — 사이드바도 일치(죽은 링크 제거)
      { href: '/verify', label: '검증', roles: ['TEC', 'PHY', 'MIC', 'ADM', 'AUD'] },
      { href: '/results/report', label: '보고서', roles: ['TEC', 'PHY', 'MIC', 'ADM', 'AUD'] },
      { href: '/sendout', label: '외부위탁', roles: ['TEC', 'PHY', 'MIC', 'PAT', 'GEN', 'ADM', 'AUD'] },
    ],
  },
  {
    // 분야(도메인) 화면은 각 컨트롤러 @Roles와 일치시켜 노출(죽은 링크 방지).
    title: '분야',
    links: [
      { href: '/transfusion', label: '수혈', roles: ['BB', 'ADM'] },
      { href: '/pathology', label: '병리', roles: ['PAT', 'ADM'] },
      { href: '/microbiology', label: '미생물', roles: ['MIC', 'ADM'] },
      { href: '/microbiology/notifiable', label: '감염관리', roles: ['MIC', 'PHY', 'ADM'] },
      { href: '/molecular', label: '분자진단', roles: ['MIC', 'ADM'] },
      { href: '/ngs', label: '종양 NGS', roles: ['GEN', 'ADM'] },
      { href: '/qc', label: 'QC', roles: ['TEC', 'PHY', 'ADM'] },
      { href: '/genomic', label: '유전체', roles: ['GEN', 'GC', 'PHY', 'ADM'] },
    ],
  },
  {
    title: '운영',
    links: [
      { href: '/notifications', label: '알림' },
      { href: '/eqa', label: 'EQA', roles: ['TEC', 'PHY', 'MIC', 'ADM'] },
      { href: '/instruments', label: '장비', roles: ['TEC', 'ADM'] },
      { href: '/stats', label: '통계', roles: ['TEC', 'PHY', 'MIC', 'PAT', 'BB', 'ADM', 'AUD'] },
      { href: '/help', label: '도움말' },
      { href: '/help/glossary', label: '용어집' },
      { href: '/settings/password', label: '비밀번호' },
    ],
  },
  // 관리 화면을 초기설정(개시 전 1회 정의)과 운영관리(개시 후 일상)로 분리 배치.
  //   운영관리콘솔은 두 축을 잇는 허브라 초기설정 최상단에 '시작점'으로 둔다.
  {
    title: '초기설정',
    links: [
      { href: '/admin/console', label: '운영관리콘솔', roles: ['ADM', 'AUD'] },
      { href: '/admin/golive', label: '개시 전환', roles: ['ADM', 'AUD'] },
      { href: '/master', label: '마스터', roles: ['TEC', 'ADM', 'AUD'] },
      { href: '/admin/catalogs', label: '코드셋', roles: ['MIC', 'ADM'] },
      { href: '/admin/terminology', label: '용어코드', roles: ['TEC', 'ADM', 'AUD'] },
      { href: '/admin/barcode', label: '바코드', roles: ['TEC', 'ADM'] },
      { href: '/admin/reflex', label: '반사검사', roles: ['TEC', 'PHY', 'ADM'] },
      { href: '/admin/gates', label: '서명·결재', roles: ['TEC', 'PHY', 'MIC', 'ADM', 'AUD'] },
    ],
  },
  {
    title: '운영관리',
    links: [
      { href: '/admin/users', label: '권한관리', roles: ['ADM'] },
      { href: '/admin/integration', label: '연계콘솔', roles: ['ADM'] },
      { href: '/admin/settings', label: '운영설정', roles: ['ADM'] },
      { href: '/admin/lifecycle', label: '수명주기', roles: ['ADM'] },
      { href: '/billing', label: '청구', roles: ['ADM', 'AUD'] },
      { href: '/audit', label: '감사', roles: ['ADM', 'AUD'] },
    ],
  },
];

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [roles, setRoles] = useState<string[]>([]);
  const [dark, setDark] = useState(false);
  const [open, setOpen] = useState(false); // 모바일 드로어
  const [collapsed, setCollapsed] = useState<string[]>([]); // 접힌 그룹
  const [alertCount, setAlertCount] = useState(0); // 미확인 알림+위험치(전역 배지)
  const [compact, setCompact] = useState(false); // 표 밀도(§1-7)

  useEffect(() => {
    // 즉시 best-guess(토큰/lis_user) 후, 서버(DB 권위 역할)로 정정한다.
    //   ★"작업 중 메뉴 사라짐"의 근본 원인: 사이드바가 토큰의 roles 클레임만 믿는데, 구/누락 토큰이면
    //     전 게이팅 메뉴가 사라진다. 서버 authz는 매 요청 DB 역할로 재판정하므로, 여기서도 /auth/me(DB 역할)를
    //     권위 소스로 삼아 표시 불일치를 없앤다. lis_user도 갱신해 다른 화면 getRoles 폴백까지 최신화.
    setRoles(getRoles());
    if (getToken()) {
      apiFetch<{ userId: string; name: string; roles: string[] }>('/api/v1/auth/me')
        .then((u) => {
          if (Array.isArray(u?.roles)) {
            setRoles(u.roles);
            try {
              const prev = JSON.parse(localStorage.getItem('lis_user') || 'null') || {};
              localStorage.setItem('lis_user', JSON.stringify({ ...prev, ...u }));
            } catch { /* noop */ }
          }
        })
        .catch(() => { /* 401은 apiFetch가 재로그인 유도, 그 외는 best-guess 유지 */ });
    }
    const stored = localStorage.getItem('lis_theme');
    setDark(stored ? stored === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (stored) document.documentElement.dataset.theme = stored;
    try { setCollapsed(JSON.parse(localStorage.getItem('lis_nav_collapsed') || '[]')); } catch { /* noop */ }
    setCompact(localStorage.getItem('lis_density') === 'compact');
  }, []);

  // 전역 알림 배지 — 미확인 알림+위험치 건수 폴링(어느 화면에서든 신규 위험치 인지).
  //   ★목록 API(/pending)가 아니라 **카운트 전용 엔드포인트**를 쓴다.
  //     목록을 쓰면 ① 응답에 환자명이 실려 목록을 열지도 않은 사용자에게 PHI가 60초마다 전송되고
  //     ② PHI 조회 감사가 폴링으로 가득 차 실제 열람 추적이 묻힌다(운영 실측 93%가 폴링이었다).
  //   ★타이머는 pathname에 의존하지 않는다 — 의존하면 페이지 이동마다 재호출된다.
  useEffect(() => {
    let alive = true;
    async function poll() {
      if (!getToken()) return;
      try {
        const c = await apiFetch<{ notifications: number; criticals: number }>('/api/v1/notifications/badge');
        if (alive) setAlertCount((c?.notifications ?? 0) + (c?.criticals ?? 0));
      } catch { /* noop */ }
    }
    void poll();
    const t = setInterval(() => void poll(), 60000);
    // 확인 처리 화면이 쏘는 즉시 갱신 이벤트(Q9) — 60초 폴링 사이의 틀린 배지 숫자 제거
    const onRefresh = () => void poll();
    window.addEventListener(BADGE_REFRESH_EVENT, onRefresh);
    return () => { alive = false; clearInterval(t); window.removeEventListener(BADGE_REFRESH_EVENT, onRefresh); };
  }, []);

  function toggleGroup(title: string) {
    setCollapsed((prev) => {
      const next = prev.includes(title) ? prev.filter((t) => t !== title) : [...prev, title];
      localStorage.setItem('lis_nav_collapsed', JSON.stringify(next));
      return next;
    });
  }

  useEffect(() => { setOpen(false); }, [pathname]); // 이동 시 드로어 닫기

  // 모바일 드로어 — Esc로 닫기(키보드 사용자는 배경 클릭을 쓸 수 없다)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (pathname === '/') return null; // 로그인 화면엔 사이드바 없음

  const visible = (l: { roles?: string[] }) => !l.roles || l.roles.some((r) => roles.includes(r));

  function toggleTheme() {
    const next = !dark; setDark(next);
    document.documentElement.dataset.theme = next ? 'dark' : 'light';
    localStorage.setItem('lis_theme', next ? 'dark' : 'light');
  }
  function logout() { clearToken(); router.push('/'); }
  function toggleDensity() {
    const next = document.documentElement.dataset.density === 'compact' ? '' : 'compact';
    document.documentElement.dataset.density = next;
    localStorage.setItem('lis_density', next || 'normal');
    setCompact(next === 'compact');
  }

  const panel = (
    <aside className="w-44 shrink-0 bg-surface border-r border-line flex flex-col p-2 gap-1 h-screen sticky top-0 overflow-y-auto no-print" aria-label="주 메뉴">
      <div className="flex items-center gap-2 px-2 py-2 mb-1">
        <Logo size={26} />
        <span className="font-extrabold text-teal tracking-tight text-lg">LIS</span>
      </div>
      {/* D7 전역 검체 검색 → 보고서 바로가기 */}
      <input
        aria-label="검체번호 전역 검색"
        placeholder="검체 검색 (⌘K)"
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const v = (e.target as HTMLInputElement).value.trim();
            if (v) { (e.target as HTMLInputElement).value = ''; router.push(`/results/report?sp=${encodeURIComponent(v)}`); }
          }
        }}
        className="mono text-xs px-2 py-1.5 r-ctl border border-line bg-bg mb-2 w-full focus:border-teal"
      />
      {GROUPS.map((g) => {
        const links = g.links.filter(visible);
        if (links.length === 0) return null;
        const isCol = collapsed.includes(g.title);
        return (
          <div key={g.title} className="mb-1">
            <button onClick={() => toggleGroup(g.title)} aria-expanded={!isCol}
              className="w-full flex items-center justify-between text-[11px] uppercase tracking-wider text-ink-3 px-2 mb-0.5 hover:text-ink-2">
              <span>{g.title}</span><IconChevron open={!isCol} className="opacity-60" />
            </button>
            {!isCol && links.map((l) => {
              const active = pathname === l.href;
              return (
                <Link key={l.href} href={l.href} aria-current={active ? 'page' : undefined}
                  /* 라벨은 좌측 정렬 — 우측 정렬은 항목마다 글자 시작점이 달라져 세로 스캔이 끊긴다.
                     활성 표시는 배경 대신 좌측 4px 바(계기판 인상 + 배경 틴트 남용 회피). */
                  className={`relative flex items-center gap-1.5 pl-3 pr-2 py-1.5 r-ctl text-sm whitespace-nowrap m-hover ${active ? 'text-teal font-bold before:absolute before:left-0 before:top-1 before:bottom-1 before:w-[3px] before:rounded-full before:bg-teal' : 'text-ink-2 font-medium hover:bg-surface-2'}`}>
                  <span className="flex-1">{l.label}</span>
                  {l.href === '/notifications' && alertCount > 0 && (
                    <span aria-label={`미확인 ${alertCount}건`} className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-crit text-white text-[11px] font-bold">{alertCount > 99 ? '99+' : alertCount}</span>
                  )}
                </Link>
              );
            })}
          </div>
        );
      })}
      <div className="mt-auto pt-2 border-t border-line flex items-center justify-between gap-1 px-1">
        <span className="flex items-center gap-0.5">
          <button onClick={toggleTheme} aria-label={dark ? '라이트 모드로 전환' : '다크 모드로 전환'} className="text-sm text-ink-2 px-1.5 py-1 r-ctl hover:bg-bg m-hover">{dark ? <IconSun /> : <IconMoon />}</button>
          <button onClick={toggleDensity} aria-label={compact ? '보통 밀도로' : '조밀 밀도로'} title={compact ? '보통 밀도' : '조밀 밀도'} className="text-sm text-ink-2 px-1.5 py-1 r-ctl hover:bg-bg m-hover"><IconDensity className={compact ? 'opacity-100' : 'opacity-60'} /></button>
        </span>
        {/* whitespace-nowrap 필수 — 폭이 좁으면 "로그아웃"이 한 글자씩 세로로 쪼개진다 */}
        <button onClick={logout} className="text-sm text-ink-2 underline whitespace-nowrap px-1">로그아웃</button>
      </div>
      <div className="text-[11px] text-ink-3 text-right px-1 pt-1 leading-tight">v{APP_VERSION}<br />© 위루비</div>
    </aside>
  );

  return (
    <>
      {/* 모바일 상단 바 + 햄버거 */}
      <div className="md:hidden fixed top-0 inset-x-0 z-30 flex items-center gap-2 bg-surface border-b border-line px-3 h-12 no-print">
        <button onClick={() => setOpen(true)} aria-label="메뉴 열기" className="text-xl px-2">☰</button>
        <Logo size={22} />
        <span className="font-extrabold text-teal">LIS</span>
      </div>
      {/* 데스크톱 사이드바 */}
      <div className="hidden md:block">{panel}</div>
      {/* 모바일 드로어 */}
      {open && (
        <div className="md:hidden fixed inset-0 z-40 no-print">
          {/* 배경 클릭으로 닫기 — 실제 button(키보드 접근 가능). Escape는 전역 리스너로도 닫힌다 */}
          <button type="button" aria-label="메뉴 닫기" className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-0">{panel}</div>
        </div>
      )}
    </>
  );
}
