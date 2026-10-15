'use client';

/**
 * 병리 판독 화면 (`/pathology`).
 *
 * 사이드바 노출 역할: PAT, ADM.
 * ⚠ 노출 역할과 화면이 호출하는 API 권한이 어긋나면 전부 403인 죽은 화면이 된다 —
 *   역할을 바꿀 때는 `Sidebar.tsx`(정본)와 API 권한 매트릭스를 함께 본다.
 * 데이터는 `lib/api.ts`의 `apiFetch`로만 가져온다(HTTP 호출 정본).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, getToken, getUserId } from '@/lib/api';
import AttachmentPanel from '@/components/AttachmentPanel';
import PathologyCaseTabs from '@/components/PathologyCaseTabs';
import TerminologyInput from '@/components/TerminologyInput';
import { useToast } from '@/components/toast';
import { useConfirm } from '@/components/confirm';
import { ErrorText } from '@/components/ui';
import { IconChevron } from '@/components/Icon';
import { maskName } from '@/lib/privacy';

interface PathReport {
  findings: string | null;
  diagnosis: string | null;
  snomed: string | null;
  synoptic: string | null;
  synopticProtocol: string | null;
  status: string | null;
  accessionNo: string | null;
  version: number | null;
  amendReason: string | null;
  signer: string | null;
  signedDt: string | null;
}
interface PathCase {
  spNo: string;
  specimenSite: string | null;
  status: string | null;
  receivedDate: string | null;
  grossedDt: string | null;
  grossDesc: string | null;
  mwlStatus: string | null;
  mwlSentDt: string | null;
  wsiConfirmedDt: string | null;
  wsiConfirmedBy: string | null;
  patient: { name: string };
  report: PathReport | null;
}
interface ViewerLink {
  accession: string;
  configured: boolean;
  found: boolean;
  viewerUrl: string | null;
  confirmed?: boolean;
  reason?: string;
}
interface Slide { slideId: string; stain: string; stainDetail: string | null; }
interface Block { blockId: string; label: string; tissue: string | null; slides: Slide[]; }
interface Tracking { spNo: string; status: string | null; grossDesc: string | null; blocks: Block[]; }
interface PathEvidence {
  case: { spNo: string; specimenSite: string | null; caseType: string | null; diagnosis: string | null };
  ihc: { marker: string | null; result: string | null; intensity: string | null; percentPos: number | null; score: string | null; interpretation: string | null }[];
  staging: { pT: string | null; pN: string | null; pM: string | null; stageGroup: string | null; icdoTopo: string | null; icdoMorph: string | null } | null;
  synoptic: { protocol: string | null; label: string | null; required: string[]; missing: string[]; complete: boolean } | null;
  cytology: { specimenType: string | null; adequacy: string | null; category: string | null } | null;
  linked: { kind: string; label: string }[];
  sources: string[]; promptContext: string; llmNote: string;
}

const stainBadge: Record<string, string> = { HE: 'bg-indigo/15 text-indigo', SPECIAL: 'bg-warn/15 text-warn', IHC: 'bg-teal/15 text-teal' };
// 구조화 암 보고(synoptic) 표준 필드 — CAP 암 프로토콜 간소화
const SYN_FIELDS = [
  { k: 'site', label: '종양 부위' }, { k: 'histology', label: '조직학적 유형' }, { k: 'grade', label: '조직학적 등급' },
  { k: 'size', label: '종양 크기' }, { k: 'margin', label: '절제연' }, { k: 'lvi', label: '림프혈관 침습' },
  { k: 'pni', label: '신경주위 침습' }, { k: 'nodes', label: '림프절(양성/검사)' }, { k: 'stage', label: '병기(pTNM)' },
];

export default function PathologyPage() {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [spNo, setSpNo] = useState('');
  const [pcase, setPcase] = useState<PathCase | null>(null);
  const [track, setTrack] = useState<Tracking | null>(null);
  const [gross, setGross] = useState('');
  const [grossEdit, setGrossEdit] = useState(false);
  const [blockLabel, setBlockLabel] = useState('A');
  const [blockTissue, setBlockTissue] = useState('');
  const [err, setErr] = useState('');
  const [viewerMsg, setViewerMsg] = useState('');
  const [rpt, setRpt] = useState({ findings: '', diagnosis: '', snomed: '', reason: '' });
  const [syn, setSyn] = useState<Record<string, string>>({});
  const [synOpen, setSynOpen] = useState(false);
  // CAP synoptic 프로토콜(옵인) — 선택 시 그 프로토콜의 필수요소를 사인아웃에서 검증(서버 validateSynoptic)
  const [synProtocol, setSynProtocol] = useState('');
  const [protocols, setProtocols] = useState<{ key: string; label: string; required: string[]; options?: Record<string, string[]> }[]>([]);
  useEffect(() => { apiFetch<{ key: string; label: string; required: string[]; options?: Record<string, string[]> }[]>('/api/v1/pathology/synoptic-protocols').then(setProtocols).catch(() => setProtocols([])); }, []);
  const [pecOpen, setPecOpen] = useState(false);
  const [pecRes, setPecRes] = useState<PathEvidence | null>(null);
  const [cases, setCases] = useState<{ spNo: string; patientName: string; specimenSite: string | null; status: string; reportStatus: string | null; assignedTo?: string | null; receivedDate?: string | null }[]>([]);
  const [slideDetail, setSlideDetail] = useState<Record<string, string>>({});
  const signer = getUserId() ?? '';

  // 기간 지정 시 완료분까지 포함해 조회한다(지난 건은 기본 목록에서 빠진다)
  const [caseFrom, setCaseFrom] = useState('');
  const [caseTo, setCaseTo] = useState('');
  const [caseStatus, setCaseStatus] = useState('');
  const loadCases = async (f = caseFrom, t = caseTo, st = caseStatus) => {
    try {
      const qs = new URLSearchParams();
      if (f) qs.set('from', f);
      if (t) qs.set('to', t);
      if (st) qs.set('status', st);
      setCases(await apiFetch(`/api/v1/pathology/cases${qs.toString() ? `?${qs}` : ''}`));
    } catch (e) { setErr(e instanceof Error ? e.message : '케이스 목록 조회 실패'); }
  };

  useEffect(() => {
    if (!getToken()) { router.push('/'); return; }
    loadCases();
    // loadCases는 매 렌더 새로 만들어지므로 deps에 넣으면 무한 재조회가 된다.
    // 여기는 **진입 시 1회 로드**가 의도다(기간·상태 변경은 [조회] 버튼이 명시 호출).
    // loadCases가 기본 인자로 읽는 caseFrom/caseTo/caseStatus는 useCallback이 아니라
    // 매 렌더 갱신되므로 sendout에서 있었던 '기간 고정' 버그는 여기 해당 없다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  async function loadPathEvidence() {
    if (!pcase) return;
    if (pecOpen) { setPecOpen(false); return; }
    setPecOpen(true); setPecRes(null);
    try { setPecRes(await apiFetch<PathEvidence>(`/api/v1/pathology/cases/${pcase.spNo}/evidence-context`)); }
    catch (e) { setErr(e instanceof Error ? e.message : '근거 종합 조회 실패'); setPecOpen(false); }
  }
  async function loadTracking(sp = spNo) {
    try { setTrack(await apiFetch<Tracking>(`/api/v1/pathology/cases/${sp}/tracking`)); }
    catch { setTrack(null); }
  }

  async function load(sp = spNo) {
    setErr('');
    setViewerMsg('');
    setPcase(null);
    try {
      const c = await apiFetch<PathCase>(`/api/v1/pathology/cases/${sp}`);
      setPcase(c);
      setRpt({ findings: c.report?.findings ?? '', diagnosis: c.report?.diagnosis ?? '', snomed: c.report?.snomed ?? '', reason: '' });
      try { setSyn(c.report?.synoptic ? JSON.parse(c.report.synoptic) : {}); } catch { setSyn({}); }
      setSynOpen(!!c.report?.synoptic || !!c.report?.synopticProtocol);
      setSynProtocol(c.report?.synopticProtocol ?? '');
      await loadTracking(sp);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '조회 실패');
    }
  }

  async function doGrossing() {
    if (!gross.trim()) return; setErr('');
    try { await apiFetch(`/api/v1/pathology/cases/${spNo}/grossing`, { method: 'POST', body: JSON.stringify({ grossDesc: gross, grossedBy: signer || undefined }) }); setGrossEdit(false); await loadTracking(); await load(spNo); }
    catch (e) { setErr(e instanceof Error ? e.message : '그로싱 실패'); }
  }
  async function addBlock() {
    setErr('');
    try { await apiFetch(`/api/v1/pathology/cases/${spNo}/blocks`, { method: 'POST', body: JSON.stringify({ label: blockLabel, tissue: blockTissue.trim() || undefined }) }); setBlockTissue(''); await loadTracking(); }
    catch (e) { setErr(e instanceof Error ? e.message : '블록 생성 실패'); }
  }
  async function addSlide(blockId: string, stain: string, detail?: string) {
    setErr('');
    // 특수·IHC는 염색/항체 명칭 필수(의미 없는 빈 슬라이드 방지)
    if ((stain === 'SPECIAL' || stain === 'IHC') && !detail?.trim()) { toast(`${stain === 'IHC' ? '항체' : '특수염색'} 명칭을 입력하세요`, 'info'); return; }
    try { await apiFetch(`/api/v1/pathology/blocks/${blockId}/slides`, { method: 'POST', body: JSON.stringify({ stain, stainDetail: detail || undefined }) }); await loadTracking(); }
    catch (e) { setErr(e instanceof Error ? e.message : '슬라이드 실패'); }
  }
  async function delSlide(slideId: string) {
    setErr('');
    try { await apiFetch(`/api/v1/pathology/slides/${slideId}`, { method: 'DELETE' }); await loadTracking(); }
    catch (e) { toast(e instanceof Error ? e.message : '슬라이드 삭제 실패', 'error'); }
  }
  async function delBlock(blockId: string) {
    setErr('');
    try { await apiFetch(`/api/v1/pathology/blocks/${blockId}`, { method: 'DELETE' }); await loadTracking(); }
    catch (e) { toast(e instanceof Error ? e.message : '블록 삭제 실패', 'error'); }
  }

  // PACS MWL 송신(ORM^O01 NW) — 병리 오더를 PACS 워크리스트에 등록해야 스캐너가 스터디를 생성함
  async function sendMwl(cancel = false) {
    if (!spNo.trim()) { toast('병리번호를 입력하세요', 'info'); return; }
    try {
      const r = await apiFetch<{ sentTo?: string; accession?: string; ackCode?: string }>(
        `/api/v1/integration/hl7/mwl/${encodeURIComponent(spNo)}/${cancel ? 'cancel' : 'send'}`, { method: 'POST' },
      );
      const ok = r.ackCode === 'AA';
      toast(`MWL ${cancel ? '취소' : '송신'} ${ok ? '성공' : (r.ackCode ?? '')} · Accession ${r.accession ?? '-'}${r.sentTo ? ` → ${r.sentTo}` : ''}`, ok ? 'success' : 'error');
    } catch (e) { toast(e instanceof Error ? e.message : `MWL ${cancel ? '취소' : '송신'} 실패(PACS 미연동 등)`, 'error'); }
  }

  // ③ WSI 열람 종단 확인 — viewer-link 해소 + found 시 열람 확인 기록(누가/언제) + 뷰어 열기.
  async function openViewer() {
    setViewerMsg('');
    try {
      const v = await apiFetch<ViewerLink>(`/api/v1/integration/hl7/pacs/viewer-link/${spNo}/confirm`, { method: 'POST' });
      if (!v.configured) {
        setViewerMsg(`PACS 연동 대기 중 (자격증명 수령 전) · Accession ${v.accession}`);
      } else if (v.found && v.viewerUrl) {
        window.open(v.viewerUrl, '_blank', 'noopener');
        toast('WSI 열람 확인 기록됨(③ 종단) · 뷰어 새 창', 'success');
        await load();
      } else {
        setViewerMsg(`WSI 미도착 — PACS에 해당 스터디 없음 · Accession ${v.accession}`);
      }
    } catch (e) {
      setViewerMsg(e instanceof Error ? e.message : '뷰어 링크 조회 실패');
    }
  }

  // C1: 판독 서명 확정(최초) / 개정(최종 이후)
  async function signReport() {
    if (!rpt.findings.trim() || !rpt.diagnosis.trim()) { toast('소견·진단을 입력하세요', 'info'); return; }
    // 표본추적(그로싱·블록) 미완 시 경고 — 서명은 허용하되 확인 요구
    if (track && (!track.grossDesc || track.blocks.length === 0)) {
      const ok = await confirm({
        title: '표본추적 미완 — 서명 확인',
        message: '그로싱 또는 블록 기록이 없는 상태에서 서명합니다. 표본추적을 먼저 완료하는 것을 권장합니다.',
        detail: [{ label: '그로싱', value: track.grossDesc ? '기록됨' : '없음' }, { label: '블록', value: `${track.blocks.length}건` }],
        confirmLabel: '그래도 서명',
      });
      if (!ok) return;
    }
    try {
      const synoptic = Object.fromEntries(Object.entries(syn).filter(([, v]) => (v ?? '').trim()));
      await apiFetch('/api/v1/pathology/reports/sign', { method: 'POST', body: JSON.stringify({ spNo, findings: rpt.findings, diagnosis: rpt.diagnosis, snomed: rpt.snomed || undefined, signer, synoptic: Object.keys(synoptic).length ? synoptic : undefined, synopticProtocol: synProtocol || undefined }) });
      toast('판독 서명 확정됨(Accession 부여)', 'success'); await load();
    } catch (e) { toast(e instanceof Error ? e.message : '서명 실패', 'error'); }
  }
  /**
   * 2단계 사인아웃 1단계 — 전공의 초안.
   *
   * 초안은 **서명이 아니다.** 전공의가 소견·진단을 먼저 적어 두고, 전문의가 확인해 서명한다.
   * 이 경로가 화면에 없어서 초안 작성이 곧 서명이 되거나(전공의가 서명 버튼을 누름) 아예
   * 시스템 밖(구두·메모)에서 이뤄졌다. 초안은 Accession을 부여하지 않는다.
   */
  async function draftReport() {
    if (!rpt.findings.trim() || !rpt.diagnosis.trim()) { toast('소견·진단을 입력하세요', 'info'); return; }
    try {
      const synoptic = Object.fromEntries(Object.entries(syn).filter(([, v]) => (v ?? '').trim()));
      await apiFetch('/api/v1/pathology/reports/draft', { method: 'POST', body: JSON.stringify({ spNo, findings: rpt.findings, diagnosis: rpt.diagnosis, snomed: rpt.snomed || undefined, synoptic: Object.keys(synoptic).length ? synoptic : undefined, synopticProtocol: synProtocol || undefined }) });
      toast('초안 저장됨 — 전문의 서명 대기', 'success'); await load();
    } catch (e) { toast(e instanceof Error ? e.message : '초안 저장 실패', 'error'); }
  }

  async function amendReport() {
    if (!rpt.findings.trim() || !rpt.diagnosis.trim() || !rpt.reason.trim()) { toast('소견·진단·개정사유를 입력하세요', 'info'); return; }
    try {
      await apiFetch(`/api/v1/pathology/reports/${spNo}/amend`, { method: 'POST', body: JSON.stringify({ findings: rpt.findings, diagnosis: rpt.diagnosis, reason: rpt.reason, signer }) });
      toast('보고서 개정됨', 'success'); await load();
    } catch (e) { toast(e instanceof Error ? e.message : '개정 실패', 'error'); }
  }
  const isFinal = pcase?.report?.status === '최종' || pcase?.report?.status === '개정';

  return (
    <main className="page">
      <h1 className="t-page mb-4">병리 판독</h1>

      <div className="flex gap-2 items-end mb-4">
        <div>
          <label className="block text-xs text-ink-2 mb-1">병리번호(SP)</label>
          <input
            aria-label="병리번호"
            className="mono px-3 py-2 rounded-lg border border-line bg-bg text-sm w-44"
            value={spNo}
            onChange={(e) => setSpNo(e.target.value)}
          />
        </div>
        <button onClick={() => load()} className="py-2 px-4 rounded-lg bg-teal text-white font-semibold text-sm">
          조회
        </button>
      </div>

      {/* C5 병리 워크리스트 — 기간 지정 시 완료분 포함(지난 건 조회) */}
      <section className="card mb-4">
          <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
            <h2 className="t-section">{caseFrom || caseTo ? '기간 케이스' : '대기 케이스'} <span className="t-meta">({cases.length})</span></h2>
            <div className="flex items-end gap-1.5">
              <div>
                <label htmlFor="pc-status" className="block t-micro mb-0.5">상태</label>
                <select id="pc-status" value={caseStatus} onChange={(e) => { setCaseStatus(e.target.value); void loadCases(caseFrom, caseTo, e.target.value); }} className="px-2 py-1 r-ctl border border-line bg-bg text-xs">
                  <option value="">대기(기본)</option>
                  <option value="접수">접수</option>
                  <option value="판독대기">판독대기</option>
                  <option value="완료">완료</option>
                  <option value="취소">취소</option>
                </select>
              </div>
              <div>
                <label htmlFor="pc-from" className="block t-micro mb-0.5">접수일 시작</label>
                <input id="pc-from" type="date" value={caseFrom} onChange={(e) => setCaseFrom(e.target.value)} className="px-2 py-1 r-ctl border border-line bg-bg text-xs" />
              </div>
              <div>
                <label htmlFor="pc-to" className="block t-micro mb-0.5">종료</label>
                <input id="pc-to" type="date" value={caseTo} onChange={(e) => setCaseTo(e.target.value)} className="px-2 py-1 r-ctl border border-line bg-bg text-xs" />
              </div>
              <button onClick={() => loadCases()} className="py-1 px-2.5 r-ctl bg-teal text-white text-xs font-semibold m-hover hover:bg-teal-2">조회</button>
              <button onClick={() => { setCaseFrom(''); setCaseTo(''); loadCases('', ''); }} className="py-1 px-2.5 r-ctl border border-line text-ink-2 text-xs font-semibold m-hover hover:border-teal hover:text-teal">대기만</button>
            </div>
          </div>
          {cases.length === 0 ? <p className="t-meta py-2">{caseFrom || caseTo ? '해당 기간에 케이스가 없습니다' : '대기 중인 케이스가 없습니다 — 기간으로 지난 건을 조회할 수 있습니다'}</p> : (
            <div className="overflow-x-auto max-h-80 overflow-y-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left t-micro text-ink-2 border-b border-line sticky top-0 bg-surface">
                  <th className="py-1.5 pr-3">병리번호</th><th className="pr-3">환자</th><th className="pr-3">검체부위</th><th className="pr-3">상태</th><th className="pr-3">담당</th><th className="pr-3">접수일</th>
                </tr></thead>
                <tbody>
                  {cases.map((c) => (
                    <tr key={c.spNo} onClick={() => { setSpNo(c.spNo); load(c.spNo); }}
                      className={`border-b border-line last:border-0 cursor-pointer ${spNo === c.spNo ? 'bg-teal/10' : 'hover:bg-bg'}`}>
                      <td className="py-1.5 pr-3 mono font-medium">{c.spNo}</td>
                      <td className="pr-3">{maskName(c.patientName)}</td>
                      <td className="pr-3 text-ink-2">{c.specimenSite || '—'}</td>
                      <td className="pr-3">
                        <span className={`px-1.5 py-0.5 r-chip t-micro ${(c.reportStatus === '최종' || c.reportStatus === '개정') ? 'bg-good/15 text-good' : c.status === '취소' ? 'bg-crit/15 text-crit' : c.reportStatus ? 'bg-indigo/15 text-indigo' : 'bg-bg text-ink-3'}`}>
                          {c.reportStatus ?? c.status}
                        </span>
                      </td>
                      <td className="pr-3 text-ink-3">{c.assignedTo ?? '—'}</td>
                      <td className="pr-3 mono text-ink-3">{c.receivedDate ?? '접수일 미상'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </section>

      {err && <ErrorText message={err} />}

      {pcase && (
        <div className="grid md:grid-cols-2 gap-4">
          <section className="card">
            <div className="flex items-center gap-2 mb-3">
              <span className="mono font-bold">{pcase.spNo}</span>
              <span className="font-semibold">{pcase.patient?.name}</span>
              <span className="mono text-xs text-ink-2">{pcase.specimenSite}</span>
              <button onClick={loadPathEvidence} title="근거 종합(IHC·병기·synoptic·분자 소견 통합)" className={`ml-auto py-0.5 px-2 rounded border text-[11px] font-semibold ${pecOpen ? 'bg-teal/10 border-teal/40 text-teal' : 'border-line hover:border-teal hover:text-teal'}`}>근거 종합</button>
            </div>
            {pecOpen && (
              <div className="mb-3 p-2 rounded-lg border border-teal/30 bg-teal/[0.03]">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[11px] font-bold text-teal">근거 종합</span>
                  <span className="text-[11px] text-ink-3">판독 검토용 · 향후 원내 LLM(RAG) 컨텍스트 · 외부 미전송</span>
                  <button onClick={() => { setPecOpen(false); setPecRes(null); }} className="ml-auto text-[11px] text-ink-3 hover:text-ink-2">닫기</button>
                </div>
                {!pecRes ? <p className="text-[11px] text-ink-3">불러오는 중…</p> : (
                  <div className="flex flex-col gap-1 text-[11px]">
                    <div className="flex gap-1 flex-wrap">{pecRes.sources.length ? pecRes.sources.map((sx, i) => <span key={i} className="px-1.5 py-0.5 rounded bg-teal/10 text-teal text-[11px] font-semibold">{sx}</span>) : <span className="text-ink-3">등록된 근거 없음</span>}</div>
                    {pecRes.ihc.length > 0 && <div className="text-ink-2">IHC: {pecRes.ihc.slice(0, 6).map((h) => `${h.marker} ${h.result ?? h.interpretation ?? ''}${h.score ? `(${h.score})` : ''}`).join(', ')}</div>}
                    {pecRes.staging && (pecRes.staging.pT || pecRes.staging.stageGroup) && <div className="text-ink-2">병기: {[pecRes.staging.pT, pecRes.staging.pN, pecRes.staging.pM, pecRes.staging.stageGroup].filter(Boolean).join(' ')}{pecRes.staging.icdoMorph ? ` · ICD-O ${pecRes.staging.icdoTopo ?? ''} ${pecRes.staging.icdoMorph}` : ''}</div>}
                    {pecRes.synoptic && <div className={pecRes.synoptic.complete ? 'text-teal' : 'text-warn'}>synoptic {pecRes.synoptic.label ?? pecRes.synoptic.protocol}: {pecRes.synoptic.complete ? '필수요소 충족' : `결손 ${pecRes.synoptic.missing.length}(${pecRes.synoptic.missing.slice(0, 4).join(', ')})`}</div>}
                    {pecRes.linked.length > 0 && <div className="text-ink-2">분자/체세포: {pecRes.linked.slice(0, 4).map((l) => l.label).join(' · ')}</div>}
                    <details><summary className="text-ink-3 cursor-pointer text-[11px]">RAG 컨텍스트 미리보기(모델에 넘길 문맥)</summary>
                      <pre className="mono text-[11px] text-ink-2 whitespace-pre-wrap bg-bg rounded p-1.5 mt-1 max-h-48 overflow-auto">{pecRes.promptContext}</pre>
                    </details>
                    <div className="text-[11px] text-ink-3">{pecRes.llmNote}</div>
                  </div>
                )}
              </div>
            )}
            <div className="text-sm">
              <div className="mb-2">
                <span className="text-xs text-ink-2 block mb-1">현미경 소견</span>
                <div className="bg-surface-2 rounded-lg p-2">{pcase.report?.findings ?? '—'}</div>
              </div>
              <div className="mb-2">
                <span className="text-xs text-ink-2 block mb-1">진단</span>
                <div className="bg-surface-2 rounded-lg p-2">
                  {pcase.report?.diagnosis ?? '—'}{' '}
                  {pcase.report?.snomed && <span className="mono text-xs text-ink-2">({pcase.report.snomed})</span>}
                </div>
              </div>
              {/* 구조화 암 보고(synoptic) — 서명 후에도 표시 */}
              {(() => {
                let synObj: Record<string, string> = {};
                try { synObj = pcase.report?.synoptic ? JSON.parse(pcase.report.synoptic) : {}; } catch { synObj = {}; }
                // 표준(영문 키)은 라벨로, CAP 프로토콜(한글 요소명 키)은 키 그대로 표시 — 전엔 영문 키만 걸러
                // CAP 프로토콜로 서명한 구조화 보고가 요약카드에서 통째로 빈칸이었다.
                const labelOf = (k: string) => SYN_FIELDS.find((f) => f.k === k)?.label ?? k;
                const entries = Object.entries(synObj).filter(([, v]) => (v ?? '').toString().trim());
                if (entries.length === 0) return null;
                return (
                  <div className="mb-2">
                    <span className="text-xs text-ink-2 block mb-1">구조화 암 보고(synoptic)</span>
                    <table className="w-full text-xs bg-surface-2 rounded-lg overflow-hidden">
                      <tbody>
                        {entries.map(([k, v]) => (
                          <tr key={k} className="border-b border-line last:border-0">
                            <td className="py-1 px-2 text-ink-2 w-32">{labelOf(k)}</td>
                            <td className="py-1 px-2 font-medium">{v}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })()}
              {/* 개정 이력 */}
              {pcase.report && (pcase.report.version ?? 1) > 1 && (
                <div className="mb-2 text-xs bg-warn/5 border border-warn/20 rounded-lg p-2">
                  <span className="font-bold text-warn">v{pcase.report.version} · 개정</span>
                  {pcase.report.amendReason && <span className="text-ink-2"> · 사유: {pcase.report.amendReason}</span>}
                </div>
              )}
              {/* 상태 타임라인 */}
              <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-ink-2 mb-1">
                {[
                  ['접수', pcase.receivedDate ?? null],
                  ['그로싱', pcase.grossedDt ? pcase.grossedDt.slice(0, 10) : null],
                  ['서명', pcase.report?.signedDt ? pcase.report.signedDt.slice(0, 10) : null],
                ].map(([label, dt], i, arr) => (
                  <span key={label as string} className="flex items-center gap-1">
                    <span className={`px-1.5 py-0.5 rounded ${dt ? 'bg-good/15 text-good font-semibold' : 'bg-bg text-ink-3'}`}>{label}{dt ? ` ${dt}` : ''}</span>
                    {i < arr.length - 1 && <span className="text-ink-3">→</span>}
                  </span>
                ))}
              </div>
              <div className="mono text-xs text-ink-2">
                상태 {pcase.report?.status ?? '—'}{pcase.report?.signer ? ` · 서명 ${pcase.report.signer}` : ''} · Accession {pcase.report?.accessionNo ?? '—'}
              </div>
            </div>
          </section>

          <section className="card">
            <h2 className="t-section mb-3">PACS 이미지</h2>
            <div className="aspect-[4/3] rounded-lg border border-line grid place-items-center text-ink-3 text-sm mb-3"
              style={{ background: 'linear-gradient(135deg,#b9548e22,#6244c922)' }}>
              슬라이드 이미지 (PACS 뷰어)
            </div>
            {/* PACS 연동 상태 — MWL 송신·WSI 열람 확인(③) 지속 표시 */}
            <div className="flex flex-wrap gap-2 text-xs mb-2">
              <span className={`px-2 py-0.5 rounded ${pcase.mwlStatus === 'SENT' ? 'bg-teal/15 text-teal' : pcase.mwlStatus === 'CANCELLED' ? 'bg-ink-3/15 text-ink-3' : 'bg-warn/15 text-warn'}`}>
                MWL {pcase.mwlStatus === 'SENT' ? `등록됨 · ${pcase.mwlSentDt?.slice(0, 16).replace('T', ' ')}` : pcase.mwlStatus === 'CANCELLED' ? '취소됨' : '미송신'}
              </span>
              <span className={`px-2 py-0.5 rounded ${pcase.wsiConfirmedDt ? 'bg-indigo/15 text-indigo' : 'bg-ink-3/10 text-ink-3'}`}>
                WSI 열람 {pcase.wsiConfirmedDt ? `확인됨 · ${pcase.wsiConfirmedBy ?? ''} ${pcase.wsiConfirmedDt.slice(0, 16).replace('T', ' ')}` : '미확인'}
              </span>
            </div>
            {/* PACS MWL 송신 — 스캐너/모달리티가 워크리스트로 스터디를 생성하려면 선행 필수 */}
            <div className="flex gap-2 mb-2">
              <button onClick={() => sendMwl(false)} className="py-2 px-3 rounded-lg bg-teal text-white font-semibold text-sm flex-1">MWL {pcase.mwlStatus === 'SENT' ? '재송신' : '송신'}(PACS 등록)</button>
              <button onClick={() => sendMwl(true)} className="py-2 px-3 rounded-lg border border-line text-sm">취소</button>
            </div>
            <button
              onClick={openViewer}
              className="py-2 px-4 rounded-lg bg-indigo text-white font-semibold text-sm w-full"
            >
              WSI 열람 확인 + 뷰어 열기 (③ 종단 확인)
            </button>
            <p className="text-xs text-ink-3 mt-1">순서: <b>MWL 송신</b> → 스캐너가 워크리스트로 스터디 생성 → <b>WSI 열람 확인</b>(found 시 기록·뷰어). PACS §4.4 마감 회신에 사용.</p>
            {viewerMsg && <p className="text-xs text-warn mt-2">{viewerMsg}</p>}
            <p className="text-xs text-ink-3 mt-2">
              흐름: QIDO(AccessionNumber) → StudyInstanceUID → 뷰어 딥링크(새 창)
            </p>
          </section>
        </div>
      )}

      {/* C1: 판독 · 서명 / 개정 */}
      {pcase && (
        <section className="card mt-4">
          <div className="flex items-center gap-2 mb-3">
            <h2 className="t-section">판독 {isFinal ? '개정' : '· 서명'}</h2>
            <span className="mono text-xs px-2 py-0.5 rounded bg-bg text-ink-2">{pcase.report?.status ?? '미판독'}</span>
            {pcase.report?.accessionNo && <span className="mono text-xs text-ink-3">Accession {pcase.report.accessionNo}</span>}
          </div>
          <div className="space-y-2">
            <div>
              <label className="block text-xs text-ink-2 mb-1">현미경 소견</label>
              <textarea value={rpt.findings} onChange={(e) => setRpt({ ...rpt, findings: e.target.value })} rows={3} className="w-full px-2 py-1.5 rounded-lg border border-line bg-bg text-sm" />
            </div>
            <div className="flex flex-wrap gap-2">
              <div className="flex-1 min-w-[12rem]">
                <label className="block text-xs text-ink-2 mb-1">진단 <span className="text-ink-3">코드 검색·선택 시 SNOMED 자동 결속</span></label>
                <TerminologyInput
                  value={rpt.diagnosis}
                  ariaLabel="진단 코드 검색"
                  onChange={(v) => setRpt((p) => ({ ...p, diagnosis: v }))}
                  onPick={(it) => setRpt((p) => ({ ...p, diagnosis: it.termKo || it.term, snomed: it.system === 'SNOMED' ? it.code : p.snomed }))}
                  placeholder="진단명 또는 코드 검색"
                />
              </div>
              <div className="w-44">
                <label className="block text-xs text-ink-2 mb-1">SNOMED(선택)</label>
                <TerminologyInput
                  value={rpt.snomed}
                  ariaLabel="SNOMED 코드 검색"
                  system="SNOMED"
                  mono
                  onChange={(v) => setRpt((p) => ({ ...p, snomed: v }))}
                  onPick={(it) => setRpt((p) => ({ ...p, snomed: it.code }))}
                  placeholder="M-/T- 코드 검색"
                />
              </div>
            </div>

            {/* 구조화 암 보고(synoptic) — 선택 */}
            <div>
              <button type="button" onClick={() => setSynOpen((v) => !v)} aria-expanded={synOpen} className="text-xs font-semibold text-teal">
                <IconChevron open={synOpen} /> 구조화 암 보고(synoptic) <span className="text-ink-3 font-normal">암 검체 선택</span>
              </button>
              {synOpen && (
                <div className="mt-2 p-2 rounded-lg border border-line bg-bg">
                  {/* 프로토콜 선택(옵인) — 선택 시 그 암종 CAP 필수요소만 입력·검증. 미선택은 자유 기재(검증 없음) */}
                  <div className="flex items-center gap-2 mb-2">
                    <label className="text-[11px] text-ink-2">CAP 프로토콜</label>
                    <select aria-label="synoptic 프로토콜" value={synProtocol} onChange={(e) => setSynProtocol(e.target.value)} className="px-1.5 py-1 rounded border border-line bg-surface text-xs">
                      <option value="">(자유 기재 — 검증 없음)</option>
                      {protocols.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                    </select>
                    {synProtocol && <span className="text-[11px] text-warn">선택 시 필수요소 누락이면 최종 확정 차단</span>}
                  </div>
                  <div className="grid sm:grid-cols-3 gap-2">
                    {(() => {
                      const proto = synProtocol ? protocols.find((p) => p.key === synProtocol) : null;
                      const fields = proto ? proto.required.map((k) => ({ k, label: k })) : SYN_FIELDS;
                      return fields.map((f) => {
                        const opts = proto?.options?.[f.k];
                        const listId = opts ? `syn-${synProtocol}-${f.k}` : undefined;
                        return (
                          <div key={f.k}>
                            <label className="block text-[11px] text-ink-2 mb-0.5">{f.label}{opts && <span className="text-ink-3"> </span>}</label>
                            {/* 콤보박스(datalist) — 허용값 선행 제시, 없는 값은 직접 입력('기타' 등) */}
                            <input aria-label={f.label} list={listId} value={syn[f.k] ?? ''} onChange={(e) => setSyn({ ...syn, [f.k]: e.target.value })} placeholder={opts ? '선택 또는 입력' : ''} className="w-full px-1.5 py-1 rounded border border-line bg-surface text-xs" />
                            {opts && <datalist id={listId}>{opts.map((o) => <option key={o} value={o} />)}</datalist>}
                          </div>
                        );
                      });
                    })()}
                  </div>
                </div>
              )}
            </div>

            {isFinal && (
              <div>
                <label className="block text-xs text-crit mb-1">개정 사유(필수)</label>
                <input aria-label="개정 사유(필수)" value={rpt.reason} onChange={(e) => setRpt({ ...rpt, reason: e.target.value })} className="w-full px-2 py-1.5 rounded-lg border border-crit/40 bg-bg text-sm" />
              </div>
            )}
            <div className="flex gap-2 pt-1">
              {isFinal
                ? <button onClick={amendReport} className="py-2 px-4 rounded-lg bg-warn text-white font-semibold text-sm">개정 서명</button>
                : <>
                    <button onClick={draftReport} className="py-2 px-4 rounded-lg border border-line text-sm font-semibold" title="전공의 초안 — 서명이 아니며 Accession도 부여되지 않습니다">초안 저장</button>
                    <button onClick={signReport} className="py-2 px-4 rounded-lg bg-teal text-white font-semibold text-sm">서명 확정</button>
                  </>}
            </div>
          </div>
        </section>
      )}

      {track && (
        <section className="card mt-4">
          <div className="flex items-center gap-2 mb-3">
            <h2 className="t-section">표본 추적</h2>
            <span className="mono text-xs px-2 py-0.5 rounded bg-bg text-ink-2">{track.status ?? '접수'}</span>
          </div>

          {/* 그로싱 — 기록 후에도 수정·추가 가능 */}
          <div className="mb-3">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs text-ink-2">그로싱(육안)</span>
              {track.grossDesc && !grossEdit && <button onClick={() => { setGross(track.grossDesc ?? ''); setGrossEdit(true); }} className="text-xs text-teal">수정</button>}
            </div>
            {track.grossDesc && !grossEdit ? (
              <div className="bg-bg rounded-lg p-2 text-sm">{track.grossDesc}</div>
            ) : (
              <div className="flex gap-2">
                <input aria-label="육안 소견" value={gross} onChange={(e) => setGross(e.target.value)} placeholder="육안 소견" className="flex-1 px-2 py-1.5 rounded-lg border border-line bg-bg text-sm" />
                <button onClick={doGrossing} className="py-1.5 px-3 rounded-lg bg-teal text-white font-semibold text-xs">기록</button>
                {grossEdit && <button onClick={() => { setGrossEdit(false); setGross(''); }} className="py-1.5 px-3 rounded-lg border border-line text-xs">취소</button>}
              </div>
            )}
          </div>

          {/* 블록·슬라이드 트리 */}
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <span className="text-xs text-ink-2">블록</span>
            <input aria-label="블록 라벨" value={blockLabel} onChange={(e) => setBlockLabel(e.target.value)} className="mono w-12 px-2 py-1 rounded border border-line bg-bg text-sm" />
            <input aria-label="조직/부위" value={blockTissue} onChange={(e) => setBlockTissue(e.target.value)} placeholder="조직/부위(예: 좌엽)" className="w-32 px-2 py-1 rounded border border-line bg-bg text-sm" />
            <button onClick={addBlock} className="py-1 px-2 rounded-lg bg-teal text-white font-semibold text-xs">블록 추가</button>
          </div>
          {track.blocks.length === 0 ? (
            <p className="text-sm text-ink-3">블록 없음</p>
          ) : (
            <div className="space-y-2">
              {track.blocks.map((b) => (
                <div key={b.blockId} className="border border-line rounded-lg p-2">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="mono text-xs font-bold">{b.blockId}</span>
                    <span className="text-xs text-ink-2">{b.tissue ?? ''}</span>
                    {b.slides.length === 0 && <button onClick={() => delBlock(b.blockId)} aria-label="블록 삭제" title="블록 삭제(슬라이드 없을 때)" className="text-xs text-crit hover:underline">삭제</button>}
                    <span className="ml-auto flex gap-1 items-center">
                      <input aria-label="염색 상세(항체/특수)" value={slideDetail[b.blockId] ?? ''} onChange={(e) => setSlideDetail({ ...slideDetail, [b.blockId]: e.target.value })}
                        placeholder="항체/특수(예 CK7)" className="mono text-xs px-1.5 py-0.5 rounded border border-line bg-bg w-24" />
                      <button onClick={() => addSlide(b.blockId, 'HE')} className="py-0.5 px-2 rounded bg-indigo/15 text-indigo text-xs font-bold">+H&E</button>
                      <button onClick={() => addSlide(b.blockId, 'SPECIAL', slideDetail[b.blockId])} className="py-0.5 px-2 rounded bg-warn/15 text-warn text-xs font-bold">+특수</button>
                      <button onClick={() => addSlide(b.blockId, 'IHC', slideDetail[b.blockId])} className="py-0.5 px-2 rounded bg-teal/15 text-teal text-xs font-bold">+IHC</button>
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {b.slides.map((s) => (
                      <span key={s.slideId} className={`px-2 py-0.5 rounded text-xs inline-flex items-center gap-1 ${stainBadge[s.stain] ?? 'bg-bg'}`}>
                        {s.stain}{s.stainDetail ? `·${s.stainDetail}` : ''}
                        <button onClick={() => delSlide(s.slideId)} aria-label="슬라이드 삭제" title="슬라이드 삭제" className="opacity-60 hover:opacity-100">✕</button>
                      </span>
                    ))}
                    {b.slides.length === 0 && <span className="text-xs text-ink-3">슬라이드 없음</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* PP1~PP8 케이스 상세 탭 — 검체·IHC·세포·병기·분자·보고서배포·물류 */}
      {pcase && <PathologyCaseTabs spNo={pcase.spNo} onChanged={() => load(pcase.spNo)} />}

      {pcase && <AttachmentPanel spNo={pcase.spNo} />}
    </main>
  );
}
