'use client';

/**
 * 운영 관리 콘솔 화면 (`/admin/console`).
 *
 * 사이드바 노출 역할: ADM, AUD.
 * ⚠ 노출 역할과 화면이 호출하는 API 권한이 어긋나면 전부 403인 죽은 화면이 된다 —
 *   역할을 바꿀 때는 `Sidebar.tsx`(정본)와 API 권한 매트릭스를 함께 본다.
 * 데이터는 `lib/api.ts`의 `apiFetch`로만 가져온다(HTTP 호출 정본).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { apiFetch, getToken, getRoles } from '@/lib/api';
import { Loading, ErrorText } from '@/components/ui';
import { useToast } from '@/components/toast';

interface Item {
  key: string; label: string; owner: string; fix: string | null;
  blocking: boolean; status: 'OK' | 'WARN' | 'BLOCK' | 'SEED';
  stage: string; next: string | null; review: boolean; detail: string;
}
interface Axis { axis: string; label: string; items: Item[]; progress: { ok: number; total: number } }
interface PipeCol { stage: string; items: { key: string; label: string; status: string; axis: string }[] }
interface Console {
  summary: { block: number; warn: number; seed: number; ok: number; total: number; blockingOpen: number; review: number };
  axes: Axis[]; pipeline: PipeCol[]; generatedAt: string;
}
interface Activity { total: number; events: { at: string; category: string; actor: string | null; summary: string; itemKey: string }[]; generatedAt: string }
interface Decision {
  key: string; label: string; owner: string; blocking: boolean; hint: string; status: string;
  decidedValue: string | null; decidedByName: string | null; decidedBy: string | null;
  decidedDate: string | null; documentRef: string | null; note: string | null; updatedDt: string | null;
}

const TONE: Record<string, string> = {
  OK: 'border-good/40 bg-good/[0.04]', WARN: 'border-warn/40 bg-warn/[0.04]',
  BLOCK: 'border-crit/40 bg-crit/[0.05]', SEED: 'border-indigo/40 bg-indigo/[0.04]',
};
const DOT: Record<string, string> = { OK: 'bg-good', WARN: 'bg-warn', BLOCK: 'bg-crit', SEED: 'bg-indigo' };
const BADGE: Record<string, string> = { OK: 'bg-good/15 text-good', WARN: 'bg-warn/15 text-warn', BLOCK: 'bg-crit/15 text-crit', SEED: 'bg-indigo/15 text-indigo' };
const LABEL: Record<string, string> = { OK: '완료', WARN: '대기', BLOCK: '차단', SEED: '시드' };
// P2 표준 lifecycle
const STAGE_ORDER = ['UNDEFINED', 'SEEDED', 'CONFIGURED', 'SIGNED', 'LIVE', 'REVIEW'];
const STAGE_LABEL: Record<string, string> = { UNDEFINED: '미정의', SEEDED: '시드/대표값', CONFIGURED: '설정됨', SIGNED: '서명·결재', LIVE: '운영', REVIEW: '재검토' };
const STAGE_TONE: Record<string, string> = { UNDEFINED: 'bg-crit/10 text-crit', SEEDED: 'bg-indigo/10 text-indigo', CONFIGURED: 'bg-warn/10 text-warn', SIGNED: 'bg-teal/10 text-teal', LIVE: 'bg-good/10 text-good', REVIEW: 'bg-crit/10 text-crit' };
const CAT_TONE: Record<string, string> = { 조직결재: 'bg-crit/10 text-crit', 검사실서명: 'bg-teal/10 text-teal', 코드셋반입: 'bg-indigo/10 text-indigo', 설정변경: 'bg-warn/10 text-warn', 반사검사: 'bg-good/10 text-good' };

/** 운영 관리 콘솔(P2) — 정의 항목 4축 집계 + 표준 lifecycle 워크플로우 뷰. */
export default function ManagementConsolePage() {
  const router = useRouter();
  const toast = useToast();
  const [data, setData] = useState<Console | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [onlyBlock, setOnlyBlock] = useState(false);
  const [view, setView] = useState<'axis' | 'flow' | 'log' | 'decisions'>('axis');
  const [act, setAct] = useState<Activity | null>(null);
  const [actErr, setActErr] = useState(false);
  const [decisions, setDecisions] = useState<Decision[] | null>(null);
  const [dForm, setDForm] = useState<Record<string, { status: string; decidedValue: string; decidedByName: string; decidedDate: string; documentRef: string; note: string }>>({});
  const [canWrite, setCanWrite] = useState(false);
  useEffect(() => { setCanWrite(getRoles().includes('ADM')); }, []);
  // 결정 항목의 "해결 →" 링크(/admin/console?view=decisions)로 들어오면 결정등록 탭을 연다(자기링크 데드엔드 해소).
  useEffect(() => {
    const v = new URLSearchParams(window.location.search).get('view');
    if (v === 'decisions' || v === 'flow' || v === 'log' || v === 'axis') setView(v);
  }, []);
  const [golive, setGolive] = useState<{ state: string; blockingOpen: number; openBlockers: { key: string; label: string }[]; current: { action: string; approvedByName: string | null; approvedBy: string | null; approvedDate: string | null; override: boolean; residualRisk: string | null; note: string | null } | null } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      setData(await apiFetch<Console>('/api/v1/admin/console'));
      setActErr(false); setAct(null);
      apiFetch<Activity>('/api/v1/admin/console/activity').then(setAct).catch(() => setActErr(true));
      apiFetch<Decision[]>('/api/v1/admin/decisions').then(setDecisions).catch(() => setDecisions(null));
      apiFetch<typeof golive>('/api/v1/admin/golive').then(setGolive).catch(() => setGolive(null));
    }
    catch (e) { setErr(e instanceof Error ? e.message : '조회 실패'); }
    finally { setLoading(false); }
  }, []);

  // 조직/외부 결정 기입(ADM) — 기입자는 서버가 결속
  async function recordDecision(key: string) {
    const f = dForm[key];
    if (!f) return;
    setBusy(true);
    try {
      await apiFetch(`/api/v1/admin/decisions/${encodeURIComponent(key)}`, {
        method: 'POST',
        body: JSON.stringify({ status: f.status || 'DECIDED', decidedValue: f.decidedValue || undefined, decidedByName: f.decidedByName || undefined, decidedDate: f.decidedDate || undefined, documentRef: f.documentRef || undefined, note: f.note || undefined }),
      });
      toast('결정 기입됨', 'success');
      setDForm((p) => { const n = { ...p }; delete n[key]; return n; });
      await load();
    } catch (e) { toast(e instanceof Error ? e.message : '기입 실패', 'error'); }
    finally { setBusy(false); }
  }

  // 개시 최종 승인/철회(ADM). 차단 잔존 시 강행은 override+잔여위험 프롬프트.
  async function approveGoLive() {
    const approvedByName = window.prompt('개시 승인 주체(개시 책임자·부서)를 입력하세요');
    if (approvedByName == null) return;
    const blocked = (golive?.blockingOpen ?? 0) > 0;
    let residualRisk: string | undefined;
    if (blocked) {
      const r = window.prompt(`개시 차단 ${golive?.blockingOpen}건이 남아 있습니다. 강행 승인하려면 잔여위험·사유를 입력하세요(취소하려면 빈칸)`);
      if (!r || !r.trim()) { toast('강행 승인 취소(잔여위험 미입력)', 'info'); return; }
      residualRisk = r.trim();
    }
    setBusy(true);
    try {
      await apiFetch('/api/v1/admin/golive/approve', { method: 'POST', body: JSON.stringify({ approvedByName, override: blocked || undefined, residualRisk }) });
      toast(blocked ? '개시 강행 승인됨(잔여위험 기록)' : '개시 승인됨', 'success');
      await load();
    } catch (e) { toast(e instanceof Error ? e.message : '승인 실패', 'error'); }
    finally { setBusy(false); }
  }
  async function revokeGoLive() {
    if (!window.confirm('개시 승인을 철회하시겠습니까?')) return;
    setBusy(true);
    try { await apiFetch('/api/v1/admin/golive/revoke', { method: 'POST', body: '{}' }); toast('개시 승인 철회됨', 'info'); await load(); }
    catch (e) { toast(e instanceof Error ? e.message : '철회 실패', 'error'); }
    finally { setBusy(false); }
  }

  useEffect(() => { if (!getToken()) { router.push('/'); return; } void load(); }, [router, load]);

  async function seed() {
    // 서버도 실값·개시승인을 보호하지만, 클릭 한 번으로 도는 작업이라 확인을 한 겹 더 둔다.
    if (!window.confirm('파일럿 시드값을 설정합니다. 위험치 채널이 비어 있거나 시드일 때만 시드 sink로 설정되며, 실 URL은 덮어쓰지 않습니다. 진행할까요?')) return;
    setBusy(true);
    try {
      const r = await apiFetch<{ providersLinked: number }>('/api/v1/admin/readiness/seed', { method: 'POST', body: '{}' });
      toast(`파일럿 시드 — 위험치채널 시드·판독의 연결 ${r.providersLinked}건 (조직결재·검사실서명은 실 몫)`, 'success');
      await load();
    } catch (e) { toast(e instanceof Error ? e.message : '시드 실패', 'error'); }
    finally { setBusy(false); }
  }

  // 개시 차단 = blocking 항목 중 미완(OK 아님) — 시드/‘http만’ 위험치 채널도 개시 전 해소 대상.
  const isOpenBlocker = (i: Item) => i.blocking && i.status !== 'OK';
  const show = (i: Item) => !onlyBlock || isOpenBlocker(i);

  return (
    <main className="page-doc">
      <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
        <h1 className="t-page">운영 관리 콘솔</h1>
        {data && (
          <div className="flex items-center gap-2 text-sm flex-wrap">
            {data.summary.blockingOpen > 0 && <span className="px-2 py-0.5 rounded bg-crit/15 text-crit font-bold">개시 차단 {data.summary.blockingOpen}</span>}
            {data.summary.review > 0 && <span className="px-2 py-0.5 rounded bg-crit/10 text-crit font-bold">재검토 {data.summary.review}</span>}
            <span className="px-2 py-0.5 rounded bg-warn/10 text-warn font-bold">대기 {data.summary.warn}</span>
            {data.summary.seed > 0 && <span className="px-2 py-0.5 rounded bg-indigo/10 text-indigo font-bold">시드 {data.summary.seed}</span>}
            <span className="px-2 py-0.5 rounded bg-good/10 text-good font-bold">완료 {data.summary.ok}/{data.summary.total}</span>
            <div className="flex rounded-lg border border-line overflow-hidden text-xs ml-1">
              <button onClick={() => setView('axis')} className={`px-2 py-1 ${view === 'axis' ? 'bg-teal text-white font-semibold' : 'text-ink-2'}`}>축별</button>
              <button onClick={() => setView('flow')} className={`px-2 py-1 ${view === 'flow' ? 'bg-teal text-white font-semibold' : 'text-ink-2'}`}>워크플로우</button>
              <button onClick={() => setView('log')} className={`px-2 py-1 ${view === 'log' ? 'bg-teal text-white font-semibold' : 'text-ink-2'}`}>이력</button>
              <button onClick={() => setView('decisions')} className={`px-2 py-1 ${view === 'decisions' ? 'bg-teal text-white font-semibold' : 'text-ink-2'}`}>결정등록</button>
            </div>
            {view === 'axis' && <button onClick={() => setOnlyBlock((v) => !v)} className={`text-xs px-2 py-1 rounded border ${onlyBlock ? 'border-crit/50 text-crit bg-crit/5' : 'border-line text-ink-2'}`}>차단만</button>}
            {canWrite && <button onClick={seed} disabled={busy} className="text-xs px-2 py-1 rounded border border-indigo/40 text-indigo font-semibold disabled:opacity-50">{busy ? '설정 중…' : '시드값 설정'}</button>}
            <button onClick={load} className="text-xs text-teal underline">새로고침</button>
          </div>
        )}
      </div>
      <p className="text-xs text-ink-2 mb-4">
        개시·운영에 <b>정의해야 하는 관리 항목</b>을 4축으로 집계하고, <b>워크플로우</b> 뷰로 각 항목이 어느 단계
        (미정의→시드→설정→서명·결재→운영)에 있는지 봅니다. <b className="text-crit">차단</b>은 개시를 막고, <b className="text-indigo">시드</b>는 파일럿 임시값입니다.
      </p>

      {/* 개시 승인(Go-Live) 배너 — 조직 최종 GO/NO-GO. 차단 0이어야 승인 가능(강행은 override) */}
      {golive && (
        <div className={`mb-4 rounded-xl border px-3 py-2.5 flex items-center gap-3 flex-wrap ${golive.state === 'APPROVED' ? 'border-good/50 bg-good/[0.06]' : golive.state === 'READY' ? 'border-indigo/50 bg-indigo/[0.06]' : 'border-crit/50 bg-crit/[0.06]'}`}>
          <span className={`text-sm font-bold ${golive.state === 'APPROVED' ? 'text-good' : golive.state === 'READY' ? 'text-indigo' : 'text-crit'}`}>
            {golive.state === 'APPROVED' ? '개시 승인됨'
              : golive.state === 'APPROVED_STALE' ? `승인 후 차단 재발생 ${golive.blockingOpen}건 — 승인 무효(재검토)`
              : golive.state === 'READY' ? '🟦 개시 준비 완료 — 승인 대기'
              : `⛔ 개시 차단 ${golive.blockingOpen}건 미해소`}
          </span>
          {(golive.state === 'APPROVED' || golive.state === 'APPROVED_STALE') && golive.current && (
            <span className="text-xs text-ink-2">
              by {golive.current.approvedByName ?? '—'}{golive.current.approvedDate ? ` · ${golive.current.approvedDate}` : ''}{golive.current.override ? ' · 강행(잔여위험)' : ''}{golive.current.approvedBy ? ` · 기입 ${golive.current.approvedBy}` : ''}
              {/* 강행 승인의 잔여위험 사유 — 개시를 가능케 한 판단 근거. 표시 없으면 '왜 강행했는지'가 사문화된다. */}
              {golive.current.residualRisk && <span className="block text-crit mt-0.5">잔여위험: {golive.current.residualRisk}</span>}
              {golive.current.note && <span className="block text-ink-3 mt-0.5">비고: {golive.current.note}</span>}
            </span>
          )}
          {golive.state !== 'APPROVED' && golive.openBlockers.length > 0 && (
            <span className="text-xs text-ink-2">{golive.state === 'APPROVED_STALE' ? '재발생 포함 차단' : '남은 차단'}: {golive.openBlockers.map((b) => b.label).join(', ')}</span>
          )}
          {canWrite && (golive.state === 'APPROVED' || golive.state === 'APPROVED_STALE'
            ? <button onClick={revokeGoLive} disabled={busy} className="ml-auto text-xs px-2 py-1 rounded border border-line text-ink-2 disabled:opacity-50">승인 철회</button>
            : <button onClick={approveGoLive} disabled={busy} className={`ml-auto text-xs px-3 py-1 rounded font-semibold text-white disabled:opacity-50 ${golive.state === 'READY' ? 'bg-indigo' : 'bg-crit'}`}>{golive.state === 'READY' ? '개시 승인' : '강행 승인(override)'}</button>)}
        </div>
      )}

      {err && <ErrorText message={err} />}
      {loading && !data ? <Loading /> : data && view === 'axis' ? (
        <div className="flex flex-col gap-5">
          {onlyBlock && data.summary.blockingOpen === 0 && (
            <p className="border border-good/40 bg-good/[0.04] rounded-xl p-3 text-sm text-good">개시 차단 항목 없음 — 모든 blocking 항목 완료.</p>
          )}
          {data.axes.map((ax) => {
            const items = ax.items.filter(show);
            if (items.length === 0) return null;
            return (
              <section key={ax.axis}>
                <div className="flex items-center gap-2 mb-2">
                  <span className="t-micro font-bold text-teal">{ax.axis}</span>
                  <h2 className="t-section text-sm">{ax.label}</h2>
                  <span className="t-micro text-ink-3">{ax.progress.ok}/{ax.progress.total} 완료</span>
                </div>
                <div className="grid md:grid-cols-2 gap-2">
                  {items.map((i) => (
                    <div key={i.key} className={`border rounded-xl p-3 flex items-start gap-3 ${TONE[i.status]}`}>
                      <span className={`w-2.5 h-2.5 rounded-full mt-1.5 shrink-0 ${DOT[i.status]}`} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-sm">{i.label}</span>
                          <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded ${BADGE[i.status]}`}>{LABEL[i.status]}</span>
                          <span className={`text-[11px] px-1.5 py-0.5 rounded ${STAGE_TONE[i.stage] ?? 'bg-bg text-ink-3'}`}>{STAGE_LABEL[i.stage] ?? i.stage}</span>
                          {i.review && <span className="text-[11px] text-crit border border-crit/30 rounded px-1">재검토</span>}
                          {isOpenBlocker(i) && <span className="text-[11px] text-crit border border-crit/30 rounded px-1">개시차단</span>}
                        </div>
                        <p className="text-xs text-ink-2 mt-0.5">{i.detail}</p>
                        <p className="t-micro text-ink-3 mt-0.5">담당: {i.owner}{i.next && <span className="text-teal"> · 다음: {i.next}</span>}</p>
                      </div>
                      {i.fix && i.status !== 'OK' && (
                        <Link href={i.fix} className="text-xs text-teal underline whitespace-nowrap shrink-0 mt-1">해결 →</Link>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
          <p className="t-micro text-ink-3">점검 {data.generatedAt.slice(0, 16).replace('T', ' ')} · 상세는 컷오버 런시트·기획서(운영관리콘솔 통합) 참조.</p>
        </div>
      ) : data && view === 'flow' ? (
        // 워크플로우(파이프라인) 뷰 — 각 항목이 lifecycle 어느 단계인지
        <div className="overflow-x-auto">
          <div className="flex gap-3 min-w-max pb-2">
            {STAGE_ORDER.map((st) => {
              const col = data.pipeline.find((p) => p.stage === st);
              const items = col?.items ?? [];
              return (
                <div key={st} className="w-44 shrink-0">
                  <div className={`text-xs font-bold px-2 py-1 rounded-t-lg ${STAGE_TONE[st]}`}>{STAGE_LABEL[st]} <span className="opacity-70">{items.length}</span></div>
                  <div className="border border-t-0 border-line rounded-b-lg p-2 min-h-24 flex flex-col gap-1.5 bg-surface">
                    {items.length === 0 ? <span className="t-micro text-ink-3 text-center py-2">—</span> :
                      items.map((i) => (
                        <div key={i.key} className={`text-xs rounded-lg border px-2 py-1.5 ${TONE[i.status]}`}>
                          <div className="flex items-center gap-1"><span className={`w-1.5 h-1.5 rounded-full ${DOT[i.status]}`} /><span className="t-micro text-ink-3">축{i.axis}</span></div>
                          <div className="font-medium leading-tight mt-0.5">{i.label}</div>
                        </div>
                      ))}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="t-micro text-ink-3 mt-2">왼쪽일수록 미정의, 오른쪽 운영(LIVE)·재검토. 각 항목은 담당 화면에서 다음 단계로 진행합니다. (축별 뷰에서 &lsquo;해결→&rsquo; 이동)</p>
        </div>
      ) : data && view === 'log' ? (
        // 통합 이력(P3) — 결재·서명·반입·설정·반사검사 이벤트 한 타임라인
        <div>
          {actErr ? <p className="t-micro text-crit">이력 조회 실패 — 새로고침으로 재시도</p> : !act ? <p className="t-micro text-ink-3">이력 불러오는 중…</p> : act.events.length === 0 ? <p className="t-micro text-ink-3">이력 없음</p> : (
            <ul className="flex flex-col gap-1.5">
              {act.events.map((e, idx) => (
                <li key={idx} className="flex items-start gap-3 border-b border-line pb-1.5 last:border-0 text-sm">
                  <span className="mono text-xs text-ink-3 w-28 shrink-0">{e.at.slice(0, 16).replace('T', ' ')}</span>
                  <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded shrink-0 ${CAT_TONE[e.category] ?? 'bg-bg text-ink-2'}`}>{e.category}</span>
                  <span className="min-w-0 flex-1">{e.summary}{e.actor && <span className="text-ink-3 text-xs"> · {e.actor}</span>}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="t-micro text-ink-3 mt-2">결재·서명·코드셋 반입·설정 변경·반사검사 프로토콜 이벤트 통합(최근순). 시크릿류는 값 미노출.</p>
        </div>
      ) : data && (
        // 조직·외부 결정 등록 — 시스템 추론 불가한 사람/조직 결정을 결정값·주체·근거와 함께 캡처
        <div className="flex flex-col gap-2">
          {!canWrite && <p className="t-micro text-ink-3">읽기 전용 — 결정 기입은 관리자(ADM)만. 결정 주체(부서)는 자유 기재, 기입자는 시스템이 자동 기록.</p>}
          {!decisions ? <p className="t-micro text-ink-3">불러오는 중…</p> : decisions.map((d) => {
            const decided = d.status === 'DECIDED';
            const tone = decided ? 'border-good/40 bg-good/[0.04]' : d.blocking ? 'border-crit/40 bg-crit/[0.05]' : 'border-warn/40 bg-warn/[0.04]';
            const f = dForm[d.key] ?? { status: 'DECIDED', decidedValue: '', decidedByName: '', decidedDate: '', documentRef: '', note: '' };
            const setF = (patch: Partial<typeof f>) => setDForm((p) => ({ ...p, [d.key]: { ...f, ...patch } }));
            return (
              <div key={d.key} className={`border rounded-xl p-3 ${tone}`}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-sm">{d.label}</span>
                  <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded ${decided ? 'bg-good/15 text-good' : d.blocking ? 'bg-crit/15 text-crit' : 'bg-warn/15 text-warn'}`}>{decided ? '결정완료' : d.status === 'HOLD' ? '보류' : d.status === 'IN_PROGRESS' ? '진행' : d.blocking ? '개시차단' : '대기'}</span>
                  <span className="t-micro text-ink-3">담당: {d.owner}</span>
                </div>
                {decided ? (
                  <p className="text-xs text-ink-2 mt-1">결정: <b>{d.decidedValue}</b>{d.decidedByName && <span> · {d.decidedByName}</span>}{d.decidedDate && <span> · {d.decidedDate}</span>}{d.documentRef && <span className="mono"> ({d.documentRef})</span>}{d.decidedBy && <span className="text-ink-3"> · 기입 {d.decidedBy}</span>}</p>
                ) : <p className="t-micro text-ink-3 mt-0.5">{d.hint}</p>}
                {/* 결정 비고 — 특히 HOLD(보류)의 사유. hint(정적 안내)와 별개로 실제 기입된 판단 근거. */}
                {d.note && <p className="t-micro text-ink-2 mt-0.5">비고: {d.note}{d.updatedDt && <span className="text-ink-3"> · {d.updatedDt.slice(0, 10)}</span>}</p>}
                {canWrite && (
                  <div className="mt-2 flex flex-wrap gap-1.5 items-center">
                    <select aria-label="상태" value={f.status} onChange={(e) => setF({ status: e.target.value })} className="text-xs px-1.5 py-1 rounded border border-line bg-bg"><option value="DECIDED">결정완료</option><option value="IN_PROGRESS">진행</option><option value="HOLD">보류</option><option value="PENDING">대기</option></select>
                    <input aria-label="결정 내용" placeholder="결정 내용/값" value={f.decidedValue} onChange={(e) => setF({ decidedValue: e.target.value })} className="text-xs px-1.5 py-1 rounded border border-line bg-bg w-48" />
                    <input aria-label="결정 주체" placeholder="결정 주체(부서·인물)" value={f.decidedByName} onChange={(e) => setF({ decidedByName: e.target.value })} className="text-xs px-1.5 py-1 rounded border border-line bg-bg w-36" />
                    <input aria-label="결정 일자" placeholder="YYYY-MM-DD" value={f.decidedDate} onChange={(e) => setF({ decidedDate: e.target.value })} className="text-xs px-1.5 py-1 rounded border border-line bg-bg w-28 mono" />
                    <input aria-label="근거 문서" placeholder="근거 문서번호" value={f.documentRef} onChange={(e) => setF({ documentRef: e.target.value })} className="text-xs px-1.5 py-1 rounded border border-line bg-bg w-32" />
                    <button onClick={() => recordDecision(d.key)} disabled={busy} className="text-xs px-2 py-1 rounded bg-indigo text-white font-semibold disabled:opacity-50">기입</button>
                  </div>
                )}
              </div>
            );
          })}
          <p className="t-micro text-ink-3 mt-1">시스템 상태로 추론 못 하는 조직·외부 결정을 여기서 기입하면 콘솔 ⑤축·개시차단 집계에 반영됩니다. 기입자는 시스템이 자동 기록(부인방지).</p>
        </div>
      )}
    </main>
  );
}
