'use client';

/**
 * 유전체 변이 · 해석 화면 (`/genomic`).
 *
 * 사이드바 노출 역할: GEN, GC, PHY, ADM.
 * ⚠ 노출 역할과 화면이 호출하는 API 권한이 어긋나면 전부 403인 죽은 화면이 된다 —
 *   역할을 바꿀 때는 `Sidebar.tsx`(정본)와 API 권한 매트릭스를 함께 본다.
 * 데이터는 `lib/api.ts`의 `apiFetch`로만 가져온다(HTTP 호출 정본).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, getToken, getUserId } from '@/lib/api';
import { useConfirm } from '@/components/confirm';
import AttachmentPanel from '@/components/AttachmentPanel';
import { ErrorText } from '@/components/ui';
import { IconWarn } from '@/components/Icon';
import { maskName } from '@/lib/privacy';

interface Interpretation {
  interpId: string;
  classification: string | null;
  evidence: string | null;
  status: string | null;
  classifier: string | null;
  classifiedDate: string | null;
  reason: string | null;
}
interface Variant {
  variantId: string;
  gene: string | null;
  chrom: string | null;
  pos: number | null;
  refAllele: string | null;
  altAllele: string | null;
  hgvsC: string | null;
  hgvsP: string | null;
  vaf: number | null;
  zygosity: string | null;
  interpretations: Interpretation[];
}

interface GenomicFinding { variantId?: string; gene: string | null; hgvsC: string | null; hgvsP: string | null; zygosity: string | null; classification: string | null; evidence: string | null; }
interface GenDelivery { deliveryId: string; channel: string; recipient: string | null; deliveredBy: string | null; deliveredDt: string }

interface GenomicReport { genomicOrderId: string; patient: { patientId: string | null; name: string | null }; panelCode: string | null; reportStatus: string | null; reportSignedBy: string | null; reportSignedDt: string | null; consent: { present: boolean; secondaryFindingsOptin: boolean; consentType: string | null; signedDate: string | null; withdrawn: boolean; withdrawnDate: string | null; withdrawnReason: string | null }; primary: GenomicFinding[]; secondary: GenomicFinding[]; secondarySuppressed: number | null; reviewCount?: number; review?: GenomicFinding[]; unresolved: number; }

const ACMG = ['Pathogenic', 'Likely Pathogenic', 'VUS', 'Likely Benign', 'Benign'];
interface DriftRow {
  variantId: string; genomicOrderId: string; gene: string | null; hgvs: string | null;
  patientId: string | null; patientName: string | null;
  finalizedClass: string | null; evidenceClass: string; source: string | null; stars: number | string | null;
  citation: string | null; needsRecontact: boolean;
}
interface EvidenceCtx {
  variant: { gene: string | null; hgvs: string | null; locus: string | null; vaf: number | null; zygosity: string | null; testType: string | null };
  geneKnowledge: { role: string; conditions: string; somaticTherapy?: string } | null;
  citedEvidence: { source?: string; significance: string; stars?: number | string; citation?: string; catalogVersion?: string } | null;
  priorInterpretations: { classification: string | null; classifiedDate: string | null; status: string | null }[];
  sources: string[]; promptContext: string; llmNote: string;
}
interface AiInterpret {
  suggestedClassification: string | null; confidence: string;
  geneContext: { gene: string; role: string; conditions: string; actionable: boolean } | null;
  citedEvidence: { significance?: string; stars?: number | string; gnomadAf?: number | string; source?: string; citation?: string; oncokbLevel?: string; catalogVersion?: string } | null;
  rationale: string[]; clinicalSignificance: string; therapyImplications: string[];
  caveats: string[]; disclaimer: string; draftNarrative: string;
}
// ACMG/AMP 근거 카테고리(카운트) — 백엔드 acmgClassify 입력.
const ACMG_EV = [
  { key: 'pvs', label: 'PVS1', tone: 'crit' }, { key: 'strongP', label: 'PS', tone: 'crit' },
  { key: 'moderateP', label: 'PM', tone: 'warn' }, { key: 'supportingP', label: 'PP', tone: 'warn' },
  { key: 'standaloneB', label: 'BA1', tone: 'ink' }, { key: 'strongB', label: 'BS', tone: 'ink' },
  { key: 'supportingB', label: 'BP', tone: 'ink' },
] as const;
const statusBadge: Record<string, string> = { FINAL: 'bg-good/15 text-good', DRAFT: 'bg-indigo/15 text-indigo', SUPERSEDED: 'bg-bg text-ink-3 line-through' };

function classColor(c: string | null): string {
  if (c === 'Pathogenic' || c === 'Likely Pathogenic') return 'text-crit';
  if (c === 'VUS') return 'text-warn';
  return 'text-ink-2';
}

export default function GenomicPage() {
  const router = useRouter();
  const confirm = useConfirm();
  const [genomicOrderId, setGenomicOrderId] = useState('');
  const [variants, setVariants] = useState<Variant[]>([]);
  const [report, setReport] = useState<GenomicReport | null>(null);
  const [deliveries, setDeliveries] = useState<GenDelivery[] | null>(null);
  const [vcf, setVcf] = useState('');
  const [mv, setMv] = useState({ gene: '', hgvsC: '', hgvsP: '', vaf: '', zygosity: '' });
  const [cls, setCls] = useState<Record<string, string>>({});
  const [ev, setEv] = useState<Record<string, string>>({});
  const [geneFix, setGeneFix] = useState<Record<string, string>>({}); // P4 유전자 심볼 보정 입력
  const [acmgOpen, setAcmgOpen] = useState<string | null>(null);
  const [acmgEv, setAcmgEv] = useState<Record<string, number>>({});
  const [acmgSug, setAcmgSug] = useState<string | null>(null);
  // AI 해석 초안(로컬 지식기반) — 어느 변이에 대해, 결과
  const [aiFor, setAiFor] = useState<string | null>(null);
  const [aiRes, setAiRes] = useState<AiInterpret | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [ecFor, setEcFor] = useState<string | null>(null); // 근거 종합 번들 대상 변이
  const [ecRes, setEcRes] = useState<EvidenceCtx | null>(null);
  const [filter, setFilter] = useState('');
  const classifier = getUserId() ?? '';
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [orders, setOrders] = useState<{ genomicOrderId: string; patientName: string; patientId: string | null; panelCode: string | null; testType: string; status: string; sendoutCenter: string | null; tatTarget: string | null; reportStatus: string | null; variantCount: number; unresolved: number }[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  // 근거 drift 재해석 검토 — 확정 해석이 현재 근거 DB와 어긋나는 변이
  const [drift, setDrift] = useState<{ evidenceActive: boolean; catalogVersion: string | null; drifted: DriftRow[] } | null>(null);
  const [consent, setConsent] = useState({ consentType: '생식세포(germline)', secondaryFindingsOptin: false, signedDate: new Date().toISOString().slice(0, 10) });

  const loadOrders = async () => { try { setOrders(await apiFetch('/api/v1/genomic/orders')); } catch (e) { setErr(e instanceof Error ? e.message : '유전체 오더 조회 실패'); } };
  const loadDrift = async () => { try { setDrift(await apiFetch('/api/v1/genomic/reinterpret-review')); } catch { setDrift(null); } };
  async function loadEvidenceCtx(v: Variant) {
    if (ecFor === v.variantId) { setEcFor(null); setEcRes(null); return; }
    setEcFor(v.variantId); setEcRes(null);
    try { setEcRes(await apiFetch<EvidenceCtx>(`/api/v1/genomic/variants/${v.variantId}/evidence-context`)); }
    catch (e) { setErr(e instanceof Error ? e.message : '근거 종합 조회 실패'); setEcFor(null); }
  }
  const curOrder = orders.find((o) => o.genomicOrderId === genomicOrderId);

  async function recordConsent() {
    setErr(''); setMsg('');
    try {
      await apiFetch('/api/v1/genomic/consent', { method: 'POST', body: JSON.stringify({ genomicOrderId, consentType: consent.consentType, secondaryFindingsOptin: consent.secondaryFindingsOptin, signedDate: consent.signedDate }) });
      setMsg('전자동의 등록됨 — 수탁 발송 가능'); await loadOrders();
    } catch (e) { setErr(e instanceof Error ? e.message : '동의 등록 실패'); }
  }
  async function requestSendout() {
    setErr(''); setMsg('');
    try {
      const r = await apiFetch<{ status: string }>(`/api/v1/genomic/${genomicOrderId}/sendout`, { method: 'POST' });
      setMsg(`수탁 발송 요청됨 (${r.status})`); await loadOrders();
    } catch (e) { setErr(e instanceof Error ? e.message : '발송 불가 — 동의 게이트 확인'); }
  }
  async function withdrawConsent() {
    const ok = await confirm({ title: '동의 철회', message: '이 오더의 활성 동의를 전부 철회합니다. 이후 수탁 발송이 차단됩니다.', danger: true });
    if (!ok) return;
    setErr(''); setMsg('');
    try {
      const r = await apiFetch<{ withdrawnCount: number; postSendout: boolean }>(`/api/v1/genomic/${genomicOrderId}/consent/withdraw`, { method: 'POST', body: JSON.stringify({ reason: '환자 요청', actor: classifier }) });
      setMsg(`동의 철회됨(${r.withdrawnCount}건)${r.postSendout ? ' · 발송 이후 — 회수 확인 필요' : ''}`); await loadOrders();
    } catch (e) { setErr(e instanceof Error ? e.message : '철회 실패(활성 동의 없음)'); }
  }

  useEffect(() => {
    if (!getToken()) { router.push('/'); return; }
    loadOrders();
    loadDrift();
  }, [router]);

  async function load(id = genomicOrderId) {
    setErr(''); setMsg('');
    try {
      setVariants(await apiFetch<Variant[]>(`/api/v1/genomic/${id}/variants`));
      setLoaded(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '조회 실패(유전정보 권한 필요)');
    }
  }

  async function loadReport() {
    setErr('');
    try { setReport(await apiFetch<GenomicReport>(`/api/v1/genomic/${genomicOrderId}/report`)); }
    catch (e) { setErr(e instanceof Error ? e.message : '보고서 조립 실패'); }
  }

  async function importVcf() {
    setErr(''); setMsg('');
    try {
      const r = await apiFetch<{ imported: number }>(`/api/v1/genomic/${genomicOrderId}/vcf`, { method: 'POST', body: JSON.stringify({ vcf }) });
      setMsg(`VCF 수신 완료 · 변이 ${r.imported}건`); setVcf(''); await load();
    } catch (e) { setErr(e instanceof Error ? e.message : 'VCF 수신 실패'); }
  }

  async function addManualVariant() {
    if (!mv.gene.trim() && !mv.hgvsC.trim() && !mv.hgvsP.trim()) { setErr('유전자 또는 HGVS(c./p.) 중 하나는 입력하세요'); return; }
    setErr(''); setMsg('');
    try {
      await apiFetch(`/api/v1/genomic/${genomicOrderId}/variant`, { method: 'POST', body: JSON.stringify({
        gene: mv.gene || undefined, hgvsC: mv.hgvsC || undefined, hgvsP: mv.hgvsP || undefined,
        vaf: mv.vaf ? Number(mv.vaf) : undefined, zygosity: mv.zygosity || undefined,
      }) });
      setMsg('수기 변이 등록됨 — ACMG 큐레이션으로 진행'); setMv({ gene: '', hgvsC: '', hgvsP: '', vaf: '', zygosity: '' }); await load();
    } catch (e) { setErr(e instanceof Error ? e.message : '수기 변이 등록 실패'); }
  }

  const clsOf = (v: Variant, cur?: Interpretation) => cls[v.variantId] ?? cur?.classification ?? 'VUS';

  // ACMG 근거 카운트 → 분류 제안(큐레이션 보조). 제안은 참고값이며 확정은 사람 판단.
  function toggleAcmg(variantId: string) {
    if (acmgOpen === variantId) { setAcmgOpen(null); return; }
    setAcmgOpen(variantId); setAcmgEv({}); setAcmgSug(null);
  }
  async function runAcmgSuggest() {
    setErr('');
    try {
      const r = await apiFetch<{ classification: string }>('/api/v1/genomic/acmg-suggest', { method: 'POST', body: JSON.stringify(acmgEv) });
      setAcmgSug(r.classification);
    } catch (e) { setErr(e instanceof Error ? e.message : 'ACMG 제안 실패'); }
  }

  /**
   * AI 해석 초안 — 로컬 지식기반. 변이 정보 + (열려 있으면)ACMG 근거로 분류 제안·근거·표적치료
   * 시사점을 생성한다. ★환자 데이터는 외부로 나가지 않으며, 초안은 반드시 사람이 검토·확정한다.
   */
  async function runAiInterpret(v: Variant, cur?: Interpretation) {
    if (aiFor === v.variantId) { setAiFor(null); setAiRes(null); return; }
    setAiFor(v.variantId); setAiRes(null); setAiBusy(true); setErr('');
    try {
      const body: Record<string, unknown> = {
        gene: v.gene ?? undefined, hgvsC: v.hgvsC ?? undefined, hgvsP: v.hgvsP ?? undefined,
        classification: cls[v.variantId] ?? cur?.classification ?? undefined,
        vaf: v.vaf ?? undefined, zygosity: v.zygosity ?? undefined,
        testType: curOrder?.testType ?? undefined,
      };
      // ACMG 패널이 열려 있고 근거를 입력했으면 함께 전달(규칙 기반 분류 재계산)
      if (acmgOpen === v.variantId && Object.values(acmgEv).some((n) => (n ?? 0) > 0)) body.acmgEvidence = acmgEv;
      setAiRes(await apiFetch<AiInterpret>('/api/v1/genomic/ai-interpret', { method: 'POST', body: JSON.stringify(body) }));
    } catch (e) { setErr(e instanceof Error ? e.message : 'AI 해석 실패'); setAiFor(null); }
    finally { setAiBusy(false); }
  }

  // C4-1: 초안 저장(curate → DRAFT, 근거 기록)
  async function saveDraft(v: Variant, cur?: Interpretation) {
    setErr(''); setMsg('');
    try {
      await apiFetch(`/api/v1/genomic/variants/${v.variantId}/curate`, {
        method: 'POST',
        body: JSON.stringify({ classification: clsOf(v, cur), evidence: ev[v.variantId] || undefined, classifier }),
      });
      setMsg(`${v.gene} 초안 저장(DRAFT)`); await load();
    } catch (e) { setErr(e instanceof Error ? e.message : '초안 저장 실패'); }
  }

  // C4-2: 초안 확정(finalize DRAFT → FINAL)
  async function finalizeDraft(v: Variant) {
    const draft = v.interpretations.find((i) => i.status === 'DRAFT');
    if (!draft) { setErr('먼저 초안을 저장하세요.'); return; }
    setErr(''); setMsg('');
    try {
      await apiFetch(`/api/v1/genomic/interpretations/${draft.interpId}/finalize`, { method: 'POST' });
      setMsg(`${v.gene} 해석 확정(FINAL)`); await load();
    } catch (e) { setErr(e instanceof Error ? e.message : '확정 실패'); }
  }

  // C4-3: 확정 이후 재분류(reclassify — 근거 필수)
  async function reclassify(v: Variant) {
    const classification = cls[v.variantId] ?? '';
    const evidence = ev[v.variantId];
    if (!classification) { setErr('새 분류를 선택하세요.'); return; }
    if (!evidence?.trim()) { setErr('재분류는 근거(evidence)가 필요합니다.'); return; }
    const ok = await confirm({
      title: '변이 재분류 확인',
      message: '기존 확정(FINAL) 해석이 SUPERSEDED 처리되고 새 해석이 확정됩니다. 재연락 대상이 될 수 있습니다.',
      detail: [{ label: '유전자', value: v.gene ?? '-' }, { label: '새 분류', value: classification }, { label: '근거', value: evidence }],
      danger: true, confirmLabel: '재분류 확정',
    });
    if (!ok) return;
    setErr(''); setMsg('');
    try {
      const r = await apiFetch<{ recontact: { notifyId: string } | null }>(`/api/v1/genomic/variants/${v.variantId}/reclassify`, {
        method: 'POST',
        body: JSON.stringify({ classification, evidence, classifier, reason: evidence }),
      });
      setMsg(`${v.gene} → ${classification} 재분류 확정${r.recontact ? ' · 재접촉 통보 발생(의뢰의) — 알림 화면 복창' : ''}`); await load();
    } catch (e) { setErr(e instanceof Error ? e.message : '재분류 실패'); }
  }

  /**
   * 유전자 심볼 보정(P4) — 심볼을 못 읽어 review에 갇힌 확정 P/LP를 되살린다.
   * 서버는 '정규화 불가 심볼'만 받는다(이미 확정된 심볼 교체 = SF 게이트 뒤집기라 차단).
   */
  async function correctGene(f: GenomicFinding) {
    const variantId = f.variantId;
    if (!variantId) return;
    const gene = (geneFix[variantId] ?? '').trim();
    if (!gene) { setErr('보정할 유전자 심볼을 입력하세요.'); return; }
    const ok = await confirm({
      title: '유전자 심볼 보정',
      message: '보고서 판정(이차소견 여부·동의 게이트)에 직접 영향을 줍니다. 수탁 원본 결과지와 대조해 확인하세요.',
      detail: [{ label: '변이', value: f.hgvsC ?? f.hgvsP ?? variantId }, { label: '현재 심볼', value: f.gene || '(없음)' }, { label: '보정 심볼', value: gene }],
      danger: true, confirmLabel: '보정 확정',
    });
    if (!ok) return;
    setErr(''); setMsg('');
    try {
      await apiFetch(`/api/v1/genomic/variants/${variantId}/gene`, {
        method: 'POST',
        body: JSON.stringify({ gene, reason: '수탁 원본 결과지 대조 — 심볼 미확정 보정' }),
      });
      setGeneFix({ ...geneFix, [variantId]: '' });
      setMsg(`유전자 심볼 보정 — ${gene}`); await loadReport(); await load();
    } catch (e) { setErr(e instanceof Error ? e.message : '심볼 보정 실패'); }
  }

  // G3 유전체 보고서 서명·배포
  async function signReport() {
    setErr(''); setMsg('');
    try {
      const r = await apiFetch<{ reportStatus: string }>(`/api/v1/genomic/${genomicOrderId}/report/sign`, { method: 'POST', body: JSON.stringify({ signer: classifier }) });
      setMsg(`보고서 서명 확정(${r.reportStatus})`); await loadReport();
    } catch (e) { setErr(e instanceof Error ? e.message : '서명 실패(확정 해석 필요)'); }
  }
  async function deliverReport() {
    setErr(''); setMsg('');
    try {
      await apiFetch(`/api/v1/genomic/${genomicOrderId}/report/deliver`, { method: 'POST', body: JSON.stringify({ channel: 'PROVIDER', recipient: '의뢰의', deliveredBy: classifier || undefined }) });
      setMsg('보고서 배포 기록됨(의뢰의)'); await loadDeliveries();
    } catch (e) { setErr(e instanceof Error ? e.message : '배포 실패(서명 완료 보고서만)'); }
  }

  /**
   * 배포 이력 — "이 보고서가 누구에게 언제 나갔는가".
   * 기록만 되고 볼 방법이 없었다. 재분류로 재연락해야 할 때 누가 이미 받았는지가 출발점이다.
   */
  async function loadDeliveries() {
    if (!genomicOrderId) return;
    try { setDeliveries(await apiFetch<GenDelivery[]>(`/api/v1/genomic/${genomicOrderId}/report/deliveries`)); }
    catch { setDeliveries([]); }
  }

  return (
    <main className="page">
      <h1 className="t-page mb-1">유전체 변이 · 해석</h1>
      <p className="text-xs text-ink-2 mb-4">
        유전정보는 민감정보로 접근이 별도 감사됩니다(GEN/GC/PHY/ADM 권한).
      </p>
      {err && <ErrorText message={err} />}
      {msg && <p className="text-sm text-good mb-3">{msg}</p>}

      <div className="flex gap-2 items-end mb-4">
        <div>
          <label className="block text-xs text-ink-2 mb-1">유전체 오더ID</label>
          <input
            aria-label="유전체 오더ID"
            className="mono px-3 py-2 rounded-lg border border-line bg-bg text-sm w-40"
            value={genomicOrderId}
            onChange={(e) => setGenomicOrderId(e.target.value)}
          />
        </div>
        <button onClick={() => load()} className="py-2 px-4 rounded-lg bg-indigo text-white font-semibold text-sm">
          변이 조회
        </button>
      </div>

      {/* 근거 drift 재해석 검토 — ClinVar 등 개정으로 확정 해석이 낡은 변이(재접촉 필요 우선) */}
      {drift?.evidenceActive && drift.drifted.length > 0 && (
        <section className="card border-crit/30 mb-4">
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <h2 className="t-section text-sm text-crit"><IconWarn className="mr-1" />근거 변경 — 재해석 검토 ({drift.drifted.length})</h2>
            <span className="t-micro text-ink-3">근거 DB {drift.catalogVersion} 기준 · 확정 해석이 현재 근거와 다른 변이</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="text-left text-ink-2 border-b border-line">
                <th className="py-1.5">환자</th><th>오더</th><th>변이</th><th>확정 분류</th><th>현재 근거</th><th>출처</th><th></th>
              </tr></thead>
              <tbody>
                {drift.drifted.map((d) => (
                  <tr key={d.variantId} className={`border-b border-line last:border-0 ${d.needsRecontact ? 'bg-crit/[0.04]' : ''}`}>
                    <td className="py-1.5">{maskName(d.patientName)}{d.needsRecontact && <span className="ml-1 px-1 rounded bg-crit/15 text-crit font-bold text-[11px]">재접촉</span>}</td>
                    <td className="mono">{d.genomicOrderId}</td>
                    <td><b className="italic">{d.gene}</b> <span className="mono text-ink-3">{d.hgvs}</span></td>
                    <td className={classColor(d.finalizedClass)}>{d.finalizedClass}</td>
                    <td className={`font-bold ${classColor(d.evidenceClass)}`}>→ {d.evidenceClass}</td>
                    <td className="text-ink-2">{d.source ?? '—'}{d.stars != null && d.stars !== '' ? ` ${d.stars}★` : ''}{d.citation ? ` · ${d.citation}` : ''}</td>
                    <td><button onClick={() => { setGenomicOrderId(d.genomicOrderId); load(d.genomicOrderId); }} className="text-teal underline">열기</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="t-micro text-ink-3 mt-2">탐지만 표시합니다 — 재분류는 판독자가 변이를 열어 근거 확인 후 확정합니다(P/LP 변경 시 재접촉 통보 발생).</p>
        </section>
      )}

      {/* C5 유전체 수탁 워크리스트 — 오더·환자·패널·수탁기관·TAT·상태 한눈에 (05 §3) */}
      {orders.length > 0 && (
        <section className="card mb-4">
          <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
            <div className="t-section text-sm">수탁 워크리스트 <span className="text-ink-3 font-normal">({orders.length})</span></div>
            <select aria-label="상태 필터" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="px-2 py-1 rounded-lg border border-line bg-bg text-xs">
              <option value="">전체 상태</option>
              <option value="접수">접수</option>
              <option value="수탁발송">수탁발송</option>
              <option value="결과수신">결과수신</option>
              <option value="해석중">해석중</option>
              <option value="해석확정">해석확정</option>
            </select>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="text-left text-ink-2 border-b border-line">
                <th className="py-1.5 pr-2">오더</th><th className="pr-2">환자</th><th className="pr-2">패널</th><th className="pr-2">수탁기관</th><th className="pr-2">TAT</th><th className="pr-2">상태</th><th className="pr-2">변이</th><th className="pr-2">보고서</th>
              </tr></thead>
              <tbody>
                {orders.filter((o) => !statusFilter || o.status === statusFilter).map((o) => {
                  const tone = o.status === '해석확정' ? 'bg-good/15 text-good' : o.status === '결과수신' || o.status === '해석중' ? 'bg-indigo/15 text-indigo' : o.status === '수탁발송' ? 'bg-warn/15 text-warn' : 'bg-bg text-ink-2';
                  return (
                    <tr key={o.genomicOrderId} onClick={() => { setGenomicOrderId(o.genomicOrderId); load(o.genomicOrderId); }}
                      className={`border-b border-line last:border-0 cursor-pointer hover:bg-bg ${genomicOrderId === o.genomicOrderId ? 'bg-indigo/[0.06]' : ''}`}>
                      <td className="py-1.5 pr-2 mono">{o.genomicOrderId}</td>
                      <td className="pr-2">{maskName(o.patientName)}</td>
                      <td className="pr-2">{o.panelCode ?? '—'} <span className="text-ink-3">{o.testType === 'GERMLINE' ? '생식' : o.testType === 'SOMATIC' ? '체세포' : ''}</span></td>
                      <td className="pr-2">{o.sendoutCenter ?? '—'}</td>
                      <td className="pr-2 text-ink-2">{o.tatTarget ?? '—'}</td>
                      <td className="pr-2"><span className={`px-1.5 py-0.5 rounded ${tone}`}>{o.status}</span></td>
                      <td className="pr-2 mono">{o.variantCount}{o.unresolved > 0 && <span className="text-warn font-bold"> ·미{o.unresolved}</span>}</td>
                      <td className="pr-2 text-ink-2">{o.reportStatus ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="t-micro text-ink-3 mt-2">행을 클릭하면 아래에서 해당 오더의 동의·수탁·변이·보고서를 처리합니다. 상태: 접수→수탁발송→결과수신→해석→해석확정.</p>
        </section>
      )}

      {/* 동의 게이트 → 수탁 발송 (수탁 발송 선행 필수) */}
      <section className="card mb-4">
        <h2 className="t-section text-sm mb-1">전자동의 · 수탁 발송 <span className="text-xs text-ink-3 font-normal">발송 전 동의 게이트 필수 (05 §3)</span></h2>
        <div className="flex items-center gap-2 mb-2 text-xs">
          <span className="mono">{genomicOrderId}</span>
          {curOrder && <><span className="text-ink-2">{curOrder.patientName}</span><span className="px-2 py-0.5 rounded bg-bg border border-line">{curOrder.status}</span></>}
        </div>
        <div className="flex flex-wrap items-end gap-2 mb-2">
          <div><label className="block text-xs text-ink-2 mb-1">동의 유형</label>
            <select value={consent.consentType} onChange={(e) => setConsent({ ...consent, consentType: e.target.value })} className="px-2 py-1.5 rounded-lg border border-line bg-bg text-sm">
              <option>생식세포(germline)</option><option>체세포(somatic)</option><option>수탁검사 포괄동의</option>
            </select></div>
          <div><label className="block text-xs text-ink-2 mb-1">서명일</label>
            <input aria-label="서명일" type="date" value={consent.signedDate} onChange={(e) => setConsent({ ...consent, signedDate: e.target.value })} className="px-2 py-1.5 rounded-lg border border-line bg-bg text-sm" /></div>
          <label className="flex items-center gap-1.5 text-sm cursor-pointer self-center"><input type="checkbox" checked={consent.secondaryFindingsOptin} onChange={(e) => setConsent({ ...consent, secondaryFindingsOptin: e.target.checked })} />2차 소견(secondary findings) 동의</label>
          <button onClick={recordConsent} className="py-1.5 px-3 rounded-lg bg-teal text-white text-sm font-semibold">동의 등록</button>
        </div>
        <div className="flex gap-2 pt-2 border-t border-line">
          <button onClick={requestSendout} className="py-1.5 px-3 rounded-lg bg-indigo text-white text-sm font-semibold">수탁 발송 요청</button>
          <button onClick={withdrawConsent} className="py-1.5 px-3 rounded-lg border border-crit/30 text-crit text-sm">동의 철회</button>
        </div>
      </section>

      {/* 임상 보고서 — 1차/이차 소견(이차소견은 동의 시에만) */}
      <section className="card mb-4">
        <div className="flex items-center justify-between mb-2 no-print">
          <h2 className="t-section text-sm">임상 보고서 <span className="text-xs text-ink-3 font-normal">확정(FINAL) 변이 · 이차소견 동의 필터</span></h2>
          <div className="flex gap-2">
            <button onClick={loadReport} className="text-xs bg-teal text-white px-3 py-1.5 rounded-lg font-semibold">보고서 조립</button>
            {report && <button onClick={() => window.print()} className="text-xs bg-indigo text-white px-3 py-1.5 rounded-lg font-semibold">인쇄</button>}
            {report && <button onClick={signReport} className="text-xs bg-teal text-white px-3 py-1.5 rounded-lg font-semibold">서명 확정</button>}
            {report && <button onClick={deliverReport} className="text-xs border border-line text-ink-2 px-3 py-1.5 rounded-lg font-semibold">배포(의뢰의)</button>}
            {report && <button onClick={loadDeliveries} className="text-xs border border-line text-ink-2 px-3 py-1.5 rounded-lg font-semibold">배포 이력</button>}
          </div>
        </div>
        {deliveries && (
          <div className="text-xs mb-3 print:hidden">
            {deliveries.length === 0 ? <p className="text-ink-3">배포 이력 없음</p> : (
              <ul className="flex flex-col gap-0.5">
                {deliveries.map((d) => (
                  <li key={d.deliveryId} className="text-ink-2">
                    <span className="font-semibold">{d.channel}</span> · {d.recipient ?? '—'} · {d.deliveredBy ?? '—'}
                    <span className="mono text-ink-3"> {d.deliveredDt.slice(0, 16).replace('T', ' ')}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-ink-3 mt-1">재분류(P/LP 변경) 시 재연락 대상을 여기서 확인합니다.</p>
          </div>
        )}
        {report && (
          <div className="text-sm print-area">
            <div className="print-only mb-2"><h3 className="text-base font-bold">유전체 검사 보고서</h3></div>
            <div className="text-xs text-ink-2 mb-2">{report.patient.name ?? '-'} <span className="mono">{report.patient.patientId ?? ''}</span> · 패널 {report.panelCode ?? '-'} · 동의 {report.consent.present ? '있음' : '없음'}{report.consent.present && report.consent.consentType ? `(${report.consent.consentType})` : ''}{report.consent.secondaryFindingsOptin ? '·이차소견 동의' : ''}{report.consent.present && report.consent.signedDate ? ` ${report.consent.signedDate}` : ''} · 미확정 {report.unresolved}</div>
            {/* 동의 철회 지속 표시 — 철회 후에도 상태가 사라지지 않게(회수·재접촉 판단에 필수) */}
            {report.consent.withdrawn && (
              <div className="text-xs bg-crit/5 border border-crit/30 rounded-lg p-2 mb-2 text-crit"><IconWarn className="mr-1" />동의 철회됨{report.consent.withdrawnDate ? ` · ${report.consent.withdrawnDate}` : ''}{report.consent.withdrawnReason ? ` · ${report.consent.withdrawnReason}` : ''} — 이차소견 보고 불가·수탁 발송분 회수 확인</div>
            )}
            {/* 보고서 서명 상태·서명자 — 최종 확정 여부와 판독 책임 소재 */}
            <div className="text-xs mb-2 flex flex-wrap items-center gap-2">
              <span className={`px-1.5 py-0.5 rounded font-bold ${report.reportStatus === '최종' || report.reportStatus === '개정' ? 'bg-good/15 text-good' : 'bg-warn/15 text-warn'}`}>{report.reportStatus ?? '미서명'}</span>
              {report.reportSignedBy && <span className="text-ink-2">서명 {report.reportSignedBy}{report.reportSignedDt ? ` · ${report.reportSignedDt.slice(0, 16).replace('T', ' ')}` : ''}</span>}
            </div>
            <div className="font-semibold text-xs text-ink-2 mb-1">1차 소견 ({report.primary.length})</div>
            {report.primary.length === 0 ? <p className="text-xs text-ink-3 mb-2">보고 대상 1차 소견 없음</p> : (
              <ul className="flex flex-col gap-1.5 mb-3">
                {report.primary.map((f, i) => (
                  <li key={i} className="text-xs">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold">{f.gene ?? '-'}</span><span className="mono text-ink-3">{f.hgvsC ?? ''} {f.hgvsP ?? ''}</span>
                      <span className={`font-bold ${classColor(f.classification)}`}>{f.classification}</span>
                      <span className="text-ink-3">{f.zygosity ?? ''}</span>
                    </div>
                    {f.evidence && <div className="text-ink-2 mt-0.5 pl-2 border-l-2 border-line">근거: {f.evidence}</div>}
                  </li>
                ))}
              </ul>
            )}
            <div className="font-semibold text-xs text-ink-2 mb-1">이차 소견 ({report.secondary.length})</div>
            {report.secondary.length > 0 ? (
              <ul className="flex flex-col gap-1.5">
                {report.secondary.map((f, i) => (
                  <li key={i} className="text-xs">
                    <div className="flex items-center gap-2 flex-wrap"><span className="font-semibold text-indigo">{f.gene}</span><span className="mono text-ink-3">{f.hgvsC ?? ''}</span><span className={`font-bold ${classColor(f.classification)}`}>{f.classification}</span></div>
                    {f.evidence && <div className="text-ink-2 mt-0.5 pl-2 border-l-2 border-line">근거: {f.evidence}</div>}
                  </li>
                ))}
              </ul>
            ) : !report.consent.secondaryFindingsOptin ? (
              <p className="text-xs text-ink-3">이차소견 미동의 — 이차소견 항목 <b>미조회·미보고</b>(존재 여부 비노출)</p>
            ) : <p className="text-xs text-ink-3">이차 소견 없음</p>}
            {(report.reviewCount ?? 0) > 0 && (
              <div className="mt-2 no-print rounded-xl border border-warn/40 bg-warn/[0.06] p-2">
                <p className="text-xs text-warn font-semibold"><IconWarn className="mr-1" />유전자 심볼 미확정 P/LP {report.reviewCount}건 — 자동 보고 보류(이차소견 여부를 판정할 수 없어 primary로 내보내지 않습니다)</p>
                {(report.review ?? []).map((f) => (
                  <div key={f.variantId} className="flex flex-wrap items-center gap-1.5 mt-1.5 text-xs">
                    <span className="mono text-ink-3">{f.hgvsC ?? f.hgvsP ?? f.variantId}</span>
                    <span className={`font-bold ${classColor(f.classification)}`}>{f.classification}</span>
                    <span className="text-ink-3">심볼 &quot;{f.gene ?? ''}&quot;</span>
                    <input aria-label="유전자 심볼 보정" placeholder="정확한 유전자 심볼" value={geneFix[f.variantId ?? ''] ?? ''}
                      onChange={(e) => setGeneFix({ ...geneFix, [f.variantId ?? '']: e.target.value })}
                      className="px-2 py-1 rounded-lg border border-line bg-bg mono w-40" />
                    <button onClick={() => correctGene(f)} className="px-2 py-1 rounded-lg bg-warn text-white font-semibold">심볼 보정</button>
                  </div>
                ))}
                <p className="text-xs text-ink-3 mt-1">보정 후 ACMG 이차소견 유전자로 판명되면 <b>동의 게이트</b>가 자동 적용됩니다.</p>
              </div>
            )}
          </div>
        )}
      </section>

      {/* 수탁 결과 수신 — ① 구조화 VCF(자동), ② PDF/수기(장비 미연동·비협조 수탁) */}
      <section className="card mb-4">
        <h2 className="t-section text-sm mb-2">수탁 VCF 수신 <span className="text-xs font-normal text-ink-3">구조화 결과(자동 경로)</span></h2>
        <textarea aria-label="VCF 붙여넣기" value={vcf} onChange={(e) => setVcf(e.target.value)} rows={3} placeholder="#CHROM	POS	ID	REF	ALT	QUAL	FILTER	INFO ..." className="w-full mono text-xs px-2 py-1.5 rounded-lg border border-line bg-bg mb-2" />
        <div className="flex items-center gap-2">
          <button onClick={importVcf} className="py-1.5 px-3 rounded-lg bg-teal text-white font-semibold text-xs">VCF 수신 → 변이 등록</button>
          <label className="text-xs text-teal underline cursor-pointer">
            파일 불러오기
            <input type="file" accept=".vcf,text/plain" className="hidden" aria-label="VCF 파일 선택"
              onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setVcf(await f.text()); } e.target.value = ''; }} />
          </label>
          <span className="text-xs text-ink-3">.vcf 파일을 불러와 붙여넣기</span>
        </div>

        {/* 장비 미연동·PDF 결과지 경로 — 원본 PDF 첨부 + 변이 수기 입력 */}
        <div className="mt-3 pt-3 border-t border-line">
          <h3 className="font-bold text-sm mb-1">장비 미연동 · PDF 결과지 <span className="text-xs font-normal text-ink-3">문서/수기 경로(비협조 수탁)</span></h3>
          <p className="text-xs text-ink-3 mb-2">수탁이 VCF 없이 PDF 결과지로만 회신할 때: <b>①</b> 아래 첨부에 원본 PDF를 올려 보존하고, <b>②</b> 결과지를 보고 변이를 아래 폼으로 직접 등록하면 이후 ACMG 큐레이션·보고서 흐름이 동일하게 진행됩니다.</p>
          <div className="grid sm:grid-cols-6 gap-2 items-end p-2 rounded-lg border border-line bg-bg">
            <div><label className="block text-[11px] text-ink-2 mb-0.5">유전자</label><input aria-label="유전자" value={mv.gene} onChange={(e) => setMv({ ...mv, gene: e.target.value })} placeholder="BRCA1" className="w-full px-2 py-1 rounded border border-line bg-surface text-sm" /></div>
            <div><label className="block text-[11px] text-ink-2 mb-0.5">HGVS c.</label><input aria-label="HGVS c." value={mv.hgvsC} onChange={(e) => setMv({ ...mv, hgvsC: e.target.value })} placeholder="c.68_69delAG" className="w-full mono px-2 py-1 rounded border border-line bg-surface text-xs" /></div>
            <div><label className="block text-[11px] text-ink-2 mb-0.5">HGVS p.</label><input aria-label="HGVS p." value={mv.hgvsP} onChange={(e) => setMv({ ...mv, hgvsP: e.target.value })} placeholder="p.Glu23fs" className="w-full mono px-2 py-1 rounded border border-line bg-surface text-xs" /></div>
            <div><label className="block text-[11px] text-ink-2 mb-0.5">VAF %</label><input aria-label="VAF %" value={mv.vaf} onChange={(e) => setMv({ ...mv, vaf: e.target.value })} inputMode="decimal" placeholder="45" className="w-full px-2 py-1 rounded border border-line bg-surface text-sm" /></div>
            <div><label className="block text-[11px] text-ink-2 mb-0.5">접합성</label><input aria-label="접합성" value={mv.zygosity} onChange={(e) => setMv({ ...mv, zygosity: e.target.value })} placeholder="het/hom" className="w-full px-2 py-1 rounded border border-line bg-surface text-sm" /></div>
            <button onClick={addManualVariant} className="py-1.5 px-3 rounded-lg bg-indigo text-white font-semibold text-xs">수기 변이 등록</button>
          </div>
        </div>
      </section>

      {/* 유전체 오더 문서 첨부(수탁 PDF 결과지 원본 보존·열람) */}
      {genomicOrderId && loaded && <AttachmentPanel genomicOrderId={genomicOrderId} />}

      {loaded && (
        <section className="card">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-xs text-ink-2">분류 필터</span>
            <select aria-label="분류 필터" value={filter} onChange={(e) => setFilter(e.target.value)} className="px-2 py-1 rounded-lg border border-line bg-bg text-xs">
              <option value="">전체</option>
              {ACMG.map((c) => <option key={c}>{c}</option>)}
              <option value="미해석">미해석</option>
            </select>
            <span className="text-xs text-ink-3">{variants.length}건 중 필터</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-ink-2 border-b border-line">
                  <th className="py-2">유전자</th>
                  <th>변이</th>
                  <th>VAF</th>
                  <th>해석 이력</th>
                  <th>큐레이션</th>
                </tr>
              </thead>
              <tbody>
                {variants.filter((v) => {
                  if (!filter) return true;
                  const cur = v.interpretations.find((i) => i.status === 'FINAL' || i.status === 'DRAFT');
                  if (filter === '미해석') return v.interpretations.length === 0;
                  return cur?.classification === filter;
                }).map((v) => {
                  const current = v.interpretations.find((i) => i.status === 'FINAL' || i.status === 'DRAFT');
                  return (
                    <tr key={v.variantId} className="border-b border-line last:border-0 align-top">
                      <td className="py-2 font-bold">{v.gene}</td>
                      <td className="mono text-xs">
                        {v.chrom ? `${v.chrom}:${v.pos}` : (v.hgvsC ?? '')} {v.hgvsP && `(${v.hgvsP})`}
                        {(v.refAllele || v.altAllele) && <span className="block text-ink-3">{v.refAllele ?? '?'}&gt;{v.altAllele ?? '?'}</span>}
                        {v.zygosity && <span className="block not-mono text-[11px] text-ink-3">{v.zygosity}</span>}
                      </td>
                      <td className="mono text-xs">{v.vaf != null ? v.vaf : '—'}</td>
                      <td>
                        <div className="flex flex-col gap-0.5">
                          {v.interpretations.length === 0 && <span className="text-xs text-ink-3">미해석</span>}
                          {v.interpretations.map((i) => (
                            <span key={i.interpId} className="flex flex-col text-xs">
                              <span className="flex items-center gap-1">
                                <span className={`px-1.5 rounded ${statusBadge[i.status ?? ''] ?? ''}`}>{i.status}</span>
                                <span className={`font-bold ${classColor(i.classification)}`}>{i.classification}</span>
                                {(i.classifiedDate || i.classifier) && <span className="text-ink-3">{i.classifiedDate ?? ''}{i.classifier ? ` · ${i.classifier}` : ''}</span>}
                              </span>
                              {i.reason && <span className="text-ink-3 pl-1" title={i.reason}>사유: {i.reason.length > 40 ? `${i.reason.slice(0, 40)}…` : i.reason}</span>}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td>
                        <div className="flex flex-col gap-1">
                          <div className="flex gap-1 items-center">
                            <select aria-label="변이 분류" value={cls[v.variantId] ?? current?.classification ?? 'VUS'} onChange={(e) => setCls({ ...cls, [v.variantId]: e.target.value })}
                              className="text-xs px-1.5 py-1 rounded border border-line bg-bg">
                              {ACMG.map((c) => <option key={c}>{c}</option>)}
                            </select>
                            {current?.status === 'FINAL'
                              ? <button onClick={() => reclassify(v)} className="py-1 px-2 rounded border border-line text-ink-2 text-xs font-semibold transition-colors duration-150 hover:border-teal hover:text-teal">재분류</button>
                              : <>
                                  <button onClick={() => saveDraft(v, current)} className="py-1 px-2 rounded border border-line text-xs font-semibold">초안</button>
                                  {current?.status === 'DRAFT' && <button onClick={() => finalizeDraft(v)} className="py-1 px-2 rounded bg-indigo text-white text-xs font-semibold">확정</button>}
                                </>}
                            <button onClick={() => toggleAcmg(v.variantId)} title="ACMG 근거로 분류 제안" className={`py-1 px-2 rounded border text-xs font-semibold ${acmgOpen === v.variantId ? 'bg-teal/10 border-teal/40 text-teal' : 'border-line'}`}>ACMG</button>
                            <button onClick={() => runAiInterpret(v, current)} title="AI 해석 초안(로컬 지식기반·전문가 검토 필수)" className={`py-1 px-2 rounded border text-xs font-semibold ${aiFor === v.variantId ? 'bg-indigo/10 border-indigo/40 text-indigo' : 'border-line hover:border-indigo hover:text-indigo'}`}>AI 해석</button>
                            <button onClick={() => loadEvidenceCtx(v)} title="근거 종합(유전자 지식·인용 근거·이전 해석 통합)" className={`py-1 px-2 rounded border text-xs font-semibold ${ecFor === v.variantId ? 'bg-teal/10 border-teal/40 text-teal' : 'border-line hover:border-teal hover:text-teal'}`}>근거 종합</button>
                          </div>
                          <input aria-label="해석 근거" value={ev[v.variantId] ?? current?.evidence ?? ''} onChange={(e) => setEv({ ...ev, [v.variantId]: e.target.value })}
                            placeholder="근거(ACMG 기준)" className="text-xs px-1.5 py-1 rounded border border-line bg-bg w-full" />
                          {acmgOpen === v.variantId && (
                            <div className="mt-1 p-2 rounded-lg border border-line bg-bg">
                              <div className="text-[11px] text-ink-2 mb-1">ACMG 근거 개수 입력 → 분류 제안(참고값)</div>
                              <div className="grid grid-cols-4 gap-1 mb-1.5">
                                {ACMG_EV.map((f) => (
                                  <label key={f.key} className="flex flex-col text-[11px] text-ink-2">
                                    <span className={f.tone === 'crit' ? 'text-crit' : f.tone === 'warn' ? 'text-warn' : 'text-ink-3'}>{f.label}</span>
                                    <input type="number" aria-label={f.label} min={0} value={acmgEv[f.key] ?? 0} onChange={(e) => setAcmgEv({ ...acmgEv, [f.key]: Math.max(0, Number(e.target.value) || 0) })}
                                      className="mono w-full px-1 py-0.5 rounded border border-line bg-surface text-xs" />
                                  </label>
                                ))}
                              </div>
                              <div className="flex items-center gap-2">
                                <button onClick={runAcmgSuggest} className="py-1 px-2 rounded bg-teal text-white text-xs font-semibold">제안</button>
                                {acmgSug && (
                                  <>
                                    <span className={`text-xs font-bold ${classColor(acmgSug)}`}>→ {acmgSug}</span>
                                    <button onClick={() => {
                                      const summary = ACMG_EV.filter((f) => (acmgEv[f.key] ?? 0) > 0).map((f) => `${f.label}×${acmgEv[f.key]}`).join(', ');
                                      const prior = ev[v.variantId] ?? current?.evidence ?? '';
                                      const note = `${summary ? summary + ' → ' : ''}${acmgSug} (ACMG 제안)`;
                                      setCls({ ...cls, [v.variantId]: acmgSug });
                                      setEv({ ...ev, [v.variantId]: prior.trim() ? `${prior.trim()} · ${note}` : note });
                                      setAcmgOpen(null);
                                    }} className="py-1 px-2 rounded border border-teal/40 text-teal text-xs font-semibold">적용</button>
                                  </>
                                )}
                              </div>
                            </div>
                          )}
                          {aiFor === v.variantId && (
                            <div className="mt-1 p-2 rounded-lg border border-indigo/30 bg-indigo/[0.03]">
                              <div className="flex items-center gap-2 mb-1">
                                <span className="text-[11px] font-bold text-indigo">AI 해석 초안</span>
                                <span className="text-[11px] text-ink-3">로컬 지식기반 · 데이터 외부 미전송</span>
                              </div>
                              {aiBusy ? <p className="text-[11px] text-ink-3">해석 생성 중…</p> : aiRes && (
                                <div className="flex flex-col gap-1 text-[11px]">
                                  <div>
                                    제안 분류 <span className={`font-bold ${classColor(aiRes.suggestedClassification)}`}>{aiRes.suggestedClassification}</span>
                                    <span className="text-ink-3"> · 신뢰도 {aiRes.confidence === 'high' ? '높음' : aiRes.confidence === 'moderate' ? '보통' : '낮음'}</span>
                                  </div>
                                  {aiRes.geneContext && <div className="text-ink-2"><b>{aiRes.geneContext.gene}</b>: {aiRes.geneContext.role} — {aiRes.geneContext.conditions}{aiRes.geneContext.actionable && <span className="text-teal"> · 표적치료 관련</span>}</div>}
                                  {aiRes.citedEvidence && (
                                    <div className="text-[11px] px-1.5 py-1 rounded bg-teal/[0.06] border border-teal/20">
                                      <span className="font-semibold text-teal">근거 인용</span>{' '}
                                      {aiRes.citedEvidence.source ?? 'DB'}: {aiRes.citedEvidence.significance}
                                      {aiRes.citedEvidence.stars != null && aiRes.citedEvidence.stars !== '' && <span> ({'★'.repeat(Math.max(0, Math.min(4, Number(aiRes.citedEvidence.stars))))}{'☆'.repeat(4 - Math.max(0, Math.min(4, Number(aiRes.citedEvidence.stars))))})</span>}
                                      {aiRes.citedEvidence.gnomadAf != null && aiRes.citedEvidence.gnomadAf !== '' && <span className="text-ink-2"> · gnomAD {(Number(aiRes.citedEvidence.gnomadAf) * 100).toPrecision(3)}%</span>}
                                      {aiRes.citedEvidence.oncokbLevel && <span className="text-ink-2"> · OncoKB {aiRes.citedEvidence.oncokbLevel}</span>}
                                      {aiRes.citedEvidence.citation && <span className="mono text-ink-3"> · {aiRes.citedEvidence.citation}</span>}
                                      {aiRes.citedEvidence.catalogVersion && <span className="text-ink-3"> · 반입본 {aiRes.citedEvidence.catalogVersion}</span>}
                                    </div>
                                  )}
                                  <div className="text-ink-2">{aiRes.clinicalSignificance}</div>
                                  {aiRes.therapyImplications.length > 0 && (
                                    <div className="text-teal">표적치료 시사점: {aiRes.therapyImplications.join('; ')}</div>
                                  )}
                                  {aiRes.rationale.length > 0 && (
                                    <details><summary className="text-ink-3 cursor-pointer">근거 {aiRes.rationale.length}</summary>
                                      <ul className="list-disc ml-4 text-ink-2">{aiRes.rationale.map((r, i) => <li key={i}>{r}</li>)}</ul>
                                    </details>
                                  )}
                                  {aiRes.caveats.length > 0 && (
                                    <div className="text-warn"><IconWarn className="mr-1" />{aiRes.caveats.join(' ')}</div>
                                  )}
                                  <div className="text-[11px] text-crit mt-0.5">{aiRes.disclaimer}</div>
                                  <div className="flex gap-1.5 mt-1">
                                    <button onClick={() => {
                                      if (aiRes.suggestedClassification && ACMG.includes(aiRes.suggestedClassification)) setCls({ ...cls, [v.variantId]: aiRes.suggestedClassification });
                                      const prior = ev[v.variantId] ?? current?.evidence ?? '';
                                      const draft = aiRes.draftNarrative;
                                      setEv({ ...ev, [v.variantId]: prior.trim() ? `${prior.trim()}\n${draft}` : draft });
                                      setAiFor(null); setAiRes(null);
                                    }} className="py-1 px-2 rounded border border-indigo/40 text-indigo text-xs font-semibold">초안 적용(검토 후 확정)</button>
                                    <button onClick={() => { setAiFor(null); setAiRes(null); }} className="py-1 px-2 rounded border border-line text-ink-3 text-xs">닫기</button>
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                          {ecFor === v.variantId && (
                            <div className="mt-1 p-2 rounded-lg border border-teal/30 bg-teal/[0.03]">
                              <div className="flex items-center gap-2 mb-1">
                                <span className="text-[11px] font-bold text-teal">근거 종합</span>
                                <span className="text-[11px] text-ink-3">판독 검토용 · 향후 원내 LLM(RAG) 컨텍스트 · 외부 미전송</span>
                                <button onClick={() => { setEcFor(null); setEcRes(null); }} className="ml-auto text-[11px] text-ink-3 hover:text-ink-2">닫기</button>
                              </div>
                              {!ecRes ? <p className="text-[11px] text-ink-3">불러오는 중…</p> : (
                                <div className="flex flex-col gap-1 text-[11px]">
                                  <div className="flex gap-1 flex-wrap">{ecRes.sources.length ? ecRes.sources.map((sx, i) => <span key={i} className="px-1.5 py-0.5 rounded bg-teal/10 text-teal text-[11px] font-semibold">{sx}</span>) : <span className="text-ink-3">등록된 인용 근거 없음</span>}</div>
                                  {ecRes.geneKnowledge && <div className="text-ink-2"><b className="italic">{ecRes.variant.gene}</b>: {ecRes.geneKnowledge.role} — {ecRes.geneKnowledge.conditions}{ecRes.geneKnowledge.somaticTherapy && <span className="text-teal"> · 표적: {ecRes.geneKnowledge.somaticTherapy}</span>}</div>}
                                  {ecRes.citedEvidence && <div className="text-ink-2">인용: {ecRes.citedEvidence.source ?? 'DB'} {ecRes.citedEvidence.significance}{ecRes.citedEvidence.stars != null && ecRes.citedEvidence.stars !== '' ? ` ${ecRes.citedEvidence.stars}★` : ''}{ecRes.citedEvidence.citation ? ` · ${ecRes.citedEvidence.citation}` : ''}{ecRes.citedEvidence.catalogVersion ? ` · ${ecRes.citedEvidence.catalogVersion}` : ''}</div>}
                                  {ecRes.priorInterpretations.length > 0 && (
                                    <div className="text-ink-3">이전 해석 {ecRes.priorInterpretations.length}: {ecRes.priorInterpretations.slice(0, 3).map((pi) => `${pi.classifiedDate ?? '?'} ${pi.status ?? ''} ${pi.classification ?? ''}`).join(' / ')}</div>
                                  )}
                                  <details><summary className="text-ink-3 cursor-pointer text-[11px]">RAG 컨텍스트 미리보기(모델에 넘길 문맥)</summary>
                                    <pre className="mono text-[11px] text-ink-2 whitespace-pre-wrap bg-bg rounded p-1.5 mt-1 max-h-48 overflow-auto">{ecRes.promptContext}</pre>
                                  </details>
                                  <div className="text-[11px] text-ink-3">{ecRes.llmNote}</div>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {variants.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-3 text-ink-2">
                      변이 없음
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
