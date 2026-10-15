'use client';

/**
 * 마스터 관리 화면 (`/master`).
 *
 * 사이드바 노출 역할: TEC, ADM, AUD.
 * ⚠ 노출 역할과 화면이 호출하는 API 권한이 어긋나면 전부 403인 죽은 화면이 된다 —
 *   역할을 바꿀 때는 `Sidebar.tsx`(정본)와 API 권한 매트릭스를 함께 본다.
 * 데이터는 `lib/api.ts`의 `apiFetch`로만 가져온다(HTTP 호출 정본).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, getToken, getRoles } from '@/lib/api';
import { Loading, ErrorText } from '@/components/ui';
import { useToast } from '@/components/toast';
import { csvToObjects } from '@/lib/csv';
import { Term } from '@/components/Explain';
import { IconChevron } from '@/components/Icon';

interface TestMaster { testCode: string; name: string; loinc: string | null; domain: string; unitUcum: string | null; status: string; autoVerify?: boolean | null; deltaPctLimit?: number | null; deltaAbsLimit?: number | null; deltaWindowDays?: number | null; }
interface RefRange { rrId: string; sex: string; ageMin: number; ageMax: number; low: number | null; high: number | null; panicLow: number | null; panicHigh: number | null; }
interface CodeMap { lisCode: string; hisCode: string | null; loinc: string | null; }
interface QcTarget { qcTargetId: string; qcCode: string; instrument: string; testCode: string; mean: number; sd: number; }
interface InstMap { id: string; instrument: string; rawCode: string; testCode: string; }
interface Panel { panelCode: string; name: string; items: { testCode: string }[]; }

const DOMAINS = ['DIAGNOSTIC', 'MICROBIOLOGY', 'PATHOLOGY', 'TRANSFUSION', 'GENOMIC'];

export default function MasterPage() {
  const router = useRouter();
  const toast = useToast();
  // 마스터 편집(쓰기)은 ADM만(F-MST:W). TEC/AUD는 읽기 전용 — 쓰기 컨트롤 숨김(403 죽은버튼 방지).
  const [canWrite, setCanWrite] = useState(false);
  const [tests, setTests] = useState<TestMaster[]>([]);
  const [loading, setLoading] = useState(true);
  const [domain, setDomain] = useState('DIAGNOSTIC');
  const [sel, setSel] = useState<string | null>(null);
  const [ranges, setRanges] = useState<RefRange[]>([]);
  const [err, setErr] = useState('');
  const [nt, setNt] = useState({ testCode: '', name: '', loinc: '', unitUcum: '' });
  const [nr, setNr] = useState({ low: '', high: '', panicLow: '', panicHigh: '', sex: 'A', ageMin: '', ageMax: '' });
  const [editRR, setEditRR] = useState<{ rrId: string; sex: string; ageMin: string; ageMax: string; low: string; high: string; panicLow: string; panicHigh: string } | null>(null);
  const [editT, setEditT] = useState<{ name: string; unitUcum: string; loinc: string; status: string } | null>(null);
  // 자동검증·델타 정책(검사실 서명 대상) — 이전엔 seed 수정+재배포로만 바꿀 수 있었다
  const [editP, setEditP] = useState<{ autoVerify: boolean; deltaPctLimit: string; deltaAbsLimit: string; deltaWindowDays: string } | null>(null);
  const [tq, setTq] = useState(''); // 검사항목 검색(D5)
  // 코드매핑·QC목표·장비매핑
  const [cms, setCms] = useState<CodeMap[]>([]);
  const [cmBulk, setCmBulk] = useState('');
  const [cmBulkOpen, setCmBulkOpen] = useState(false);
  const [cmBulkResult, setCmBulkResult] = useState<{ dryRun?: boolean; total: number; imported: number; updated: number; unchanged?: number; changes?: { row: number; lisCode: string; field: string; before: string | null; after: string }[]; errors: { row: number; lisCode: string; error: string }[] } | null>(null);
  const [riBulk, setRiBulk] = useState('');
  const [riCreateTests, setRiCreateTests] = useState(true);
  const [riResult, setRiResult] = useState<{ total: number; testsCreated: number; mappings: number; panels: number; panelItems: number; errors: { row: number; testCode: string; error: string }[] } | null>(null);
  const [qts, setQts] = useState<QcTarget[]>([]);
  const [ims, setIms] = useState<InstMap[]>([]);
  const [ncm, setNcm] = useState({ lisCode: '', hisCode: '' });
  const [nqt, setNqt] = useState({ qcCode: '', instrument: '', testCode: '', mean: '', sd: '' });
  const [nim, setNim] = useState({ instrument: '', rawCode: '', testCode: '' });
  const [panels, setPanels] = useState<Panel[]>([]);
  const [np, setNp] = useState({ panelCode: '', name: '', testCodes: '' });

  const loadExtra = useCallback(async () => {
    apiFetch<CodeMap[]>('/api/v1/master/code-mappings').then(setCms).catch(() => {});
    apiFetch<QcTarget[]>('/api/v1/master/qc-targets').then(setQts).catch(() => {});
    apiFetch<InstMap[]>('/api/v1/instruments/mappings').then(setIms).catch(() => {});
    apiFetch<Panel[]>('/api/v1/master/panels').then(setPanels).catch(() => {});
  }, []);

  async function addPanel(e: React.FormEvent) {
    e.preventDefault();
    const testCodes = np.testCodes.split(',').map((s) => s.trim()).filter(Boolean);
    try { await apiFetch('/api/v1/master/panels', { method: 'PUT', body: JSON.stringify({ panelCode: np.panelCode, name: np.name, testCodes }) }); toast('패널 저장'); setNp({ panelCode: '', name: '', testCodes: '' }); loadExtra(); }
    catch (e) { toast(e instanceof Error ? e.message : '실패', 'error'); }
  }

  const loadTests = useCallback(async () => {
    setErr('');
    setLoading(true);
    try { setTests(await apiFetch<TestMaster[]>(`/api/v1/master/tests?domain=${domain}`)); }
    catch (e) { setErr(e instanceof Error ? e.message : '조회 실패'); }
    finally { setLoading(false); }
  }, [domain]);

  useEffect(() => { if (!getToken()) { router.push('/'); return; } setCanWrite(getRoles().includes('ADM')); loadTests(); loadExtra(); }, [router, loadTests, loadExtra]);

  /**
   * EDI 코드매핑 CSV 대량 반입 — 헤더: lisCode,hisCode,loinc,ediCode,status
   * dryRun이면 아무것도 쓰지 않고 차이(before→after)만 보여준다 — 심평원 실 수가코드 반입은
   * 청구 산정에 직결되므로 기존 매핑을 조용히 덮기 전에 눈으로 확인한다.
   */
  async function bulkImportCm(dryRun = false) {
    setCmBulkResult(null);
    const rows = csvToObjects(cmBulk).map((o) => ({ lisCode: o.lisCode ?? o.LIS ?? o.liscode, hisCode: o.hisCode ?? o.HIS ?? o.hiscode, loinc: o.loinc ?? o.LOINC, ediCode: o.ediCode ?? o.EDI ?? o.edicode, status: o.status }));
    if (rows.length === 0) { toast('CSV 데이터가 없습니다(헤더+행 필요)', 'info'); return; }
    try {
      const r = await apiFetch<typeof cmBulkResult>(`/api/v1/master/code-mappings/bulk${dryRun ? '?dryRun=1' : ''}`, { method: 'POST', body: JSON.stringify({ rows }) });
      setCmBulkResult(r);
      toast(`${dryRun ? '차이 확인(미적용)' : '반입 완료'} · 신규 ${r!.imported}·갱신 ${r!.updated}·무변경 ${r!.unchanged ?? 0}·오류 ${r!.errors.length}`, r!.errors.length ? 'info' : 'success');
      if (!dryRun) loadExtra();
    } catch (e) { toast(e instanceof Error ? e.message : '반입 실패', 'error'); }
  }

  /** 실 수가코드 적재 후 미청구 항목의 EDI코드 스냅샷 현행화(D5). 전송 완료분은 근거라 그대로 둔다. */
  async function resyncBillingEdi() {
    try {
      const r = await apiFetch<{ scanned: number; updated: number; stillUnmapped: number }>('/api/v1/master/billing-edi/resync', { method: 'POST', body: '{}' });
      toast(`미청구 ${r.scanned}건 검사 · ${r.updated}건 EDI코드 갱신${r.stillUnmapped ? ` · 미매핑 ${r.stillUnmapped}건 남음` : ''}`, r.stillUnmapped ? 'info' : 'success');
    } catch (e) { toast(e instanceof Error ? e.message : '재동기화 실패', 'error'); }
  }

  // 결과항목 EDI 반입 — 헤더: ediCode,testCode,name,loinc,specimenType,panelName (동일 ediCode=패널)
  async function bulkImportRi() {
    setRiResult(null);
    const rows = csvToObjects(riBulk).map((o) => ({ ediCode: o.ediCode ?? o.edi_code ?? o.EDI, testCode: o.testCode ?? o.test_code ?? o.LIS, name: o.name ?? o.검사명, loinc: o.loinc ?? o.LOINC, specimenType: o.specimenType ?? o.specimen_type ?? o.검체, panelName: o.panelName ?? o.panel_name ?? o.패널명 }));
    if (rows.length === 0) { toast('CSV 데이터가 없습니다(헤더+행 필요)', 'info'); return; }
    try {
      const r = await apiFetch<typeof riResult>('/api/v1/master/result-items/bulk', { method: 'POST', body: JSON.stringify({ rows, createTests: riCreateTests }) });
      setRiResult(r); toast(`반입 · 검사 ${r!.testsCreated}·매핑 ${r!.mappings}·패널 ${r!.panels}(${r!.panelItems}항목)·오류 ${r!.errors.length}`, r!.errors.length ? 'info' : 'success');
      loadExtra(); loadTests();
    } catch (e) { toast(e instanceof Error ? e.message : '반입 실패', 'error'); }
  }

  async function addCm(e: React.FormEvent) {
    e.preventDefault();
    try { await apiFetch(`/api/v1/master/code-mappings/${ncm.lisCode}`, { method: 'PUT', body: JSON.stringify({ hisCode: ncm.hisCode }) }); toast('코드매핑 저장'); setNcm({ lisCode: '', hisCode: '' }); loadExtra(); }
    catch (e) { toast(e instanceof Error ? e.message : '실패', 'error'); }
  }
  async function addQt(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiFetch('/api/v1/master/qc-materials', { method: 'PUT', body: JSON.stringify({ qcCode: nqt.qcCode }) });
      await apiFetch('/api/v1/master/qc-targets', { method: 'PUT', body: JSON.stringify({ ...nqt, mean: Number(nqt.mean), sd: Number(nqt.sd) }) });
      toast('QC목표 저장'); setNqt({ qcCode: '', instrument: '', testCode: '', mean: '', sd: '' }); loadExtra();
    } catch (e) { toast(e instanceof Error ? e.message : '실패', 'error'); }
  }
  async function addIm(e: React.FormEvent) {
    e.preventDefault();
    try { await apiFetch('/api/v1/instruments/mappings', { method: 'PUT', body: JSON.stringify(nim) }); toast('장비매핑 저장'); setNim({ instrument: '', rawCode: '', testCode: '' }); loadExtra(); }
    catch (e) { toast(e instanceof Error ? e.message : '실패', 'error'); }
  }

  async function selectTest(code: string) {
    setSel(code);
    const t = tests.find((x) => x.testCode === code);
    setEditT(t ? { name: t.name, unitUcum: t.unitUcum ?? '', loinc: t.loinc ?? '', status: t.status } : null);
    setEditP(t ? {
      autoVerify: t.autoVerify !== false,
      deltaPctLimit: t.deltaPctLimit != null ? String(t.deltaPctLimit) : '',
      deltaAbsLimit: t.deltaAbsLimit != null ? String(t.deltaAbsLimit) : '',
      deltaWindowDays: t.deltaWindowDays != null ? String(t.deltaWindowDays) : '',
    } : null);
    setRanges(await apiFetch<RefRange[]>(`/api/v1/master/tests/${code}/reference-ranges`));
  }

  // D1: 검사항목 수정(명칭·단위·LOINC·USE/STOP)
  async function updateTest() {
    if (!sel || !editT) return; setErr('');
    try {
      // 빈 값은 null로 보내 실제로 지울 수 있게 한다(undefined면 PATCH에서 빠져 옛 값이 남는다)
      await apiFetch(`/api/v1/master/tests/${sel}`, { method: 'PATCH', body: JSON.stringify({ name: editT.name, unitUcum: editT.unitUcum.trim() || null, loinc: editT.loinc.trim() || null, status: editT.status }) });
      toast('검사항목 수정됨'); await loadTests();
    } catch (e) { toast(e instanceof Error ? e.message : '수정 실패', 'error'); }
  }

  /**
   * 자동검증·델타 정책 저장.
   * API는 처음부터 이 값들을 받았는데 화면이 없어서, 검사실이 값을 정해줘도 seed를 고쳐
   * 재배포해야 반영됐다(전사 과정에서 조용히 틀릴 수 있는 경로). 여기서 직접 넣는다.
   */
  async function updatePolicy() {
    if (!sel || !editP) return; setErr('');
    const num = (v: string) => (v.trim() === '' ? null : Number(v));
    // 숫자가 아닌 입력(예: "50%","1,000")은 NaN→JSON에서 null이 되어 조용히 기본값으로 리셋된다. 막는다.
    for (const [label, v] of [['델타 백분율', editP.deltaPctLimit], ['델타 절대값', editP.deltaAbsLimit], ['델타 기간', editP.deltaWindowDays]] as const) {
      if (v.trim() !== '' && Number.isNaN(Number(v))) { toast(`${label}에 숫자만 입력하세요`, 'error'); return; }
    }
    try {
      await apiFetch(`/api/v1/master/tests/${sel}`, {
        method: 'PATCH',
        body: JSON.stringify({
          // 비우면 null — "기본값으로 되돌린다"가 가능해야 한다(undefined면 지울 방법이 없다)
          autoVerify: editP.autoVerify,
          deltaPctLimit: num(editP.deltaPctLimit),
          deltaAbsLimit: num(editP.deltaAbsLimit),
          deltaWindowDays: num(editP.deltaWindowDays),
        }),
      });
      toast('자동검증·델타 정책 저장됨'); await loadTests();
    } catch (e) { toast(e instanceof Error ? e.message : '저장 실패', 'error'); }
  }

  // D1: 참고치 삭제(잘못된 값 정리)
  async function deleteRange(rrId: string) {
    if (!sel) return; setErr('');
    if (!confirm('참고치를 삭제하면 이 검사의 정상/위험 플래그 판정에 영향이 있습니다(마지막 참고치면 플래그가 사라짐). 삭제할까요?')) return;
    try { await apiFetch(`/api/v1/master/reference-ranges/${rrId}`, { method: 'DELETE' }); toast('참고치 삭제됨'); selectTest(sel); }
    catch (e) { toast(e instanceof Error ? e.message : '삭제 실패', 'error'); }
  }

  // D1: 참고치 인라인 수정(삭제·재생성 대신 제자리 정정 — PATCH)
  async function saveRange() {
    if (!sel || !editRR) return; setErr('');
    const num = (v: string) => (v === '' ? undefined : Number(v));
    try {
      await apiFetch(`/api/v1/master/reference-ranges/${editRR.rrId}`, { method: 'PATCH', body: JSON.stringify({ testCode: sel, sex: editRR.sex, ageMin: num(editRR.ageMin), ageMax: num(editRR.ageMax), low: num(editRR.low), high: num(editRR.high), panicLow: num(editRR.panicLow), panicHigh: num(editRR.panicHigh) }) });
      toast('참고치 수정됨'); setEditRR(null); selectTest(sel);
    } catch (e) { toast(e instanceof Error ? e.message : '수정 실패', 'error'); }
  }

  async function addTest(e: React.FormEvent) {
    e.preventDefault(); setErr('');
    try {
      await apiFetch('/api/v1/master/tests', { method: 'POST', body: JSON.stringify({ ...nt, domain, loinc: nt.loinc || undefined, unitUcum: nt.unitUcum || undefined }) });
      setNt({ testCode: '', name: '', loinc: '', unitUcum: '' }); loadTests();
    } catch (e) { setErr(e instanceof Error ? e.message : '등록 실패'); }
  }

  // 파생(계산)검사 마스터 시딩 — eGFR·LDL·anion gap·보정칼슘 등 자동산출 검사 등록
  async function seedDerived() {
    setErr('');
    try {
      const r = await apiFetch<{ seeded?: number }>('/api/v1/master/seed-derived-tests', { method: 'POST', body: '{}' });
      toast(`파생검사 시딩 완료${r.seeded != null ? ` · ${r.seeded}건` : ''}`, 'success'); loadTests();
    } catch (e) { toast(e instanceof Error ? e.message : '시딩 실패', 'error'); }
  }

  async function addRange(e: React.FormEvent) {
    e.preventDefault(); if (!sel) return; setErr('');
    const num = (v: string) => (v === '' ? undefined : Number(v));
    try {
      await apiFetch('/api/v1/master/reference-ranges', { method: 'POST', body: JSON.stringify({ testCode: sel, sex: nr.sex, low: num(nr.low), high: num(nr.high), panicLow: num(nr.panicLow), panicHigh: num(nr.panicHigh), ageMin: num(nr.ageMin), ageMax: num(nr.ageMax) }) });
      setNr({ low: '', high: '', panicLow: '', panicHigh: '', sex: 'A', ageMin: '', ageMax: '' }); selectTest(sel);
    } catch (e) { setErr(e instanceof Error ? e.message : '등록 실패'); }
  }

  const inp = 'px-2 py-1.5 rounded-lg border border-line bg-bg text-sm';

  return (
    <main className="page">
      <h1 className="t-page mb-4">마스터 관리</h1>
      {!canWrite && <p className="mb-4 rounded-xl border border-warn/40 bg-warn/[0.06] px-3 py-2 text-sm text-warn">읽기 전용 — 마스터 편집·반입은 관리자(ADM)만 가능합니다.</p>}
      {err && <ErrorText message={err} />}

      <div className="grid md:grid-cols-2 gap-4">
        {/* 검사항목 */}
        <section className="card">
          <div className="flex items-center justify-between mb-3 gap-2">
            <h2 className="t-section">검사항목</h2>
            <div className="flex items-center gap-2">
              {canWrite && <button onClick={seedDerived} title="eGFR·LDL 등 계산검사 마스터 등록" className="text-xs py-1 px-2 rounded-lg border border-line text-ink-2 hover:border-teal">파생검사 시딩</button>}
              <select aria-label="검사 분야" value={domain} onChange={(e) => setDomain(e.target.value)} className={`${inp} mono text-xs`}>
                {DOMAINS.map((d) => <option key={d}>{d}</option>)}
              </select>
            </div>
          </div>
          <input aria-label="검사항목 검색" value={tq} onChange={(e) => setTq(e.target.value)} placeholder="코드·명칭 검색" className={`${inp} w-full mb-2`} />
          {loading && tests.length === 0 ? <Loading /> : (
          <div className="overflow-x-auto max-h-72 overflow-y-auto mb-3">
            <table className="w-full text-sm">
              <tbody>
                {tests.filter((t) => { const s = tq.trim().toLowerCase(); return !s || t.testCode.toLowerCase().includes(s) || t.name.toLowerCase().includes(s); }).map((t) => (
                  <tr key={t.testCode} onClick={() => selectTest(t.testCode)}
                    className={`cursor-pointer border-b border-line last:border-0 ${sel === t.testCode ? 'bg-teal/10' : 'hover:bg-bg'} ${t.status === 'STOP' ? 'opacity-50' : ''}`}>
                    <td className="py-1.5 mono text-xs">{t.testCode}</td>
                    <td>{t.name}{t.status === 'STOP' && <span className="ml-1 text-[11px] text-ink-3">(중지)</span>}</td>
                    <td className="mono text-xs text-ink-3">{t.unitUcum ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}

          {/* D1 선택 항목 수정 */}
          {canWrite && sel && editT && (
            <div className="border-t border-line pt-3 mb-3 flex flex-wrap gap-2 items-center">
              <span className="mono text-xs text-ink-2">{sel} 수정</span>
              <input aria-label="명칭 수정" value={editT.name} onChange={(e) => setEditT({ ...editT, name: e.target.value })} className={`${inp} w-28`} />
              <input aria-label="단위 수정" value={editT.unitUcum} onChange={(e) => setEditT({ ...editT, unitUcum: e.target.value })} placeholder="단위" className={`${inp} w-16`} />
              <input aria-label="LOINC 수정" value={editT.loinc} onChange={(e) => setEditT({ ...editT, loinc: e.target.value })} placeholder="LOINC" className={`${inp} mono w-24`} />
              <select aria-label="상태" value={editT.status} onChange={(e) => setEditT({ ...editT, status: e.target.value })} className={`${inp} w-20`}><option value="USE">사용</option><option value="STOP">중지</option></select>
              <button onClick={updateTest} className="py-1.5 px-3 rounded-lg bg-indigo text-white font-semibold text-xs">저장</button>
            </div>
          )}

          {/* 자동검증·델타 정책 — 검사실 서명 대상 값. 결과가 사람 검토 없이 나갈지를 가른다. */}
          {canWrite && sel && editP && (
            <div className="border-t border-line pt-3 mb-3">
              <div className="flex items-baseline gap-2 mb-1.5">
                <span className="t-meta font-semibold">결과 판정 정책</span>
                <span className="t-micro text-ink-3">이 값이 결과를 사람이 볼지 그냥 나갈지 정합니다</span>
              </div>
              <div className="flex flex-wrap gap-2 items-center">
                <label className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" checked={editP.autoVerify} onChange={(e) => setEditP({ ...editP, autoVerify: e.target.checked })} />
                  <Term k="auto-verify" label="자동확정 허용" />
                </label>
                <span className="t-micro text-ink-3">|</span>
                <Term k="delta-check" label={<span className="t-meta">델타</span>} />
                <input aria-label="델타 백분율 한계(%)" inputMode="decimal" value={editP.deltaPctLimit} onChange={(e) => setEditP({ ...editP, deltaPctLimit: e.target.value })} placeholder="% (미입력 50)" className={`${inp} w-28`} />
                <input aria-label="델타 절대값 한계" inputMode="decimal" value={editP.deltaAbsLimit} onChange={(e) => setEditP({ ...editP, deltaAbsLimit: e.target.value })} placeholder="절대값" className={`${inp} w-24`} />
                <input aria-label="델타 비교 기간(일)" inputMode="numeric" value={editP.deltaWindowDays} onChange={(e) => setEditP({ ...editP, deltaWindowDays: e.target.value })} placeholder="기간(일)" className={`${inp} w-24`} />
                <button onClick={updatePolicy} className="py-1.5 px-3 rounded-lg bg-indigo text-white font-semibold text-xs">정책 저장</button>
              </div>
              <p className="t-micro text-ink-3 mt-1.5">
                자동확정을 끄면 이 검사는 <b>항상 사람이 검증</b>합니다. 델타는 같은 환자 직전 결과 대비 변화가 한계를 넘으면 자동확정을 막습니다(백분율·절대값 중 하나만 넘어도 보류).
                한계를 <b>너무 좁게</b> 잡으면 정상 결과까지 전부 보류로 쌓이고, <b>너무 넓게</b> 잡으면 검체 뒤바뀜을 놓칩니다.
              </p>
            </div>
          )}
          {canWrite && (
          <form onSubmit={addTest} className="flex flex-wrap gap-2 items-center border-t border-line pt-3">
            <input required aria-label="검사코드" placeholder="코드" value={nt.testCode} onChange={(e) => setNt({ ...nt, testCode: e.target.value })} className={`${inp} mono w-24`} />
            <input required aria-label="명칭" placeholder="명칭" value={nt.name} onChange={(e) => setNt({ ...nt, name: e.target.value })} className={`${inp} w-28`} />
            <input aria-label="LOINC" placeholder="LOINC" value={nt.loinc} onChange={(e) => setNt({ ...nt, loinc: e.target.value })} className={`${inp} mono w-24`} />
            <input aria-label="단위" placeholder="단위" value={nt.unitUcum} onChange={(e) => setNt({ ...nt, unitUcum: e.target.value })} className={`${inp} w-16`} />
            <button className="py-1.5 px-3 rounded-lg bg-teal text-white font-semibold text-xs">추가</button>
          </form>
          )}
        </section>

        {/* 참고치 */}
        <section className="card">
          <h2 className="t-section mb-3">참고치 {sel && <span className="mono text-xs text-ink-2">{sel}</span>}</h2>
          {!sel ? (
            <p className="text-sm text-ink-2 py-6 text-center">좌측에서 검사항목을 선택하세요</p>
          ) : (
            <>
              <div className="overflow-x-auto mb-3">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-xs text-ink-2 border-b border-line"><th className="py-1">성별</th><th>연령</th><th>정상</th><th>위험</th><th></th></tr></thead>
                  <tbody>
                    {ranges.length === 0 ? <tr><td colSpan={5} className="py-3 text-center text-ink-3 text-xs">참고치 없음</td></tr> :
                      ranges.map((r) => (editRR?.rrId === r.rrId ? (
                        <tr key={r.rrId} className="border-b border-line last:border-0 bg-teal/5">
                          <td className="py-1"><select aria-label="성별" value={editRR.sex} onChange={(e) => setEditRR({ ...editRR, sex: e.target.value })} className={`${inp} w-12 text-xs py-1`}><option>A</option><option>M</option><option>F</option></select></td>
                          <td><span className="flex gap-0.5"><input aria-label="연령↓" value={editRR.ageMin} onChange={(e) => setEditRR({ ...editRR, ageMin: e.target.value })} className={`${inp} mono w-10 text-xs py-1`} /><input aria-label="연령↑" value={editRR.ageMax} onChange={(e) => setEditRR({ ...editRR, ageMax: e.target.value })} className={`${inp} mono w-10 text-xs py-1`} /></span></td>
                          <td><span className="flex gap-0.5"><input aria-label="정상↓" value={editRR.low} onChange={(e) => setEditRR({ ...editRR, low: e.target.value })} className={`${inp} mono w-12 text-xs py-1`} /><input aria-label="정상↑" value={editRR.high} onChange={(e) => setEditRR({ ...editRR, high: e.target.value })} className={`${inp} mono w-12 text-xs py-1`} /></span></td>
                          <td><span className="flex gap-0.5"><input aria-label="위험↓" value={editRR.panicLow} onChange={(e) => setEditRR({ ...editRR, panicLow: e.target.value })} className={`${inp} mono w-12 text-xs py-1`} /><input aria-label="위험↑" value={editRR.panicHigh} onChange={(e) => setEditRR({ ...editRR, panicHigh: e.target.value })} className={`${inp} mono w-12 text-xs py-1`} /></span></td>
                          <td className="text-right whitespace-nowrap"><button onClick={saveRange} className="text-xs text-teal font-semibold hover:underline mr-1">저장</button><button onClick={() => setEditRR(null)} className="text-xs text-ink-3 hover:underline">취소</button></td>
                        </tr>
                      ) : (
                        <tr key={r.rrId} className="border-b border-line last:border-0">
                          <td className="py-1.5">{r.sex}</td><td className="mono text-xs">{r.ageMin}–{r.ageMax}</td>
                          <td className="mono text-xs">{r.low ?? '–'} ~ {r.high ?? '–'}</td>
                          <td className="mono text-xs text-crit">{r.panicLow ?? '–'} / {r.panicHigh ?? '–'}</td>
                          <td className="text-right whitespace-nowrap">
                            {canWrite && <>
                            <button onClick={() => setEditRR({ rrId: r.rrId, sex: r.sex, ageMin: String(r.ageMin), ageMax: String(r.ageMax), low: r.low?.toString() ?? '', high: r.high?.toString() ?? '', panicLow: r.panicLow?.toString() ?? '', panicHigh: r.panicHigh?.toString() ?? '' })} aria-label="참고치 수정" className="text-xs text-teal hover:underline mr-1">수정</button>
                            <button onClick={() => deleteRange(r.rrId)} aria-label="참고치 삭제" className="text-xs text-crit hover:underline">삭제</button>
                            </>}
                          </td>
                        </tr>
                      )))}
                  </tbody>
                </table>
              </div>
              {canWrite && (
              <form onSubmit={addRange} className="flex flex-wrap gap-2 items-center border-t border-line pt-3">
                <select aria-label="성별" value={nr.sex} onChange={(e) => setNr({ ...nr, sex: e.target.value })} className={`${inp} w-14`}><option>A</option><option>M</option><option>F</option></select>
                <input aria-label="연령 하한" placeholder="연령↓" value={nr.ageMin} onChange={(e) => setNr({ ...nr, ageMin: e.target.value })} className={`${inp} mono w-14`} />
                <input aria-label="연령 상한" placeholder="연령↑" value={nr.ageMax} onChange={(e) => setNr({ ...nr, ageMax: e.target.value })} className={`${inp} mono w-14`} />
                <input aria-label="정상 하한" placeholder="정상↓" value={nr.low} onChange={(e) => setNr({ ...nr, low: e.target.value })} className={`${inp} mono w-16`} />
                <input aria-label="정상 상한" placeholder="정상↑" value={nr.high} onChange={(e) => setNr({ ...nr, high: e.target.value })} className={`${inp} mono w-16`} />
                <input aria-label="위험 하한" placeholder="위험↓" value={nr.panicLow} onChange={(e) => setNr({ ...nr, panicLow: e.target.value })} className={`${inp} mono w-16`} />
                <input aria-label="위험 상한" placeholder="위험↑" value={nr.panicHigh} onChange={(e) => setNr({ ...nr, panicHigh: e.target.value })} className={`${inp} mono w-16`} />
                <button className="py-1.5 px-3 rounded-lg bg-teal text-white font-semibold text-xs">추가</button>
              </form>
              )}
            </>
          )}
        </section>
      </div>

      {/* 코드매핑 · QC목표 · 장비매핑 */}
      <div className="grid md:grid-cols-3 gap-4 mt-4">
        <section className="card">
          <div className="flex items-center justify-between mb-2">
            <h2 className="t-section text-sm">HIS 코드매핑 <span className="text-xs text-ink-2">({cms.length})</span></h2>
            {canWrite && <button onClick={() => setCmBulkOpen((v) => !v)} aria-expanded={cmBulkOpen} className="text-xs text-teal"><IconChevron open={cmBulkOpen} /> CSV 반입</button>}
          </div>
          {canWrite && cmBulkOpen && (
            <div className="mb-2 rounded-lg border border-line bg-bg p-2">
              <div className="text-[11px] text-ink-3 mb-1">헤더: <span className="mono">lisCode,hisCode,loinc,ediCode,status</span> (EDI 코드 CSV 붙여넣기)</div>
              <textarea value={cmBulk} onChange={(e) => setCmBulk(e.target.value)} rows={4} placeholder={'lisCode,hisCode,loinc,ediCode,status\nCHE-GLU,E6501,1558-6,,USE'} className="w-full mono text-[11px] px-2 py-1 rounded border border-line bg-surface mb-1" />
              <div className="flex items-center gap-2">
                <label className="text-xs text-teal underline cursor-pointer">파일 선택<input type="file" accept=".csv,text/csv,text/plain" className="hidden" aria-label="코드매핑 CSV 파일" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCmBulk(await f.text()); e.target.value = ''; }} /></label>
                <button onClick={() => bulkImportCm(true)} className="py-1 px-2 rounded-lg border border-line text-xs font-semibold" title="아무것도 적용하지 않고 바뀌는 값만 확인(심평원 실 수가코드 반입 전 필수)">차이 확인</button>
                <button onClick={() => bulkImportCm(false)} className="py-1 px-2 rounded-lg bg-teal text-white text-xs font-semibold">반입 실행</button>
                <span className="flex-1" />
                <button onClick={resyncBillingEdi} className="py-1 px-2 rounded-lg border border-line text-xs" title="실 수가코드 적재 후 — 미청구(CAPTURED) 항목의 EDI코드 스냅샷을 현재 매핑으로 갱신. 전송 완료분은 근거 보존">미청구 EDI 재동기화</button>
              </div>
              {cmBulkResult && (
                <div className="mt-1 text-[11px]">
                  {cmBulkResult.dryRun && <div className="text-warn font-semibold">차이 확인 결과 — 아직 적용되지 않았습니다</div>}
                  <span className="text-good">신규 {cmBulkResult.imported}</span> · <span className="text-teal">갱신 {cmBulkResult.updated}</span> · <span className="text-ink-3">무변경 {cmBulkResult.unchanged ?? 0}</span> · <span className={cmBulkResult.errors.length ? 'text-crit' : 'text-ink-3'}>오류 {cmBulkResult.errors.length}</span>
                  {(cmBulkResult.changes ?? []).slice(0, 20).map((c, i) => (
                    <div key={i} className="mono text-ink-2">{c.lisCode} · {c.field}: <span className="text-ink-3">{c.before ?? '(없음)'}</span> → <span className="text-teal">{c.after}</span></div>
                  ))}
                  {(cmBulkResult.changes ?? []).length > 20 && <div className="text-ink-3">…외 {(cmBulkResult.changes ?? []).length - 20}건 변경</div>}
                  {cmBulkResult.errors.slice(0, 5).map((er) => <div key={er.row} className="text-crit">행{er.row} {er.lisCode}: {er.error}</div>)}
                  {cmBulkResult.errors.length > 5 && <div className="text-ink-3">…외 {cmBulkResult.errors.length - 5}건</div>}
                </div>
              )}
              {/* 결과항목 EDI 반입 — 동일 edi_code = 패널 자동구성(HIS 확정) */}
              <div className="mt-2 pt-2 border-t border-line">
                <div className="text-[11px] text-ink-3 mb-1">결과항목 EDI 반입 <span className="mono">ediCode,testCode,name,loinc,specimenType,panelName</span> — 동일 edi_code=패널 자동구성</div>
                <textarea value={riBulk} onChange={(e) => setRiBulk(e.target.value)} rows={3} placeholder={'ediCode,testCode,name,loinc,panelName\nE6541,CBC-HGB,혈색소,718-7,일반혈액\nE6541,CBC-WBC,백혈구수,6690-2,일반혈액'} className="w-full mono text-[11px] px-2 py-1 rounded border border-line bg-surface mb-1" />
                <div className="flex items-center gap-2 flex-wrap">
                  <label className="flex items-center gap-1 text-[11px] cursor-pointer"><input type="checkbox" checked={riCreateTests} onChange={(e) => setRiCreateTests(e.target.checked)} />미등록 검사 자동생성</label>
                  <button onClick={bulkImportRi} className="py-1 px-2 rounded-lg bg-indigo text-white text-xs font-semibold">결과항목 반입</button>
                </div>
                {riResult && (
                  <div className="mt-1 text-[11px]">
                    <span className="text-good">검사 {riResult.testsCreated}</span> · <span className="text-teal">매핑 {riResult.mappings}</span> · <span className="text-indigo">패널 {riResult.panels}({riResult.panelItems})</span> · <span className={riResult.errors.length ? 'text-crit' : 'text-ink-3'}>오류 {riResult.errors.length}</span>
                    {riResult.errors.slice(0, 5).map((er, i) => <div key={i} className="text-crit">행{er.row} {er.testCode}: {er.error}</div>)}
                  </div>
                )}
              </div>
            </div>
          )}
          {canWrite && (
          <form onSubmit={addCm} className="flex gap-1 mb-2">
            <input required aria-label="LIS코드" placeholder="LIS코드" value={ncm.lisCode} onChange={(e) => setNcm({ ...ncm, lisCode: e.target.value })} className={`${inp} mono flex-1`} />
            <input aria-label="HIS코드" placeholder="HIS코드" value={ncm.hisCode} onChange={(e) => setNcm({ ...ncm, hisCode: e.target.value })} className={`${inp} mono w-20`} />
            <button className="py-1 px-2 rounded-lg bg-teal text-white text-xs">저장</button>
          </form>
          )}
          <div className="max-h-40 overflow-y-auto text-xs space-y-0.5">
            {cms.map((c) => <div key={c.lisCode} className="flex justify-between mono"><span>{c.lisCode}</span><span className="text-ink-2">{c.hisCode ?? '-'}</span></div>)}
          </div>
        </section>

        <section className="card">
          <h2 className="t-section text-sm mb-2">QC 목표치 <span className="text-xs text-ink-2">({qts.length})</span></h2>
          {canWrite && (
          <form onSubmit={addQt} className="grid grid-cols-2 gap-1 mb-2">
            <input required aria-label="QC로트" placeholder="QC로트" value={nqt.qcCode} onChange={(e) => setNqt({ ...nqt, qcCode: e.target.value })} className={`${inp} mono`} />
            <input required aria-label="장비" placeholder="장비" value={nqt.instrument} onChange={(e) => setNqt({ ...nqt, instrument: e.target.value })} className={`${inp} mono`} />
            <input required aria-label="검사코드" placeholder="검사코드" value={nqt.testCode} onChange={(e) => setNqt({ ...nqt, testCode: e.target.value })} className={`${inp} mono`} />
            <div className="flex gap-1">
              <input required aria-label="평균" placeholder="평균" value={nqt.mean} onChange={(e) => setNqt({ ...nqt, mean: e.target.value })} className={`${inp} mono w-full`} />
              <input required aria-label="SD" placeholder="SD" value={nqt.sd} onChange={(e) => setNqt({ ...nqt, sd: e.target.value })} className={`${inp} mono w-full`} />
            </div>
            <button className="col-span-2 py-1 rounded-lg bg-teal text-white text-xs">저장</button>
          </form>
          )}
          <div className="max-h-32 overflow-y-auto text-xs space-y-0.5">
            {qts.map((q) => <div key={q.qcTargetId} className="mono flex justify-between"><span>{q.testCode}@{q.instrument}</span><span className="text-ink-2">x̄{q.mean}·SD{q.sd}</span></div>)}
          </div>
        </section>

        <section className="card">
          <h2 className="t-section text-sm mb-2">장비 매핑 <span className="text-xs text-ink-2">({ims.length})</span></h2>
          {canWrite && (
          <form onSubmit={addIm} className="grid grid-cols-3 gap-1 mb-2">
            <input required aria-label="장비" placeholder="장비" value={nim.instrument} onChange={(e) => setNim({ ...nim, instrument: e.target.value })} className={`${inp} mono`} />
            <input required aria-label="장비코드" placeholder="장비코드" value={nim.rawCode} onChange={(e) => setNim({ ...nim, rawCode: e.target.value })} className={`${inp} mono`} />
            <input required aria-label="검사코드" placeholder="검사코드" value={nim.testCode} onChange={(e) => setNim({ ...nim, testCode: e.target.value })} className={`${inp} mono`} />
            <button className="col-span-3 py-1 rounded-lg bg-teal text-white text-xs">저장</button>
          </form>
          )}
          <div className="max-h-32 overflow-y-auto text-xs space-y-0.5">
            {ims.map((m) => <div key={m.id} className="mono flex justify-between"><span>{m.instrument}:{m.rawCode}</span><span className="text-ink-2">→{m.testCode}</span></div>)}
          </div>
        </section>
      </div>

      {/* 패널(묶음검사) */}
      <section className="card mt-4">
        <h2 className="t-section text-sm mb-2">패널(묶음검사) <span className="text-xs text-ink-2">({panels.length})</span></h2>
        {canWrite && (
        <form onSubmit={addPanel} className="flex flex-wrap gap-2 items-center mb-3">
          <input required aria-label="패널코드" placeholder="패널코드" value={np.panelCode} onChange={(e) => setNp({ ...np, panelCode: e.target.value })} className={`${inp} mono w-28`} />
          <input required aria-label="명칭" placeholder="명칭" value={np.name} onChange={(e) => setNp({ ...np, name: e.target.value })} className={`${inp} w-32`} />
          <input required aria-label="검사코드" placeholder="검사코드(콤마구분) CHE-NA,CHE-K" value={np.testCodes} onChange={(e) => setNp({ ...np, testCodes: e.target.value })} className={`${inp} mono flex-1 min-w-[16rem]`} />
          <button className="py-1.5 px-3 rounded-lg bg-teal text-white font-semibold text-xs">저장</button>
        </form>
        )}
        <div className="flex flex-wrap gap-2">
          {panels.map((p) => (
            <div key={p.panelCode} className="border border-line rounded-lg px-3 py-2 text-xs">
              <span className="mono font-bold">{p.panelCode}</span> {p.name}
              <div className="mt-1 flex flex-wrap gap-1">{p.items.map((i) => <span key={i.testCode} className="mono bg-bg px-1.5 rounded">{i.testCode}</span>)}</div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
