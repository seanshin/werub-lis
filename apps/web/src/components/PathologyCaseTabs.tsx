'use client';

/**
 * PathologyCaseTabs.tsx — 웹 공용 컴포넌트.
 *
 * 제공: PathologyCaseTabs.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import React from 'react';

import { useState, useEffect, useCallback } from 'react';
import { apiFetch, apiText, getUserId } from '@/lib/api';
import { useToast } from '@/components/toast';
import { IconWarn } from '@/components/Icon';

// ── 타입(병리 케이스 상세 — PP1~PP8) ──
interface Specimen { specimenId: string; partLabel: string; specimenType: string | null; site: string | null; description: string | null; }
interface Ihc { ihcId: string; marker: string; result: string | null; intensity: string | null; percentPos: number | null; score: string | null; interpretation: string | null; reportedBy: string | null; reportedDt: string; }
interface Cytology { specimenType: string; adequacy: string | null; adequacyNote: string | null; category: string | null; diagnosis: string | null; status: string; signer: string | null; }
interface Molecular { molId: string; target: string; panelCode: string | null; detection: string; ct: number | null; quantValue: string | null; interpretation: string | null; blockId: string | null; }
interface Somatic { findingId: string; category: string; gene: string | null; alteration: string | null; vaf: number | null; tier: string | null; therapy: string | null; runQcFlag: string | null; note: string | null; }
interface Addendum { addendumId?: string; seq: number; content: string; addedBy: string | null; addedDt: string; }
interface StainOrder { orderId: string; orderType: string; detail: string | null; status: string; requestedBy: string | null; requestedDt: string; }
interface Consult { consultId: string; consultType: string; consultant: string | null; question: string | null; opinion: string | null; status: string; requestedDt: string; }
interface CaseDetail {
  spNo: string; caseType: string; clinicalInfo: string | null; requestingProvider: string | null; specimenSite: string | null;
  assignedTo: string | null; rejectStatus: string | null; rejectReason: string | null;
  grossDesc: string | null; grossedBy: string | null; grossedDt: string | null;
  specimens: Specimen[]; ihcResults: Ihc[]; cytology: Cytology | null; molecular: Molecular[]; somatic: Somatic[];
  stainOrders: StainOrder[]; consults: Consult[];
  report: {
    pT: string | null; pN: string | null; pM: string | null; stageGroup: string | null; icdoTopo: string | null; icdoMorph: string | null; status: string | null;
    draftBy: string | null; draftDt: string | null; signer: string | null;
    frozenDx: string | null; frozenConcordance: string | null; frozenBy: string | null; frozenDt: string | null;
    addenda?: Addendum[];
  } | null;
}
interface Delivery { deliveryId: string; channel: string; recipient: string | null; deliveredBy: string | null; deliveredDt: string; note: string | null; }
interface ScanEvent { eventId: string; targetType: string; targetId: string; event: string; location: string | null; scannedBy: string | null; scannedDt: string; }
interface CustodyBlock { blockId: string; label: string; tissue: string | null; barcode: string | null; status: string; }
interface CustodySlide { slideId: string; blockId: string; stain: string; stainDetail: string | null; barcode: string | null; scanStatus: string; scannedDt: string | null; wsiRef: string | null; }
interface Custody { spNo: string; blocks: CustodyBlock[]; slides: CustodySlide[]; events: ScanEvent[]; }

const CYTO_SPECIMEN = ['PAP', 'FNA', 'FLUID', 'URINE', 'SPUTUM', 'OTHER'];
const CYTO_CATEGORY = ['NILM', 'ASC-US', 'ASC-H', 'LSIL', 'HSIL', 'AGC', 'AIS', 'SCC', 'ADENOCARCINOMA', '양성', '비정형', '의심', '악성', '판정보류'];
const DELIVER_CH = ['PRINT', 'PORTAL', 'PROVIDER', 'FAX'];
const scanBadge = (s: string) => s === 'SCANNED' ? 'bg-good/15 text-good' : s === 'FAILED' ? 'bg-crit/15 text-crit' : 'bg-ink-3/10 text-ink-3';
const blockBadge = (s: string) => s === 'CUT' ? 'bg-indigo/15 text-indigo' : s === 'EMBEDDED' ? 'bg-teal/15 text-teal' : 'bg-ink-3/10 text-ink-3';

const TABS = [
  { k: 'specimen', label: '검체·임상(PP1)' },
  { k: 'ihc', label: 'IHC(PP2)' },
  { k: 'cyto', label: '세포병리(PP3)' },
  { k: 'stage', label: '병기·분류(PP7)' },
  { k: 'mol', label: '분자(PP5)' },
  { k: 'report', label: '보고서·배포(PP4)' },
  { k: 'custody', label: '물류·custody(PP8)' },
  { k: 'manage', label: '판독관리(A~E)' },
] as const;
type TabKey = typeof TABS[number]['k'];

/**
 * 라벨-입력 자동 연결(접근성) — 자식 입력에 `aria-label`을 주입해 스크린리더가 읽게 한다.
 * 시각 라벨만 있고 프로그래매틱 연결이 없으면 SR 사용자는 "편집창"으로만 듣는다.
 */
const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div>
    <label className="block t-micro mb-0.5">{label}</label>
    {React.isValidElement(children) && !(children.props as { 'aria-label'?: string })['aria-label']
      ? React.cloneElement(children as React.ReactElement<{ 'aria-label'?: string }>, { 'aria-label': label })
      : children}
  </div>
);
const inputCls = 'w-full px-2 py-1 rounded border border-line bg-bg text-sm';

