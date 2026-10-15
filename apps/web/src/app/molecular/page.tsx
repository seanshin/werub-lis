'use client';

/**
 * 분자진단 (PCR) 화면 (`/molecular`).
 *
 * 사이드바 노출 역할: MIC, ADM.
 * ⚠ 노출 역할과 화면이 호출하는 API 권한이 어긋나면 전부 403인 죽은 화면이 된다 —
 *   역할을 바꿀 때는 `Sidebar.tsx`(정본)와 API 권한 매트릭스를 함께 본다.
 * 데이터는 `lib/api.ts`의 `apiFetch`로만 가져온다(HTTP 호출 정본).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, getToken, getUserId } from '@/lib/api';
import { EmptyState, ErrorText, TableSkeleton, BTN } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useConfirm } from '@/components/confirm';
import { maskName } from '@/lib/privacy';

/**
 * 분자진단(PCR) — 타깃·Ct·검출유무·정량 기록과 검출 워크리스트.
 *
 * ★임상 안전: `DETECTED`가 **법정감염병 타깃**이면 서버가 신고 기록과 감염관리팀 알림을
 *   자동 생성한다. 입력자가 그 사실을 모르면 "왜 신고가 떴는지" 알 수 없으므로 저장 전에 알린다.
 * ⚠ 패널·assay 카탈로그와 해석 규칙은 검사실 확정 대기 — 지금은 자유 입력.
 */
interface MolResult {
  molId: string; specimenNo: string; panelCode: string | null; target: string; assay: string | null;
  detection: string; ct: number | null; quantValue: string | null; quantUnit: string | null;
  interpretation: string | null; reportedBy: string | null; reportedDt: string; status: string;
  caseSpNo?: string | null;
}
interface DetectedRow extends MolResult { patientName?: string | null }
interface Assay { panelCode: string; target: string; assayName: string | null; ctCutoff: number | null; equivocalFrom: number | null; note: string | null }

const DETECTIONS = [
  { v: 'DETECTED', label: '검출' },
  { v: 'NOT_DETECTED', label: '미검출' },
  { v: 'EQUIVOCAL', label: '판정보류' },
  { v: 'INVALID', label: '무효' },
] as const;

const detectionTone: Record<string, string> = {
  DETECTED: 'bg-warn/20 text-warn',
  NOT_DETECTED: 'bg-good/15 text-good',
  EQUIVOCAL: 'bg-bg text-ink-2',
  INVALID: 'bg-bg text-ink-3',
};
const detectionLabel: Record<string, string> = Object.fromEntries(DETECTIONS.map((d) => [d.v, d.label]));

