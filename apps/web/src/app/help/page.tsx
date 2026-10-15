'use client';

/**
 * 도움말 화면 (`/help`).
 *
 * 사이드바 GROUPS에 없는 경로(로그인·도움말·상세 진입 등).
 * 데이터는 `lib/api.ts`의 `apiFetch`로만 가져온다(HTTP 호출 정본).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { APP_VERSION } from '@/lib/version';
import { getToken } from '@/lib/api';

interface HelpItem { title: string; href?: string; roles?: string; body: string; }
interface HelpSection { id: string; group: string; items: HelpItem[]; }

const SECTIONS: HelpSection[] = [
  {
    id: 'start', group: '시작하기',
    items: [
      { title: '로그인', body: '발급받은 ID·비밀번호로 로그인합니다. 비밀번호 5회 연속 실패 시 계정이 잠기며, 관리자(권한관리 화면)가 잠금 해제·재설정합니다.' },
      { title: '역할과 권한', body: '각 계정은 하나 이상의 역할(예: TEC 진단검사·PHY 병리·MIC 미생물·ADM 관리자·AUD 감사)을 가집니다. 화면·기능 접근은 역할×기능 매트릭스로 결정됩니다. 좌측 메뉴는 보유 역할에 맞는 항목만 표시됩니다.' },
      { title: '"권한 없음"이 뜨는 이유', body: '해당 기능에 필요한 역할이 없기 때문입니다. 필요한 권한은 관리자에게 요청하세요. 역할은 로그인 시 토큰에 반영되므로, 역할이 변경되면 다시 로그인해야 적용됩니다.' },
      { title: '다크 모드 · 로그아웃', body: '좌측 사이드바 하단의 해·달 아이콘으로 라이트/다크 모드를 전환합니다(설정은 브라우저에 저장). 옆의 로그아웃으로 세션을 종료합니다.' },
    ],
  },
  {
    id: 'test', group: '검사 (공통 업무)',
    items: [
      { title: '대시보드', href: '/dashboard', body: '당일 접수·미보고·지연 현황과 주요 지표를 한눈에 확인합니다.' },
      { title: '오더·접수', href: '/orders', body: 'HIS 처방으로 생성된 오더를 조회하고 검체를 접수합니다. 상태 필터로 진행 단계를 좁혀 볼 수 있습니다.' },
      { title: '결과입력', href: '/results/entry', roles: 'TEC·PHY·MIC·ADM', body: '검체 바코드를 스캔(또는 입력)하고 결과값을 입력합니다. 참고치 밖 값은 자동으로 플래그(H/L·HH/LL)와 색상이 표시됩니다. 자동 인터페이스가 없는 장비는 이 화면에서 수기·문서 입력으로 결과를 등록합니다.' },
      { title: '검증(2차 확인)', href: '/verify', body: '입력된 결과를 검토·확정(verify)합니다. 확정된 결과만 보고서에 포함됩니다. delta check·QC 위반 등은 보류(hold)로 표시됩니다.' },
      { title: '결과보고서', href: '/results/report', body: '검체 바코드로 조회해 확정 결과 보고서를 확인·인쇄합니다. 미확정 항목은 별도 표기됩니다.' },
    ],
  },
  {
    id: 'domain', group: '분야별 검사',
    items: [
      { title: '수혈', href: '/transfusion', body: '혈액제제 등록·출고와 이상반응 보고를 관리합니다(제제 종류·혈액형·유효기한, 반응 유형·중증도). 출고 전 ‘적격성 사전점검’으로 ABO 2회확인·교차시험 경과·특수요구·항원매칭 근거와 차단 사유를 미리 확인할 수 있습니다.' },
      { title: '병리', href: '/pathology', roles: 'PHY·ADM', body: '표본 추적(그로싱→블록→슬라이드)과 2단계 사인아웃(초안→서명)·개정을 기록하고, PACS MWL 송신·WSI 뷰어 딥링크로 슬라이드 이미지를 새 창에서 엽니다. 케이스 조회 시 하단에 상세 7탭이 나타납니다 — ①검체·임상(다부위 part·임상정보·의뢰의) ②IHC(marker·강도·양성%·score) ③세포병리(Pap/FNA·적정성·Bethesda 분류) ④병기·분류(AJCC TNM·ICD-O-3) ⑤분자(결속 PCR/NGS 소견·molId 결속) ⑥보고서·배포(HTML 인쇄·PRINT/PORTAL/PROVIDER/FAX 배포 이력) ⑦물류·custody(블록 포매·박절, 슬라이드 WSI 스캔, 관리연속성 로그). ‘근거 종합’ 버튼으로 IHC·병기·synoptic·분자 소견을 한곳에 모아 봅니다.' },
      { title: '미생물', href: '/microbiology', body: '배양·동정, 항생제 감수성(AST: S/I/R)을 입력합니다. 결과는 통계의 Antibiogram(%S)으로 집계됩니다. 분리주별 ‘근거 종합’으로 브레이크포인트·고유내성·MDRO·법정감염병·과거 내성 이력을 함께 봅니다.' },
      { title: '정도관리(QC)', href: '/qc', body: 'QC 측정값을 등록하면 Westgard 규칙으로 자동 판정하고, Levey-Jennings 차트(±1/2/3SD)로 추세를 봅니다.' },
      { title: '유전체(NGS)', href: '/genomic', body: 'VCF를 붙여넣어 변이를 등록하고, ACMG 기준으로 분류·판독·동의서를 관리합니다. 변이별 ‘AI 해석 초안(로컬 지식기반)’·‘근거 종합’과, 근거 DB 개정 시 확정 해석이 낡은 변이를 찾는 ‘재해석 검토’를 제공합니다.' },
    ],
  },
  {
    id: 'ops', group: '운영',
    items: [
      { title: '알림', href: '/notifications', body: '위험치·지연·QC 위반 등 주요 이벤트 알림을 확인합니다.' },
      { title: 'EQA(외부정도관리)', href: '/eqa', roles: 'TEC·PHY·MIC·ADM', body: '외부정도관리 결과를 등록하고 또래(peer) 평균·SD 대비 SDI를 평가합니다.' },
      { title: '장비', href: '/instruments', roles: 'TEC·MIC·ADM', body: '장비 인터페이스(ASTM/CSV) 페이로드를 확인·처리합니다. 비협조 장비는 결과입력 화면의 수기·문서 경로를 병행합니다.' },
      { title: '통계·리포트', href: '/stats', roles: 'TEC·PHY·MIC·ADM·AUD', body: 'TAT(접수→보고), 검사량·재검률, 워크로드·섹션별 TAT·추세, 미보고·지연, Antibiogram을 조회하고 CSV로 내보냅니다. 병리 QA(케이스량·개정률·동결절편 일치도·TAT·IHC/세포 볼륨)도 포함됩니다.' },
    ],
  },
  {
    id: 'setup', group: '초기설정',
    items: [
      { title: '운영관리콘솔', href: '/admin/console', roles: 'ADM·AUD', body: '개시·운영에 정의해야 하는 관리 항목을 4축(기준정보·거버넌스·운영·연동)으로 집계하고, lifecycle(미정의→시드→설정→서명·결재→운영)로 각 항목의 진행 단계를 봅니다. 초기설정·운영관리의 진입 허브입니다.' },
      { title: '마스터', href: '/master', roles: 'TEC·ADM·AUD', body: '검사항목·참고치·패널 등 기준정보를 관리합니다.' },
      { title: '코드셋(카탈로그)', href: '/admin/catalogs', roles: 'MIC·ADM', body: 'AST 브레이크포인트·법정감염병·세포병리·synoptic·ICD-O·변이 근거 DB 등 개정 코드셋을 반입(DRAFT)→비교→활성화합니다. 미반입 항목은 코드 스타터셋으로 동작합니다.' },
      { title: '서명·결재', href: '/admin/gates', roles: 'TEC·PHY·MIC·ADM·AUD', body: '조직 결재(A-1/A-2/A-3)와 검사실 실값 서명 워크시트를 한곳에서 추적·기입합니다. 개시 전 거버넌스 게이트입니다.' },
    ],
  },
  {
    id: 'admin', group: '운영관리',
    items: [
      { title: '운영 설정', href: '/admin/settings', roles: 'ADM', body: '위험치 알림 채널(웹훅 URL·서명키·에스컬레이션 간격) 등 운영 파라미터를 재기동 없이 설정하고 테스트 발송으로 도달을 확인합니다.' },
      { title: '권한 관리', href: '/admin/users', roles: 'ADM', body: '사용자 생성, 역할 배정, 계정 활성/비활성·잠금 해제, 비밀번호 재설정과 권한 매트릭스를 관리합니다.' },
      { title: '연계콘솔', href: '/admin/integration', roles: 'ADM', body: 'HIS/PACS/Reflex 연동 헬스·미적재·커버리지를 모니터링합니다.' },
      { title: '검체 수명주기', href: '/admin/lifecycle', roles: 'ADM', body: '검체 보관·폐기 등 수명주기 상태를 관리합니다.' },
      { title: '청구', href: '/billing', roles: 'ADM·AUD', body: '청구 캡처·ERP 전송·반송 상태를 관리합니다.' },
      { title: '감사추적', href: '/audit', roles: 'ADM·AUD', body: '사용자·액션·대상별 접근 이력을 조회합니다. 민감 접근은 별도 표기됩니다.' },
    ],
  },
];

const TIPS: [string, string][] = [
  ['바코드 스캔', '결과입력·보고서 화면은 바코드 스캐너 입력을 그대로 받습니다. 스캔 후 Enter로 조회됩니다.'],
  ['결과 플래그 색상', '주황=경고 수준(H/L), 빨강=위험 수준(HH/LL). 참고치 밖 값은 자동 계산됩니다.'],
  ['확정(검증)', '결과는 입력 → 검증(확정)을 거쳐야 보고서에 반영됩니다. 미확정 항목은 보고서에 별도 표기됩니다.'],
  ['수기·문서 입력', '자동 인터페이스가 없는 장비도 결과입력 화면에서 동일하게 등록되며, 같은 검증·감사 파이프라인을 따릅니다.'],
  ['근거 종합 · AI 해석 초안', '유전체·미생물·병리·결과검증·수혈 화면에서 판정 근거를 한곳에 모아 보고, 향후 원내 모델 초안의 바탕이 됩니다. 환자 데이터는 외부로 전송되지 않습니다.'],
  ['CSV 내보내기', '통계·Antibiogram 등은 CSV 다운로드를 지원합니다(UTF-8 BOM 포함, Excel 호환).'],
  ['인쇄', '결과보고서는 인쇄 버튼으로 출력하며, 메뉴·조작 영역은 인쇄에서 제외됩니다.'],
];

const TIPS_ID = 'tips';
const TABS = [...SECTIONS.map((s) => ({ id: s.id, group: s.group })), { id: TIPS_ID, group: '공통 팁' }];

export default function HelpPage() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<string>(SECTIONS[0].id);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => { if (!getToken()) router.push('/'); }, [router]);

  const norm = q.trim().toLowerCase();
  const searching = norm.length > 0;
  const match = (t: string, b: string) => !norm || t.toLowerCase().includes(norm) || b.toLowerCase().includes(norm);

  // 탭 개수 배지(검색 무관, 전체 기준 고정)
  const counts = useMemo(() => {
    const m: Record<string, number> = { [TIPS_ID]: TIPS.length };
    for (const s of SECTIONS) m[s.id] = s.items.length;
    return m;
  }, []);

  // 검색 시: 전체 섹션+팁에서 매칭. 비검색 시: 활성 탭만.
  const shownSections = useMemo(() => {
    if (!searching) return SECTIONS.filter((s) => s.id === tab);
    return SECTIONS.map((s) => ({ ...s, items: s.items.filter((i) => match(i.title, i.body)) })).filter((s) => s.items.length > 0);
  }, [searching, tab, norm]); // eslint-disable-line react-hooks/exhaustive-deps

  const shownTips = useMemo(() => {
    if (!searching) return tab === TIPS_ID ? TIPS : [];
    return TIPS.filter(([t, b]) => match(t, b));
  }, [searching, tab, norm]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalResults = shownSections.reduce((n, s) => n + s.items.length, 0) + shownTips.length;

  const onTabKey = (e: React.KeyboardEvent, idx: number) => {
    const last = TABS.length - 1;
    let next = -1;
    if (e.key === 'ArrowRight') next = idx === last ? 0 : idx + 1;
    else if (e.key === 'ArrowLeft') next = idx === 0 ? last : idx - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    if (next < 0) return;
    e.preventDefault();
    setTab(TABS[next].id);
    tabRefs.current[next]?.focus();
  };

  return (
    <main className="page-doc">
      <div className="flex items-baseline gap-3 mb-1">
        <h1 className="t-page">도움말</h1>
        <span className="text-xs text-ink-3">LIS v{APP_VERSION} 사용 안내</span>
      </div>
      <p className="text-xs text-ink-2 mb-4">화면별 사용법과 공통 팁입니다. 필요한 권한이 없어 열리지 않는 메뉴는 관리자에게 요청하세요.</p>

      <input
        aria-label="도움말 검색"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="도움말 검색 (예: 바코드, 권한, QC, CSV)"
        className="w-full mb-3 px-3 py-2 rounded-lg border border-line bg-bg text-sm"
      />

      {/* 카테고리 탭 */}
      <div role="tablist" aria-label="도움말 카테고리" className="flex gap-1 overflow-x-auto border-b border-line mb-4 -mx-1 px-1">
        {TABS.map((t, i) => {
          const active = !searching && tab === t.id;
          return (
            <button
              key={t.id}
              ref={(el) => { tabRefs.current[i] = el; }}
              role="tab"
              id={`htab-${i}`}
              aria-selected={active}
              aria-controls="help-panel"
              tabIndex={active ? 0 : -1}
              onClick={() => { setQ(''); setTab(t.id); }}
              onKeyDown={(e) => onTabKey(e, i)}
              className={`shrink-0 flex items-center gap-1.5 px-3 py-2 text-sm font-semibold border-b-2 -mb-px transition-colors duration-150 whitespace-nowrap ${
                active ? 'border-teal text-teal' : 'border-transparent text-ink-2 hover:text-teal'
              }`}
            >
              {t.group}
              <span className={`inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full text-[11px] font-semibold ${
                active ? 'bg-teal/15 text-teal' : 'bg-line/60 text-ink-3'
              }`}>{counts[t.id] ?? 0}</span>
            </button>
          );
        })}
      </div>

      <div id="help-panel" role="tabpanel" aria-labelledby={searching ? undefined : `htab-${TABS.findIndex((t) => t.id === tab)}`}>
        {searching && <p className="t-meta mb-3">{totalResults}개 결과 · 전체에서 검색</p>}

        {totalResults === 0 ? (
          <p className="text-sm text-ink-3 text-center py-10">&ldquo;{q}&rdquo;에 대한 도움말이 없습니다.</p>
        ) : (
          <div className="space-y-4">
            {shownSections.map((s) => (
              <section key={s.id} className="card">
                {searching && <h2 className="t-section text-sm text-ink-3 mb-3">{s.group}</h2>}
                <div className="space-y-3">
                  {s.items.map((i) => (
                    <div key={i.title} className="border-b border-line last:border-0 pb-3 last:pb-0">
                      <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                        {i.href ? (
                          <Link href={i.href} className="font-semibold text-sm text-teal hover:underline">{i.title}</Link>
                        ) : (
                          <span className="font-semibold text-sm">{i.title}</span>
                        )}
                        {i.roles && <span className="text-[11px] mono px-1.5 py-0.5 rounded bg-bg text-ink-3 border border-line">{i.roles}</span>}
                      </div>
                      <p className="text-sm text-ink-2 leading-relaxed">{i.body}</p>
                    </div>
                  ))}
                </div>
              </section>
            ))}

            {shownTips.length > 0 && (
              <section className="card">
                {searching && <h2 className="t-section text-sm text-ink-3 mb-3">공통 팁</h2>}
                <div className="grid md:grid-cols-2 gap-3">
                  {shownTips.map(([t, b]) => (
                    <div key={t}>
                      <div className="font-semibold text-sm mb-0.5">{t}</div>
                      <p className="text-sm text-ink-2 leading-relaxed">{b}</p>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>

      <p className="text-xs text-ink-3 mt-6 text-center">문의·지원: 시스템 관리자(전산) · 제작사 위루비 (Weruby) · © 2026</p>
    </main>
  );
}
