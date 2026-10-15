'use client';

/**
 * SignoffWorksheet.tsx — 웹 공용 컴포넌트.
 *
 * 제공: SignoffWorksheet.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '@/lib/api';
import { ErrorText, Loading } from '@/components/ui';
import { useToast } from '@/components/toast';
import { getRoles } from '@/lib/api';
import { GATE_STATUS_LABEL, labelOf } from '@lis/shared';
import { IconWarn } from '@/components/Icon';

interface RefRange { testCode: string; name: string; unit: string | null; low: number | null; high: number | null; panicLow: number | null; panicHigh: number | null; ageMin: number | null; ageMax: number | null; }
interface Delta { testCode: string; name: string | null; autoVerify: boolean | null; deltaPctLimit: number | null; deltaAbsLimit: number | null; deltaWindowDays: number | null; }
interface Edi { lisCode: string; hisCode: string | null; ediCode: string | null; loinc: string | null; }
interface Qc { testCode: string; name: string; instrument: string; lot: string; mean: number; sd: number; }
interface Decision { code?: string; item: string; current: string; decide: string; }
interface Gate { gateCode: string; title: string; owner: string | null; scope: string | null; status: string; docNo: string | null; approvedDate: string | null; approver: string | null; nextReviewDate?: string | null; reviewFlags?: string[]; }
interface Worksheet {
  generatedAt: string; notice: string;
  referenceRanges: RefRange[]; deltaConfig: Delta[]; ediCodes: Edi[]; qcTargets: Qc[];
  clinicalDecisions: Decision[]; pathologyCatalogs: Decision[]; legal: Decision[]; gates: Gate[];
}

interface SignoffStatus {
  section: string; label: string; owner: string; editHref: string | null;
  itemCount: number; currentHash: string; drifted: boolean; history: number;
  signed: { signoffId: string; signerName: string; signerRole: string | null; signedBy: string | null; documentNo: string | null; note: string | null; signedDt: string } | null;
}
interface DriftChange { key: string; kind: 'ADDED' | 'REMOVED' | 'CHANGED'; before?: unknown; after?: unknown }

const th = 'text-left py-1.5 px-2 text-ink-2 font-semibold border-b border-line';
const td = 'py-1.5 px-2 border-b border-line align-top';
const sign = <td className={`${td} bg-warn/[0.04] min-w-[7rem]`}>&nbsp;</td>;

function Section({ id, title, subtitle, status, onSigned, children }: {
  id: string; title: string; subtitle?: string;
  status?: SignoffStatus; onSigned?: () => void; children: React.ReactNode;
}) {
  return (
    <section id={id} className="print-area card mb-4 break-inside-avoid">
      <h2 className="font-bold mb-0.5">{title}</h2>
      {subtitle && <p className="text-xs text-ink-3 mb-3">{subtitle}</p>}
      {status && <SignoffBar s={status} onSigned={onSigned} />}
      <div className="overflow-x-auto">{children}</div>
    </section>
  );
}

/**
 * 섹션 서명 — 인쇄 후 손으로 적고 사람이 seed로 옮기던 구간을 없앤다.
 * 서명 시점 값의 스냅샷을 함께 굳히므로, 이후 값이 바뀌면 '서명 이후 변경'으로 드러난다.
 */
