'use client';

/**
 * 수혈 · 혈액제제 화면 (`/transfusion`).
 *
 * 사이드바 노출 역할: BB, ADM.
 * ⚠ 노출 역할과 화면이 호출하는 API 권한이 어긋나면 전부 403인 죽은 화면이 된다 —
 *   역할을 바꿀 때는 `Sidebar.tsx`(정본)와 API 권한 매트릭스를 함께 본다.
 * 데이터는 `lib/api.ts`의 `apiFetch`로만 가져온다(HTTP 호출 정본).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, getToken, getUserId } from '@/lib/api';
import { useConfirm } from '@/components/confirm';
import { useToast } from '@/components/toast';
import AttachmentPanel from '@/components/AttachmentPanel';
import { ErrorText } from '@/components/ui';
import { maskName } from '@/lib/privacy';
import {IconWarn, IconCheck } from '@/components/Icon';

interface BloodUnit {
  unitNo: string;
  donationId?: string | null;
  productType: string | null;
  bloodGroup: string | null;
  expiryDate: string | null;
  status: string;
  expiryStatus: string;
  irradiated?: boolean;
  cmvNeg?: boolean;
  leukoreduced?: boolean;
  washed?: boolean;
  antigenNeg?: string | null;
  recallStatus?: string | null;
  recallReason?: string | null;
  drawnDate?: string | null;
}
interface Typing { abo: string; rhD: string; antibodyScreen: string; antibodyId: string | null; testedDt: string; }
interface Xm { xmId: string; result: string | null; method: string | null; }
interface PanelCell { cell: number; antigens: Record<string, boolean>; }
interface PanelResult { ruledOut: string[]; candidates: string[]; identified: string[]; antibodies: string; recordedTypingId?: string | null; }
interface IssueCtx { patient: { patientId: string; name: string; birthDate: string | null; sex: string | null }; latestTyping: Typing | null; typingCount: number; typingDiscordant: boolean; requirements: string[]; }
interface CompatResult { patientId: string; antibodies: string | null; requiredAntigenNeg: string[]; units: BloodUnit[]; }

const expiryBadge: Record<string, string> = { OK: 'bg-good/15 text-good', EXPIRING: 'bg-warn/15 text-warn', EXPIRED: 'bg-warn/20 text-warn' };
// 특수요구 게이트: 환자가 요구하는 제제 특성 ↔ 제제 속성 대조(서버 checkIssueEligibility)
const SPECIAL: [string, string][] = [['IRRADIATED', '방사선조사'], ['CMV_NEG', 'CMV음성'], ['LEUKOREDUCED', '백혈구제거'], ['WASHED', '세척']];

// 제제 특수속성 배지(입고 시 지정 → 출고 게이트 근거)
function unitTags(u: BloodUnit): { label: string; cls: string }[] {
  const t: { label: string; cls: string }[] = [];
  if (u.irradiated) t.push({ label: '조사', cls: 'bg-indigo/10 text-indigo' });
  if (u.cmvNeg) t.push({ label: 'CMV−', cls: 'bg-teal/10 text-teal' });
  if (u.leukoreduced) t.push({ label: 'LR', cls: 'bg-ink-2/10 text-ink-2' });
  if (u.washed) t.push({ label: '세척', cls: 'bg-ink-2/10 text-ink-2' });
  if (u.antigenNeg) t.push({ label: `Ag−:${u.antigenNeg}`, cls: 'bg-warn/10 text-warn' });
  return t;
}

interface IssueEligibility {
  eligible: boolean;
  abo: { latest: string | null; typingCount: number; concordantCount: number; verifiedTwice: boolean; matchesHistory: boolean; independentResult: string | null };
  crossmatch: { result: string | null; testedDt: string; ageHours: number | null; expired: boolean } | null;
  special: { required: string[]; unitAttributes: string[]; missing: string[] };
  antigen: { identifiedAntibodies: string | null; compatible: boolean; missing: string[] };
  softReasons: string[]; hardReasons: string[]; blockerExplanations: string[];
  sources: string[]; promptContext: string; llmNote: string;
}
interface PatientTx { issueId: string; unitNo: string; donationId: string | null; productType: string | null; bloodGroup: string | null; status: string; emergency: boolean; recallStatus: string | null; retroCrossmatchStatus: string | null; issuedDt: string }

export default function TransfusionPage() {
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const [units, setUnits] = useState<BloodUnit[]>([]);
  const [nearExp, setNearExp] = useState<BloodUnit[]>([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [nu, setNu] = useState({ unitNo: '', productType: 'RBC', bloodGroup: 'A+', expiryDate: '', irradiated: false, cmvNeg: false, leukoreduced: false, washed: false, antigenNeg: '' });
  const [rx, setRx] = useState({ issueId: '', patientId: '', reactionType: 'FEBRILE', severity: 'MILD', symptoms: '' });
  const [guidance, setGuidance] = useState('');
  // 반응 조사 워크업(B 인증 항목) — 등록 API는 있었으나 화면이 없어 기록할 방법이 없었다
  const [inv, setInv] = useState({ clericalCheckOk: true, postDat: '', postAboRecheck: '', hemolysisVisual: '', labFindings: '', culpritUnitNo: '', finalClassification: '', conclusion: '' });
  const [invSaved, setInvSaved] = useState<string | null>(null);
  const [invState, setInvState] = useState<{ investigationStatus: string | null; investigatedBy: string | null; investigatedDt: string | null; attachmentCount: number } | null>(null);
  // 환자 수혈 이력 — 특수수혈 요구 판단·반응 조사에 필요
  const [ptxId, setPtxId] = useState('');
  const [ptx, setPtx] = useState<PatientTx[] | null>(null);
  const [reactionId, setReactionId] = useState('');
  const [iss, setIss] = useState<{ unitNo: string; patientId: string; issuer: string; receiver: string; confirm1: string; confirm2: string; aboVerifiedTwice: boolean; aboMatchesHistory: boolean; specialRequired: string[]; consentAttested: boolean } | null>(null);
  const [typing, setTyping] = useState<Typing | null>(null);
  const [xm, setXm] = useState<Xm | null>(null);
  const [xmResult, setXmResult] = useState('적합');
  const [newType, setNewType] = useState({ abo: 'A', rhD: 'POS', antibodyScreen: 'NEG', antibodyId: '' });
  const [ctx, setCtx] = useState<IssueCtx | null>(null);
  const [ctxErr, setCtxErr] = useState('');
  const [elig, setElig] = useState<IssueEligibility | null>(null);
  const [eligBusy, setEligBusy] = useState(false);
  async function checkEligibility() {
    if (!iss?.patientId.trim() || !iss.unitNo) { toast('환자ID를 입력하세요', 'info'); return; }
    setEligBusy(true); setElig(null);
    try { setElig(await apiFetch<IssueEligibility>(`/api/v1/transfusion/issue-eligibility/${encodeURIComponent(iss.patientId.trim())}/${encodeURIComponent(iss.unitNo)}`)); }
    catch (e) { setErr(e instanceof Error ? e.message : '적격성 점검 실패'); }
    finally { setEligBusy(false); }
  }
  const [adm, setAdm] = useState({ issueId: '', administeredBy: '', note: '' });
  // 동종면역 대응(적합혈액 조회 · 항체동정 패널)
  const [alloPid, setAlloPid] = useState('');
  const [compat, setCompat] = useState<CompatResult | null>(null);
  const [panelTpl, setPanelTpl] = useState<PanelCell[] | null>(null);
  const [panelAg, setPanelAg] = useState<string[]>([]);
  const [reactivity, setReactivity] = useState<boolean[]>([]);
  const [panelResult, setPanelResult] = useState<PanelResult | null>(null);
  const [recordAb, setRecordAb] = useState(false);
  const [abType, setAbType] = useState({ abo: 'A', rhD: 'POS' });
  // 특수수혈 요구(환자별 서버 강제)
  const [reqPid, setReqPid] = useState('');
  const [reqs, setReqs] = useState<{ reqId: string; requirement: string; reason: string | null; active: boolean; createdBy: string | null }[]>([]);
  const [newReq, setNewReq] = useState({ requirement: 'IRRADIATED', reason: '' });
  const me = getUserId() ?? undefined;

  // C3/C2: 출고 대상 환자의 혈액형·항체·교차시험 조회
  const loadCtx = useCallback(async (patientId: string, unitNo: string) => {
    setTyping(null); setXm(null); setCtx(null); setCtxErr('');
    if (!patientId.trim()) return;
    // ★환자 성명을 먼저 확보한다 — ID만 대조시키면 오타를 눈으로 잡을 수 없다(P1-17).
    //   조회 실패는 '환자 없음'이므로 조용히 넘기지 않고 화면에 세운다.
    try {
      setCtx(await apiFetch<IssueCtx>(`/api/v1/transfusion/patient/${encodeURIComponent(patientId)}`));
    } catch (e) {
      setCtxErr(e instanceof Error ? e.message : '환자 조회 실패 — 환자ID를 확인하세요');
    }
    try {
      const t = await apiFetch<Typing[]>(`/api/v1/transfusion/typing/${encodeURIComponent(patientId)}`);
      setTyping(t[0] ?? null);
      const x = await apiFetch<Xm | null>(`/api/v1/transfusion/crossmatch/${encodeURIComponent(patientId)}/${encodeURIComponent(unitNo)}`);
      setXm(x);
    } catch { /* noop */ }
  }, []);

  async function recordXm() {
    if (!iss?.patientId.trim()) { toast('환자ID를 입력하세요', 'info'); return; }
    try {
      await apiFetch('/api/v1/transfusion/crossmatch', { method: 'POST', body: JSON.stringify({ patientId: iss.patientId, unitNo: iss.unitNo, result: xmResult, tester: me }) });
      toast('교차시험 기록됨', 'success');
      await loadCtx(iss.patientId, iss.unitNo);
    } catch (e) { toast(e instanceof Error ? e.message : '기록 실패', 'error'); }
  }

  // 환자 혈액형·항체선별 등록(이력 없을 때) — 교차/출고 게이트의 선행 조건
  async function recordTyping() {
    if (!iss?.patientId.trim()) { toast('환자ID를 입력하세요', 'info'); return; }
    try {
      await apiFetch('/api/v1/transfusion/typing', {
        method: 'POST',
        body: JSON.stringify({ patientId: iss.patientId, abo: newType.abo, rhD: newType.rhD, antibodyScreen: newType.antibodyScreen, antibodyId: newType.antibodyId || undefined, tester: me }),
      });
      toast(`혈액형 등록됨 · ${newType.abo}${newType.rhD === 'POS' ? '+' : '-'}`, 'success');
      await loadCtx(iss.patientId, iss.unitNo);
    } catch (e) { toast(e instanceof Error ? e.message : '혈액형 등록 실패', 'error'); }
  }

  // 교차시험 자동판정 — 환자 혈액형·항체선별 + 제제 혈액형으로 ABO/RhD 적합성 자동 판정·기록
  async function performXm() {
    if (!iss?.patientId.trim()) { toast('환자ID를 입력하세요', 'info'); return; }
    try {
      const r = await apiFetch<{ determination: { result: string; method: string; requiresAhg: boolean; reasons: string[] } }>(
        '/api/v1/transfusion/crossmatch/perform',
        { method: 'POST', body: JSON.stringify({ patientId: iss.patientId, unitNo: iss.unitNo, tester: me }) },
      );
      const d = r.determination;
      const tone = d.result === '적합' ? 'success' : d.result === '부적합' ? 'error' : 'info';
      toast(`자동판정: ${d.result} (${d.method})${d.reasons.length ? ' — ' + d.reasons.join('; ') : ''}`, tone);
      await loadCtx(iss.patientId, iss.unitNo);
    } catch (e) { toast(e instanceof Error ? e.message : '판정 실패(혈액형 미등록 등)', 'error'); }
  }

  const load = useCallback(async () => {
    try {
      const [inv, ne] = await Promise.all([
        apiFetch<BloodUnit[]>('/api/v1/transfusion/inventory'),
        apiFetch<BloodUnit[]>('/api/v1/transfusion/near-expiry').catch(() => [] as BloodUnit[]),
      ]);
      setUnits(inv);
      setNearExp(ne);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '조회 실패');
    }
  }, []);

  useEffect(() => {
    if (!getToken()) {
      router.push('/');
      return;
    }
    void load();
  }, [load, router]);

  function startIssue(unitNo: string) {
    setErr(''); setMsg(''); setTyping(null); setXm(null);
    setElig(null);
    setIss({ unitNo, patientId: '', issuer: '', receiver: '', confirm1: '', confirm2: '', aboVerifiedTwice: false, aboMatchesHistory: false, specialRequired: [], consentAttested: false });
  }

  function toggleSpecial(code: string) {
    if (!iss) return;
    const has = iss.specialRequired.includes(code);
    setIss({ ...iss, specialRequired: has ? iss.specialRequired.filter((c) => c !== code) : [...iss.specialRequired, code] });
  }

  async function submitIssue() {
    if (!iss) return;
    setErr(''); setMsg('');
    if (!iss.patientId || !iss.confirm1 || !iss.confirm2) { setErr('환자ID·확인자1·확인자2는 필수입니다.'); return; }
    // 환자를 특정하지 못한 상태로는 출고 확인 모달을 띄우지 않는다 — 대조할 이름이 없으면 확인이 아니다.
    if (!ctx) { setErr('환자를 확인하지 못했습니다 — 환자ID를 다시 확인하세요(오타 시 타 환자 오출고 위험).'); return; }
    if (iss.confirm1 === iss.confirm2) { setErr('2인 확인은 서로 다른 확인자여야 합니다.'); return; }
    const u = units.find((x) => x.unitNo === iss.unitNo);
    const ok = await confirm({
      title: '혈액제제 출고 확인',
      message: '출고 후 되돌릴 수 없습니다. 환자·제제·혈액형·2인 확인을 대조하세요.',
      detail: [
        { label: '제제번호', value: iss.unitNo },
        { label: '제제 혈액형', value: u?.bloodGroup ?? '-' },
        { label: '환자', value: ctx ? `${ctx.patient.name} (${iss.patientId})` : iss.patientId },
        { label: '환자 혈액형', value: typing ? `${typing.abo}${typing.rhD === 'POS' ? '+' : typing.rhD === 'NEG' ? '-' : ''}` : '이력없음' },
        { label: '교차시험', value: xm?.result ?? '미기록' },
        { label: '특수요구', value: iss.specialRequired.length ? iss.specialRequired.map((c) => SPECIAL.find((s) => s[0] === c)?.[1] ?? c).join(', ') : '없음' },
        { label: '확인자', value: `${iss.confirm1} / ${iss.confirm2}` },
      ],
      danger: true, confirmLabel: '출고',
      doubleConfirm: ctx ? `환자 「${ctx.patient.name}」 본인 확인 · 혈액형·교차적합·2인 확인을 대조했습니다.` : '환자 ID·혈액형·교차적합·2인 확인을 대조했습니다.',
    });
    if (!ok) return;
    try {
      const body = { ...iss, consentAttestedBy: iss.consentAttested ? (me || iss.issuer || undefined) : undefined };
      const r = await apiFetch<{ issue: { issueId: string }; consentWarning: string | null }>('/api/v1/transfusion/issue', { method: 'POST', body: JSON.stringify(body) });
      toast(`출고 완료 · ${iss.unitNo} (안전 게이트 통과) · 출고ID ${r.issue.issueId}`);
      if (r.consentWarning) toast(`${r.consentWarning}`, 'info');
      setAdm({ issueId: r.issue.issueId, administeredBy: me ?? '', note: '' }); // 시행·반납 기록 준비
      setIss(null); await load();
    } catch (e) { toast(e instanceof Error ? e.message : '출고 차단', 'error'); }
  }

  // 수혈 시행 기록 — 출고→시행→부작용 안전루프의 중간 단계
  async function administer() {
    if (!adm.issueId.trim()) { toast('출고ID를 입력하세요(출고 시 자동 채움)', 'info'); return; }
    try {
      await apiFetch('/api/v1/transfusion/administer', { method: 'POST', body: JSON.stringify({ issueId: adm.issueId.trim(), administeredBy: adm.administeredBy || undefined, note: adm.note || undefined }) });
      toast('수혈 시행 기록됨', 'success'); setAdm({ issueId: '', administeredBy: '', note: '' });
    } catch (e) { toast(e instanceof Error ? e.message : '시행 기록 실패', 'error'); }
  }

  // 출고 반납 — 시행 전 제제를 재고로 복원(오출고·미사용 회수)
  async function returnIssue() {
    const id = adm.issueId.trim();
    if (!id) { toast('반납할 출고ID가 필요합니다(출고 시 자동 채움)', 'info'); return; }
    const ok = await confirm({ title: '출고 반납', message: '시행 전 제제를 재고(IN_STOCK)로 복원합니다. 이미 시행(수혈)된 제제는 반납할 수 없습니다.', detail: [{ label: '출고ID', value: id }, { label: '사유', value: adm.note || '(미기재)' }], confirmLabel: '반납' });
    if (!ok) return;
    try {
      const r = await apiFetch<{ unitNo: string }>(`/api/v1/transfusion/issue/${encodeURIComponent(id)}/return`, { method: 'POST', body: JSON.stringify({ reason: adm.note || undefined }) });
      toast(`반납 완료 · ${r.unitNo} 재고 복원`, 'success');
      setAdm({ issueId: '', administeredBy: '', note: '' }); await load();
    } catch (e) { toast(e instanceof Error ? e.message : '반납 실패', 'error'); }
  }

  // T1 HIS 수혈 동의 조회 — active면 attestation 자동 체크
  async function checkHisConsent() {
    if (!iss?.patientId.trim()) { toast('환자ID를 입력하세요', 'info'); return; }
    try {
      const r = await apiFetch<{ available: boolean; active: boolean; state?: string; reason?: string }>(`/api/v1/transfusion/consent-status/${encodeURIComponent(iss.patientId)}`);
      if (!r.available) { toast(`HIS 동의 참조 불가: ${r.reason ?? ''} — 수기 확인`, 'info'); return; }
      if (r.active) { setIss({ ...iss, consentAttested: true }); toast('HIS 수혈 동의 유효(active) — 확인 처리', 'success'); }
      else { toast(`HIS 수혈 동의 ${r.state ?? '미승인'} — 출고 전 확인 필요`, 'error'); }
    } catch (e) { toast(e instanceof Error ? e.message : 'HIS 동의 조회 실패', 'error'); }
  }

  // T2 명시적 폐기(만료·손상·오염) — 사유 기록
  async function discardUnit(unitNo: string) {
    const reason = window.prompt(`혈액 폐기 사유 — ${unitNo}`, '');
    if (!reason?.trim()) return;
    const ok = await confirm({ title: '혈액 폐기', message: '이 제제를 폐기(DISCARDED)합니다. 되돌릴 수 없습니다.', detail: [{ label: '제제', value: unitNo }, { label: '사유', value: reason.trim() }], danger: true, confirmLabel: '폐기' });
    if (!ok) return;
    try {
      await apiFetch(`/api/v1/transfusion/units/${encodeURIComponent(unitNo)}/discard`, { method: 'POST', body: JSON.stringify({ reason: reason.trim(), discardedBy: me || undefined }) });
      toast(`폐기됨 · ${unitNo}`, 'success'); await load();
    } catch (e) { toast(e instanceof Error ? e.message : '폐기 실패', 'error'); }
  }

  async function register(e: React.FormEvent) {
    e.preventDefault(); setErr(''); setMsg('');
    try {
      await apiFetch('/api/v1/transfusion/units', { method: 'POST', body: JSON.stringify({ ...nu, antigenNeg: nu.antigenNeg.trim() || undefined }) });
      toast(`입고 완료 · ${nu.unitNo}`); setNu({ unitNo: '', productType: 'RBC', bloodGroup: 'A+', expiryDate: '', irradiated: false, cmvNeg: false, leukoreduced: false, washed: false, antigenNeg: '' }); await load();
    } catch (e) { toast(e instanceof Error ? e.message : '입고 실패', 'error'); }
  }

  async function reportReaction(e: React.FormEvent) {
    e.preventDefault(); setErr(''); setGuidance('');
    try {
      const r = await apiFetch<{ guidance: string; reaction: { reactionId: string } }>('/api/v1/transfusion/reactions', { method: 'POST', body: JSON.stringify({ ...rx, issueId: rx.issueId.trim() || undefined }) });
      setGuidance(r.guidance);
      setReactionId(r.reaction?.reactionId ?? '');
    } catch (e) { setErr(e instanceof Error ? e.message : '보고 실패'); }
  }

  // 동종면역 대응 — 적합(항원음성) 혈액 조회
  async function findCompatible() {
    if (!alloPid.trim()) { toast('환자ID를 입력하세요', 'info'); return; }
    try {
      const r = await apiFetch<CompatResult>(`/api/v1/transfusion/compatible-units/${encodeURIComponent(alloPid)}`);
      setCompat(r);
      if (r.units.length === 0) toast(r.antibodies ? `항체(${r.antibodies}) 대응 항원음성 재고 없음` : '재고 없음', 'info');
      else toast(`적합 ${r.units.length}건`, 'success');
    } catch (e) { toast(e instanceof Error ? e.message : '조회 실패', 'error'); }
  }

  // 특수수혈 요구 — 조회·등록·해제
  async function loadReqs(pid: string) {
    if (!pid.trim()) { setReqs([]); return; }
    try { setReqs(await apiFetch(`/api/v1/transfusion/requirements/${encodeURIComponent(pid)}`)); }
    catch (e) { toast(e instanceof Error ? e.message : '요구 조회 실패', 'error'); }
  }
  async function addReq() {
    if (!reqPid.trim()) { toast('환자ID를 입력하세요', 'info'); return; }
    try {
      await apiFetch('/api/v1/transfusion/requirements', { method: 'POST', body: JSON.stringify({ patientId: reqPid.trim(), requirement: newReq.requirement, reason: newReq.reason || undefined }) });
      toast('특수수혈 요구 등록 — 이후 출고 서버 강제', 'success'); setNewReq({ requirement: 'IRRADIATED', reason: '' }); await loadReqs(reqPid);
    } catch (e) { toast(e instanceof Error ? e.message : '등록 실패', 'error'); }
  }
  async function deactivateReq(reqId: string) {
    try { await apiFetch(`/api/v1/transfusion/requirements/${reqId}/deactivate`, { method: 'POST', body: '{}' }); toast('요구 해제됨'); await loadReqs(reqPid); }
    catch (e) { toast(e instanceof Error ? e.message : '해제 실패', 'error'); }
  }

  // 항체동정 패널 로드(11-cell 항원 프로파일)
  async function loadPanel() {
    try {
      const r = await apiFetch<{ cells: PanelCell[]; antigens: string[] }>('/api/v1/transfusion/antibody-panel/template');
      setPanelTpl(r.cells); setPanelAg(r.antigens);
      setReactivity(new Array(r.cells.length).fill(false)); setPanelResult(null);
    } catch (e) { toast(e instanceof Error ? e.message : '패널 로드 실패', 'error'); }
  }

  // 항체동정 판정(룰아웃·후보·동정)
  async function interpret() {
    if (!alloPid.trim()) { toast('환자ID를 입력하세요', 'info'); return; }
    try {
      const r = await apiFetch<PanelResult>('/api/v1/transfusion/antibody-panel', {
        method: 'POST',
        body: JSON.stringify({ patientId: alloPid, reactivity, recordTyping: recordAb ? { abo: abType.abo, rhD: abType.rhD } : undefined }),
      });
      setPanelResult(r);
      toast(r.identified.length ? `동정: ${r.antibodies}${r.recordedTypingId ? ' · 이력 기록됨' : ''}` : '동정 미확정 — 후보 검토 필요', r.identified.length ? 'success' : 'info');
      if (r.recordedTypingId) await load();
    } catch (e) { toast(e instanceof Error ? e.message : '판정 실패', 'error'); }
  }

  // ── 추적성 · 회수/격리 · Look-back (API만 있고 화면이 없던 기능 — P2) ──
  interface TraceRecipient { issueId: string; patientId: string; name: string; status: string; issuedDt?: string | null; emergency?: boolean }
  interface TraceInfo { unitNo: string; donationId: string | null; productType: string | null; bloodGroup: string | null; status: string; recallStatus: string | null; recipients: TraceRecipient[] }
  interface RecallInfo { unitNo: string; recallStatus: string; affectedRecipients: { issueId: string; patientId: string; name: string; transfused: boolean }[]; lookbackRequired: boolean }
  interface LookbackInfo { donationId: string; units: string[]; recipients: { unitNo: string; issueId: string; patientId: string; name: string; transfused: boolean }[]; recipientCount: number }
  const [traceNo, setTraceNo] = useState('');
  const [trace, setTrace] = useState<TraceInfo | null>(null);
  const [recallReason, setRecallReason] = useState('');
  const [recallRes, setRecallRes] = useState<RecallInfo | null>(null);
  const [lbDonation, setLbDonation] = useState('');
  const [lb, setLb] = useState<LookbackInfo | null>(null);

  async function doTrace() {
    if (!traceNo.trim()) return;
    try { setRecallRes(null); setTrace(await apiFetch<TraceInfo>(`/api/v1/transfusion/traceability/${encodeURIComponent(traceNo.trim())}`)); }
    catch (e) { setTrace(null); toast(e instanceof Error ? e.message : '추적 조회 실패', 'error'); }
  }
  async function doRecall(status: 'RECALLED' | 'QUARANTINED') {
    if (!trace) return;
    const ok = await confirm({
      title: status === 'RECALLED' ? '제제 회수' : '제제 격리',
      message: `${trace.unitNo}을(를) ${status === 'RECALLED' ? '회수' : '격리'} 처리합니다. 출고된 수혈자는 look-back 대상이 됩니다.`,
      danger: true, confirmLabel: status === 'RECALLED' ? '회수' : '격리',
    });
    if (!ok) return;
    try {
      const r = await apiFetch<RecallInfo>(`/api/v1/transfusion/units/${encodeURIComponent(trace.unitNo)}/recall`, { method: 'POST', body: JSON.stringify({ status, reason: recallReason.trim() || undefined }) });
      setRecallRes(r);
      toast(r.lookbackRequired ? `처리됨 — 수혈자 ${r.affectedRecipients.length}명 look-back 필요` : '처리됨(수혈자 없음)', r.lookbackRequired ? 'info' : 'success');
      await doTrace(); // 회수상태 갱신 반영
    } catch (e) { toast(e instanceof Error ? e.message : '회수 실패', 'error'); }
  }
  async function doLookback() {
    if (!lbDonation.trim()) return;
    try { setLb(await apiFetch<LookbackInfo>(`/api/v1/transfusion/lookback/${encodeURIComponent(lbDonation.trim())}`, { method: 'POST' })); }
    catch (e) { setLb(null); toast(e instanceof Error ? e.message : 'look-back 실패', 'error'); }
  }

  /** 반응 조사 워크업 저장 — 사무착오·DAT·용혈지표·최종분류. 인증 요구 기록이다. */
  async function saveInvestigation() {
    if (!reactionId.trim()) { toast('이상반응 ID를 입력하세요(보고 시 자동 채워집니다)', 'error'); return; }
    const body: Record<string, unknown> = { clericalCheckOk: inv.clericalCheckOk };
    for (const k of ['postDat', 'postAboRecheck', 'hemolysisVisual', 'labFindings', 'culpritUnitNo', 'finalClassification', 'conclusion'] as const) {
      if (inv[k]?.trim()) body[k] = inv[k].trim();
    }
    try {
      await apiFetch(`/api/v1/transfusion/reactions/${encodeURIComponent(reactionId.trim())}/investigate`, { method: 'POST', body: JSON.stringify(body) });
      setInvSaved(new Date().toLocaleString('ko-KR')); toast('조사 기록 저장됨', 'success');
      await loadReaction(reactionId.trim());
    } catch (e) { toast(e instanceof Error ? e.message : '저장 실패', 'error'); }
  }

  /** 반응 조사 상태 조회 → 워크업 폼 prefill(재방문 시 이전 조사 이어쓰기). */
  async function loadReaction(id: string) {
    if (!id.trim()) { toast('이상반응 ID를 입력하세요', 'info'); return; }
    try {
      const r = await apiFetch<{ clericalCheckOk: boolean | null; postDat: string | null; postAboRecheck: string | null; hemolysisVisual: string | null; labFindings: string | null; culpritUnitNo: string | null; finalClassification: string | null; conclusion: string | null; investigationStatus: string | null; investigatedBy: string | null; investigatedDt: string | null; attachmentCount: number }>(`/api/v1/transfusion/reactions/${encodeURIComponent(id.trim())}`);
      setInv({
        clericalCheckOk: r.clericalCheckOk ?? true,
        postDat: r.postDat ?? '', postAboRecheck: r.postAboRecheck ?? '', hemolysisVisual: r.hemolysisVisual ?? '',
        labFindings: r.labFindings ?? '', culpritUnitNo: r.culpritUnitNo ?? '', finalClassification: r.finalClassification ?? '', conclusion: r.conclusion ?? '',
      });
      setInvState({ investigationStatus: r.investigationStatus, investigatedBy: r.investigatedBy, investigatedDt: r.investigatedDt, attachmentCount: r.attachmentCount });
    } catch (e) { toast(e instanceof Error ? e.message : '조회 실패', 'error'); }
  }

  /** 환자 수혈 이력 — 반응 조사·특수수혈 요구 판단에 필요한데 조회 화면이 없었다. */
  async function loadPatientTx() {
    if (!ptxId.trim()) return;
    try { setPtx(await apiFetch<PatientTx[]>(`/api/v1/transfusion/patient-transfusions/${encodeURIComponent(ptxId.trim())}`)); }
    catch (e) { toast(e instanceof Error ? e.message : '조회 실패', 'error'); setPtx([]); }
  }

  const inp = 'px-2 py-1.5 rounded-lg border border-line bg-bg text-sm';

  return (
    <main className="page">
      <h1 className="t-page mb-4">수혈 · 혈액제제</h1>
      {err && <ErrorText message={err} />}
      {msg && <p className="text-sm text-good mb-3">{msg}</p>}

      {/* 근접만료 워크리스트 — 폐기 예방 */}
      {nearExp.length > 0 && (
        <div className="mb-4 rounded-xl border border-warn/40 bg-warn/5 p-3">
          <div className="flex items-center gap-2 mb-2">
            <span className="font-bold text-sm text-warn">⏰ 근접만료 {nearExp.length}건 (7일 내)</span>
            <span className="text-xs text-ink-2">폐기 예방 — 유효기간 순 우선 사용</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {nearExp.map((u) => (
              <button key={u.unitNo} onClick={() => u.status === 'IN_STOCK' && startIssue(u.unitNo)} className="mono text-xs px-2 py-1 rounded bg-bg border border-line hover:border-warn text-left">
                {u.unitNo} · {u.bloodGroup} · <span className="text-crit font-semibold">{u.expiryDate}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <section className="card">
        <h2 className="t-section mb-3">재고 · 출고(안전 게이트)</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-2 border-b border-line">
                <th className="py-2">제제번호(ISBT)</th>
                <th>종류</th>
                <th>혈액형</th>
                <th>특수속성</th>
                <th>유효기간</th>
                <th>상태</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {units.map((u) => (
                <tr key={u.unitNo} className="border-b border-line last:border-0">
                  <td className="py-2 mono text-xs">{u.unitNo}{u.donationId && <span className="block text-[11px] text-ink-3">헌혈 {u.donationId}</span>}</td>
                  <td>{u.productType}</td>
                  <td className="font-bold">{u.bloodGroup}</td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {unitTags(u).map((t) => <span key={t.label} className={`px-1.5 py-0.5 rounded text-[11px] font-bold ${t.cls}`}>{t.label}</span>)}
                    </div>
                  </td>
                  <td className="mono text-xs">
                    {u.expiryDate} <span className={`ml-1 px-1.5 py-0.5 rounded text-xs font-bold ${expiryBadge[u.expiryStatus] ?? ''}`}>{u.expiryStatus}</span>
                    {u.drawnDate && <span className="block text-[11px] text-ink-3">채혈 {u.drawnDate}</span>}
                  </td>
                  <td className="mono text-xs">
                    {u.status}
                    {u.recallStatus && <span className="block text-[11px] px-1.5 py-0.5 rounded bg-crit/15 text-crit font-bold not-mono" title={u.recallReason ?? undefined}><IconWarn className="mr-1" />회수 {u.recallStatus}</span>}
                  </td>
                  <td>
                    {u.status === 'IN_STOCK' && (
                      u.recallStatus ? (
                        <span className="text-[11px] text-crit font-semibold" title={u.recallReason ?? '회수·격리 대상'}>회수 대상 — 출고 불가</span>
                      ) : (
                        <span className="flex gap-1">
                          <button onClick={() => startIssue(u.unitNo)} className="py-1 px-3 rounded-lg bg-crit text-white text-xs font-semibold">출고</button>
                          <button onClick={() => discardUnit(u.unitNo)} title="만료·손상·오염 폐기" className="py-1 px-2 rounded-lg border border-line text-ink-2 text-xs">폐기</button>
                        </span>
                      )
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 출고 실입력 폼 */}
        {iss && (
          <div className="mt-4 border border-crit/30 rounded-xl p-4 bg-crit/5">
            <h3 className="font-bold text-sm mb-2">출고 정보 입력 · 제제 <span className="mono">{iss.unitNo}</span></h3>
            <div className="flex flex-wrap gap-2 items-center mb-2">
              <input aria-label="환자 ID" placeholder="환자ID*" value={iss.patientId}
                onChange={(e) => setIss({ ...iss, patientId: e.target.value })}
                onBlur={() => loadCtx(iss.patientId, iss.unitNo)}
                className={`${inp} mono w-28`} />
              <button type="button" onClick={() => { if (!iss.patientId.trim()) { toast('환자ID를 입력하세요', 'info'); return; } loadCtx(iss.patientId, iss.unitNo); }} className="py-1.5 px-2 rounded-lg border border-line text-xs">혈액형 조회</button>
              <input aria-label="인수자" placeholder="인수자" value={iss.receiver} onChange={(e) => setIss({ ...iss, receiver: e.target.value })} className={`${inp} w-28`} />
              <input aria-label="확인자1 계정ID" placeholder="확인자1 계정*" value={iss.confirm1} onChange={(e) => setIss({ ...iss, confirm1: e.target.value })} className={`${inp} w-28`} />
              <input aria-label="확인자2 계정ID" placeholder="확인자2 계정*" value={iss.confirm2} onChange={(e) => setIss({ ...iss, confirm2: e.target.value })} className={`${inp} w-28`} />
            </div>
            {/* ★환자확인 스트립(P1-17) — 접수 화면엔 있고 정작 출고엔 없던 것. 이름 없이 ID만
                 대조하면 오타를 눈으로 잡을 수 없고, 그 오타가 실재하는 타 환자면 ABO 방벽이
                 엉뚱한 환자의 혈액형으로 검증한다. */}
            {ctx ? (
              <div className="mb-3 flex items-center gap-2 flex-wrap text-sm bg-teal/10 border border-teal/30 rounded-lg px-3 py-2">
                <span className="text-teal font-bold">환자확인</span>
                <span className="font-bold text-base">{ctx.patient.name}</span>
                <span className="mono text-xs text-ink-2">{ctx.patient.patientId}</span>
                {ctx.patient.birthDate && <span className="text-xs text-ink-2">{ctx.patient.birthDate}</span>}
                {ctx.patient.sex && <span className="text-xs text-ink-2">{ctx.patient.sex}</span>}
                {ctx.typingCount === 0 && <span className="text-xs px-1.5 py-0.5 rounded bg-warn/15 text-warn font-bold">혈액형 이력 없음</span>}
                {ctx.typingDiscordant && <span className="text-xs px-1.5 py-0.5 rounded bg-crit/15 text-crit font-bold"><IconWarn className="mr-1" />혈액형 이력 불일치</span>}
                {ctx.requirements.length > 0 && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-indigo/15 text-indigo font-bold">특수요구: {ctx.requirements.join(', ')}</span>
                )}
              </div>
            ) : iss.patientId.trim() ? (
              <div className="mb-3 text-sm bg-crit/10 border border-crit/40 rounded-lg px-3 py-2 text-crit font-semibold">
                {ctxErr || '환자를 확인하지 못했습니다 — 환자ID를 확인하세요. 확인 전에는 출고할 수 없습니다.'}
              </div>
            ) : (
              <p className="mb-3 text-xs text-ink-3">환자ID를 입력하면 성명·혈액형을 조회합니다. <b>성명 확인 없이는 출고할 수 없습니다.</b></p>
            )}

            {/* C3: 환자 혈액형 vs 제제 혈액형 대조 */}
            {(() => {
              const unitBG = units.find((x) => x.unitNo === iss.unitNo)?.bloodGroup ?? '';
              const unitAbo = unitBG.replace(/[+-]/g, '');
              const unitRh = unitBG.includes('-') ? 'NEG' : unitBG.includes('+') ? 'POS' : '';
              const patientBG = typing ? `${typing.abo}${typing.rhD === 'POS' ? '+' : typing.rhD === 'NEG' ? '-' : ''}` : null;
              const identical = typing && unitAbo && typing.abo === unitAbo && (!unitRh || typing.rhD === unitRh);
              const antibodyAlert = typing && (typing.antibodyScreen === 'POS' || typing.antibodyId);
              return (
                <div className="mb-3 rounded-lg border border-line bg-bg p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-4">
                    <span>제제 <b className="font-bold">{unitBG || '—'}</b></span>
                    <span>환자 <b className="font-bold">{patientBG ?? '조회 필요'}</b></span>
                    {typing && (identical
                      ? <span className="px-2 py-0.5 rounded bg-good/15 text-good text-xs font-bold">ABO/Rh 동일</span>
                      : <span className="px-2 py-0.5 rounded bg-crit/15 text-crit text-xs font-bold"><IconWarn className="mr-1" />불일치 — 적합성 대조 필수</span>)}
                    {!typing && <span className="text-xs text-warn">환자 혈액형 이력 없음 — 등록 필요</span>}
                    {antibodyAlert && <span className="px-2 py-0.5 rounded bg-warn/15 text-warn text-xs font-bold">항체양성 {typing?.antibodyId ?? ''} → 항원음성 매칭 필요</span>}
                  </div>
                  {/* 혈액형·항체선별 등록(이력 없을 때) */}
                  {!typing && (
                    <div className="mt-2 pt-2 border-t border-line flex flex-wrap items-end gap-2">
                      <span className="text-xs text-ink-2 self-center">혈액형 등록</span>
                      <select aria-label="ABO" value={newType.abo} onChange={(e) => setNewType({ ...newType, abo: e.target.value })} className={`${inp} text-xs py-1`}><option>A</option><option>B</option><option>O</option><option>AB</option></select>
                      <select aria-label="RhD" value={newType.rhD} onChange={(e) => setNewType({ ...newType, rhD: e.target.value })} className={`${inp} text-xs py-1`}><option value="POS">Rh+</option><option value="NEG">Rh−</option></select>
                      <select aria-label="항체선별" value={newType.antibodyScreen} onChange={(e) => setNewType({ ...newType, antibodyScreen: e.target.value })} className={`${inp} text-xs py-1`}><option value="NEG">항체 음성</option><option value="POS">항체 양성</option></select>
                      {newType.antibodyScreen === 'POS' && <input aria-label="동정 항체" value={newType.antibodyId} onChange={(e) => setNewType({ ...newType, antibodyId: e.target.value })} placeholder="동정 항체(예: anti-E)" className={`${inp} text-xs py-1 w-32`} />}
                      <button type="button" onClick={recordTyping} className="py-1 px-2 rounded-lg bg-teal text-white text-xs font-semibold">등록</button>
                    </div>
                  )}
                  {/* C2: 교차시험 결과·기록 */}
                  <div className="flex items-center gap-2 mt-2 pt-2 border-t border-line">
                    <span className="text-xs text-ink-2">교차시험</span>
                    {xm?.result
                      ? <span className={`px-2 py-0.5 rounded text-xs font-bold ${xm.result === '적합' ? 'bg-good/15 text-good' : 'bg-crit/15 text-crit'}`}>{xm.result}{xm.method && <span className="font-normal ml-1" title="교차시험법 — 항체양성(동종면역) 환자는 AHG 필요, 전자교차 부적절">· {xm.method}</span>}</span>
                      : <span className="text-xs text-warn">미기록</span>}
                    <button type="button" onClick={performXm} className="py-1 px-2 rounded-lg bg-teal/10 text-teal border border-teal/30 text-xs font-medium">자동판정</button>
                    <span className="text-line">|</span>
                    <select aria-label="교차시험 결과" value={xmResult} onChange={(e) => setXmResult(e.target.value)} className={`${inp} text-xs py-1`}><option>적합</option><option>부적합</option></select>
                    <button type="button" onClick={recordXm} className="py-1 px-2 rounded-lg border border-line text-xs">수기기록</button>
                  </div>
                </div>
              );
            })()}
            {/* C5: 특수요구(환자 요구 제제 특성) — 서버가 제제 속성과 대조 */}
            <div className="mb-3 rounded-lg border border-line bg-bg p-3">
              <span className="text-xs text-ink-2 mr-2">특수요구(환자):</span>
              <div className="inline-flex flex-wrap gap-3 items-center">
                {SPECIAL.map(([code, label]) => (
                  <label key={code} className="flex items-center gap-1 cursor-pointer text-xs">
                    <input type="checkbox" checked={iss.specialRequired.includes(code)} onChange={() => toggleSpecial(code)} />{label}
                  </label>
                ))}
                <span className="text-[11px] text-ink-3">체크 시 제제가 해당 속성을 갖지 않으면 출고 차단</span>
              </div>
            </div>
            <div className="flex flex-wrap gap-4 items-center text-sm mb-3">
              <label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={iss.aboVerifiedTwice} onChange={(e) => setIss({ ...iss, aboVerifiedTwice: e.target.checked })} />ABO 2회 확인</label>
              <label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={iss.aboMatchesHistory} onChange={(e) => setIss({ ...iss, aboMatchesHistory: e.target.checked })} />과거 혈액형 일치</label>
              <label className="flex items-center gap-1.5 cursor-pointer" title="동의서 정본은 HIS/EMR — 출고 전 HIS에서 수혈 동의 확인"><input type="checkbox" checked={iss.consentAttested} onChange={(e) => setIss({ ...iss, consentAttested: e.target.checked })} />HIS 수혈 동의서 확인함</label>
              <button type="button" onClick={checkHisConsent} className="py-1 px-2 rounded-lg border border-line text-indigo text-xs">HIS 동의 조회</button>
            </div>
            {/* 적격성 사전점검 — 출고를 시도해야만 차단 사유를 알던 것을 미리 근거와 함께 보여준다 */}
            {elig && (
              <div className={`mb-3 p-2 rounded-lg border ${elig.eligible ? 'border-teal/40 bg-teal/[0.04]' : 'border-crit/40 bg-crit/[0.04]'}`}>
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className={`text-xs font-bold ${elig.eligible ? 'text-teal' : 'text-crit'}`}>{elig.eligible ? '출고 가능' : '✕ 출고 차단'}</span>
                  {elig.hardReasons.length > 0 && <span className="px-1.5 py-0.5 rounded bg-crit/15 text-crit text-[11px] font-bold">불가침 {elig.hardReasons.length}건(응급에도 우회 불가)</span>}
                  {elig.sources.map((sx, i) => <span key={i} className="px-1.5 py-0.5 rounded bg-ink-3/10 text-ink-2 text-[11px]">{sx}</span>)}
                  <button onClick={() => setElig(null)} className="ml-auto text-[11px] text-ink-3 hover:text-ink-2">닫기</button>
                </div>
                {elig.blockerExplanations.length > 0 && (
                  <ul className="text-[11px] text-crit list-disc ml-4 mb-1">{elig.blockerExplanations.map((b, i) => <li key={i}>{b}</li>)}</ul>
                )}
                <div className="text-[11px] text-ink-2 flex flex-col gap-0.5">
                  <span>ABO {elig.abo.latest ?? '미상'} · 동일 판정 {elig.abo.concordantCount}회/{elig.abo.typingCount}건 {elig.abo.verifiedTwice ? '(2회 확인 충족)' : '(2회 미충족)'}{elig.abo.independentResult ? ` · 독립검증 ${elig.abo.independentResult}` : ''}</span>
                  <span>교차시험 {elig.crossmatch ? `${elig.crossmatch.result ?? '?'} · ${elig.crossmatch.testedDt} · ${elig.crossmatch.ageHours}시간 경과${elig.crossmatch.expired ? ' (72h 초과)' : ''}` : '기록 없음'}</span>
                  {elig.special.required.length > 0 && <span>특수요구 [{elig.special.required.join(', ')}] vs 제제 [{elig.special.unitAttributes.join(', ') || '없음'}]{elig.special.missing.length > 0 && <span className="text-crit"> · 미충족 {elig.special.missing.join(', ')}</span>}</span>}
                  {elig.antigen.identifiedAntibodies && <span>동정 항체 {elig.antigen.identifiedAntibodies} · 항원매칭 {elig.antigen.compatible ? '적합' : `부적합(미확인 ${elig.antigen.missing.join(',')})`}</span>}
                </div>
                <details className="mt-1"><summary className="text-[11px] text-ink-3 cursor-pointer">RAG 컨텍스트 미리보기</summary>
                  <pre className="mono text-[11px] text-ink-2 whitespace-pre-wrap bg-bg rounded p-1.5 mt-1 max-h-48 overflow-auto">{elig.promptContext}</pre>
                </details>
              </div>
            )}
            <div className="flex gap-2">
              {/* 환자 성명 확인 전에는 출고 버튼 자체를 잠근다 — 대조할 이름이 없으면 확인이 아니다. */}
              <button onClick={submitIssue} disabled={!ctx} title={ctx ? undefined : '환자 확인 필요'} className="py-1.5 px-4 rounded-lg bg-crit text-white font-semibold text-sm disabled:opacity-40 disabled:cursor-not-allowed">출고(2인 확인)</button>
              <button onClick={checkEligibility} disabled={eligBusy} title="출고 전 적격성·차단 사유 미리 확인(읽기 전용)" className="py-1.5 px-4 rounded-lg border border-teal text-teal font-semibold text-sm disabled:opacity-50">{eligBusy ? '점검중…' : '적격성 사전점검'}</button>
              <button onClick={() => setIss(null)} className="py-1.5 px-4 rounded-lg border border-line text-sm">취소</button>
            </div>
          </div>
        )}
        <p className="text-xs text-ink-2 mt-3">
          출고 시 서버가 ABO 2회·교차적합·유효기간·특수요구·항원음성을 검증하고 2인 확인(서로 다른 활성 계정)을 강제합니다(위배 시 차단).
        </p>
      </section>

      {/* 동종면역 대응 — 적합혈액 조회 · 항체동정 패널 */}
      <section className="card mt-4">
        <h2 className="t-section mb-1">동종면역 대응 <span className="text-xs text-ink-3 font-normal">항체양성 환자 · 항원음성 적합혈액 조회 · 항체동정 패널</span></h2>
        <div className="flex flex-wrap items-end gap-2 mt-2 mb-3">
          <div><label className="block text-xs text-ink-2 mb-1">환자ID</label><input aria-label="환자ID" className={`${inp} mono w-32`} value={alloPid} onChange={(e) => setAlloPid(e.target.value)} placeholder="환자ID" /></div>
          <button type="button" onClick={findCompatible} className="py-1.5 px-3 rounded-lg bg-teal text-white text-sm font-semibold">적합 혈액 조회</button>
          <button type="button" onClick={loadPanel} className="py-1.5 px-3 rounded-lg border border-line text-sm">항체동정 패널</button>
        </div>

        {/* 적합 혈액 결과 */}
        {compat && (
          <div className="mb-3 rounded-lg border border-line bg-bg p-3 text-sm">
            <div className="flex flex-wrap items-center gap-3 mb-2">
              <span>환자 <b className="mono">{compat.patientId}</b></span>
              <span>동정 항체 <b>{compat.antibodies ?? '없음'}</b></span>
              {compat.requiredAntigenNeg.length > 0 && <span className="px-2 py-0.5 rounded bg-warn/15 text-warn text-xs font-bold">필요 항원음성: {compat.requiredAntigenNeg.join(', ')}</span>}
              <span className="text-xs text-ink-2">적합 {compat.units.length}건</span>
            </div>
            {compat.units.length === 0
              ? <p className="text-xs text-crit">적합(항원음성) 재고 없음 — 혈액원 요청 필요</p>
              : (
                <div className="flex flex-wrap gap-2">
                  {compat.units.map((u) => (
                    <button key={u.unitNo} onClick={() => startIssue(u.unitNo)} className="text-xs px-2 py-1 rounded bg-good/10 text-good border border-good/30 hover:border-good">
                      <span className="mono">{u.unitNo}</span> · {u.bloodGroup} · {u.expiryDate} {u.antigenNeg ? `· Ag−:${u.antigenNeg}` : ''}
                    </button>
                  ))}
                </div>
              )}
          </div>
        )}

        {/* 항체동정 패널(11-cell) */}
        {panelTpl && (
          <div className="rounded-lg border border-line bg-bg p-3">
            <p className="text-xs text-ink-2 mb-2">각 세포의 환자 혈청 반응(+/0)을 입력하세요. 항원+ 세포에 비반응(0)이면 해당 항체 룰아웃.</p>
            <div className="overflow-x-auto">
              <table className="text-xs">
                <thead>
                  <tr className="text-ink-2">
                    <th className="px-1.5 py-1 text-left">세포</th>
                    {panelAg.map((a) => <th key={a} className="px-1.5 py-1">{a}</th>)}
                    <th className="px-1.5 py-1">반응</th>
                  </tr>
                </thead>
                <tbody>
                  {panelTpl.map((c, i) => (
                    <tr key={c.cell} className="border-t border-line">
                      <td className="px-1.5 py-1 font-semibold">{c.cell}</td>
                      {panelAg.map((a) => <td key={a} className={`px-1.5 py-1 text-center ${c.antigens[a] ? 'text-ink font-bold' : 'text-ink-3'}`}>{c.antigens[a] ? '+' : '0'}</td>)}
                      <td className="px-1.5 py-1 text-center">
                        <button type="button" onClick={() => setReactivity(reactivity.map((r, j) => j === i ? !r : r))} className={`w-7 py-0.5 rounded font-bold ${reactivity[i] ? 'bg-warn/25 text-warn border border-warn' : 'bg-surface border border-line text-ink-2'}`}>{reactivity[i] ? '+' : '0'}</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center gap-3 mt-3">
              <label className="flex items-center gap-1 text-xs cursor-pointer"><input type="checkbox" checked={recordAb} onChange={(e) => setRecordAb(e.target.checked)} />동정 시 이력에 항체 기록</label>
              {recordAb && (
                <>
                  <select aria-label="ABO" value={abType.abo} onChange={(e) => setAbType({ ...abType, abo: e.target.value })} className={`${inp} text-xs py-1`}><option>A</option><option>B</option><option>O</option><option>AB</option></select>
                  <select aria-label="RhD" value={abType.rhD} onChange={(e) => setAbType({ ...abType, rhD: e.target.value })} className={`${inp} text-xs py-1`}><option value="POS">Rh+</option><option value="NEG">Rh−</option></select>
                </>
              )}
              <button type="button" onClick={interpret} className="py-1.5 px-3 rounded-lg bg-teal text-white text-sm font-semibold">판정</button>
            </div>
            {panelResult && (
              <div className="mt-3 pt-3 border-t border-line text-sm space-y-1">
                {panelResult.identified.length > 0
                  ? <p className="text-good font-bold"><IconCheck className="mr-1" />동정: {panelResult.antibodies}</p>
                  : <p className="text-warn font-semibold">동정 미확정 — 추가 세포/방법 필요</p>}
                <p className="text-xs text-ink-2">후보: {panelResult.candidates.length ? panelResult.candidates.join(', ') : '없음'}</p>
                <p className="text-xs text-ink-3">룰아웃: {panelResult.ruledOut.length ? panelResult.ruledOut.join(', ') : '없음'}</p>
              </div>
            )}
          </div>
        )}
      </section>

      {/* 특수수혈 요구 — 환자별 서버 강제(방사선조사·CMV음성 등) */}
      <section className="card mt-4">
        <h2 className="t-section mb-1">특수수혈 요구 <span className="text-xs text-ink-3 font-normal">환자별 등록 시 이후 출고를 서버가 강제(요청 누락 무관) — TA-GVHD 등 예방</span></h2>
        <div className="flex flex-wrap items-end gap-2 mt-2 mb-3">
          <div><label className="block text-xs text-ink-2 mb-1">환자ID</label><input aria-label="환자ID" className={`${inp} mono w-32`} value={reqPid} onChange={(e) => setReqPid(e.target.value)} onBlur={() => loadReqs(reqPid)} placeholder="환자ID" /></div>
          <button type="button" onClick={() => loadReqs(reqPid)} className="py-1.5 px-3 rounded-lg border border-line text-sm">조회</button>
          <span className="text-line">|</span>
          <select aria-label="요구 유형" value={newReq.requirement} onChange={(e) => setNewReq({ ...newReq, requirement: e.target.value })} className={inp}>
            {SPECIAL.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
          </select>
          <input aria-label="사유" value={newReq.reason} onChange={(e) => setNewReq({ ...newReq, reason: e.target.value })} placeholder="사유(예: 조혈모세포이식)" className={`${inp} w-48`} />
          <button type="button" onClick={addReq} className="py-1.5 px-3 rounded-lg bg-teal text-white text-sm font-semibold transition-colors duration-150 hover:bg-teal-2">요구 등록</button>
        </div>
        {reqs.length > 0 && (
          <ul className="flex flex-col gap-1">
            {reqs.map((r) => (
              <li key={r.reqId} className={`flex items-center gap-2 text-sm ${r.active ? '' : 'opacity-50'}`}>
                <span className={`px-2 py-0.5 rounded text-xs font-bold ${r.active ? 'bg-crit/15 text-crit' : 'bg-bg text-ink-3'}`}>{SPECIAL.find((s) => s[0] === r.requirement)?.[1] ?? r.requirement}</span>
                {r.reason && <span className="text-ink-2 text-xs">{r.reason}</span>}
                {r.createdBy && <span className="text-ink-3 text-xs">· {r.createdBy}</span>}
                {!r.active && <span className="text-ink-3 text-xs">(해제됨)</span>}
                {r.active && <button onClick={() => deactivateReq(r.reqId)} className="ml-auto text-xs text-ink-3 hover:underline">해제</button>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="grid md:grid-cols-2 gap-4 mt-4">
        {/* 입고 */}
        <section className="card">
          <h2 className="t-section mb-3">혈액제제 입고</h2>
          <form onSubmit={register} className="space-y-2">
            <div className="flex flex-wrap gap-2 items-center">
              <input required aria-label="제제번호" placeholder="제제번호" value={nu.unitNo} onChange={(e) => setNu({ ...nu, unitNo: e.target.value })} className={`${inp} mono w-36`} />
              <select aria-label="혈액제제 종류" value={nu.productType} onChange={(e) => setNu({ ...nu, productType: e.target.value })} className={inp}><option>RBC</option><option>PLT</option><option>FFP</option><option>Cryo</option></select>
              <input required aria-label="혈액형" placeholder="혈액형" value={nu.bloodGroup} onChange={(e) => setNu({ ...nu, bloodGroup: e.target.value })} className={`${inp} w-16`} />
              <input required aria-label="유효기한" type="date" value={nu.expiryDate} onChange={(e) => setNu({ ...nu, expiryDate: e.target.value })} className={inp} />
            </div>
            <div className="flex flex-wrap gap-3 items-center text-xs">
              <span className="text-ink-2">특수속성:</span>
              <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={nu.irradiated} onChange={(e) => setNu({ ...nu, irradiated: e.target.checked })} />방사선조사</label>
              <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={nu.cmvNeg} onChange={(e) => setNu({ ...nu, cmvNeg: e.target.checked })} />CMV음성</label>
              <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={nu.leukoreduced} onChange={(e) => setNu({ ...nu, leukoreduced: e.target.checked })} />백혈구제거</label>
              <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={nu.washed} onChange={(e) => setNu({ ...nu, washed: e.target.checked })} />세척</label>
            </div>
            <div className="flex flex-wrap gap-2 items-center">
              <input aria-label="항원음성 표현형" placeholder="항원음성(예: K-neg, E-neg)" value={nu.antigenNeg} onChange={(e) => setNu({ ...nu, antigenNeg: e.target.value })} className={`${inp} w-52`} />
              <button className="py-1.5 px-3 rounded-lg bg-teal text-white font-semibold text-xs">입고</button>
            </div>
          </form>
        </section>

        {/* 수혈 시행 기록 · 반납 (출고→시행→부작용) */}
        <section className="card">
          <h2 className="t-section mb-1">수혈 시행 · 반납 <span className="text-xs text-ink-3 font-normal">출고 후 시행 기록 또는 미사용 반납</span></h2>
          <div className="flex flex-wrap items-end gap-2 mt-2">
            <div><label className="block text-xs text-ink-2 mb-1">출고ID</label><input aria-label="출고ID" className={`${inp} mono w-40`} value={adm.issueId} onChange={(e) => setAdm({ ...adm, issueId: e.target.value })} placeholder="출고 시 자동 채움" /></div>
            <div><label className="block text-xs text-ink-2 mb-1">시행자</label><input aria-label="시행자" className={`${inp} w-24`} value={adm.administeredBy} onChange={(e) => setAdm({ ...adm, administeredBy: e.target.value })} placeholder="시행자" /></div>
            <div className="flex-1 min-w-40"><label className="block text-xs text-ink-2 mb-1">비고 / 반납사유</label><input aria-label="비고 / 반납사유" className={`${inp} w-full`} value={adm.note} onChange={(e) => setAdm({ ...adm, note: e.target.value })} placeholder="시행 메모 또는 반납 사유" /></div>
          </div>
          <div className="flex gap-2 mt-2">
            <button type="button" onClick={administer} className="py-1.5 px-4 rounded-lg bg-teal text-white text-sm font-semibold">시행 기록</button>
            <button type="button" onClick={returnIssue} className="py-1.5 px-4 rounded-lg border border-line text-sm">반납(재고 복원)</button>
          </div>
        </section>

        {/* 부작용 보고 */}
        <section className="card">
          <h2 className="t-section mb-3">수혈 부작용 보고</h2>
          <form onSubmit={reportReaction} className="flex flex-wrap gap-2 items-center">
            <input aria-label="출고ID" placeholder="출고ID(선택·자동중단 연동)" value={rx.issueId} onChange={(e) => setRx({ ...rx, issueId: e.target.value })} className={`${inp} mono w-44`} />
            <input required aria-label="환자 ID" placeholder="환자ID" value={rx.patientId} onChange={(e) => setRx({ ...rx, patientId: e.target.value })} className={`${inp} mono w-24`} />
            <select aria-label="이상반응 유형" value={rx.reactionType} onChange={(e) => setRx({ ...rx, reactionType: e.target.value })} className={inp}><option>FEBRILE</option><option>ALLERGIC</option><option>HEMOLYTIC</option><option>TACO</option><option>OTHER</option></select>
            <select aria-label="중증도" value={rx.severity} onChange={(e) => setRx({ ...rx, severity: e.target.value })} className={inp}><option>MILD</option><option>MODERATE</option><option>SEVERE</option></select>
            <input aria-label="증상" placeholder="증상(발열·오한 등)" value={rx.symptoms} onChange={(e) => setRx({ ...rx, symptoms: e.target.value })} className={`${inp} w-40`} />
            <button className="py-1.5 px-3 rounded-lg bg-teal text-white font-semibold text-xs transition-colors duration-150 hover:bg-teal-2">보고</button>
          </form>
          <p className="text-[11px] text-ink-3 mt-2">출고ID 지정 시 HEMOLYTIC·SEVERE는 해당 환자 미시행 제제 자동중단(안전루프)과 연동됩니다.</p>
          {guidance && <p className="text-sm text-crit mt-3 font-semibold"><IconWarn className="mr-1" />권고: {guidance}</p>}
          {/* 이상반응 조사서·외부 항체동정 결과지 문서 첨부 — 이상반응 단위 */}
          <div className="mt-3 pt-3 border-t border-line flex items-center gap-2 flex-wrap">
            <label className="text-xs text-ink-2">이상반응 ID(문서 첨부·조사)</label>
            <input aria-label="이상반응 ID" value={reactionId} onChange={(e) => setReactionId(e.target.value)} placeholder="reactionId(보고 시 자동 채움)" className={`${inp} mono flex-1`} />
            <button onClick={() => loadReaction(reactionId)} className="py-1.5 px-3 rounded-lg border border-line text-xs font-semibold">조사 상태 불러오기</button>
          </div>
          {invState && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <span className={`px-1.5 py-0.5 rounded font-bold ${invState.investigationStatus === 'CLOSED' ? 'bg-good/15 text-good' : invState.investigationStatus === 'IN_PROGRESS' ? 'bg-warn/15 text-warn' : 'bg-bg text-ink-3'}`}>
                조사 {invState.investigationStatus === 'CLOSED' ? '종결' : invState.investigationStatus === 'IN_PROGRESS' ? '진행중' : '미착수'}
              </span>
              {invState.investigatedBy && <span className="text-ink-3">{invState.investigatedBy}{invState.investigatedDt ? ` · ${invState.investigatedDt.slice(0, 16).replace('T', ' ')}` : ''}</span>}
              <span className="text-ink-3">조사서 첨부 {invState.attachmentCount}건</span>
            </div>
          )}

          {/* 반응 조사 워크업 — 등록 API는 있었으나 화면이 없어 기록할 방법이 없었다(인증 요구 기록) */}
          <div className="mt-3 pt-3 border-t border-line">
            <h3 className="t-meta font-semibold mb-2">반응 조사 워크업</h3>
            <div className="flex flex-wrap gap-2 items-center">
              <label className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" checked={inv.clericalCheckOk} onChange={(e) => setInv({ ...inv, clericalCheckOk: e.target.checked })} />
                사무착오 확인 정상
              </label>
              <select aria-label="반응 후 DAT" value={inv.postDat} onChange={(e) => setInv({ ...inv, postDat: e.target.value })} className={inp}>
                <option value="">DAT —</option><option value="NEG">DAT 음성</option><option value="POS">DAT 양성</option>
              </select>
              <select aria-label="육안 용혈" value={inv.hemolysisVisual} onChange={(e) => setInv({ ...inv, hemolysisVisual: e.target.value })} className={inp}>
                <option value="">육안 용혈 —</option><option value="NONE">없음</option><option value="PRESENT">있음</option>
              </select>
              <input aria-label="반응 후 ABO 재검" placeholder="ABO/교차 재검" value={inv.postAboRecheck} onChange={(e) => setInv({ ...inv, postAboRecheck: e.target.value })} className={`${inp} w-32`} />
              <input aria-label="검사 소견" placeholder="haptoglobin·LDH·bilirubin" value={inv.labFindings} onChange={(e) => setInv({ ...inv, labFindings: e.target.value })} className={`${inp} w-52`} />
              <input aria-label="원인 의심 제제" placeholder="원인 의심 unitNo" value={inv.culpritUnitNo} onChange={(e) => setInv({ ...inv, culpritUnitNo: e.target.value })} className={`${inp} mono w-40`} />
              <select aria-label="최종 분류" value={inv.finalClassification} onChange={(e) => setInv({ ...inv, finalClassification: e.target.value })} className={inp}>
                <option value="">최종 분류 —</option>
                <option value="AHTR">AHTR(급성 용혈)</option><option value="FNHTR">FNHTR(발열·비용혈)</option>
                <option value="TRALI">TRALI</option><option value="TACO">TACO(순환과부하)</option>
                <option value="ALLERGIC">알레르기</option><option value="BACTERIAL">세균오염</option><option value="NONE">반응 아님</option>
              </select>
              <input aria-label="결론·권고" placeholder="결론·권고" value={inv.conclusion} onChange={(e) => setInv({ ...inv, conclusion: e.target.value })} className={`${inp} flex-1 min-w-[10rem]`} />
              <button onClick={saveInvestigation} className="py-1.5 px-3 rounded-lg bg-indigo text-white font-semibold text-xs">조사 기록</button>
            </div>
            <p className="text-[11px] text-ink-3 mt-1.5">
              사무착오(환자·제제 대조)는 급성 용혈반응의 가장 흔한 원인이라 가장 먼저 확인합니다.
              {invSaved && <span className="text-good"> · 최종 저장 {invSaved}</span>}
            </p>
          </div>
        </section>

        {/* 환자 수혈 이력 — 반응 조사·특수수혈 요구 판단에 필요한데 조회 화면이 없었다 */}
        <section className="card">
          <h2 className="t-section mb-2">환자 수혈 이력</h2>
          <div className="flex gap-2 items-center">
            <input aria-label="환자 ID(수혈 이력)" placeholder="환자ID" value={ptxId} onChange={(e) => setPtxId(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void loadPatientTx(); } }} className={`${inp} mono flex-1`} />
            <button onClick={loadPatientTx} className="py-1.5 px-3 rounded-lg bg-indigo text-white font-semibold text-xs">조회</button>
          </div>
          {ptx && (ptx.length === 0 ? (
            <p className="text-sm text-ink-3 mt-3">수혈 이력이 없습니다.</p>
          ) : (
            <div className="overflow-x-auto mt-3">
              <table className="w-full text-xs">
                <thead><tr className="text-left text-ink-2 border-b border-line">
                  <th className="py-1.5">제제번호</th><th>제제</th><th>혈액형</th><th>상태</th><th>사후교차</th><th>출고</th>
                </tr></thead>
                <tbody>
                  {ptx.map((t) => (
                    <tr key={t.issueId} className="border-b border-line last:border-0">
                      <td className="py-1.5 mono">{t.unitNo}{t.donationId && <span className="block text-[11px] text-ink-3">헌혈 {t.donationId}</span>}</td>
                      <td>{t.productType ?? '—'}{t.emergency && <span className="ml-1 text-warn">응급</span>}</td>
                      <td className="mono">{t.bloodGroup ?? '—'}</td>
                      <td>{t.status}{t.recallStatus && t.recallStatus !== 'NONE' && <span className="ml-1 text-crit font-semibold">회수 {t.recallStatus}</span>}</td>
                      {/* 응급(MTP·미교차) 출고분의 사후 교차확인 대기 — 확인 누락 방지 */}
                      <td>{t.retroCrossmatchStatus === 'PENDING' ? <span className="px-1.5 py-0.5 rounded bg-warn/15 text-warn font-bold" title="응급 출고(교차 우회) — 사후 교차확인 필요">대기</span> : t.retroCrossmatchStatus === 'DONE' ? <span className="text-good">완료</span> : '—'}</td>
                      <td className="text-ink-2">{t.issuedDt?.slice(0, 16).replace('T', ' ') ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </section>
      </div>

      {/* 추적성·회수·Look-back — 오염/사후양성 통보 시 제제→수혈자 역추적(P2: API만 있고 화면 없던 기능) */}
      <section className="card mt-4">
        <h2 className="t-section mb-1">추적성 · 회수/격리 · Look-back <span className="text-xs text-ink-3 font-normal">헌혈유래→출고→수혈자 체인 · 공혈자 사후 양성 역추적</span></h2>
        <div className="grid md:grid-cols-2 gap-4 mt-3">
          <div>
            <div className="flex gap-2 items-center">
              <input aria-label="추적 제제번호" placeholder="제제번호(unitNo)" value={traceNo} onChange={(e) => setTraceNo(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); doTrace(); } }} className={`${inp} mono flex-1`} />
              <button onClick={doTrace} className="py-1.5 px-3 rounded-lg bg-indigo text-white font-semibold text-xs">추적 조회</button>
            </div>
            {trace && (
              <div className="mt-3 text-sm">
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  <span className="mono font-bold">{trace.unitNo}</span>
                  <span>{trace.productType ?? '—'} · {trace.bloodGroup ?? '—'}</span>
                  <span>상태 {trace.status}</span>
                  <span>헌혈번호 <span className="mono">{trace.donationId ?? '—'}</span></span>
                  {trace.recallStatus && <span className="px-1.5 rounded bg-crit/15 text-crit font-bold text-xs">{trace.recallStatus}</span>}
                </div>
                {trace.recipients.length > 0 ? (
                  <table className="w-full text-xs mt-2">
                    <thead><tr className="text-left text-ink-3"><th className="py-1">출고ID</th><th>환자</th><th>상태</th></tr></thead>
                    <tbody>{trace.recipients.map((r) => (
                      <tr key={r.issueId} className="border-t border-line"><td className="py-1 mono">{r.issueId}</td><td>{maskName(r.name)} <span className="mono text-ink-3">{r.patientId}</span></td><td>{r.status}{r.emergency ? ' · 응급' : ''}</td></tr>
                    ))}</tbody>
                  </table>
                ) : <p className="text-xs text-ink-3 mt-2">출고 이력 없음</p>}
                <div className="flex gap-2 items-center mt-3">
                  <input aria-label="회수 사유" placeholder="회수/격리 사유" value={recallReason} onChange={(e) => setRecallReason(e.target.value)} className={`${inp} flex-1`} />
                  <button onClick={() => doRecall('RECALLED')} className="py-1.5 px-3 rounded-lg bg-crit text-white font-semibold text-xs">회수</button>
                  <button onClick={() => doRecall('QUARANTINED')} className="py-1.5 px-3 rounded-lg border border-crit text-crit font-semibold text-xs transition-colors duration-150 hover:bg-crit/10">격리</button>
                </div>
                {recallRes && recallRes.lookbackRequired && (
                  <p className="text-sm text-crit mt-2 font-semibold" role="alert"><IconWarn className="mr-1" />수혈자 {recallRes.affectedRecipients.length}명 — 시행분은 담당의 통보·추가검사(look-back) 대상: {recallRes.affectedRecipients.map((a) => `${maskName(a.name)}(${a.patientId})${a.transfused ? '·시행' : ''}`).join(', ')}</p>
                )}
              </div>
            )}
          </div>
          <div>
            <div className="flex gap-2 items-center">
              <input aria-label="look-back 헌혈번호" placeholder="헌혈번호(donationId)" value={lbDonation} onChange={(e) => setLbDonation(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); doLookback(); } }} className={`${inp} mono flex-1`} />
              <button onClick={doLookback} className="py-1.5 px-3 rounded-lg bg-indigo text-white font-semibold text-xs">Look-back</button>
            </div>
            {lb && (
              <div className="mt-3 text-sm">
                <p>유래 제제 <span className="mono">{lb.units.join(', ')}</span> — 수혈자 <b>{lb.recipientCount}</b>명</p>
                {lb.recipients.length > 0 && (
                  <table className="w-full text-xs mt-2">
                    <thead><tr className="text-left text-ink-3"><th className="py-1">제제</th><th>환자</th><th>시행</th></tr></thead>
                    <tbody>{lb.recipients.map((r) => (
                      <tr key={r.issueId} className="border-t border-line"><td className="py-1 mono">{r.unitNo}</td><td>{maskName(r.name)} <span className="mono text-ink-3">{r.patientId}</span></td><td>{r.transfused ? '시행됨(통보 대상)' : '미시행'}</td></tr>
                    ))}</tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      {reactionId.trim() && <AttachmentPanel reactionId={reactionId.trim()} />}
    </main>
  );
}
