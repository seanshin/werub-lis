'use client';

/**
 * 표준 코드셋 반입 화면 (`/admin/catalogs`).
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
import { apiFetch, getToken } from '@/lib/api';
import { useToast } from '@/components/toast';
import { useConfirm } from '@/components/confirm';
import { ErrorText, Loading } from '@/components/ui';

interface Version {
  version: string; standard: string | null; effectiveDate: string | null; status: string;
  itemCount: number; note: string | null; importedBy: string | null; importedDt: string;
  activatedBy: string | null; activatedDt: string | null;
}
interface Catalog {
  catalogId: string; label: string; help: string; columns: string[]; sample: string;
  versions: Version[]; activeVersion: string | null;
}
interface Diff {
  added: { key: string; after: Record<string, unknown> }[];
  removed: { key: string; before: Record<string, unknown> }[];
  changed: { key: string; before: Record<string, unknown>; after: Record<string, unknown> }[];
  unchanged: number;
  comparedTo: string;
  baselineIsStarter: boolean;
}

/** unknown 값을 안전하게 표시 문자열로(객체면 JSON — "[object Object]" 방지). */
function s(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(s).join(' · ');
  return typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v);
}

/** payload를 카탈로그별로 한 줄 요약 — key 열에는 안 나오는 값만 보여준다. */
function fmtItem(catalogId: string, p: Record<string, unknown>): string {
  switch (catalogId) {
    case 'AST_BREAKPOINT': return `S ≤${s(p.s)} · R ≥${s(p.r)}`;
    case 'NOTIFIABLE_DISEASE': return `${s(p.disease)}${p.grade ? ` (${s(p.grade)})` : ''}`;
    case 'CYTOLOGY_CATEGORY': return `${s(p.system)} · ${s(p.label)}`;
    case 'SYNOPTIC_PROTOCOL': return `${s(p.label)} — ${s(p.required)}`;
    case 'ICDO': return s(p.name);
    case 'VARIANT_EVIDENCE': return `${s(p.gene)} ${s(p.variant)} · ${s(p.significance)}${p.oncokb_level ? ` · ${s(p.oncokb_level)}` : ''}${p.stars ? ` · ★${s(p.stars)}` : ''}${p.gnomad_af ? ` · gnomAD ${s(p.gnomad_af)}` : ''}${p.condition ? ` · ${s(p.condition)}` : ''}${p.source ? ` · ${s(p.source)}` : ''}${p.citation ? ` · ${s(p.citation)}` : ''}`;
    default: return JSON.stringify(p);
  }
}

/**
 * 표준 코드셋 반입 — 반입(초안) → 차이 확인 → 활성화.
 * 손으로 한 줄씩 고치는 값이 아니라 발행기관 개정판을 통째로 갈아 끼우는 값이다.
 */
