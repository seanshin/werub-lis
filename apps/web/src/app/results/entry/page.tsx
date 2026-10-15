'use client';

/**
 * 결과 입력 화면 (`/results/entry`).
 *
 * 사이드바 노출 역할: TEC, PHY, MIC, ADM.
 * ⚠ 노출 역할과 화면이 호출하는 API 권한이 어긋나면 전부 403인 죽은 화면이 된다 —
 *   역할을 바꿀 때는 `Sidebar.tsx`(정본)와 API 권한 매트릭스를 함께 본다.
 * 데이터는 `lib/api.ts`의 `apiFetch`로만 가져온다(HTTP 호출 정본).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, getToken, getUserId } from '@/lib/api';
import { EmptyState, ErrorText } from '@/components/ui';
import { FlagBadge, HoldBadge, VerifyBadge } from '@/components/StatusBadge';
import { useToast } from '@/components/toast';
import AttachmentPanel from '@/components/AttachmentPanel';
import { BarcodeConfig, DEFAULT_BARCODE_CONFIG, fetchBarcodeConfig, normalizeBarcode, beep as beepSound } from '@/lib/barcode';
import { maskName } from '@/lib/privacy';

interface Item { testCode: string; testName: string; unit: string | null; value: string | null; flag: string | null; verifyState: string | null; holdReason: string | null; refRange?: string; prevValue?: string | null; }
interface Derived { testCode: string; testName: string; unit: string | null; value: string | null; flag: string | null; verifyState: string | null; }
interface Entry { specimenNo: string; status: string; rejected: boolean; patient: { patientId: string; name: string }; orderId: string; items: Item[]; derived?: Derived[]; }
interface WorklistRow { specimenNo: string; patientName: string; patientId: string; specimenType: string | null; total: number; reported: number; }
interface Evaluation { flag: string | null; autoVerified: boolean; critical: boolean; holdReason: string | null; delta: { exceeded: boolean; pctDelta: number | null }; interference?: { factors: string[]; message: string } | null; }

export default function ResultEntryPage() {
  const router = useRouter();
  const toast = useToast();
  const [scan, setScan] = useState('');
  const [entry, setEntry] = useState<Entry | null>(null);
  const [worklist, setWorklist] = useState<WorklistRow[]>([]);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [dils, setDils] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string>('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [wlq, setWlq] = useState(''); // 워크리스트 검색(A10)
  const [dual, setDual] = useState(false);
  const [addTests, setAddTests] = useState(''); // 이중입력 오타방지(A6)
  const [cvals, setCvals] = useState<Record<string, string>>({});
  const [cmts, setCmts] = useState<Record<string, string>>({}); // A3 결과 코멘트(검체상태 등)
  const [barCfg, setBarCfg] = useState<BarcodeConfig>(DEFAULT_BARCODE_CONFIG);
  const scanRef = useRef<HTMLInputElement>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const valsRef = useRef<Record<string, string>>({});
  valsRef.current = vals; // 최신 입력값 스냅샷(리로드 병합용)
  const enteredBy = getUserId() ?? undefined;

  const loadWorklist = useCallback(async () => {
    try { setWorklist(await apiFetch<WorklistRow[]>('/api/v1/orders/specimens/worklist')); } catch { /* noop */ }
  }, []);

  useEffect(() => { if (!getToken()) router.push('/'); else { loadWorklist(); fetchBarcodeConfig().then(setBarCfg); scanRef.current?.focus(); } }, [router, loadWorklist]);

  // fresh=true: 새 검체(스캔) — 서버값으로 초기화·스캔칸 포커스.
  // fresh=false: 저장 후 갱신 — 미저장 입력값 보존(서버 null이면 로컬 유지), 포커스 유지.
  const load = useCallback(async (specimenNo: string, fresh = true) => {
    setErr(''); setMsg('');
    const sp = specimenNo.trim();
    if (!sp) return;
    try {
      const e = await apiFetch<Entry>(`/api/v1/orders/specimens/${encodeURIComponent(sp)}/entry`);
      setEntry(e);
      setVals(Object.fromEntries(e.items.map((i) => [
        i.testCode,
        fresh ? (i.value ?? '') : (i.value ?? valsRef.current[i.testCode] ?? ''), // 미저장 로컬값 보존
      ])));
      if (fresh) {
        // ★새 검체로 넘어갈 때 **입력 보조값 전부** 초기화한다.
        //   희석배수·코멘트·HIL은 검체마다 다른 값인데, 남겨두면 이전 검체의 값이 그대로
        //   저장 payload에 실린다(희석은 dilutionFactor+rerun까지 붙어 결과값 자체가 바뀐다).
        //   vals는 위에서 fresh 분기로 이미 서버값으로 교체된다.
        setScan(''); setCvals({}); setDils({}); setCmts({});
        setHil({ hemolysis: '', icterus: '', lipemia: '' });
        scanRef.current?.focus();
        if (barCfg.beep) beepSound();
      }
    } catch (er) { setErr(er instanceof Error ? er.message : '검체 조회 실패'); setEntry(null); }
  }, [barCfg.beep]);

  // 스캔값 정규화(설정 적용) 후 로드 — 빈 값/경고 피드백
  function submitScan(raw: string) {
    if (idleTimer.current) { clearTimeout(idleTimer.current); idleTimer.current = null; }
    const r = normalizeBarcode(raw, barCfg);
    if (!r.value) { toast(entry ? '다른 검체 바코드를 입력하세요' : '검체 바코드를 입력하세요', 'info'); scanRef.current?.focus(); return; }
    if (r.warning) toast(`바코드 경고: ${r.warning}`, 'info'); // 경고해도 조회는 시도
    load(r.value);
  }

  // 저장 후 다음 미저장 항목 입력칸으로 포커스 이동(A2 키보드 흐름)
  function focusNext(afterCode: string) {
    if (!entry) return;
    const idx = entry.items.findIndex((i) => i.testCode === afterCode);
    for (let k = idx + 1; k < entry.items.length; k++) {
      const el = inputRefs.current[entry.items[k].testCode];
      if (el && !el.disabled) { el.focus(); el.select?.(); return; }
    }
  }

  async function save(item: Item, opts: { advance?: boolean } = {}) {
    if (!entry) return;
    const value = vals[item.testCode];
    if (value == null || value === '') return;
    setBusy(item.testCode); setErr(''); setMsg('');
    try {
      const r = await apiFetch<{ evaluation: Evaluation }>('/api/v1/results', {
        method: 'POST',
        body: JSON.stringify({ specimenNo: entry.specimenNo, testCode: item.testCode, value, unit: item.unit ?? undefined, enteredBy, source: 'MANUAL', comment: cmts[item.testCode]?.trim() || undefined, valueConfirm: dual ? (cvals[item.testCode] ?? '') : undefined, ...(Number(dils[item.testCode]) > 1 ? { dilutionFactor: Number(dils[item.testCode]), rerun: true } : {}) }),
      });
      const ev = r.evaluation;
      const tags = [ev.critical ? '위험치' : '', ev.delta?.exceeded ? `델타 ${ev.delta.pctDelta}%` : '', ev.autoVerified ? '자동검증' : (ev.holdReason ?? '보류')].filter(Boolean).join(' · ');
      toast(`${item.testName} ${value}${item.unit ? ' ' + item.unit : ''} → ${ev.flag ?? 'N'} · ${tags}`, ev.critical ? 'error' : 'success');
      if (ev.interference) toast(`${ev.interference.message}`, 'info'); // D1 HIL 간섭
      await load(entry.specimenNo, false); // 미저장 값 보존 갱신
      if (opts.advance) setTimeout(() => focusNext(item.testCode), 0);
    } catch (er) { toast(er instanceof Error ? er.message : '저장 실패', 'error'); }
    finally { setBusy(''); }
  }

  // A1: 입력된 모든 미저장 항목 일괄 저장
  async function saveAll() {
    if (!entry) return;
    const dirty = entry.items.filter((i) => (vals[i.testCode]?.trim()) && vals[i.testCode] !== (i.value ?? ''));
    if (dirty.length === 0) { toast('저장할 입력값이 없습니다', 'info'); return; }
    setBusy('all'); setErr('');
    let ok = 0, fail = 0;
    for (const it of dirty) {
      try {
        await apiFetch('/api/v1/results', { method: 'POST', body: JSON.stringify({ specimenNo: entry.specimenNo, testCode: it.testCode, value: vals[it.testCode], unit: it.unit ?? undefined, enteredBy, source: 'MANUAL', comment: cmts[it.testCode]?.trim() || undefined, valueConfirm: dual ? (cvals[it.testCode] ?? '') : undefined, ...(Number(dils[it.testCode]) > 1 ? { dilutionFactor: Number(dils[it.testCode]), rerun: true } : {}) }) });
        ok++;
      } catch { fail++; }
    }
    toast(`${ok}건 저장${fail ? ` · ${fail}건 실패` : ''}`, fail ? 'error' : 'success');
    await load(entry.specimenNo, false);
    setBusy('');
  }

  // D1 검체 품질 HIL 등급 기록(용혈·황달·지질혈)
  const [hil, setHil] = useState({ hemolysis: '', icterus: '', lipemia: '' });
  async function addOn() {
    if (!entry) return;
    const codes = addTests.split(/[,\s]+/).map((c) => c.trim()).filter(Boolean);
    if (codes.length === 0) { toast('추가할 검사코드를 입력하세요', 'info'); return; }
    setBusy('addon');
    try {
      const r = await apiFetch<{ added: string[]; skipped: string[]; warnings: string[] }>(`/api/v1/orders/specimens/${encodeURIComponent(entry.specimenNo)}/add-on`, { method: 'POST', body: JSON.stringify({ testCodes: codes }) });
      if (r.added.length) toast(`추가검사 ${r.added.join(', ')} — 재채취 없이 이 검체로 진행`);
      if (r.skipped.length) toast(`이미 오더에 있음: ${r.skipped.join(', ')}`, 'info');
      r.warnings.forEach((w) => toast(`${w}`, 'info'));
      setAddTests('');
      await load(entry.specimenNo, false);
    } catch (e) {
      toast(e instanceof Error ? e.message : '추가검사 실패', 'error');
    } finally { setBusy(''); }
  }

  async function recordHil() {
    if (!entry) return;
    const body = Object.fromEntries(Object.entries(hil).filter(([, v]) => v));
    if (Object.keys(body).length === 0) { toast('HIL 등급을 선택하세요', 'info'); return; }
    try {
      await apiFetch(`/api/v1/results/specimens/${encodeURIComponent(entry.specimenNo)}/hil`, { method: 'POST', body: JSON.stringify(body) });
      toast('검체 HIL 등급 기록됨 — 영향 검사에 간섭 경고 표시', 'success');
    } catch (e) { toast(e instanceof Error ? e.message : 'HIL 기록 실패', 'error'); }
  }

  const inp = 'px-2 py-1.5 rounded-lg border border-line bg-bg text-sm';

  return (
    <main className="page">
      <h1 className="text-lg font-bold mb-4">결과 입력</h1>
      <ErrorText message={err} />
      {msg && <p className="text-sm text-good mb-3">{msg}</p>}

      {/* 바코드 스캔 */}
      <section className="card mb-4">
        <form onSubmit={(e) => { e.preventDefault(); submitScan(scan); }} className="flex gap-2 items-center">
          <label htmlFor="scan" className="text-xs text-ink-2">검체 바코드</label>
          <input id="scan" ref={scanRef} value={scan}
            onChange={(e) => {
              const v = e.target.value; setScan(v);
              // 자동 제출(스캐너가 Enter를 안 보내는 경우 대응)
              if (barCfg.autoSubmit === 'LENGTH' && barCfg.autoSubmitLen && v.trim().length >= barCfg.autoSubmitLen) submitScan(v);
              else if (barCfg.autoSubmit === 'IDLE' && barCfg.idleMs && v.trim()) {
                if (idleTimer.current) clearTimeout(idleTimer.current);
                idleTimer.current = setTimeout(() => submitScan(v), barCfg.idleMs);
              }
            }}
            placeholder="스캔 또는 입력 후 Enter" className={`${inp} mono flex-1 max-w-xs`} autoComplete="off" />
          <button type="submit" className="py-1.5 px-4 rounded-lg bg-teal text-white font-semibold text-sm">불러오기</button>
        </form>
        {entry && <p className="text-xs text-ink-3 mt-1">현재 <span className="mono">{entry.specimenNo}</span> 로드됨 · 다른 검체는 바코드 입력 후 불러오기</p>}
      </section>

      <div className="grid md:grid-cols-3 gap-4">
        {/* 결과 입력 그리드 */}
        <section className="card md:col-span-2">
          {!entry ? (
            <EmptyState title="검체를 선택하세요" hint="바코드를 스캔하거나 우측 진행 검체에서 선택하면 항목별 결과를 입력합니다." />
          ) : (
            <>
              <div className="flex items-center gap-2 mb-3">
                <span className="mono font-bold">{entry.specimenNo}</span>
                <span className="font-semibold">{entry.patient.name}</span>
                <span className="mono text-xs text-ink-2">{entry.patient.patientId}</span>
                {entry.rejected && <span className="px-2 py-0.5 rounded bg-crit/15 text-crit text-xs font-bold">거부된 검체</span>}
                {!entry.rejected && (
                  <>
                    <label className="ml-auto flex items-center gap-1 text-xs text-ink-2 cursor-pointer"><input type="checkbox" checked={dual} onChange={(e) => setDual(e.target.checked)} />이중입력</label>
                    <button onClick={saveAll} disabled={busy === 'all'}
                      className="py-1 px-3 rounded-lg border border-teal text-teal text-xs font-semibold disabled:opacity-40">
                      {busy === 'all' ? '저장중…' : '전체 저장'}
                    </button>
                  </>
                )}
              </div>
              {!entry.rejected && (
                <div className="flex flex-wrap items-center gap-2 mb-3 text-xs bg-bg rounded-lg px-2 py-1.5">
                  <span className="text-ink-2 font-semibold">검체 품질(HIL)</span>
                  {(['hemolysis', 'icterus', 'lipemia'] as const).map((k) => (
                    <label key={k} className="flex items-center gap-1">{k === 'hemolysis' ? '용혈' : k === 'icterus' ? '황달' : '지질혈'}
                      <select value={hil[k]} onChange={(e) => setHil({ ...hil, [k]: e.target.value })} className="px-1 py-0.5 rounded border border-line bg-surface"><option value="">-</option><option>NONE</option><option>1+</option><option>2+</option><option>3+</option></select>
                    </label>
                  ))}
                  <button onClick={recordHil} className="py-1 px-2 rounded-lg border border-line text-teal">기록</button>
                  <span className="text-ink-3">2+ 이상 시 영향 검사(K·LDH·AST 등)에 간섭 경고</span>
                </div>
              )}
              {!entry.rejected && (
                <div className="flex flex-wrap items-center gap-2 mb-3 text-xs bg-bg rounded-lg px-2 py-1.5">
                  <span className="text-ink-2 font-semibold">추가검사(Add-on)</span>
                  <input aria-label="추가 검사코드" value={addTests} onChange={(e) => setAddTests(e.target.value)} placeholder="검사코드(쉼표·공백 구분)" className={`${inp} mono w-52 text-xs py-1`} />
                  <button onClick={addOn} disabled={busy === 'addon'} className="py-1 px-2 rounded-lg border border-teal text-teal disabled:opacity-40">이 검체에 추가</button>
                  <span className="text-ink-3">재채취 없이 현재 검체로 추가 검사</span>
                </div>
              )}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-xs text-ink-2 border-b border-line"><th className="py-2">검사</th><th>결과값</th><th>단위</th><th>참고치 / 이전</th><th>판정</th><th>상태</th><th></th></tr></thead>
                  <tbody>
                    {entry.items.map((it) => (
                      <tr key={it.testCode} className="border-b border-line last:border-0">
                        <td className="py-2">{it.testName} <span className="mono text-xs text-ink-3">{it.testCode}</span></td>
                        <td>
                          <input aria-label={`${it.testName} 결과값`}
                            ref={(el) => { inputRefs.current[it.testCode] = el; }}
                            value={vals[it.testCode] ?? ''} onChange={(e) => setVals({ ...vals, [it.testCode]: e.target.value })}
                            onKeyDown={(e) => { if (e.key === 'Enter' && !dual) { e.preventDefault(); save(it, { advance: true }); } }}
                            disabled={entry.rejected} className={`${inp} mono w-24`} />
                          {dual && (
                            <input aria-label={`${it.testName} 확인값`} placeholder="확인값 재입력"
                              value={cvals[it.testCode] ?? ''} onChange={(e) => setCvals({ ...cvals, [it.testCode]: e.target.value })}
                              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(it, { advance: true }); } }}
                              disabled={entry.rejected} className={`${inp} mono w-24 mt-1 border-indigo/40`} />
                          )}
                          <span className="inline-flex items-center gap-1 mt-1 text-[11px] text-ink-3">희석×<input aria-label={`${it.testName} 희석배수`} type="number" min={1} value={dils[it.testCode] ?? ''} onChange={(e) => setDils({ ...dils, [it.testCode]: e.target.value })} placeholder="1" disabled={entry.rejected} className="mono w-12 px-1 py-0.5 rounded border border-line bg-bg" /></span>
                          <input aria-label={`${it.testName} 코멘트`} value={cmts[it.testCode] ?? ''} onChange={(e) => setCmts({ ...cmts, [it.testCode]: e.target.value })} placeholder="코멘트(검체상태 등)" disabled={entry.rejected} className={`${inp} w-full mt-1 text-xs`} />
                        </td>
                        <td className="mono text-xs text-ink-2">{it.unit}</td>
                        <td className="mono text-xs text-ink-3">
                          {it.refRange || '—'}{it.prevValue != null && <span className="text-indigo"> · 이전 {it.prevValue}</span>}
                        </td>
                        <td><FlagBadge flag={it.flag} /></td>
                        <td className="flex gap-1 items-center py-2"><VerifyBadge state={it.verifyState} /><HoldBadge reason={it.holdReason} /></td>
                        <td className="text-right">
                          <button onClick={() => save(it)} disabled={busy === it.testCode || entry.rejected || !(vals[it.testCode]?.trim())}
                            className="py-1 px-3 rounded-lg bg-teal text-white text-xs font-semibold disabled:opacity-40">
                            {busy === it.testCode ? '저장중…' : '저장'}
                          </button>
                        </td>
                      </tr>
                    ))}
                    {entry.items.length === 0 && <tr><td colSpan={7} className="py-4 text-center text-ink-3">검사 항목 없음</td></tr>}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-ink-3 mt-2">값 입력 후 Enter 또는 저장 → 자동평가(참고치·델타·QC)·위험치 즉시 표시.</p>
              {/* 파생(계산)검사 — 입력값으로 자동 산출된 읽기전용 결과(eGFR·LDL 등) */}
              {entry.derived && entry.derived.length > 0 && (
                <div className="mt-3 rounded-xl border border-line bg-bg p-3">
                  <div className="text-xs font-bold text-ink-2 mb-2">계산검사(자동 산출 · 읽기전용)</div>
                  <table className="w-full text-sm">
                    <tbody>
                      {entry.derived.map((d) => (
                        <tr key={d.testCode} className="border-b border-line last:border-0">
                          <td className="py-1">{d.testName} <span className="mono text-xs text-ink-3">{d.testCode}</span></td>
                          <td className={`mono font-bold ${d.flag && d.flag !== 'N' ? (d.flag.length === 2 ? 'text-crit' : 'text-warn') : ''}`}>{d.value ?? '—'}</td>
                          <td className="mono text-xs text-ink-2">{d.unit ?? ''}</td>
                          <td><FlagBadge flag={d.flag} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <AttachmentPanel specimenNo={entry.specimenNo} />
            </>
          )}
        </section>

        {/* 워크리스트 */}
        <section className="card">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-bold text-sm">진행 검체</h2>
            <button onClick={loadWorklist} className="text-xs text-teal underline">새로고침</button>
          </div>
          <input aria-label="검체·환자 검색" value={wlq} onChange={(e) => setWlq(e.target.value)} placeholder="검체·환자 검색" className={`${inp} w-full mb-2`} />
          <div className="space-y-1 max-h-96 overflow-y-auto">
            {(() => { const s = wlq.trim().toLowerCase(); const fw = worklist.filter((w) => !s || w.specimenNo.toLowerCase().includes(s) || w.patientName.toLowerCase().includes(s)); return fw.length === 0 ? <EmptyState title="진행 검체 없음" /> :
              fw.map((w) => (
                <button key={w.specimenNo} onClick={() => load(w.specimenNo)}
                  className={`w-full text-left px-2 py-1.5 rounded-lg text-sm hover:bg-bg ${entry?.specimenNo === w.specimenNo ? 'bg-teal/10' : ''}`}>
                  <span className="mono text-xs">{w.specimenNo}</span> · {maskName(w.patientName)}
                  <span className="text-xs text-ink-2 ml-1">{w.reported}/{w.total}</span>
                </button>
              )); })()}
          </div>
        </section>
      </div>
    </main>
  );
}