export default function MolecularPage() {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const me = getUserId() ?? undefined;

  const [tab, setTab] = useState<'entry' | 'detected' | 'catalog'>('entry');
  const [err, setErr] = useState('');

  // 검체별 조회·입력
  const [spNo, setSpNo] = useState('');
  const [rows, setRows] = useState<MolResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({ target: '', panelCode: '', assay: '', detection: 'NOT_DETECTED', ct: '', quantValue: '', quantUnit: '', interpretation: '', status: 'FINAL' });
  const [suggestion, setSuggestion] = useState<{ text: string; basis: string; caution: boolean } | null>(null);
  async function suggestInterp() {
    if (!form.target.trim()) { toast('타깃을 먼저 입력하세요', 'info'); return; }
    try {
      const r = await apiFetch<{ suggestion: { text: string; basis: string; caution: boolean } | null; assayFound: boolean }>('/api/v1/molecular/interpret-suggest', {
        method: 'POST', body: JSON.stringify({ target: form.target.trim(), detection: form.detection, panelCode: form.panelCode.trim() || undefined, ct: form.ct ? Number(form.ct) : undefined }),
      });
      setSuggestion(r.suggestion);
      if (!r.suggestion) toast('제안할 판정이 없습니다', 'info');
    } catch (e) { toast(e instanceof Error ? e.message : '제안 실패', 'error'); }
  }
  const [saving, setSaving] = useState(false);

  // 검출 워크리스트
  const today = new Date().toISOString().slice(0, 10);
  const [dFrom, setDFrom] = useState('');
  const [dTo, setDTo] = useState('');
  const [detected, setDetected] = useState<DetectedRow[]>([]);
  const [dLoading, setDLoading] = useState(false);
  // assay 카탈로그 — target이 자유 문자열이라 오타가 조용히 다른 타깃이 된다
  const [assays, setAssays] = useState<Assay[]>([]);
  const [aForm, setAForm] = useState({ panelCode: '', target: '', assayName: '', ctCutoff: '', equivocalFrom: '', note: '' });

  const loadSpecimen = useCallback(async (no: string) => {
    const s = no.trim();
    if (!s) { setErr('검체번호를 입력하세요'); return; }
    setErr(''); setLoading(true);
    try { setRows(await apiFetch<MolResult[]>(`/api/v1/molecular/specimen/${encodeURIComponent(s)}`)); }
    catch (e) { setErr(e instanceof Error ? e.message : '조회 실패'); setRows([]); }
    finally { setLoading(false); }
  }, []);

  const loadDetected = useCallback(async () => {
    setDLoading(true);
    try {
      const qs = new URLSearchParams();
      if (dFrom) qs.set('from', `${dFrom}T00:00:00`);
      if (dTo) qs.set('to', `${dTo}T23:59:59`);
      setDetected(await apiFetch<DetectedRow[]>(`/api/v1/molecular/detected${qs.toString() ? `?${qs}` : ''}`));
    } catch (e) { setErr(e instanceof Error ? e.message : '조회 실패'); setDetected([]); }
    finally { setDLoading(false); }
  }, [dFrom, dTo]);

  const loadAssays = useCallback(async () => {
    try { setAssays(await apiFetch<Assay[]>('/api/v1/molecular/assays')); } catch { /* 카탈로그 없이도 입력은 가능 */ }
  }, []);

  useEffect(() => { if (!getToken()) router.push('/'); else void loadAssays(); }, [router, loadAssays]);

  async function saveAssay() {
    const num = (v: string) => (v.trim() === '' ? null : Number(v));
    if (!aForm.panelCode.trim() || !aForm.target.trim()) { setErr('패널 코드와 타깃은 필수입니다'); return; }
    try {
      await apiFetch('/api/v1/molecular/assays', {
        method: 'POST',
        body: JSON.stringify({
          panelCode: aForm.panelCode.trim(), target: aForm.target.trim(),
          assayName: aForm.assayName.trim() || undefined,
          ctCutoff: num(aForm.ctCutoff), equivocalFrom: num(aForm.equivocalFrom),
          note: aForm.note.trim() || undefined,
        }),
      });
      toast('assay 저장됨'); setAForm({ panelCode: '', target: '', assayName: '', ctCutoff: '', equivocalFrom: '', note: '' });
      await loadAssays(); setErr('');
    } catch (e) { setErr(e instanceof Error ? e.message : 'assay 저장 실패'); }
  }

  async function removeAssay(panelCode: string, target: string) {
    try { await apiFetch(`/api/v1/molecular/assays/${encodeURIComponent(panelCode)}/${encodeURIComponent(target)}`, { method: 'DELETE' }); toast('삭제됨'); await loadAssays(); }
    catch (e) { setErr(e instanceof Error ? e.message : '삭제 실패'); }
  }

  async function save() {
    if (!spNo.trim()) { setErr('검체번호를 입력하세요'); return; }
    if (!form.target.trim()) { setErr('검출 타깃을 입력하세요'); return; }

    // 검출(DETECTED)은 신고·알림 파급이 있어 되돌리기 어렵다 — 저장 전 확인
    if (form.detection === 'DETECTED') {
      const ok = await confirm({
        title: '검출(DETECTED) 등록',
        message: '법정감염병 타깃이면 신고 기록과 감염관리팀 알림이 자동 생성됩니다. 타깃명과 검체를 확인하세요.',
        detail: [
          { label: '검체', value: spNo.trim() },
          { label: '타깃', value: form.target.trim() },
          { label: 'Ct', value: form.ct || '—' },
        ],
        danger: true,
        confirmLabel: '검출로 등록',
      });
      if (!ok) return;
    }

    setSaving(true); setErr('');
    try {
      const r = await apiFetch<{ result: MolResult; infectiousReport: { disease: string; grade: string | null } | null; reportReused?: boolean; warning?: string | null }>('/api/v1/molecular/results', {
        method: 'POST',
        body: JSON.stringify({
          specimenNo: spNo.trim(),
          target: form.target.trim(),
          detection: form.detection,
          panelCode: form.panelCode.trim() || undefined,
          assay: form.assay.trim() || undefined,
          ct: form.ct ? Number(form.ct) : undefined,
          quantValue: form.quantValue.trim() || undefined,
          quantUnit: form.quantUnit.trim() || undefined,
          interpretation: form.interpretation.trim() || undefined,
          status: form.status,
          reportedBy: me,
        }),
      });
      if (r.warning) toast(r.warning, 'info'); // 검출유무↔Ct 불일치(차단 아님)
      if (r.infectiousReport) {
        toast(
          r.reportReused
            ? `법정감염병 신고 — 미처리 건이 이미 있어 재사용(${r.infectiousReport.disease}). 중복 신고를 만들지 않았습니다`
            : `법정감염병 신고 생성 — ${r.infectiousReport.disease}(${r.infectiousReport.grade ?? '-'}). 감염관리팀 알림 발송됨`,
          'info',
        );
      } else if (!r.warning) {
        toast('분자검사 결과 등록됨', 'success');
      }
      setForm({ ...form, target: '', ct: '', quantValue: '', interpretation: '' }); setSuggestion(null);
      await loadSpecimen(spNo);
    } catch (e) { setErr(e instanceof Error ? e.message : '등록 실패'); }
    finally { setSaving(false); }
  }

  const inp = 'px-2 py-1.5 r-ctl border border-line bg-bg text-sm';

  return (
    <main className="page">
      <h1 className="t-page">분자진단 (PCR)</h1>
      <p className="t-meta mb-3">타깃별 검출유무·Ct·정량을 기록합니다. 검출된 법정감염병 타깃은 신고 기록과 감염관리팀 알림이 자동 생성됩니다.</p>

      <div className="flex gap-1 mb-3">
        <button onClick={() => setTab('entry')} className={`px-3 py-1.5 r-ctl text-sm font-semibold m-hover ${tab === 'entry' ? 'bg-teal text-white' : 'border border-line text-ink-2 hover:border-teal hover:text-teal'}`}>결과 입력·조회</button>
        <button onClick={() => { setTab('detected'); if (detected.length === 0) void loadDetected(); }} className={`px-3 py-1.5 r-ctl text-sm font-semibold m-hover ${tab === 'detected' ? 'bg-teal text-white' : 'border border-line text-ink-2 hover:border-teal hover:text-teal'}`}>검출 워크리스트</button>
        <button onClick={() => setTab('catalog')} className={`px-3 py-1.5 r-ctl text-sm font-semibold m-hover ${tab === 'catalog' ? 'bg-teal text-white' : 'border border-line text-ink-2 hover:border-teal hover:text-teal'}`}>assay 카탈로그</button>
      </div>

      <ErrorText message={err} />

      {tab === 'entry' && (
        <>
          <section className="card mb-4">
            <div className="flex flex-wrap gap-2 items-end mb-3">
              <div>
                <label htmlFor="mol-sp" className="block t-micro mb-0.5">검체번호</label>
                <input id="mol-sp" value={spNo} onChange={(e) => setSpNo(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') loadSpecimen(spNo); }}
                  placeholder="바코드 스캔/입력" className={`${inp} mono w-44`} autoComplete="off" />
              </div>
              <button onClick={() => loadSpecimen(spNo)} className={BTN.primary}>조회</button>
            </div>

            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2">
              <div>
                <label htmlFor="mol-target" className="block t-micro mb-0.5">검출 타깃 *</label>
                <input id="mol-target" list="mol-target-list" value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })}
                  placeholder="예: M. tuberculosis · SARS-CoV-2" className={`${inp} w-full`} />
                <datalist id="mol-target-list">
                  {assays.filter((a) => !form.panelCode.trim() || a.panelCode === form.panelCode.trim())
                    .map((a) => <option key={`${a.panelCode}/${a.target}`} value={a.target}>{a.panelCode}</option>)}
                </datalist>
                {(() => {
                  const hit = assays.find((a) => a.target === form.target.trim() && (!form.panelCode.trim() || a.panelCode === form.panelCode.trim()));
                  if (!form.target.trim()) return null;
                  return hit
                    ? <span className="t-micro text-ink-3">등록된 타깃 · 판정 한계 Ct {hit.ctCutoff ?? 40}{hit.equivocalFrom != null ? ` · 보류 ${hit.equivocalFrom}~` : ''}</span>
                    : <span className="t-micro text-warn">카탈로그에 없는 타깃 — 오타면 추세 비교가 끊깁니다</span>;
                })()}
              </div>
              <div>
                <label htmlFor="mol-det" className="block t-micro mb-0.5">검출 유무 *</label>
                <select id="mol-det" value={form.detection} onChange={(e) => setForm({ ...form, detection: e.target.value })} className={`${inp} w-full`}>
                  {DETECTIONS.map((d) => <option key={d.v} value={d.v}>{d.label}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="mol-ct" className="block t-micro mb-0.5">Ct</label>
                <input id="mol-ct" value={form.ct} onChange={(e) => setForm({ ...form, ct: e.target.value })} inputMode="decimal" placeholder="0~50" className={`${inp} mono w-full`} />
              </div>
              <div>
                <label htmlFor="mol-panel" className="block t-micro mb-0.5">패널 코드</label>
                <input id="mol-panel" list="mol-panel-list" value={form.panelCode} onChange={(e) => setForm({ ...form, panelCode: e.target.value })} placeholder="RESP-PANEL 등" className={`${inp} w-full`} />
                <datalist id="mol-panel-list">{Array.from(new Set(assays.map((a) => a.panelCode))).map((c) => <option key={c} value={c} />)}</datalist>
              </div>
              <div>
                <label htmlFor="mol-assay" className="block t-micro mb-0.5">검사법·키트</label>
                <input id="mol-assay" value={form.assay} onChange={(e) => setForm({ ...form, assay: e.target.value })} className={`${inp} w-full`} />
              </div>
              <div>
                <label htmlFor="mol-qv" className="block t-micro mb-0.5">정량값</label>
                <input id="mol-qv" value={form.quantValue} onChange={(e) => setForm({ ...form, quantValue: e.target.value })} placeholder="예: 1.2e5" className={`${inp} mono w-full`} />
              </div>
              <div>
                <label htmlFor="mol-qu" className="block t-micro mb-0.5">정량 단위</label>
                <input id="mol-qu" value={form.quantUnit} onChange={(e) => setForm({ ...form, quantUnit: e.target.value })} placeholder="IU/mL" className={`${inp} w-full`} />
              </div>
              <div>
                <label htmlFor="mol-status" className="block t-micro mb-0.5">보고 상태</label>
                <select id="mol-status" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} className={`${inp} w-full`}>
                  <option value="FINAL">최종</option><option value="PRELIMINARY">예비</option><option value="AMENDED">개정</option>
                </select>
              </div>
              <div className="sm:col-span-2 lg:col-span-4">
                <div className="flex items-center gap-2 mb-0.5">
                  <label htmlFor="mol-interp" className="t-micro">해석</label>
                  <button type="button" onClick={suggestInterp} className="t-micro text-teal hover:underline">판정 제안(DRAFT)</button>
                  {suggestion && <span className={`t-micro ${suggestion.caution ? 'text-warn' : 'text-ink-3'}`}>제안: <b>{suggestion.text}</b> · {suggestion.basis} <button type="button" onClick={() => { setForm((f) => ({ ...f, interpretation: suggestion.text })); }} className="text-teal underline">적용</button></span>}
                </div>
                <input id="mol-interp" value={form.interpretation} onChange={(e) => setForm({ ...form, interpretation: e.target.value })} className={`${inp} w-full`} />
              </div>
            </div>

            <div className="flex items-center gap-2 mt-3">
              <button onClick={save} disabled={saving} className={`${form.detection === 'DETECTED' ? BTN.danger : BTN.primary} disabled:opacity-50`}>
                {saving ? '등록 중…' : '결과 등록'}
              </button>
              {form.detection === 'DETECTED' && (
                <span className="t-meta text-warn">검출 등록 시 법정감염병이면 신고·알림이 자동 생성됩니다</span>
              )}
            </div>
          </section>

          <section className="card">
            <h2 className="t-section mb-2">검체 결과 {rows.length > 0 && <span className="t-meta">({rows.length}건)</span>}</h2>
            {loading ? <TableSkeleton rows={3} cols={6} /> : rows.length === 0 ? (
              <EmptyState title="조회된 결과가 없습니다" hint="검체번호로 조회하거나 위에서 결과를 등록하세요." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left t-micro border-b border-line"><th className="py-2">보고일시</th><th>타깃</th><th>키트</th><th>검출</th><th>Ct</th><th>정량</th><th>해석</th><th>상태</th></tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.molId} className="border-b border-line last:border-0">
                        <td className="py-1.5 mono text-xs text-ink-3">{r.reportedDt.slice(0, 16).replace('T', ' ')}</td>
                        <td className="font-semibold text-xs">{r.target}{r.panelCode && <span className="mono text-ink-3 ml-1">{r.panelCode}</span>}{r.caseSpNo && <span className="mono text-[11px] text-indigo ml-1" title="병리 케이스 결속">병리 {r.caseSpNo}</span>}</td>
                        <td className="mono text-xs text-ink-3">{r.assay ?? '—'}</td>
                        <td><span className={`px-1.5 py-0.5 r-chip t-micro ${detectionTone[r.detection] ?? ''}`}>{detectionLabel[r.detection] ?? r.detection}</span></td>
                        <td className="mono text-xs">{r.ct ?? '—'}</td>
                        <td className="mono text-xs">{r.quantValue ? `${r.quantValue} ${r.quantUnit ?? ''}` : '—'}</td>
                        <td className="text-xs text-ink-2">{r.interpretation ?? '—'}</td>
                        <td className="t-micro">{r.status === 'FINAL' ? '최종' : r.status === 'PRELIMINARY' ? '예비' : '개정'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      {tab === 'catalog' && (
        <section className="card">
          <h2 className="t-section mb-1">assay 카탈로그</h2>
          <p className="t-meta text-ink-2 mb-3">
            패널별 타깃과 Ct 판정 한계를 등록합니다. 등록하면 결과 입력 시 타깃을 고를 수 있고, 그 타깃의 한계로 판정 보조가 이뤄집니다.
            등록하지 않아도 결과 입력은 막지 않습니다(기본 한계 Ct 40).
          </p>

          <div className="flex flex-wrap gap-2 items-end mb-3 border-b border-line pb-3">
            <div><label htmlFor="a-panel" className="block t-micro mb-0.5">패널 코드 *</label>
              <input id="a-panel" value={aForm.panelCode} onChange={(e) => setAForm({ ...aForm, panelCode: e.target.value })} placeholder="RESP-PANEL" className={`${inp} w-32 mono`} /></div>
            <div><label htmlFor="a-target" className="block t-micro mb-0.5">타깃 *</label>
              <input id="a-target" value={aForm.target} onChange={(e) => setAForm({ ...aForm, target: e.target.value })} placeholder="SARS-CoV-2" className={`${inp} w-40`} /></div>
            <div><label htmlFor="a-name" className="block t-micro mb-0.5">키트·검사법</label>
              <input id="a-name" value={aForm.assayName} onChange={(e) => setAForm({ ...aForm, assayName: e.target.value })} className={`${inp} w-40`} /></div>
            <div><label htmlFor="a-cut" className="block t-micro mb-0.5">판정 한계 Ct</label>
              <input id="a-cut" value={aForm.ctCutoff} onChange={(e) => setAForm({ ...aForm, ctCutoff: e.target.value })} inputMode="decimal" placeholder="40" className={`${inp} w-20 mono`} /></div>
            <div><label htmlFor="a-eq" className="block t-micro mb-0.5">보류 시작 Ct</label>
              <input id="a-eq" value={aForm.equivocalFrom} onChange={(e) => setAForm({ ...aForm, equivocalFrom: e.target.value })} inputMode="decimal" placeholder="37" className={`${inp} w-20 mono`} /></div>
            <button onClick={saveAssay} className={BTN.primary}>저장</button>
          </div>

          {assays.length === 0 ? (
            <EmptyState title="등록된 assay가 없습니다" hint="키트 문서의 타깃과 판정 한계를 등록하면 결과 입력에서 바로 쓰입니다." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left t-micro text-ink-2 border-b border-line">
                  <th className="py-1.5">패널</th><th>타깃</th><th>키트</th><th>판정 한계</th><th>보류 구간</th><th>비고</th><th></th>
                </tr></thead>
                <tbody>
                  {assays.map((a) => (
                    <tr key={`${a.panelCode}/${a.target}`} className="border-b border-line last:border-0">
                      <td className="py-1.5 mono">{a.panelCode}</td>
                      <td>{a.target}</td>
                      <td className="text-ink-2">{a.assayName ?? '—'}</td>
                      <td className="mono">Ct {a.ctCutoff ?? 40}{a.ctCutoff == null && <span className="t-micro text-ink-3"> (기본)</span>}</td>
                      <td className="mono">{a.equivocalFrom != null ? `${a.equivocalFrom} ~ ${a.ctCutoff ?? 40}` : '—'}</td>
                      <td className="t-micro text-ink-3">{a.note ?? '—'}</td>
                      <td className="text-right"><button onClick={() => removeAssay(a.panelCode, a.target)} className="t-micro text-crit underline">삭제</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {tab === 'detected' && (
        <>
          <section className="card mb-4">
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <label htmlFor="mol-from" className="block t-micro mb-0.5">시작</label>
                <input id="mol-from" type="date" value={dFrom} onChange={(e) => setDFrom(e.target.value)} className={inp} />
              </div>
              <div>
                <label htmlFor="mol-to" className="block t-micro mb-0.5">종료</label>
                <input id="mol-to" type="date" value={dTo} onChange={(e) => setDTo(e.target.value)} className={inp} />
              </div>
              <button onClick={loadDetected} className={BTN.primary}>조회</button>
              <button onClick={() => { setDFrom(today); setDTo(today); }} className={BTN.neutral}>오늘</button>
              <span className="t-meta">{detected.length}건</span>
            </div>
          </section>

          <section className="card">
            <h2 className="t-section mb-1">검출(DETECTED) 목록</h2>
            <p className="t-meta mb-2">감염관리·후속 조치 대상입니다. 법정감염병 타깃은 신고 화면에서 처리 상태를 확인하세요.</p>
            {dLoading ? <TableSkeleton rows={4} cols={5} /> : detected.length === 0 ? (
              <EmptyState title="해당 기간에 검출 결과가 없습니다" hint="기간을 넓혀 조회하세요." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left t-micro border-b border-line"><th className="py-2">보고일시</th><th>검체</th><th>타깃·키트</th><th>Ct</th><th>정량</th><th>해석</th><th>보고자</th></tr></thead>
                  <tbody>
                    {detected.map((r) => (
                      <tr key={r.molId} className="border-b border-line last:border-0">
                        <td className="py-1.5 mono text-xs text-ink-3">{r.reportedDt.slice(0, 16).replace('T', ' ')}</td>
                        <td className="mono text-xs">
                          <button onClick={() => { setSpNo(r.specimenNo); setTab('entry'); loadSpecimen(r.specimenNo); }} className="underline decoration-dotted hover:text-teal">{r.specimenNo}</button>
                          {r.patientName && <span className="text-ink-3 ml-1">{maskName(r.patientName)}</span>}
                        </td>
                        <td className="text-xs">
                          <span className="font-semibold">{r.target}</span>
                          {(r.assay || r.panelCode) && <span className="block mono text-[11px] text-ink-3">{[r.panelCode, r.assay].filter(Boolean).join(' · ')}</span>}
                        </td>
                        <td className="mono text-xs">{r.ct ?? '—'}</td>
                        <td className="mono text-xs">{r.quantValue ? `${r.quantValue} ${r.quantUnit ?? ''}` : '—'}</td>
                        <td className="text-xs text-ink-2">{r.interpretation ?? '—'}</td>
                        <td className="mono text-xs text-ink-3">{r.reportedBy ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