export default function CatalogsPage() {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [cats, setCats] = useState<Catalog[] | null>(null);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState<string>('AST_BREAKPOINT'); // 탭 전환으로 다른 카탈로그 선택
  const [form, setForm] = useState({ version: '', standard: '', effectiveDate: '', csv: '', note: '' });
  const [diff, setDiff] = useState<{ version: string; d: Diff } | null>(null);
  const [items, setItems] = useState<{ version: string; rows: Record<string, unknown>[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setCats(await apiFetch<Catalog[]>('/api/v1/admin/catalogs')); }
    catch (e) { setErr(e instanceof Error ? e.message : '조회 실패(미생물/관리 권한 필요)'); setCats([]); }
  }, []);
  useEffect(() => { if (!getToken()) router.push('/'); else void load(); }, [router, load]);

  const cat = cats?.find((c) => c.catalogId === sel);

  async function doImport() {
    if (!form.version.trim() || !form.csv.trim()) { toast('버전과 CSV 내용을 입력하세요', 'error'); return; }
    setBusy(true);
    try {
      const r = await apiFetch<{ version: string; itemCount: number; diff: Diff }>(`/api/v1/admin/catalogs/${sel}/import`, {
        method: 'POST',
        body: JSON.stringify({ version: form.version.trim(), standard: form.standard.trim() || undefined, effectiveDate: form.effectiveDate.trim() || undefined, csv: form.csv, note: form.note.trim() || undefined }),
      });
      toast(`초안 반입 ${r.itemCount}건 — 차이를 확인한 뒤 활성화하세요`, 'success');
      setDiff({ version: r.version, d: r.diff });
      await load();
    } catch (e) { toast(e instanceof Error ? e.message : '반입 실패', 'error'); }
    finally { setBusy(false); }
  }

  async function showDiff(version: string) {
    try { setDiff({ version, d: await apiFetch<Diff>(`/api/v1/admin/catalogs/${sel}/diff?version=${encodeURIComponent(version)}`) }); }
    catch (e) { toast(e instanceof Error ? e.message : '차이 조회 실패', 'error'); }
  }
  async function viewItems(version: string) {
    try { setItems({ version, rows: await apiFetch<Record<string, unknown>[]>(`/api/v1/admin/catalogs/${sel}/items?version=${encodeURIComponent(version)}`) }); }
    catch (e) { toast(e instanceof Error ? e.message : '항목 조회 실패', 'error'); }
  }
  async function deleteDraft(version: string) {
    if (!(await confirm({ title: `초안 ${version} 삭제`, message: '잘못 반입한 초안을 삭제합니다. 활성/이전 버전은 삭제되지 않습니다.', danger: true, confirmLabel: '삭제' }))) return;
    setBusy(true);
    try { await apiFetch(`/api/v1/admin/catalogs/${sel}/versions/${encodeURIComponent(version)}`, { method: 'DELETE' }); toast('초안 삭제됨', 'success'); await load(); }
    catch (e) { toast(e instanceof Error ? e.message : '삭제 실패', 'error'); }
    finally { setBusy(false); }
  }

  async function activate(version: string) {
    let d = diff?.version === version ? diff.d : null;
    if (!d) {
      try { d = await apiFetch<Diff>(`/api/v1/admin/catalogs/${sel}/diff?version=${encodeURIComponent(version)}`); setDiff({ version, d }); }
      catch { /* 차이를 못 봐도 확인 문구는 띄운다 */ }
    }
    const ok = await confirm({
      title: `${version} 활성화`,
      message: `이 버전이 지금부터 ${cat?.label ?? ''}의 기준이 됩니다. 바뀐 항목은 이후 판정·검증부터 적용되며, 이미 보고된 결과는 소급되지 않습니다.`,
      detail: d ? [
        { label: '추가', value: `${d.added.length}건` },
        { label: '변경', value: `${d.changed.length}건` },
        { label: '삭제', value: `${d.removed.length}건` },
        { label: '비교 대상', value: d.comparedTo },
      ] : undefined,
      danger: true,
      confirmLabel: '활성화',
    });
    if (!ok) return;
    setBusy(true);
    try { await apiFetch(`/api/v1/admin/catalogs/${sel}/activate`, { method: 'POST', body: JSON.stringify({ version }) }); toast('활성화됨', 'success'); await load(); }
    catch (e) { toast(e instanceof Error ? e.message : '활성화 실패', 'error'); }
    finally { setBusy(false); }
  }

  if (cats === null) return <Loading />;
  const inp = 'px-2 py-1.5 rounded-lg border border-line bg-bg text-sm';

  return (
    <main className="page">
      <h1 className="t-page mb-1">표준 코드셋 반입</h1>
      <p className="t-meta text-ink-2 mb-4">
        발행기관 개정판을 통째로 갈아 끼웁니다. <b>반입은 항상 초안</b>으로 들어오고, 활성 버전과의 차이를 확인한 뒤에만 활성화됩니다.
      </p>
      {err && <ErrorText message={err} />}

      {cats.length > 1 && (
        <div className="flex gap-2 mb-4">
          {cats.map((c) => (
            <button key={c.catalogId} onClick={() => { setSel(c.catalogId); setDiff(null); }}
              className={`px-3 py-1.5 r-ctl text-sm font-semibold ${sel === c.catalogId ? 'bg-teal text-white' : 'border border-line text-ink-2'}`}>{c.label}</button>
          ))}
        </div>
      )}

      {cat && (
        <>
          <section className="card mb-4">
            <h2 className="t-section mb-1">{cat.label}</h2>
            <p className="t-micro text-ink-3 leading-relaxed mb-3">{cat.help}</p>
            {!cat.activeVersion && (
              <p className="t-meta text-warn mb-3">
                활성 버전이 없어 <b>코드 내장 스타터셋</b>으로 판정하고 있습니다 — 검사실이 쓰는 개정판을 반입하세요.
              </p>
            )}

            <div className="flex flex-wrap gap-2 items-end mb-2">
              <div><label htmlFor="c-ver" className="block t-micro mb-0.5">버전 *</label>
                <input id="c-ver" value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} placeholder="CLSI-M100-2025" className={`${inp} w-44 mono`} /></div>
              <div><label htmlFor="c-std" className="block t-micro mb-0.5">보고서 표기명</label>
                <input id="c-std" value={form.standard} onChange={(e) => setForm({ ...form, standard: e.target.value })} placeholder="CLSI M100 35th ed." className={`${inp} w-52`} /></div>
              <div><label htmlFor="c-eff" className="block t-micro mb-0.5">적용일</label>
                <input id="c-eff" type="date" value={form.effectiveDate} onChange={(e) => setForm({ ...form, effectiveDate: e.target.value })} className={`${inp} text-xs`} /></div>
              <div className="flex-1 min-w-[10rem]"><label htmlFor="c-note" className="block t-micro mb-0.5">비고</label>
                <input id="c-note" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} className={`${inp} w-full`} /></div>
            </div>
            <label htmlFor="c-csv" className="block t-micro mb-0.5">CSV — 헤더 {cat.columns.join(', ')}</label>
            <textarea id="c-csv" value={form.csv} onChange={(e) => setForm({ ...form, csv: e.target.value })} rows={8}
              placeholder={cat.sample} className={`${inp} w-full mono text-xs`} />
            <div className="flex gap-2 items-center mt-2">
              <button onClick={doImport} disabled={busy} className="py-1.5 px-3 rounded-lg bg-indigo text-white font-semibold text-xs disabled:opacity-50">초안 반입</button>
              <button onClick={() => setForm({ ...form, csv: cat.sample })} className="t-micro text-teal underline">예시 채우기</button>
              <span className="t-micro text-ink-3">한 줄이라도 형식이 틀리면 반입되지 않고 몇 행이 왜 틀렸는지 알려줍니다.</span>
            </div>
          </section>

          {items && (
            <section className="card mb-4">
              <div className="flex items-center justify-between mb-1">
                <h2 className="t-section">{items.version} 전체 항목 <span className="t-micro text-ink-3 font-normal">{items.rows.length}건</span></h2>
                <button onClick={() => setItems(null)} className="t-micro text-ink-3 hover:text-ink">닫기 ✕</button>
              </div>
              <div className="max-h-80 overflow-y-auto">
                <ul className="flex flex-col gap-0.5">
                  {items.rows.map((r, i) => (
                    <li key={i} className="t-micro mono"><span className="text-ink-3">{String(r.key)}</span>: {fmtItem(sel, r)}</li>
                  ))}
                </ul>
              </div>
            </section>
          )}

          {diff && (
            <section className="card mb-4">
              <h2 className="t-section mb-1">{diff.version} 차이 <span className="t-micro text-ink-3 font-normal">기준 {diff.d.comparedTo}</span></h2>
              {diff.d.baselineIsStarter && <p className="t-micro text-warn mb-2">활성 버전이 없어 코드 스타터셋과 비교했습니다.</p>}
              <p className="t-meta mb-2">
                추가 <b className="text-good">{diff.d.added.length}</b> · 변경 <b className="text-warn">{diff.d.changed.length}</b> ·
                삭제 <b className="text-crit">{diff.d.removed.length}</b> · 동일 {diff.d.unchanged}
              </p>
              {diff.d.changed.length > 0 && (
                <div className="mb-2">
                  <p className="t-micro font-semibold text-warn mb-1">변경 — 같은 입력이라도 판정·검증 결과가 달라집니다</p>
                  <ul className="flex flex-col gap-0.5">
                    {diff.d.changed.map((c) => (
                      <li key={c.key} className="t-micro mono">
                        {c.key}: <span className="text-ink-3">{fmtItem(sel, c.before)}</span> → <b>{fmtItem(sel, c.after)}</b>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {diff.d.removed.length > 0 && (
                <div className="mb-2">
                  <p className="t-micro font-semibold text-crit mb-1">삭제 — 이 항목은 자동 판정/검증에서 빠집니다</p>
                  <ul className="flex flex-col gap-0.5">{diff.d.removed.map((c) => <li key={c.key} className="t-micro mono">{c.key} ({fmtItem(sel, c.before)})</li>)}</ul>
                </div>
              )}
              {diff.d.added.length > 0 && (
                <details>
                  <summary className="t-micro text-good cursor-pointer">추가 {diff.d.added.length}건 보기</summary>
                  <ul className="flex flex-col gap-0.5 mt-1">{diff.d.added.map((c) => <li key={c.key} className="t-micro mono">{c.key} ({fmtItem(sel, c.after)})</li>)}</ul>
                </details>
              )}
            </section>
          )}

          <section className="card">
            <h2 className="t-section mb-2">버전 이력</h2>
            {cat.versions.length === 0 ? (
              <p className="t-meta text-ink-3">반입된 버전이 없습니다.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left t-micro text-ink-2 border-b border-line">
                    <th className="py-1.5">버전</th><th>표기명</th><th>적용일</th><th>항목</th><th>상태</th><th>반입</th><th>활성화</th><th></th>
                  </tr></thead>
                  <tbody>
                    {cat.versions.map((v) => (
                      <tr key={v.version} className="border-b border-line last:border-0">
                        <td className="py-1.5 mono">{v.version}{v.note && <span className="block not-mono t-micro text-ink-3 font-normal" title={v.note}>{v.note.length > 24 ? `${v.note.slice(0, 24)}…` : v.note}</span>}</td>
                        <td className="text-ink-2">{v.standard ?? '—'}</td>
                        <td className="text-ink-2">{v.effectiveDate ?? '—'}</td>
                        <td className="mono">{v.itemCount}</td>
                        <td>
                          <span className={`px-1.5 py-0.5 r-chip t-micro ${v.status === 'ACTIVE' ? 'bg-good/15 text-good' : v.status === 'DRAFT' ? 'bg-indigo/15 text-indigo' : 'bg-bg text-ink-3'}`}>
                            {v.status === 'ACTIVE' ? '활성' : v.status === 'DRAFT' ? '초안' : '이전'}
                          </span>
                        </td>
                        <td className="t-micro text-ink-3">{v.importedDt.slice(0, 10)}{v.importedBy ? ` · ${v.importedBy}` : ''}</td>
                        <td className="t-micro text-ink-3">{v.activatedDt ? `${v.activatedDt.slice(0, 10)}${v.activatedBy ? ` · ${v.activatedBy}` : ''}` : '—'}</td>
                        <td className="text-right whitespace-nowrap">
                          <button onClick={() => viewItems(v.version)} className="t-micro text-teal underline mr-2">항목</button>
                          <button onClick={() => showDiff(v.version)} className="t-micro text-teal underline mr-2">차이</button>
                          {v.status !== 'ACTIVE' && (
                            <button onClick={() => activate(v.version)} disabled={busy} className="t-micro border border-line r-chip px-1.5 py-0.5 hover:border-teal hover:text-teal disabled:opacity-50 mr-1">활성화</button>
                          )}
                          {v.status === 'DRAFT' && (
                            <button onClick={() => deleteDraft(v.version)} disabled={busy} className="t-micro border border-line r-chip px-1.5 py-0.5 text-ink-3 hover:border-crit hover:text-crit disabled:opacity-50">삭제</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="t-micro text-ink-3 mt-2">이전 버전은 지우지 않고 남깁니다 — 지난 보고서가 어느 기준으로 판정됐는지 나중에 소명할 수 있어야 합니다.</p>
          </section>
        </>
      )}
    </main>
  );
}