export default function PathologyCaseTabs({ spNo, onChanged }: { spNo: string; onChanged?: () => void }) {
  const toast = useToast();
  const uid = getUserId() ?? '';
  const [tab, setTab] = useState<TabKey>('specimen');
  const [c, setC] = useState<CaseDetail | null>(null);
  const [custody, setCustody] = useState<Custody | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);

  const reload = useCallback(async () => {
    try { setC(await apiFetch<CaseDetail>(`/api/v1/pathology/cases/${spNo}`)); } catch { setC(null); }
  }, [spNo]);
  useEffect(() => { reload(); }, [reload]);
  const refresh = async () => { await reload(); onChanged?.(); };

  // ── PP1 검체·임상 ──
  const [info, setInfo] = useState({ clinicalInfo: '', requestingProvider: '', specimenSite: '', caseType: '' });
  const [sp, setSp] = useState({ partLabel: '', specimenType: '', site: '', description: '' });
  useEffect(() => { if (c) setInfo({ clinicalInfo: c.clinicalInfo ?? '', requestingProvider: c.requestingProvider ?? '', specimenSite: c.specimenSite ?? '', caseType: c.caseType ?? 'SURGICAL' }); }, [c]);
  const saveInfo = async () => {
    try { await apiFetch(`/api/v1/pathology/cases/${spNo}/info`, { method: 'PATCH', body: JSON.stringify(info) }); toast('임상정보 저장됨', 'success'); await refresh(); }
    catch (e) { toast(e instanceof Error ? e.message : '저장 실패', 'error'); }
  };
  const addSpecimen = async () => {
    if (!sp.partLabel.trim()) { toast('part 라벨(A/B/C…)을 입력하세요', 'info'); return; }
    try { await apiFetch(`/api/v1/pathology/cases/${spNo}/specimens`, { method: 'POST', body: JSON.stringify(sp) }); setSp({ partLabel: '', specimenType: '', site: '', description: '' }); toast('검체 part 추가됨', 'success'); await refresh(); }
    catch (e) { toast(e instanceof Error ? e.message : '추가 실패', 'error'); }
  };

  // ── PP2 IHC ──
  const [ihc, setIhc] = useState({ marker: '', result: '', intensity: '', percentPos: '', score: '', interpretation: '' });
  const addIhc = async () => {
    if (!ihc.marker.trim()) { toast('marker(예: ER/PR/HER2/Ki-67)를 입력하세요', 'info'); return; }
    try {
      await apiFetch(`/api/v1/pathology/cases/${spNo}/ihc`, { method: 'POST', body: JSON.stringify({ ...ihc, percentPos: ihc.percentPos ? Number(ihc.percentPos) : undefined, result: ihc.result || undefined }) });
      setIhc({ marker: '', result: '', intensity: '', percentPos: '', score: '', interpretation: '' }); toast('IHC 결과 등록됨', 'success'); await refresh();
    } catch (e) { toast(e instanceof Error ? e.message : '등록 실패', 'error'); }
  };

  // ── PP3 세포병리 ──
  const [cyto, setCyto] = useState({ specimenType: 'PAP', adequacy: '', adequacyNote: '', category: '', diagnosis: '' });
  useEffect(() => { if (c?.cytology) setCyto({ specimenType: c.cytology.specimenType, adequacy: c.cytology.adequacy ?? '', adequacyNote: c.cytology.adequacyNote ?? '', category: c.cytology.category ?? '', diagnosis: c.cytology.diagnosis ?? '' }); }, [c]);
  const saveCyto = async () => {
    // 이미 서명된(최종/개정) 보고는 조용히 덮어쓰지 않고 명시적 개정으로만(악성 진단 무단 교체 방지)
    const signed = c?.cytology?.status === '최종' || c?.cytology?.status === '개정';
    if (signed && !window.confirm('이미 서명된 세포병리 보고입니다. 개정(정정)하시겠습니까? 개정 이력이 감사로그에 남습니다.')) return;
    try {
      await apiFetch(`/api/v1/pathology/cases/${spNo}/cytology`, { method: 'POST', body: JSON.stringify({ ...cyto, adequacy: cyto.adequacy || undefined, category: cyto.category || undefined, amend: signed || undefined }) });
      toast(signed ? '세포병리 보고 개정됨' : '세포병리 보고 저장됨', 'success'); await refresh();
    }
    catch (e) { toast(e instanceof Error ? e.message : '저장 실패', 'error'); }
  };

  // ── PP7 병기·분류 ──
  const [stg, setStg] = useState({ pT: '', pN: '', pM: '', stageGroup: '', icdoTopo: '', icdoMorph: '' });
  useEffect(() => { if (c?.report) setStg({ pT: c.report.pT ?? '', pN: c.report.pN ?? '', pM: c.report.pM ?? '', stageGroup: c.report.stageGroup ?? '', icdoTopo: c.report.icdoTopo ?? '', icdoMorph: c.report.icdoMorph ?? '' }); }, [c]);
  const saveStage = async () => {
    try { await apiFetch(`/api/v1/pathology/cases/${spNo}/staging`, { method: 'POST', body: JSON.stringify(stg) }); toast('병기·분류 저장됨', 'success'); await refresh(); }
    catch (e) { toast(e instanceof Error ? e.message : '저장 실패(형식 확인: ICD-O 형태 NNNN/N·국소부위 Cnn.n)', 'error'); }
  };

  // ── PP5 분자 결속 ──
  const [molId, setMolId] = useState('');
  const linkMol = async () => {
    if (!molId.trim()) { toast('분자검사 결과 ID를 입력하세요', 'info'); return; }
    try { await apiFetch(`/api/v1/pathology/molecular/${molId.trim()}/link`, { method: 'POST', body: JSON.stringify({ caseSpNo: spNo }) }); setMolId(''); toast('분자검사 결속됨', 'success'); await refresh(); }
    catch (e) { toast(e instanceof Error ? e.message : '결속 실패', 'error'); }
  };

  // ── PP4 보고서·배포 ──
  const [deliver, setDeliver] = useState({ channel: 'PROVIDER', recipient: '' });
  const loadDeliveries = useCallback(async () => { try { setDeliveries(await apiFetch<Delivery[]>(`/api/v1/pathology/cases/${spNo}/deliveries`)); } catch { setDeliveries([]); } }, [spNo]);
  useEffect(() => { if (tab === 'report') loadDeliveries(); }, [tab, loadDeliveries]);
  const openReport = async () => {
    try {
      const html = await apiText(`/api/v1/pathology/cases/${spNo}/report.html`);
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) { toast(e instanceof Error ? e.message : '보고서 열기 실패', 'error'); }
  };
  const doDeliver = async () => {
    try { await apiFetch(`/api/v1/pathology/cases/${spNo}/deliver`, { method: 'POST', body: JSON.stringify({ ...deliver, recipient: deliver.recipient || undefined, deliveredBy: uid || undefined }) }); setDeliver({ ...deliver, recipient: '' }); toast('배포 기록됨', 'success'); await loadDeliveries(); }
    catch (e) { toast(e instanceof Error ? e.message : '배포 실패(최종/개정 보고서만 배포 가능)', 'error'); }
  };

  // ── PP8 물류·custody ──
  const loadCustody = useCallback(async () => { try { setCustody(await apiFetch<Custody>(`/api/v1/pathology/cases/${spNo}/custody`)); } catch { setCustody(null); } }, [spNo]);
  useEffect(() => { if (tab === 'custody') loadCustody(); }, [tab, loadCustody]);
  const scanBlock = async (blockId: string, event: string) => {
    try { await apiFetch(`/api/v1/pathology/blocks/${blockId}/scan`, { method: 'POST', body: JSON.stringify({ event, scannedBy: uid || undefined }) }); toast(`블록 ${event}`, 'success'); await loadCustody(); }
    catch (e) { toast(e instanceof Error ? e.message : '스캔 실패', 'error'); }
  };
  const scanSlide = async (slideId: string, event: string) => {
    const wsiRef = event === 'SCAN' ? `WSI/${spNo}/${slideId}` : undefined;
    try { await apiFetch(`/api/v1/pathology/slides/${slideId}/scan`, { method: 'POST', body: JSON.stringify({ event, wsiRef, scannedBy: uid || undefined }) }); toast(`슬라이드 ${event}`, 'success'); await loadCustody(); }
    catch (e) { toast(e instanceof Error ? e.message : '스캔 실패', 'error'); }
  };

  // ── 판독관리(A~E) ──
  const [crit, setCrit] = useState({ diagnosisType: '예상외 악성', summary: '' });
  const [stain, setStain] = useState({ orderType: 'IHC', detail: '' });
  const [assignTo, setAssignTo] = useState('');
  const [consult, setConsult] = useState({ consultType: 'INTERNAL', consultant: '', question: '' });
  const [rejectReason, setRejectReason] = useState('');
  // 동결절편(수술 중 신속진단) — API는 있었으나 화면이 없어 기록할 방법이 없었다
  const [frozen, setFrozen] = useState({ frozenDx: '', concordance: '' });
  // 추가보고(addendum) — 진단 변경 없이 IHC·분자 결과를 덧붙인다(개정과 구분)
  const [addendum, setAddendum] = useState('');
  const [synoptic, setSynoptic] = useState<{ key: string; label: string; required: string[] }[] | null>(null);
  useEffect(() => { if (c) setAssignTo(c.assignedTo ?? ''); }, [c]);
  const CRIT_TYPES = ['예상외 악성', '진단 불일치', '감염(결핵/진균 등)', '즉각 처치 필요', '기타'];
  const post = async (path: string, body: object, ok: string, method = 'POST') => {
    try { await apiFetch(`/api/v1/pathology/${path}`, { method, body: JSON.stringify(body) }); toast(ok, 'success'); await refresh(); }
    catch (e) { toast(e instanceof Error ? e.message : '실패', 'error'); }
  };

  if (!c) return null;
  const reportFinal = c.report?.status === '최종' || c.report?.status === '개정';

  return (
    <section className="card mt-4">
      <div className="flex flex-wrap gap-1 mb-4 border-b border-line pb-2">
        {TABS.map((t) => (
          <button key={t.k} onClick={() => setTab(t.k)}
            className={`text-xs px-3 py-1.5 rounded-lg font-semibold ${tab === t.k ? 'bg-teal text-white' : 'text-ink-2 hover:bg-bg'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* PP1 검체·임상 */}
      {tab === 'specimen' && (
        <div className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-2">
            <Field label="임상 정보(병력)"><input value={info.clinicalInfo} onChange={(e) => setInfo({ ...info, clinicalInfo: e.target.value })} className={inputCls} /></Field>
            <Field label="의뢰의"><input value={info.requestingProvider} onChange={(e) => setInfo({ ...info, requestingProvider: e.target.value })} className={inputCls} /></Field>
            <Field label="검체 부위"><input value={info.specimenSite} onChange={(e) => setInfo({ ...info, specimenSite: e.target.value })} className={inputCls} /></Field>
            <Field label="케이스 유형"><select value={info.caseType} onChange={(e) => setInfo({ ...info, caseType: e.target.value })} className={inputCls}><option value="SURGICAL">외과병리</option><option value="CYTOLOGY">세포병리</option><option value="FROZEN">동결절편</option></select></Field>
          </div>
          <button onClick={saveInfo} className="py-1.5 px-4 rounded-lg bg-teal text-white font-semibold text-xs">임상정보 저장</button>

          {/* 그로싱(육안소견) read-back — 기록됐으나 화면에 안 보였다. 판독 맥락에 필수. */}
          {c.grossDesc && (
            <div className="rounded-lg border border-line bg-bg p-2">
              <h3 className="text-xs font-bold text-ink-2 mb-0.5">그로싱(육안 소견)</h3>
              <p className="text-sm text-ink whitespace-pre-wrap">{c.grossDesc}</p>
              <p className="text-[11px] text-ink-3 mt-0.5">{c.grossedBy ? `그로싱 ${c.grossedBy}` : ''}{c.grossedDt ? ` · ${c.grossedDt.slice(0, 16).replace('T', ' ')}` : ''}</p>
            </div>
          )}

          <div>
            <h3 className="text-xs font-bold text-ink-2 mb-2">다부위 검체(part)</h3>
            {c.specimens.length === 0 ? <p className="text-sm text-ink-3 mb-2">검체 part 없음</p> : (
              <table className="w-full text-xs bg-bg rounded-lg overflow-hidden mb-2">
                <thead><tr className="text-ink-2"><th className="text-left py-1 px-2">Part</th><th className="text-left px-2">종류</th><th className="text-left px-2">부위</th><th className="text-left px-2">설명</th></tr></thead>
                <tbody>{c.specimens.map((s) => (<tr key={s.specimenId} className="border-t border-line"><td className="py-1 px-2 mono font-bold">{s.partLabel}</td><td className="px-2">{s.specimenType ?? '-'}</td><td className="px-2">{s.site ?? '-'}</td><td className="px-2">{s.description ?? '-'}</td></tr>))}</tbody>
              </table>
            )}
            <div className="grid sm:grid-cols-4 gap-2 items-end">
              <Field label="Part(A/B/C)"><input value={sp.partLabel} onChange={(e) => setSp({ ...sp, partLabel: e.target.value })} className={`${inputCls} mono`} /></Field>
              <Field label="종류"><input aria-label="조직/세포" value={sp.specimenType} onChange={(e) => setSp({ ...sp, specimenType: e.target.value })} placeholder="조직/세포" className={inputCls} /></Field>
              <Field label="부위"><input value={sp.site} onChange={(e) => setSp({ ...sp, site: e.target.value })} className={inputCls} /></Field>
              <button onClick={addSpecimen} className="py-1.5 px-3 rounded-lg bg-teal text-white font-semibold text-xs">part 추가</button>
            </div>
          </div>
        </div>
      )}

      {/* PP2 IHC */}
      {tab === 'ihc' && (
        <div className="space-y-3">
          {c.ihcResults.length === 0 ? <p className="text-sm text-ink-3">IHC 결과 없음</p> : (
            <table className="w-full text-xs bg-bg rounded-lg overflow-hidden">
              <thead><tr className="text-ink-2"><th className="text-left py-1 px-2">Marker</th><th className="text-left px-2">결과</th><th className="text-left px-2">강도</th><th className="text-left px-2">양성%</th><th className="text-left px-2">Score</th><th className="text-left px-2">해석</th></tr></thead>
              <tbody>{c.ihcResults.map((i) => (<tr key={i.ihcId} className="border-t border-line"><td className="py-1 px-2 font-bold">{i.marker}</td><td className="px-2">{i.result ?? '-'}</td><td className="px-2">{i.intensity ?? '-'}</td><td className="px-2">{i.percentPos != null ? `${i.percentPos}%` : '-'}</td><td className="px-2">{i.score ?? '-'}</td><td className="px-2">{i.interpretation ?? '-'}</td></tr>))}</tbody>
            </table>
          )}
          <div className="grid sm:grid-cols-6 gap-2 items-end p-2 rounded-lg border border-line bg-bg">
            <Field label="Marker*"><input aria-label="HER2" value={ihc.marker} onChange={(e) => setIhc({ ...ihc, marker: e.target.value })} placeholder="HER2" className={inputCls} /></Field>
            <Field label="결과"><select value={ihc.result} onChange={(e) => setIhc({ ...ihc, result: e.target.value })} className={inputCls}><option value="">-</option><option value="POS">POS</option><option value="NEG">NEG</option><option value="EQUIVOCAL">EQUIVOCAL</option></select></Field>
            <Field label="강도"><input aria-label="3+" value={ihc.intensity} onChange={(e) => setIhc({ ...ihc, intensity: e.target.value })} placeholder="3+" className={inputCls} /></Field>
            <Field label="양성%"><input value={ihc.percentPos} onChange={(e) => setIhc({ ...ihc, percentPos: e.target.value })} inputMode="decimal" className={inputCls} /></Field>
            <Field label="Score"><input aria-label="HER2 3+" value={ihc.score} onChange={(e) => setIhc({ ...ihc, score: e.target.value })} placeholder="HER2 3+" className={inputCls} /></Field>
            <button onClick={addIhc} className="py-1.5 px-3 rounded-lg bg-teal text-white font-semibold text-xs">등록</button>
          </div>
        </div>
      )}

      {/* PP3 세포병리 */}
      {tab === 'cyto' && (
        <>
        {c.cytology && (
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
            <span className={`px-1.5 py-0.5 rounded font-bold ${c.cytology.status === '최종' || c.cytology.status === '개정' ? 'bg-good/15 text-good' : 'bg-warn/15 text-warn'}`}>{c.cytology.status === '최종' ? '서명 완료(최종)' : c.cytology.status === '개정' ? '개정됨' : c.cytology.status ?? '작성 중'}</span>
            {c.cytology.signer && <span className="text-ink-2">서명 {c.cytology.signer}</span>}
          </div>
        )}
        <div className="grid sm:grid-cols-2 gap-2">
          <Field label="검체 종류"><select value={cyto.specimenType} onChange={(e) => setCyto({ ...cyto, specimenType: e.target.value })} className={inputCls}>{CYTO_SPECIMEN.map((s) => <option key={s} value={s}>{s}</option>)}</select></Field>
          <Field label="검체 적정성"><select value={cyto.adequacy} onChange={(e) => setCyto({ ...cyto, adequacy: e.target.value })} className={inputCls}><option value="">-</option><option value="SATISFACTORY">적정(SATISFACTORY)</option><option value="UNSATISFACTORY">부적정(UNSATISFACTORY)</option></select></Field>
          <Field label="분류(Bethesda/일반)"><select value={cyto.category} onChange={(e) => setCyto({ ...cyto, category: e.target.value })} className={inputCls}><option value="">-</option>{CYTO_CATEGORY.map((s) => <option key={s} value={s}>{s}</option>)}</select></Field>
          <Field label="적정성 비고"><input value={cyto.adequacyNote} onChange={(e) => setCyto({ ...cyto, adequacyNote: e.target.value })} className={inputCls} /></Field>
          <div className="sm:col-span-2"><Field label="진단"><input value={cyto.diagnosis} onChange={(e) => setCyto({ ...cyto, diagnosis: e.target.value })} className={inputCls} /></Field></div>
          <div><button onClick={saveCyto} className="py-1.5 px-4 rounded-lg bg-teal text-white font-semibold text-xs">세포병리 저장</button></div>
        </div>
        </>
      )}

      {/* PP7 병기·분류 */}
      {tab === 'stage' && (
        <div className="grid sm:grid-cols-3 gap-2">
          <Field label="pT (예: pT3)"><input value={stg.pT} onChange={(e) => setStg({ ...stg, pT: e.target.value })} className={`${inputCls} mono`} /></Field>
          <Field label="pN (예: pN1a)"><input value={stg.pN} onChange={(e) => setStg({ ...stg, pN: e.target.value })} className={`${inputCls} mono`} /></Field>
          <Field label="pM (예: M0)"><input value={stg.pM} onChange={(e) => setStg({ ...stg, pM: e.target.value })} className={`${inputCls} mono`} /></Field>
          <Field label="병기군(AJCC, 예 IIIA)"><input value={stg.stageGroup} onChange={(e) => setStg({ ...stg, stageGroup: e.target.value })} className={`${inputCls} mono`} /></Field>
          <Field label="ICD-O 국소부위(Cnn.n)"><input aria-label="C16.9" value={stg.icdoTopo} onChange={(e) => setStg({ ...stg, icdoTopo: e.target.value })} placeholder="C16.9" className={`${inputCls} mono`} /></Field>
          <Field label="ICD-O 형태(NNNN/N)"><input aria-label="8140/3" value={stg.icdoMorph} onChange={(e) => setStg({ ...stg, icdoMorph: e.target.value })} placeholder="8140/3" className={`${inputCls} mono`} /></Field>
          <div className="sm:col-span-3"><button onClick={saveStage} className="py-1.5 px-4 rounded-lg bg-teal text-white font-semibold text-xs">병기·분류 저장</button></div>
        </div>
      )}

      {/* PP5 분자 */}
      {tab === 'mol' && (
        <div className="space-y-3">
          <div>
            <h3 className="text-xs font-bold text-ink-2 mb-1">분자검사(PCR 등)</h3>
            {c.molecular.length === 0 ? <p className="text-sm text-ink-3">결속된 분자검사 없음</p> : (
              <table className="w-full text-xs bg-bg rounded-lg overflow-hidden">
                <thead><tr className="text-ink-2"><th className="text-left py-1 px-2">타깃</th><th className="text-left px-2">패널</th><th className="text-left px-2">검출</th><th className="text-left px-2">Ct</th><th className="text-left px-2">해석</th></tr></thead>
                <tbody>{c.molecular.map((m) => (<tr key={m.molId} className="border-t border-line"><td className="py-1 px-2 font-bold">{m.target}</td><td className="px-2">{m.panelCode ?? '-'}</td><td className="px-2">{m.detection}</td><td className="px-2">{m.ct ?? '-'}</td><td className="px-2">{m.interpretation ?? '-'}</td></tr>))}</tbody>
              </table>
            )}
          </div>
          {c.somatic.length > 0 && (
            <div>
              <h3 className="text-xs font-bold text-ink-2 mb-1">체세포(NGS) 소견</h3>
              <table className="w-full text-xs bg-bg rounded-lg overflow-hidden">
                <thead><tr className="text-ink-2"><th className="text-left py-1 px-2">유형</th><th className="text-left px-2">유전자</th><th className="text-left px-2">변이</th><th className="text-left px-2">VAF</th><th className="text-left px-2">Tier</th><th className="text-left px-2">연관 치료</th></tr></thead>
                <tbody>{c.somatic.map((s) => (<tr key={s.findingId} className="border-t border-line"><td className="py-1 px-2">{s.category}{s.runQcFlag && <span className="block px-1 rounded bg-crit/15 text-crit font-bold" title={s.runQcFlag}><IconWarn className="mr-1" />QC</span>}</td><td className="px-2 font-bold">{s.gene ?? '-'}</td><td className="px-2">{s.alteration ?? '-'}{s.note && <span className="block text-ink-3" title={s.note}>{s.note.length > 30 ? `${s.note.slice(0, 30)}…` : s.note}</span>}</td><td className="px-2">{s.vaf != null ? `${s.vaf}%` : '-'}</td><td className="px-2">{s.tier ?? '-'}</td><td className="px-2 text-ink-2">{s.therapy ?? '-'}</td></tr>))}</tbody>
              </table>
            </div>
          )}
          <div className="flex gap-2 items-end p-2 rounded-lg border border-line bg-bg">
            <Field label="분자검사 결과 ID 결속"><input aria-label="molId" value={molId} onChange={(e) => setMolId(e.target.value)} placeholder="molId" className={`${inputCls} mono w-56`} /></Field>
            <button onClick={linkMol} className="py-1.5 px-3 rounded-lg bg-teal text-white font-semibold text-xs">케이스에 결속</button>
          </div>
        </div>
      )}

      {/* PP4 보고서·배포 */}
      {tab === 'report' && (
        <div className="space-y-3">
          {/* 2단계 사인아웃 상태(B4) — 초안(전공의)→최종 서명(판독전문의). 누가 어디까지 갔는지 표시. */}
          {c.report && (
            <div className="flex flex-wrap items-center gap-2 text-xs bg-bg border border-line rounded-lg p-2">
              <span className={`px-1.5 py-0.5 rounded font-bold ${reportFinal ? 'bg-good/15 text-good' : c.report.status === '초안' ? 'bg-indigo/15 text-indigo' : 'bg-warn/15 text-warn'}`}>{c.report.status ?? '작성 전'}</span>
              {c.report.draftBy && <span className="text-ink-2">초안 {c.report.draftBy}{c.report.draftDt ? ` · ${c.report.draftDt.slice(0, 16).replace('T', ' ')}` : ''}</span>}
              {c.report.signer && <span className="text-ink-2">서명 {c.report.signer}</span>}
              {c.report.draftBy && !c.report.signer && <span className="text-warn">최종 서명 대기</span>}
            </div>
          )}
          <div className="flex gap-2 flex-wrap">
            <button onClick={openReport} className="py-2 px-4 rounded-lg bg-indigo text-white font-semibold text-sm">보고서 열기·인쇄(HTML)</button>
          </div>
          {!reportFinal && <p className="text-xs text-warn">서명 완료(최종/개정) 보고서만 배포 기록이 가능합니다.</p>}

          {/* 추가보고(addendum) 이력 — 기존엔 등록만 되고 내용이 화면에 안 보였다(보고서 HTML에만). */}
          {c.report?.addenda && c.report.addenda.length > 0 && (
            <div className="p-2 rounded-lg border border-indigo/20 bg-indigo/[0.03]">
              <h3 className="text-xs font-bold text-ink-2 mb-1">추가보고 이력 ({c.report.addenda.length})</h3>
              <ul className="space-y-1">
                {c.report.addenda.map((a) => (
                  <li key={a.seq} className="text-xs text-ink-2 border-t border-line first:border-0 pt-1 first:pt-0">
                    <span className="mono text-ink-3 mr-1">#{a.seq}</span>{a.content}
                    <span className="block text-[11px] text-ink-3">{a.addedBy ?? ''}{a.addedDt ? ` · ${a.addedDt.slice(0, 16).replace('T', ' ')}` : ''}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 추가보고(addendum) — 진단을 바꾸지 않고 나중에 나온 IHC·분자 결과를 덧붙인다.
              개정(amend)과 구분된다: 개정은 진단 자체가 바뀐 것이라 통보 의무가 다르다. */}
          <div className="p-2 rounded-lg border border-line bg-bg">
            <h3 className="text-xs font-bold text-ink-2 mb-1">추가보고(addendum)</h3>
            <p className="text-[11px] text-ink-3 mb-2">진단은 그대로 두고 뒤늦게 나온 IHC·분자 결과 등을 덧붙입니다. 진단이 바뀌었다면 추가보고가 아니라 <b>개정</b>입니다.</p>
            <div className="flex gap-2 items-end">
              <input aria-label="추가보고 내용" value={addendum} onChange={(e) => setAddendum(e.target.value)} placeholder="예: ER 90%, PR 60%, HER2 2+ (FISH 음성)" className={`${inputCls} flex-1`} />
              <button
                onClick={() => { if (!addendum.trim()) { toast('추가보고 내용을 입력하세요', 'error'); return; } post(`reports/${spNo}/addendum`, { content: addendum.trim() }, '추가보고 등록됨').then(() => setAddendum('')); }}
                disabled={!reportFinal}
                className="py-1.5 px-3 rounded-lg bg-indigo text-white font-semibold text-xs disabled:opacity-40"
              >추가보고</button>
            </div>
          </div>
          <div className="flex gap-2 items-end p-2 rounded-lg border border-line bg-bg">
            <Field label="채널"><select value={deliver.channel} onChange={(e) => setDeliver({ ...deliver, channel: e.target.value })} className={inputCls}>{DELIVER_CH.map((s) => <option key={s} value={s}>{s}</option>)}</select></Field>
            <Field label="수신처"><input aria-label="외래주치의/포털" value={deliver.recipient} onChange={(e) => setDeliver({ ...deliver, recipient: e.target.value })} placeholder="외래주치의/포털" className={inputCls} /></Field>
            <button onClick={doDeliver} disabled={!reportFinal} className="py-1.5 px-3 rounded-lg bg-teal text-white font-semibold text-xs disabled:opacity-40">배포 기록</button>
          </div>
          {deliveries.length > 0 && (
            <table className="w-full text-xs bg-bg rounded-lg overflow-hidden">
              <thead><tr className="text-ink-2"><th className="text-left py-1 px-2">채널</th><th className="text-left px-2">수신처</th><th className="text-left px-2">배포자</th><th className="text-left px-2">시각</th></tr></thead>
              <tbody>{deliveries.map((d) => (<tr key={d.deliveryId} className="border-t border-line"><td className="py-1 px-2 font-bold">{d.channel}</td><td className="px-2">{d.recipient ?? '-'}</td><td className="px-2">{d.deliveredBy ?? '-'}</td><td className="px-2 mono">{d.deliveredDt.slice(0, 16).replace('T', ' ')}</td></tr>))}</tbody>
            </table>
          )}
        </div>
      )}

      {/* PP8 물류·custody */}
      {tab === 'custody' && custody && (
        <div className="space-y-4">
          <div>
            <h3 className="text-xs font-bold text-ink-2 mb-2">블록</h3>
            {custody.blocks.length === 0 ? <p className="text-sm text-ink-3">블록 없음</p> : (
              <div className="space-y-1">{custody.blocks.map((b) => (
                <div key={b.blockId} className="flex items-center gap-2 text-xs border border-line rounded-lg p-2">
                  <span className="mono font-bold">{b.blockId}</span><span className="text-ink-2">{b.tissue ?? ''}</span>
                  <span className={`px-2 py-0.5 rounded ${blockBadge(b.status)}`}>{b.status}</span>
                  <span className="ml-auto flex gap-1">
                    <button onClick={() => scanBlock(b.blockId, 'EMBED')} className="py-0.5 px-2 rounded bg-teal/15 text-teal font-bold">포매(EMBED)</button>
                    <button onClick={() => scanBlock(b.blockId, 'CUT')} className="py-0.5 px-2 rounded bg-indigo/15 text-indigo font-bold">박절(CUT)</button>
                  </span>
                </div>
              ))}</div>
            )}
          </div>
          <div>
            <h3 className="text-xs font-bold text-ink-2 mb-2">슬라이드</h3>
            {custody.slides.length === 0 ? <p className="text-sm text-ink-3">슬라이드 없음</p> : (
              <div className="space-y-1">{custody.slides.map((s) => (
                <div key={s.slideId} className="flex items-center gap-2 text-xs border border-line rounded-lg p-2">
                  <span className="mono font-bold">{s.slideId}</span><span className="text-ink-2">{s.stain}{s.stainDetail ? `·${s.stainDetail}` : ''}</span>
                  <span className={`px-2 py-0.5 rounded ${scanBadge(s.scanStatus)}`}>{s.scanStatus}</span>
                  {s.wsiRef && <span className="mono text-ink-3">{s.wsiRef}</span>}
                  <span className="ml-auto flex gap-1">
                    <button onClick={() => scanSlide(s.slideId, 'SCAN')} className="py-0.5 px-2 rounded bg-good/15 text-good font-bold">스캔(WSI)</button>
                    <button onClick={() => scanSlide(s.slideId, 'SCAN_FAIL')} className="py-0.5 px-2 rounded bg-crit/15 text-crit font-bold">실패</button>
                  </span>
                </div>
              ))}</div>
            )}
          </div>
          <div>
            <h3 className="text-xs font-bold text-ink-2 mb-2">관리연속성(chain-of-custody) 로그</h3>
            {custody.events.length === 0 ? <p className="text-sm text-ink-3">이벤트 없음</p> : (
              <div className="space-y-0.5 max-h-48 overflow-y-auto">{custody.events.map((e) => (
                <div key={e.eventId} className="flex items-center gap-2 text-[11px] text-ink-2">
                  <span className="mono">{e.scannedDt.slice(0, 16).replace('T', ' ')}</span>
                  <span className="px-1.5 py-0.5 rounded bg-bg font-semibold">{e.event}</span>
                  <span className="text-ink-3">{e.targetType}</span><span className="mono">{e.targetId}</span>
                  {e.location && <span className="text-ink-3">@{e.location}</span>}
                  {e.scannedBy && <span className="ml-auto text-ink-3">{e.scannedBy}</span>}
                </div>
              ))}</div>
            )}
          </div>
        </div>
      )}

      {/* 판독관리(A~E) */}
      {tab === 'manage' && (
        <div className="space-y-5">
          {c.rejectStatus === 'REJECTED' && <div className="text-xs bg-crit/5 border border-crit/20 rounded-lg p-2 text-crit">반려된 케이스 — 사유: {c.rejectReason}</div>}

          {/* 동결절편 — 수술 중 신속진단. API는 있었는데 화면이 없어 기록할 방법이 없었다.
              영구절편과의 일치도(concordance)는 병리 QA 지표로 집계된다. */}
          <div>
            <h3 className="text-xs font-bold text-ink-2 mb-1">동결절편(수술 중) <span className="text-ink-3 font-normal">영구절편 일치도 포함</span></h3>
            {/* 기록된 동결진단 read-back — 특히 DISCORDANT(영구절편 불일치)는 QA 검토 대상이라 눈에 띄게. */}
            {c.report?.frozenDx && (
              <div className={`mb-2 rounded-lg border p-2 text-xs ${c.report.frozenConcordance === 'DISCORDANT' ? 'border-crit/40 bg-crit/[0.05]' : 'border-line bg-bg'}`}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-ink-2">기록된 동결진단</span>
                  {c.report.frozenConcordance === 'DISCORDANT' && <span className="px-1.5 py-0.5 rounded bg-crit/15 text-crit font-bold"><IconWarn className="mr-1" />영구절편 불일치(DISCORDANT) — QA 검토</span>}
                  {c.report.frozenConcordance === 'CONCORDANT' && <span className="px-1.5 py-0.5 rounded bg-good/15 text-good font-bold">일치</span>}
                  {!c.report.frozenConcordance && <span className="px-1.5 py-0.5 rounded bg-warn/15 text-warn font-bold">영구절편 대기</span>}
                </div>
                <p className="text-ink mt-1">{c.report.frozenDx}</p>
                <p className="text-[11px] text-ink-3 mt-0.5">{c.report.frozenBy ? `판독 ${c.report.frozenBy}` : ''}{c.report.frozenDt ? ` · ${c.report.frozenDt.slice(0, 16).replace('T', ' ')}` : ''}</p>
              </div>
            )}
            <div className="grid sm:grid-cols-4 gap-2 items-end p-2 rounded-lg border border-line bg-bg">
              <div className="sm:col-span-2">
                <Field label="동결절편 진단"><input aria-label="동결절편 진단" value={frozen.frozenDx} onChange={(e) => setFrozen({ ...frozen, frozenDx: e.target.value })} placeholder="예: 침윤성 암종, 절제연 음성" className={inputCls} /></Field>
              </div>
              <Field label="영구절편 일치도">
                <select value={frozen.concordance} onChange={(e) => setFrozen({ ...frozen, concordance: e.target.value })} className={inputCls}>
                  <option value="">판정 전(영구절편 대기)</option>
                  <option value="CONCORDANT">일치</option>
                  <option value="DISCORDANT">불일치</option>
                </select>
              </Field>
              <button
                onClick={() => { if (!frozen.frozenDx.trim()) { toast('동결절편 진단을 입력하세요', 'error'); return; } post(`cases/${spNo}/frozen`, { frozenDx: frozen.frozenDx.trim(), concordance: frozen.concordance || undefined }, '동결절편 기록됨').then(() => setFrozen({ frozenDx: '', concordance: '' })); }}
                className="py-1.5 px-3 rounded-lg bg-teal text-white font-semibold text-xs"
              >동결절편 기록</button>
            </div>
            <p className="text-[11px] text-ink-3 mt-1">일치도는 병리 QA 통계(동결절편 일치도)로 집계됩니다 — 불일치는 검토 대상입니다. 영구절편이 아직이면 비워 두세요.</p>
          </div>

          {/* CAP synoptic 필수요소 — 판독 시 빠뜨린 항목을 확인. 목록 API가 화면에 없었다. */}
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h3 className="text-xs font-bold text-ink-2">CAP synoptic 필수요소</h3>
              <button
                onClick={async () => { try { setSynoptic(await apiFetch<{ key: string; label: string; required: string[] }[]>('/api/v1/pathology/synoptic-protocols')); } catch { setSynoptic([]); } }}
                className="text-[11px] text-teal underline"
              >{synoptic ? '새로고침' : '프로토콜 보기'}</button>
            </div>
            {synoptic && (synoptic.length === 0 ? (
              <p className="text-[11px] text-ink-3">등록된 프로토콜이 없습니다(검사실 확정 대기).</p>
            ) : (
              <ul className="text-[11px] text-ink-2 flex flex-col gap-0.5">
                {synoptic.map((sp) => (
                  <li key={sp.key}><span className="mono font-semibold">{sp.label}</span><span className="text-ink-3"> — {sp.required.join(' · ')}</span></li>
                ))}
              </ul>
            ))}
          </div>

          {/* A 중요·긴급 진단 통보 */}
          <div>
            <h3 className="text-xs font-bold text-crit mb-1">A. 중요·긴급 진단 통보 <span className="text-ink-3 font-normal">의뢰의 read-back</span></h3>
            <div className="grid sm:grid-cols-4 gap-2 items-end p-2 rounded-lg border border-crit/20 bg-crit/[0.03]">
              <Field label="진단 유형"><select value={crit.diagnosisType} onChange={(e) => setCrit({ ...crit, diagnosisType: e.target.value })} className={inputCls}>{CRIT_TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
              <div className="sm:col-span-2"><Field label="요약"><input aria-label="예: 양성 예상 검체 침윤성 암종" value={crit.summary} onChange={(e) => setCrit({ ...crit, summary: e.target.value })} placeholder="예: 양성 예상 검체 침윤성 암종" className={inputCls} /></Field></div>
              <button onClick={() => { if (!crit.summary.trim()) { toast('요약을 입력하세요', 'info'); return; } post(`cases/${spNo}/critical`, crit, '중요진단 통보 등록(디스패치·복창 대기)').then(() => setCrit({ ...crit, summary: '' })); }} className="py-1.5 px-3 rounded-lg bg-crit text-white font-semibold text-xs">통보 발생</button>
            </div>
            <p className="text-[11px] text-ink-3 mt-1">알림 화면에서 실통보·복창(read-back)·에스컬레이션이 이어집니다.</p>
          </div>

          {/* C 판독의 배정 */}
          <div>
            <h3 className="text-xs font-bold text-ink-2 mb-1">C. 판독의 배정 {c.assignedTo && <span className="text-teal">현재: {c.assignedTo}</span>}</h3>
            <div className="flex gap-2 items-end">
              <Field label="판독의(ID)"><input aria-label="PRV1" value={assignTo} onChange={(e) => setAssignTo(e.target.value)} placeholder="PRV1" className={`${inputCls} mono w-40`} /></Field>
              <button onClick={() => post(`cases/${spNo}/assign`, { assignedTo: assignTo }, '배정됨')} className="py-1.5 px-3 rounded-lg bg-teal text-white font-semibold text-xs">배정</button>
            </div>
          </div>

          {/* B 추가 특수염색/재검 오더 */}
          <div>
            <h3 className="text-xs font-bold text-ink-2 mb-1">B. 추가 특수염색/IHC·재검 오더</h3>
            {c.stainOrders.length > 0 && (
              <table className="w-full text-xs bg-bg rounded-lg overflow-hidden mb-2">
                <thead><tr className="text-ink-2"><th className="text-left py-1 px-2">유형</th><th className="text-left px-2">상세</th><th className="text-left px-2">상태</th><th className="px-2"></th></tr></thead>
                <tbody>{c.stainOrders.map((o) => (
                  <tr key={o.orderId} className="border-t border-line">
                    <td className="py-1 px-2 font-bold">{o.orderType}</td><td className="px-2">{o.detail ?? '-'}</td>
                    <td className="px-2"><span className={`px-1.5 py-0.5 rounded ${o.status === 'COMPLETED' ? 'bg-good/15 text-good' : o.status === 'CANCELLED' ? 'bg-ink-3/15 text-ink-3' : 'bg-warn/15 text-warn'}`}>{o.status}</span></td>
                    <td className="px-2 text-right">{o.status !== 'COMPLETED' && o.status !== 'CANCELLED' && (
                      <span className="flex gap-1 justify-end">
                        {o.status === 'REQUESTED' && <button onClick={() => post(`stain-orders/${o.orderId}`, { status: 'IN_PROGRESS' }, '진행중', 'PATCH')} className="py-0.5 px-1.5 rounded bg-indigo/15 text-indigo">진행</button>}
                        <button onClick={() => post(`stain-orders/${o.orderId}`, { status: 'COMPLETED' }, '완료', 'PATCH')} className="py-0.5 px-1.5 rounded bg-good/15 text-good">완료</button>
                        <button onClick={() => post(`stain-orders/${o.orderId}`, { status: 'CANCELLED' }, '취소', 'PATCH')} className="py-0.5 px-1.5 rounded bg-crit/15 text-crit">취소</button>
                      </span>
                    )}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
            <div className="grid sm:grid-cols-4 gap-2 items-end p-2 rounded-lg border border-line bg-bg">
              <Field label="유형"><select value={stain.orderType} onChange={(e) => setStain({ ...stain, orderType: e.target.value })} className={inputCls}><option>IHC</option><option>SPECIAL</option><option>RECUT</option><option>DEEPER</option></select></Field>
              <div className="sm:col-span-2"><Field label="상세(marker/염색명)"><input aria-label="ER/PR/HER2, PAS 등" value={stain.detail} onChange={(e) => setStain({ ...stain, detail: e.target.value })} placeholder="ER/PR/HER2, PAS 등" className={inputCls} /></Field></div>
              <button onClick={() => post(`cases/${spNo}/stain-orders`, stain, '오더 요청됨').then(() => setStain({ ...stain, detail: '' }))} className="py-1.5 px-3 rounded-lg bg-teal text-white font-semibold text-xs">오더 요청</button>
            </div>
          </div>

          {/* D 컨설테이션 */}
          <div>
            <h3 className="text-xs font-bold text-ink-2 mb-1">D. 컨설테이션·2차 소견</h3>
            {c.consults.length > 0 && (
              <div className="space-y-1 mb-2">{c.consults.map((cs) => (
                <div key={cs.consultId} className="text-xs border border-line rounded-lg p-2">
                  <div className="flex items-center gap-2"><span className="font-bold">{cs.consultType}</span><span className="text-ink-2">{cs.consultant ?? ''}</span><span className={`ml-auto px-1.5 py-0.5 rounded ${cs.status === 'RESPONDED' ? 'bg-good/15 text-good' : 'bg-warn/15 text-warn'}`}>{cs.status}</span></div>
                  {cs.question && <p className="text-ink-2 mt-0.5">Q: {cs.question}</p>}
                  {cs.opinion ? <p className="text-ink mt-0.5">A: {cs.opinion}</p> : (
                    <div className="flex gap-1 mt-1">
                      <input id={`op-${cs.consultId}`} placeholder="회신 소견" className={`${inputCls} flex-1`} />
                      <button onClick={() => { const v = (document.getElementById(`op-${cs.consultId}`) as HTMLInputElement)?.value; if (v?.trim()) post(`consults/${cs.consultId}/respond`, { opinion: v.trim() }, '회신됨', 'PATCH'); }} className="py-1 px-2 rounded-lg bg-teal text-white text-xs">회신</button>
                    </div>
                  )}
                </div>
              ))}</div>
            )}
            <div className="grid sm:grid-cols-4 gap-2 items-end p-2 rounded-lg border border-line bg-bg">
              <Field label="유형"><select value={consult.consultType} onChange={(e) => setConsult({ ...consult, consultType: e.target.value })} className={inputCls}><option value="INTERNAL">내부</option><option value="EXTERNAL">외부</option></select></Field>
              <Field label="자문 대상"><input aria-label="혈액병리/타기관" value={consult.consultant} onChange={(e) => setConsult({ ...consult, consultant: e.target.value })} placeholder="혈액병리/타기관" className={inputCls} /></Field>
              <Field label="질의"><input value={consult.question} onChange={(e) => setConsult({ ...consult, question: e.target.value })} className={inputCls} /></Field>
              <button onClick={() => post(`cases/${spNo}/consults`, consult, '컨설트 요청됨').then(() => setConsult({ ...consult, question: '' }))} className="py-1.5 px-3 rounded-lg bg-teal text-white font-semibold text-xs">컨설트 요청</button>
            </div>
          </div>

          {/* E 접수 부적합·반려 */}
          {!c.report && c.rejectStatus !== 'REJECTED' && (
            <div>
              <h3 className="text-xs font-bold text-ink-2 mb-1">E. 접수 검체 부적합·반려 <span className="text-ink-3 font-normal">보고 전만</span></h3>
              <div className="flex gap-2 items-end">
                <Field label="반려 사유"><input aria-label="검체 건조·부족 등" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="검체 건조·부족 등" className={`${inputCls} w-64`} /></Field>
                <button onClick={() => { if (!rejectReason.trim()) { toast('사유를 입력하세요', 'info'); return; } post(`cases/${spNo}/reject`, { reason: rejectReason }, '반려됨'); }} className="py-1.5 px-3 rounded-lg border border-warn text-warn font-semibold text-xs transition-colors duration-150 hover:bg-warn/10">반려</button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
