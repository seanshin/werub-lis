'use client';

/**
 * 결과보고서 화면 (`/results/report`).
 *
 * 사이드바 노출 역할: TEC, PHY, MIC, ADM, AUD.
 * ⚠ 노출 역할과 화면이 호출하는 API 권한이 어긋나면 전부 403인 죽은 화면이 된다 —
 *   역할을 바꿀 때는 `Sidebar.tsx`(정본)와 API 권한 매트릭스를 함께 본다.
 * 데이터는 `lib/api.ts`의 `apiFetch`로만 가져온다(HTTP 호출 정본).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useState, useEffect, useRef, useCallback, Fragment } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, apiText, getToken } from '@/lib/api';
import { FlagBadge } from '@/components/StatusBadge';
import AttachmentPanel from '@/components/AttachmentPanel';
import { useBarcodeNormalize } from '@/lib/barcode';
import { useConfirm } from '@/components/confirm';
import { useToast } from '@/components/toast';
import { ErrorText, EmptyState, TableSkeleton } from '@/components/ui';
import { Explain } from '@/components/Explain';
import { unitDisplay } from '@lis/shared';
import { maskName } from '@/lib/privacy';
import { IconWarn } from '@/components/Icon';

interface Row { testCode: string; testName: string; value: string | null; unit: string | null; masterUnit?: string | null; flag: string | null; refRange: string; verifyState: string | null; verifier: string | null; reportedDt: string | null; version?: number; comment?: string | null; interpretation?: string | null; }
interface Report { specimenNo: string; collectedDt: string | null; receivedDt: string | null; patient: { patientId: string; name: string; sex: string | null; birthDate: string | null }; orderId: string; results: Row[]; }
interface AttachMeta { attachmentId: string; filename: string; mimeType: string; sizeBytes: number; note: string | null; uploadedBy: string | null; uploadedDt: string; }
interface Delivery { deliveryId: string; channel: string; recipient: string | null; deliveredBy: string | null; deliveredDt: string; note: string | null; }
interface Reportable { specimenNo: string; patientId: string; patientName: string; specimenType: string | null; orderId: string; reportedDt: string | null; testCount: number; hasCritical: boolean; }

export default function ReportPage() {
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const { normalize } = useBarcodeNormalize();
  const [scan, setScan] = useState('');
  const [rep, setRep] = useState<Report | null>(null);
  const [atts, setAtts] = useState<AttachMeta[]>([]);
  const [dlv, setDlv] = useState<Delivery[]>([]); // 배포 이력(P2: API만 있고 화면 없던 기능)
  const [err, setErr] = useState('');
  const scanRef = useRef<HTMLInputElement>(null);
  // 보고 가능 목록 — 검체번호를 모르면 화면을 쓸 수 없던 것 해소
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [q, setQ] = useState('');
  const [list, setList] = useState<Reportable[]>([]);
  const [listLoading, setListLoading] = useState(false);

  useEffect(() => {
    if (!getToken()) { router.push('/'); return; }
    // D7 전역 검색 진입: ?sp=검체번호 자동 조회
    const sp = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('sp') : null;
    if (sp) { setScan(sp); load(sp); } else { scanRef.current?.focus(); }
  }, [router]); // eslint-disable-line react-hooks/exhaustive-deps

  async function load(sp: string) {
    setErr('');
    const s = normalize(sp).value; // 바코드 정규화
    if (!s) { setErr('검체번호를 입력하세요'); return; }
    try {
      setRep(await apiFetch<Report>(`/api/v1/results/report/${encodeURIComponent(s)}`));
      try { setAtts(await apiFetch<AttachMeta[]>(`/api/v1/results/specimens/${encodeURIComponent(s)}/attachments`)); } catch { setAtts([]); }
      try { setDlv(await apiFetch<Delivery[]>(`/api/v1/results/report/${encodeURIComponent(s)}/deliveries`)); } catch { setDlv([]); }
    }
    catch (e) { setErr(e instanceof Error ? e.message : '조회 실패'); setRep(null); setAtts([]); setDlv([]); }
  }

  const loadList = useCallback(async (f = from, t = to, keyword = q) => {
    setListLoading(true);
    try {
      const qs = new URLSearchParams();
      if (f) qs.set('from', f);
      if (t) qs.set('to', t);
      if (keyword.trim()) qs.set('q', keyword.trim());
      setList(await apiFetch<Reportable[]>(`/api/v1/results/reportable?${qs}`));
    } catch { setList([]); }
    finally { setListLoading(false); }
  }, [from, to, q]);

  useEffect(() => { if (getToken()) void loadList(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const isFinal = (v: string | null) => v === 'VERIFIED' || v === 'AUTO';
  const unconfirmed = rep?.results.filter((r) => !isFinal(r.verifyState)) ?? [];

  // 미확정(예비/보류) 결과가 포함된 공식 보고서 인쇄 전 경고 — 미검증 결과 외부 배포 방지
  async function printReport() {
    if (!rep) return;
    if (unconfirmed.length > 0) {
      const ok = await confirm({
        title: '미확정 결과 포함 — 인쇄 확인',
        message: '검증(확정)되지 않은 예비·보류 결과가 포함되어 있습니다. 확정 전 결과를 공식 보고서로 배포하지 마세요.',
        detail: unconfirmed.slice(0, 8).map((r) => ({ label: r.testName, value: `${r.value ?? '—'} (${r.verifyState ?? '미확정'})` })),
        danger: true, confirmLabel: '그래도 인쇄',
      });
      if (!ok) return;
    }
    // C1: 인쇄를 배포 이력에 기록(누가·언제 인쇄·배포했는지 추적). 실패해도 인쇄는 진행하되
    // 조용히 삼키지 않는다(Q10) — 감사 대상 임상 행위의 기록 실패는 사용자가 알아야 한다.
    apiFetch(`/api/v1/results/report/${encodeURIComponent(rep.specimenNo)}/deliver`, { method: 'POST', body: JSON.stringify({ channel: 'PRINT' }) })
      .catch(() => toast('배포 이력 기록 실패 — 인쇄는 진행되지만 이력에 남지 않았습니다', 'error'));
    window.print();
  }

  /**
   * 정본 서식 인쇄 — **서버가 렌더한 보고서**를 그대로 출력한다.
   *
   * 화면 인쇄는 지금 보고 있는 페이지를 찍는다. 그래서 화면 배치가 바뀌면 공식 보고서 모양도
   * 같이 바뀌고, 같은 검체인데 어느 버튼을 눌렀느냐에 따라 다른 문서가 나간다. 대외로 나가는
   * 문서는 서버 렌더본 하나로 고정하는 편이 안전하다(병리 보고서와 같은 방식).
   */
  async function printOfficial() {
    if (!rep) return;
    if (unconfirmed.length > 0) {
      const ok = await confirm({
        title: '미확정 결과 포함 — 정본 인쇄 확인',
        message: '검증(확정)되지 않은 예비·보류 결과가 포함되어 있습니다. 정본에도 예비 표시가 붙지만, 확정 전 결과를 배포하지 마세요.',
        detail: unconfirmed.slice(0, 8).map((r) => ({ label: r.testName, value: `${r.value ?? '—'} (${r.verifyState ?? '미확정'})` })),
        danger: true, confirmLabel: '그래도 인쇄',
      });
      if (!ok) return;
    }
    try {
      const html = await apiText(`/api/v1/results/report/${encodeURIComponent(rep.specimenNo)}/html`);
      apiFetch(`/api/v1/results/report/${encodeURIComponent(rep.specimenNo)}/deliver`, { method: 'POST', body: JSON.stringify({ channel: 'PRINT' }) })
        .catch(() => toast('배포 이력 기록 실패 — 인쇄는 진행되지만 이력에 남지 않았습니다', 'error'));
      const w = window.open('', '_blank');
      if (!w) { toast('팝업이 차단되었습니다 — 허용 후 다시 시도하세요', 'error'); return; }
      w.document.write(html); w.document.close(); w.focus(); w.print();
    } catch (e) {
      toast(e instanceof Error ? e.message : '정본 서식을 불러오지 못했습니다', 'error');
    }
  }

  const fmt = (d: string | null) => (d ? d.slice(0, 16).replace('T', ' ') : '—');
  const ageOf = (birth: string | null) => {
    if (!birth) return '—';
    const b = new Date(birth); if (isNaN(b.getTime())) return '—';
    const now = new Date(); let a = now.getFullYear() - b.getFullYear();
    if (now.getMonth() < b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() < b.getDate())) a--;
    return `${a}세`;
  };

  return (
    <main className="page">
      
      <div className="no-print flex gap-2 items-center mb-4">
        <h1 className="t-page mr-2">결과보고서</h1>
        <input aria-label="검체 바코드" ref={scanRef} value={scan} onChange={(e) => setScan(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') load(scan); }}
          placeholder="검체 바코드 스캔/입력 후 Enter" className="mono px-3 py-2 rounded-lg border border-line bg-bg text-sm w-64" autoComplete="off" />
        <button onClick={() => load(scan)} className="py-2 px-4 rounded-lg bg-teal text-white font-semibold text-sm">조회</button>
        {rep && <button onClick={printOfficial} className="py-2 px-4 rounded-lg bg-indigo text-white font-semibold text-sm">정본 인쇄</button>}
        {rep && <button onClick={printReport} className="py-2 px-4 rounded-lg border border-line text-sm" title="지금 보고 있는 화면을 그대로 인쇄합니다(내부 참고용)">화면 인쇄</button>}
      </div>
      {err && <div className="no-print"><ErrorText message={err} /></div>}

      {/* 보고 가능 목록 — 검체번호를 몰라도 무엇을 볼 수 있는지 알 수 있게(날짜·검색) */}
      <section className="no-print card mb-4">
        <div className="flex flex-wrap items-end gap-2 mb-3">
          <div>
            <label htmlFor="rpt-from" className="block t-micro mb-0.5">보고일 시작</label>
            <input id="rpt-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="px-2 py-1.5 r-ctl border border-line bg-bg text-sm" />
          </div>
          <div>
            <label htmlFor="rpt-to" className="block t-micro mb-0.5">종료</label>
            <input id="rpt-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="px-2 py-1.5 r-ctl border border-line bg-bg text-sm" />
          </div>
          <div className="flex-1 min-w-40">
            <label htmlFor="rpt-q" className="block t-micro mb-0.5">검색(검체번호·환자ID·성명)</label>
            <input id="rpt-q" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') loadList(); }}
              placeholder="예: S260713 · 1234567 · 홍길동" className="w-full px-2 py-1.5 r-ctl border border-line bg-bg text-sm" />
          </div>
          <button onClick={() => loadList()} className="py-1.5 px-3 r-ctl bg-teal text-white font-semibold text-sm m-hover hover:bg-teal-2">조회</button>
          <button onClick={() => { const d = new Date(); d.setDate(d.getDate() - 7); const f = d.toISOString().slice(0, 10); setFrom(f); setTo(today); loadList(f, today); }}
            className="py-1.5 px-3 r-ctl border border-line text-ink-2 font-semibold text-sm m-hover hover:border-teal hover:text-teal">최근 7일</button>
        </div>

        {listLoading ? <TableSkeleton rows={3} cols={5} /> : list.length === 0 ? (
          <EmptyState title="해당 기간에 보고된 검체가 없습니다" hint="기간을 넓히거나(최근 7일) 검체번호·환자로 검색해 보세요." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left t-micro border-b border-line"><th className="py-2">보고일시</th><th>검체</th><th>환자</th><th>종류</th><th>검사수</th><th></th></tr></thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.specimenNo} className={`border-b border-line last:border-0 ${rep?.specimenNo === r.specimenNo ? 'bg-teal/5' : ''}`}>
                    <td className="py-1.5 mono text-xs">{r.reportedDt ? r.reportedDt.slice(0, 16).replace('T', ' ') : '—'}</td>
                    <td className="mono text-xs">{r.specimenNo}</td>
                    <td>{maskName(r.patientName)} <span className="mono text-xs text-ink-3">{r.patientId}</span></td>
                    <td className="text-xs text-ink-2">{r.specimenType ?? '—'}</td>
                    <td className="mono">{r.testCount}{r.hasCritical && <span className="ml-1 text-crit font-bold" title="위험치 포함">HH/LL</span>}</td>
                    <td className="text-right">
                      <button onClick={() => { setScan(r.specimenNo); load(r.specimenNo); }}
                        className="py-1 px-2.5 r-ctl border border-line text-ink-2 text-xs font-semibold m-hover hover:border-teal hover:text-teal">보고서 열기</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {rep && unconfirmed.length > 0 && (
        <p className="no-print text-sm text-warn mb-3 flex items-center gap-1.5"><IconWarn className="mr-1" />미확정(예비·보류) 결과 {unconfirmed.length}건 포함 — 확정 후 배포 권장</p>
      )}

      {rep && (
        <section className="print-area card max-w-4xl">
          <div className="flex items-start justify-between border-b-2 border-ink pb-3 mb-4">
            <div>
              <h2 className="text-xl font-extrabold tracking-tight">검사결과 보고서</h2>
              <p className="text-xs text-ink-2 mt-0.5">Laboratory Report</p>
            </div>
            <div className="text-right text-xs text-ink-2">
              <div>검체 <span className="mono font-bold text-ink">{rep.specimenNo}</span></div>
              <div>오더 <span className="mono">{rep.orderId}</span></div>
            </div>
          </div>

          <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1 text-sm mb-4">
            <div><dt className="text-ink-2 text-xs">환자</dt><dd className="font-semibold">{rep.patient.name}</dd></div>
            <div><dt className="text-ink-2 text-xs">등록번호</dt><dd className="mono">{rep.patient.patientId}</dd></div>
            <div><dt className="text-ink-2 text-xs">성별 / 나이</dt><dd>{rep.patient.sex ?? '—'} / {ageOf(rep.patient.birthDate)}</dd></div>
            <div><dt className="text-ink-2 text-xs">생년월일</dt><dd className="mono text-xs">{rep.patient.birthDate ?? '—'}</dd></div>
            <div><dt className="text-ink-2 text-xs">채취</dt><dd className="text-xs mono">{fmt(rep.collectedDt)}</dd></div>
            <div><dt className="text-ink-2 text-xs">접수</dt><dd className="text-xs mono">{fmt(rep.receivedDt)}</dd></div>
          </dl>

          <div className="overflow-x-auto">
          <table className="w-full text-sm border-t border-line">
            <thead>
              <tr className="text-left text-xs text-ink-2 border-b border-line">
                <th className="py-2">검사</th><th>결과</th><th>단위</th><th>참고치</th><th>판정</th><th>보고</th>
              </tr>
            </thead>
            <tbody>
              {rep.results.map((r) => {
                const notes = [r.interpretation && `해석: ${r.interpretation}`, r.comment && `코멘트: ${r.comment}`].filter(Boolean);
                return (
                <Fragment key={r.testCode}>
                <tr className="border-b border-line last:border-0">
                  <td className="py-1.5"><span className="no-print"><Explain kind="test" id={r.testCode} label={r.testName} /></span><span className="print-only inline">{r.testName}</span> <span className="mono text-xs text-ink-3">{r.testCode}</span>{(r.version ?? 1) > 1 && <span className="ml-1 px-1 py-0.5 rounded bg-indigo/15 text-indigo text-[11px] font-bold">정정 v{r.version}</span>}</td>
                  <td className={`mono font-bold ${r.flag && r.flag !== 'N' ? (r.flag.length === 2 ? 'text-crit' : 'text-warn') : ''}`}>
                    {r.value ?? '—'}
                    {!isFinal(r.verifyState) && <span className="ml-1 px-1 py-0.5 rounded bg-warn/15 text-warn text-[11px] font-bold align-middle">예비·미확정</span>}
                  </td>
                  <td className="mono text-xs text-ink-2">
                    {unitDisplay(r.unit)}
                    {/* 단위 불일치 표면화(§2-4) — 참고치는 마스터 단위 기준이라, 결과 단위가 다르면
                        판정·위험치 임계가 어긋난다. 차단하지 않고 사람이 보게만 한다. */}
                    {r.masterUnit && r.unit && r.unit !== r.masterUnit && (
                      // ★아이콘이 유일한 내용이므로 label을 준다 — 없으면 aria-hidden이 되어
                      //   스크린리더 사용자에겐 이 경고가 통째로 존재하지 않는다(title은 대체수단이 못 된다).
                      <span className="no-print ml-1 text-warn font-bold" title={`마스터 단위 ${unitDisplay(r.masterUnit)}와 다릅니다 — 입력 단위를 확인하세요`}><IconWarn label={`단위 불일치 — 마스터 단위 ${unitDisplay(r.masterUnit)}와 다릅니다`} /></span>
                    )}
                  </td>
                  <td className="mono text-xs text-ink-2">{r.refRange}</td>
                  <td><FlagBadge flag={r.flag} /></td>
                  <td className="text-xs text-ink-2">{isFinal(r.verifyState) ? '확정' : (r.verifyState ?? '')}{r.verifier ? ` · ${r.verifier}` : ''}</td>
                </tr>
                {notes.length > 0 && <tr className="border-b border-line last:border-0"><td colSpan={6} className="pb-1.5 pl-2 text-xs text-ink-2 italic">{notes.join(' · ')}</td></tr>}
                </Fragment>
                );
              })}
              {rep.results.length === 0 && <tr><td colSpan={6} className="py-4 text-center text-ink-3">결과 없음</td></tr>}
            </tbody>
          </table>
          </div>

          {/* 인쇄 포함: 첨부 문서 목록 */}
          {atts.length > 0 && (
            <div className="print-only mt-4 pt-3 border-t border-line text-xs">
              <div className="font-bold mb-1">첨부 문서 ({atts.length})</div>
              <ul>
                {atts.map((a) => (
                  <li key={a.attachmentId}>· {a.filename}{a.note ? ` — ${a.note}` : ''} ({(a.sizeBytes / 1024).toFixed(0)}KB{a.uploadedBy ? `, ${a.uploadedBy}` : ''})</li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex justify-between items-end mt-6 pt-3 border-t border-line text-xs text-ink-2">
            <span>본 보고서는 검증(확정)된 결과를 포함합니다. 미확정 항목은 별도 표기됩니다.</span>
            <span>출력 {fmt(new Date().toISOString())}</span>
          </div>
        </section>
      )}

      {rep && dlv.length > 0 && (
        <section className="no-print card mt-4 max-w-3xl">
          <h2 className="t-section text-sm mb-2">배포 이력 <span className="text-xs text-ink-3 font-normal">누가·언제·어느 채널로 이 보고서를 내보냈는가(감사 추적)</span></h2>
          <table className="w-full text-xs">
            <thead><tr className="text-left text-ink-3"><th className="py-1">일시</th><th>채널</th><th>수신처</th><th>배포자</th><th>비고</th></tr></thead>
            <tbody>
              {dlv.map((d) => (
                <tr key={d.deliveryId} className="border-t border-line">
                  <td className="py-1 mono">{d.deliveredDt.slice(0, 16).replace('T', ' ')}</td>
                  <td>{d.channel}</td><td>{d.recipient ?? '—'}</td><td>{d.deliveredBy ?? '—'}</td><td className="text-ink-2">{d.note ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {rep && (
        <div className="no-print">
          <AttachmentPanel specimenNo={rep.specimenNo} />
        </div>
      )}
    </main>
  );
}