function SignoffBar({ s, onSigned }: { s: SignoffStatus; onSigned?: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [changes, setChanges] = useState<DriftChange[] | null>(null);
  const [hist, setHist] = useState<{ signoffId: string; signerName: string; signerRole: string | null; documentNo: string | null; note: string | null; signedDt: string }[] | null>(null);
  const [form, setForm] = useState({ signerName: '', signerRole: '', documentNo: '', note: '' });
  const [busy, setBusy] = useState(false);
  const canSign = getRoles().some((r) => ['TEC', 'PHY', 'MIC', 'ADM'].includes(r));

  async function submit() {
    if (!form.signerName.trim()) { toast('확정한 사람 실명을 입력하세요', 'error'); return; }
    setBusy(true);
    try {
      await apiFetch(`/api/v1/admin/signoff/${s.section}`, { method: 'POST', body: JSON.stringify(form) });
      toast('서명 기록됨'); setOpen(false); setForm({ signerName: '', signerRole: '', documentNo: '', note: '' });
      onSigned?.();
    } catch (e) { toast(e instanceof Error ? e.message : '실패', 'error'); }
    finally { setBusy(false); }
  }

  async function loadDrift() {
    try {
      const d = await apiFetch<{ changes: DriftChange[] }>(`/api/v1/admin/signoff/${s.section}/drift`);
      setChanges(d.changes);
    } catch (e) { toast(e instanceof Error ? e.message : '실패', 'error'); }
  }

  return (
    <div className={`rounded-lg border mb-3 px-3 py-2 ${s.drifted ? 'border-crit/40 bg-crit/[0.04]' : s.signed ? 'border-good/40 bg-good/[0.04]' : 'border-line bg-bg'}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {s.signed ? (
          <span className={s.drifted ? 'text-crit font-semibold' : 'text-good font-semibold'}>
            {s.drifted ? '서명 이후 값이 변경됨' : '확정 서명됨'}
          </span>
        ) : (
          <span className="text-ink-2 font-semibold">미서명</span>
        )}
        {s.signed && (
          <span className="text-ink-2">
            {s.signed.signerName}{s.signed.signerRole ? `(${s.signed.signerRole})` : ''} · {s.signed.signedDt.slice(0, 10)}
            {s.signed.documentNo ? ` · 문서 ${s.signed.documentNo}` : ''}
            {s.history > 1 ? ` · 이력 ${s.history}건` : ''}
          </span>
        )}
        <span className="text-ink-3">{s.owner} · {s.itemCount}건</span>
        <span className="ml-auto flex gap-2 print:hidden">
          {s.editHref && <a href={s.editHref} className="text-teal underline">값 편집</a>}
          {s.signed && (
            <button
              onClick={async () => {
                if (hist) { setHist(null); return; }
                try { setHist(await apiFetch(`/api/v1/admin/signoff/${s.section}/history`)); } catch { setHist([]); }
              }}
              className="text-teal underline"
            >{hist ? '이력 닫기' : `이력${s.history > 1 ? ` ${s.history}` : ''}`}</button>
          )}
          {s.drifted && (
            <button onClick={() => { setChanges(null); loadDrift(); }} className="text-crit underline">변경 내역</button>
          )}
          {canSign && (
            <button onClick={() => setOpen(!open)} className="text-teal underline">{s.signed ? '재서명' : '서명 기입'}</button>
          )}
        </span>
      </div>

      {changes && (
        <div className="mt-2 text-xs print:hidden">
          {changes.length === 0 ? <p className="text-ink-3">변경 없음</p> : (
            <ul className="flex flex-col gap-0.5">
              {changes.map((c, i) => (
                <li key={i} className="mono">
                  <span className={c.kind === 'ADDED' ? 'text-good' : c.kind === 'REMOVED' ? 'text-crit' : 'text-warn'}>
                    {c.kind === 'ADDED' ? '추가' : c.kind === 'REMOVED' ? '삭제' : '변경'}
                  </span>{' '}
                  {c.key}
                  {c.kind === 'CHANGED' && <span className="text-ink-3"> — 서명본과 현재값이 다릅니다</span>}
                </li>
              ))}
            </ul>
          )}
          <p className="text-ink-3 mt-1">확인 후 재서명하면 현재 값이 새 기준이 됩니다.</p>
        </div>
      )}

      {hist && (
        <div className="mt-2 text-xs print:hidden">
          {hist.length === 0 ? <p className="text-ink-3">이력 없음</p> : (
            <ul className="flex flex-col gap-0.5">
              {hist.map((h) => (
                <li key={h.signoffId} className="text-ink-2">
                  <span className="mono">{h.signedDt.slice(0, 16).replace('T', ' ')}</span>{' '}
                  {h.signerName}{h.signerRole ? `(${h.signerRole})` : ''}
                  {h.documentNo ? ` · 문서 ${h.documentNo}` : ''}
                  {h.note ? <span className="text-ink-3"> — {h.note}</span> : null}
                </li>
              ))}
            </ul>
          )}
          <p className="text-ink-3 mt-1">재서명은 이전 기록을 지우지 않고 쌓입니다 — 확정 시점을 나중에 소명할 수 있어야 합니다.</p>
        </div>
      )}

      {open && (
        <div className="mt-2 flex flex-wrap gap-2 items-center print:hidden">
          <input aria-label="확정한 사람" placeholder="확정한 사람(실명)" value={form.signerName} onChange={(e) => setForm({ ...form, signerName: e.target.value })} className="px-2 py-1 rounded-lg border border-line bg-surface text-xs w-36" />
          <input aria-label="직책·소속" placeholder="직책·소속" value={form.signerRole} onChange={(e) => setForm({ ...form, signerRole: e.target.value })} className="px-2 py-1 rounded-lg border border-line bg-surface text-xs w-28" />
          <input aria-label="문서번호" placeholder="문서번호" value={form.documentNo} onChange={(e) => setForm({ ...form, documentNo: e.target.value })} className="px-2 py-1 rounded-lg border border-line bg-surface text-xs w-28 mono" />
          <input aria-label="비고" placeholder="비고" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} className="px-2 py-1 rounded-lg border border-line bg-surface text-xs flex-1 min-w-[8rem]" />
          <button onClick={submit} disabled={busy} className="py-1 px-3 rounded-lg bg-teal text-white font-semibold text-xs disabled:opacity-50">기록</button>
        </div>
      )}
    </div>
  );
}

/** 검사실·법무 서명 워크시트 — 현재 seed 값 실시간 집계. 페이지·탭 어디서든 임베드. */
export default function SignoffWorksheet() {
  const [w, setW] = useState<Worksheet | null>(null);
  const [st, setSt] = useState<Record<string, SignoffStatus>>({});
  const [err, setErr] = useState('');

  const loadStatus = useCallback(async () => {
    try {
      const rows = await apiFetch<SignoffStatus[]>('/api/v1/admin/signoff/status');
      setSt(Object.fromEntries(rows.map((r) => [r.section, r])));
    } catch { /* 서명 현황 없이도 워크시트는 보여야 한다 */ }
  }, []);

  const load = useCallback(async () => {
    setErr('');
    try { setW(await apiFetch<Worksheet>('/api/v1/admin/signoff-worksheet')); }
    catch (e) { setErr(e instanceof Error ? e.message : '워크시트 조회 실패(검사실/관리 권한 필요)'); }
    await loadStatus();
  }, [loadStatus]);
  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <div className="flex items-center gap-3 mb-1 flex-wrap">
        <h2 className="font-bold">검사실·법무 서명 워크시트</h2>
        <button onClick={() => window.print()} className="ml-auto py-1.5 px-4 rounded-lg bg-teal text-white font-semibold text-sm print:hidden">인쇄</button>
        <button onClick={load} className="text-xs text-teal underline print:hidden">새로고침</button>
      </div>
      <p className="text-sm text-ink-2 mb-2">현재 dev seed 값을 실시간 집계한 회람용 시트입니다. 값은 <b>화면에서 직접 편집</b>하고(값 편집 링크), 확정되면 섹션마다 <b>서명을 기록</b>합니다.
        서명 시점의 값이 함께 저장되므로, 이후 값이 바뀌면 <b>서명 이후 변경됨</b>으로 표시됩니다.
        인쇄 회람이 필요하면 오른쪽 위 인쇄를 쓰세요(확정값·서명 칸은 종이 기입용입니다).</p>

      {err && <ErrorText message={err} />}
      {!w && !err ? <Loading /> : w && (
        <>
          <div className="text-xs text-ink-3 mb-4 flex flex-wrap gap-x-4">
            <span>생성: {w.generatedAt.slice(0, 16).replace('T', ' ')}</span>
            <span className="text-warn"><IconWarn className="mr-1" />{w.notice}</span>
          </div>

          <Section id="A" status={st["A"]} onSigned={loadStatus} title="A. 임상 참고치 (§F · 검사실)" subtitle="정상범위·위험치(panic) 확정 — 서명 후 실값 교체">
            <table className="w-full text-xs">
              <thead><tr><th className={th}>검사</th><th className={th}>코드</th><th className={th}>단위</th><th className={th}>정상(현재)</th><th className={th}>위험치</th><th className={th}>확정값</th><th className={th}>서명/일자</th></tr></thead>
              <tbody>{w.referenceRanges.map((r) => (
                <tr key={r.testCode}>
                  <td className={td}>{r.name}</td><td className={`${td} mono`}>{r.testCode}</td><td className={td}>{r.unit ?? '-'}</td>
                  <td className={td}>{r.low ?? '-'} – {r.high ?? '-'}{r.ageMin === 18 ? ' (성인)' : ''}</td>
                  <td className={td}>{r.panicLow ?? '—'} / {r.panicHigh ?? '—'}</td>
                  {sign}{sign}
                </tr>
              ))}</tbody>
            </table>
          </Section>

          <Section id="B" status={st["B"]} onSigned={loadStatus} title="B. 자동검증·델타 한계 (B5 · 검사실)">
            <table className="w-full text-xs">
              <thead><tr><th className={th}>검사</th><th className={th}>자동검증</th><th className={th}>델타 %</th><th className={th}>델타 절대</th><th className={th}>look-back(일)</th><th className={th}>확정값</th><th className={th}>서명/일자</th></tr></thead>
              <tbody>{w.deltaConfig.map((d) => (
                <tr key={d.testCode}>
                  <td className={td}>{d.name ?? d.testCode} <span className="mono text-ink-3">{d.testCode}</span></td>
                  <td className={td}>{d.autoVerify ? '예' : '아니오'}</td><td className={td}>{d.deltaPctLimit != null ? `${d.deltaPctLimit}%` : '—'}</td>
                  <td className={td}>{d.deltaAbsLimit ?? '—'}</td><td className={td}>{d.deltaWindowDays ?? '—'}</td>{sign}{sign}
                </tr>
              ))}</tbody>
            </table>
          </Section>

          <Section id="C" status={st["C"]} onSigned={loadStatus} title="C. EDI 수가코드 (청구 · 검사실·원무)" subtitle="임시 대표값 — 실 청구 전 심평원 실 수가코드로 교체">
            <table className="w-full text-xs">
              <thead><tr><th className={th}>LIS코드</th><th className={th}>HIS코드</th><th className={th}>EDI(현재)</th><th className={th}>LOINC</th><th className={th}>확정 EDI</th><th className={th}>서명/일자</th></tr></thead>
              <tbody>{w.ediCodes.map((e) => (
                <tr key={e.lisCode}><td className={`${td} mono`}>{e.lisCode}</td><td className={`${td} mono`}>{e.hisCode ?? '-'}</td><td className={`${td} mono`}>{e.ediCode ?? '-'}</td><td className={`${td} mono`}>{e.loinc ?? '-'}</td>{sign}{sign}</tr>
              ))}</tbody>
            </table>
          </Section>

          <Section id="D" status={st["D"]} onSigned={loadStatus} title="D. QC 타깃 (mean/SD · QC-CH1/화학1호기, 로트 DEFAULT)" subtitle="임시값 — 실 QC 물질 로트별 목표값으로 교체">
            <table className="w-full text-xs">
              <thead><tr><th className={th}>검사</th><th className={th}>장비</th><th className={th}>mean(현재)</th><th className={th}>SD(현재)</th><th className={th}>확정 mean/SD</th><th className={th}>서명/일자</th></tr></thead>
              <tbody>{w.qcTargets.map((q) => (
                <tr key={q.testCode}><td className={td}>{q.name} <span className="mono text-ink-3">{q.testCode}</span></td><td className={td}>{q.instrument}</td><td className={td}>{q.mean}</td><td className={td}>{q.sd}</td>{sign}{sign}</tr>
              ))}</tbody>
            </table>
          </Section>

          <Section id="E" status={st["E"]} onSigned={loadStatus} title="E. 임상 결정 항목 (F-1~F-5 · 검사실)">
            <table className="w-full text-xs">
              <thead><tr><th className={th}>#</th><th className={th}>항목</th><th className={th}>현재</th><th className={th}>결정 필요</th><th className={th}>확정/서명</th></tr></thead>
              <tbody>{w.clinicalDecisions.map((d) => (
                <tr key={d.code}><td className={`${td} mono`}>{d.code}</td><td className={td}>{d.item}</td><td className={td}>{d.current}</td><td className={td}>{d.decide}</td>{sign}</tr>
              ))}</tbody>
            </table>
          </Section>

          <Section id="F" status={st["F"]} onSigned={loadStatus} title="F. 병리 코드 카탈로그 (검사실)" subtitle="현재 스타터셋 — 형식 검증만">
            <table className="w-full text-xs">
              <thead><tr><th className={th}>항목</th><th className={th}>현재</th><th className={th}>확정 필요</th><th className={th}>확정/서명</th></tr></thead>
              <tbody>{w.pathologyCatalogs.map((d) => (
                <tr key={d.item}><td className={td}>{d.item}</td><td className={td}>{d.current}</td><td className={td}>{d.decide}</td>{sign}</tr>
              ))}</tbody>
            </table>
          </Section>

          <Section id="G" status={st["G"]} onSigned={loadStatus} title="G. 법무·보안">
            <table className="w-full text-xs">
              <thead><tr><th className={th}>항목</th><th className={th}>현재(잠정)</th><th className={th}>결정 필요</th><th className={th}>확정/서명</th></tr></thead>
              <tbody>{w.legal.map((d) => (
                <tr key={d.item}><td className={td}>{d.item}</td><td className={td}>{d.current}</td><td className={td}>{d.decide}</td>{sign}</tr>
              ))}</tbody>
            </table>
          </Section>

          <Section id="H" title="H. 조직 게이트 (실결재는 '조직 게이트' 탭에서 기입)" subtitle="DEV 플레이스홀더는 임의 승인 금지 · 인력변경·정기 만료 시 재검토 필요">
            <table className="w-full text-xs">
              <thead><tr><th className={th}>게이트</th><th className={th}>제목</th><th className={th}>상태</th><th className={th}>문서번호</th><th className={th}>결재자/일자</th><th className={th}>다음 재검토</th></tr></thead>
              <tbody>{w.gates.map((g) => {
                const stale = (g.reviewFlags?.length ?? 0) > 0;
                return (
                  <tr key={g.gateCode}>
                    <td className={`${td} mono`}>{g.gateCode}</td><td className={td}>{g.title}</td>
                    <td className={td}>
                      <span className={`px-1.5 py-0.5 rounded ${g.status === 'APPROVED' ? 'bg-good/15 text-good' : g.status === 'REJECTED' ? 'bg-crit/15 text-crit' : g.status === 'PENDING' ? 'bg-warn/15 text-warn' : 'bg-indigo/15 text-indigo'}`}>{labelOf(GATE_STATUS_LABEL, g.status)}</span>
                      {stale && <span className="ml-1 px-1.5 py-0.5 rounded bg-crit/15 text-crit font-semibold">재검토</span>}
                    </td>
                    <td className={`${td} mono`}>{g.docNo ?? '—'}</td>
                    <td className={td}>{g.approver && g.approver !== '(미결재)' ? `${g.approver} ${g.approvedDate ?? ''}` : '(미결재)'}</td>
                    <td className={`${td} ${stale ? 'text-crit' : ''}`}>{g.nextReviewDate ?? '—'}{stale && g.reviewFlags ? <span className="block text-ink-3">{g.reviewFlags.join(' · ')}</span> : ''}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </Section>

          <p className="text-xs text-ink-3 mt-2 print:hidden">A~D는 화면에서 값을 고친 뒤 서명하세요(마스터·수명주기 화면). E·F는 확정 내용을 비고에 적고 서명하면 기록으로 남습니다. H는 조직 게이트 탭에서 실결재를 기입합니다.</p>
        </>
      )}
    </div>
  );
}
