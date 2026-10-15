'use client';

/**
 * 조직 게이트 상신 첨부 체크리스트 화면 (`/admin/gates/checklist`).
 *
 * 사이드바 GROUPS에 없는 경로(로그인·도움말·상세 진입 등).
 * 데이터는 `lib/api.ts`의 `apiFetch`로만 가져온다(HTTP 호출 정본).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { getToken } from '@/lib/api';
import { GATE_DOCS } from '@/lib/gate-docs';
import { IconCheck } from '@/components/Icon';

export default function GateChecklistPage() {
  const router = useRouter();
  useEffect(() => { if (!getToken()) router.push('/'); }, [router]);

  return (
    <main className="page-doc">
      <div className="flex items-center gap-3 mb-1 flex-wrap">
        <h1 className="t-page">조직 게이트 상신 첨부 체크리스트</h1>
        <button onClick={() => window.print()} className="ml-auto py-1.5 px-4 rounded-lg bg-teal text-white font-semibold text-sm print:hidden">인쇄</button>
        <Link href="/admin/gates" className="text-xs text-teal underline print:hidden">← 조직게이트</Link>
      </div>
      <p className="text-sm text-ink-2 mb-1">각 게이트를 전자결재(EAS)로 상신할 때 첨부할 근거 문서.</p>
      <p className="text-xs text-ink-3 mb-4"><IconCheck className="mr-1" />= LIS가 산출물로 제공 · ☐ = 결재 주관 부서가 작성. 실제 필수 항목·양식은 각 주관 부서·전자결재 규정이 최종 확정(권장 기준선). 정본: <span className="mono">docs/조직게이트_상신첨부체크리스트.md</span></p>

      <div className="space-y-4">
        {GATE_DOCS.map((g) => (
          <section key={g.gateCode} className="card break-inside-avoid">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className="mono font-bold">{g.gateCode}</span>
              <span className="font-semibold">{g.title}</span>
              <span className="ml-auto text-xs text-ink-3">주관: {g.owner}</span>
            </div>
            <p className="text-xs text-ink-2 mb-3">{g.scope}</p>
            <div className="grid sm:grid-cols-2 gap-3 text-sm">
              <div>
                <div className="text-teal font-semibold text-xs mb-1"><IconCheck className="mr-1" />LIS 산출물(첨부 근거)</div>
                <ul className="list-disc pl-4 space-y-0.5 text-ink-2">{g.lis.map((d) => <li key={d}>{d}</li>)}</ul>
              </div>
              <div>
                <div className="text-ink-2 font-semibold text-xs mb-1">☐ 주관 부서 작성</div>
                <ul className="list-disc pl-4 space-y-0.5 text-ink-2">{g.org.map((d) => <li key={d}>{d}</li>)}</ul>
              </div>
            </div>
          </section>
        ))}
      </div>

      <section className="card mt-4">
        <h2 className="t-section text-sm mb-2">처리 순서</h2>
        <ol className="list-decimal pl-5 text-sm text-ink-2 space-y-1">
          <li>위 산출물을 LIS에서 추출(서명워크시트 <span className="mono">/admin/signoff</span>·감사 <span className="mono">/audit</span>·cutover-preflight·왕복 스모크).</li>
          <li>☐ 조직 문서를 주관 부서가 작성·취합.</li>
          <li>EAS로 상신 → 결재 완료 후 <span className="mono">/admin/gates</span>에 문서번호·결재일·결재자 기입(APPROVED).</li>
        </ol>
      </section>
    </main>
  );
}
