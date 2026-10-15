'use client';

/**
 * 진단 · SNOMED 코드 관리 화면 (`/admin/terminology`).
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
import { useToast } from '@/components/toast';
import { Loading, EmptyState } from '@/components/ui';
import { csvToObjects } from '@/lib/csv';

interface Term {
  codeId: string;
  system: string;
  code: string;
  term: string;
  termKo: string | null;
  category: string | null;
  status: string;
  createdBy: string | null;
  createdDt: string | null;
}

const inp = 'px-2 py-1.5 rounded-lg border border-line bg-bg text-sm';
const SYSTEMS = ['SNOMED', 'ICD-O', 'LOCAL'];
const CATS = [
  { v: '', l: '(구분 없음)' },
  { v: 'MORPHOLOGY', l: '형태(Morphology)' },
  { v: 'TOPOGRAPHY', l: '부위(Topography)' },
  { v: 'DIAGNOSIS', l: '진단(Diagnosis)' },
];
const CAT_LABEL: Record<string, string> = { MORPHOLOGY: '형태', TOPOGRAPHY: '부위', DIAGNOSIS: '진단' };
const EMPTY = { system: 'SNOMED', code: '', term: '', termKo: '', category: '' };

export default function TerminologyAdminPage() {
  const router = useRouter();
  const toast = useToast();
  const [list, setList] = useState<Term[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [fSystem, setFSystem] = useState('');
  const [fCat, setFCat] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [nw, setNw] = useState({ ...EMPTY });
  const [edit, setEdit] = useState<Term | null>(null);
  const [bulk, setBulk] = useState('');
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkResult, setBulkResult] = useState<{ total: number; imported: number; updated: number; errors: { row: number; code: string; error: string }[] } | null>(null);
  const roles = getRoles();
  const canWrite = roles.includes('ADM');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set('q', q.trim());
      if (fSystem) params.set('system', fSystem);
      if (fCat) params.set('category', fCat);
      if (fStatus) params.set('status', fStatus);
      const res = await apiFetch<Term[]>(`/api/v1/terminology/list?${params.toString()}`);
      setList(res ?? []);
    } catch (e) { toast(e instanceof Error ? e.message : '조회 실패', 'error'); }
    finally { setLoading(false); }
  }, [q, fSystem, fCat, fStatus, toast]);

  useEffect(() => { if (!getToken()) router.push('/'); else load(); }, [router, load]);

  async function register() {
    if (!nw.code.trim() || !nw.term.trim()) { toast('코드·용어는 필수입니다', 'info'); return; }
    try {
      await apiFetch('/api/v1/terminology', { method: 'POST', body: JSON.stringify({ ...nw, category: nw.category || undefined, termKo: nw.termKo || undefined }) });
      toast(`코드 등록됨 · ${nw.code}`, 'success');
      setNw({ ...EMPTY, system: nw.system });
      await load();
    } catch (e) { toast(e instanceof Error ? e.message : '등록 실패(중복 코드 등)', 'error'); }
  }

  async function saveEdit() {
    if (!edit) return;
    try {
      await apiFetch(`/api/v1/terminology/${edit.codeId}`, { method: 'PUT', body: JSON.stringify({ system: edit.system, code: edit.code, term: edit.term, termKo: edit.termKo ?? '', category: edit.category ?? '' }) });
      toast('수정됨', 'success');
      setEdit(null);
      await load();
    } catch (e) { toast(e instanceof Error ? e.message : '수정 실패', 'error'); }
  }

  async function toggle(t: Term) {
    try {
      await apiFetch(`/api/v1/terminology/${t.codeId}/status`, { method: 'PUT', body: JSON.stringify({ status: t.status === 'USE' ? 'STOP' : 'USE' }) });
      toast(t.status === 'USE' ? '사용 중지됨' : '재개됨', 'success');
      await load();
    } catch (e) { toast(e instanceof Error ? e.message : '변경 실패', 'error'); }
  }

  async function seed() {
    try {
      const res = await apiFetch<{ created: number; total: number }>('/api/v1/terminology/seed-starter', { method: 'POST' });
      toast(`스타터셋 시딩 · 신규 ${res.created}/${res.total}건`, 'success');
      await load();
    } catch (e) { toast(e instanceof Error ? e.message : '시딩 실패', 'error'); }
  }

  // SNOMED/용어 CSV 대량 반입 — 헤더: system,code,term,termKo,category
  async function bulkImport() {
    setBulkResult(null);
    const rows = csvToObjects(bulk).map((o) => ({ system: o.system ?? o.System, code: o.code ?? o.Code, term: o.term ?? o.Term, termKo: o.termKo ?? o.termko ?? o.한글명, category: o.category ?? o.Category }));
    if (rows.length === 0) { toast('CSV 데이터가 없습니다(헤더+행 필요)', 'info'); return; }
    try {
      const r = await apiFetch<typeof bulkResult>('/api/v1/terminology/bulk', { method: 'POST', body: JSON.stringify({ rows }) });
      setBulkResult(r); toast(`반입 완료 · 신규 ${r!.imported}·갱신 ${r!.updated}·오류 ${r!.errors.length}`, r!.errors.length ? 'info' : 'success');
      await load();
    } catch (e) { toast(e instanceof Error ? e.message : '반입 실패', 'error'); }
  }

  return (
    <main className="page">
      <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
        <h1 className="t-page">진단 · SNOMED 코드 관리</h1>
        {canWrite && <div className="flex gap-2">
          <button onClick={() => setBulkOpen((v) => !v)} className="text-xs border border-line rounded-lg px-3 py-1.5 hover:bg-bg">CSV 대량 반입</button>
          <button onClick={seed} className="text-xs border border-line rounded-lg px-3 py-1.5 hover:bg-bg">병리 스타터셋 시딩</button>
        </div>}
      </div>
      {canWrite && bulkOpen && (
        <div className="mt-2 mb-2 rounded-xl border border-line bg-bg p-3">
          <div className="text-[11px] text-ink-3 mb-1">헤더: <span className="mono">system,code,term,termKo,category</span> — KHIS SNOMED 정식셋 CSV 붙여넣기(멱등 upsert)</div>
          <textarea value={bulk} onChange={(e) => setBulk(e.target.value)} rows={4} placeholder={'system,code,term,termKo,category\nSNOMED,M-80703,Squamous cell carcinoma,편평세포암,MORPHOLOGY'} className="w-full mono text-[11px] px-2 py-1 rounded border border-line bg-surface mb-1" />
          <div className="flex items-center gap-2">
            <label className="text-xs text-teal underline cursor-pointer">파일 선택<input type="file" accept=".csv,text/csv,text/plain" className="hidden" aria-label="용어 CSV 파일" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setBulk(await f.text()); e.target.value = ''; }} /></label>
            <button onClick={bulkImport} className="py-1 px-3 rounded-lg bg-teal text-white text-xs font-semibold">반입 실행</button>
          </div>
          {bulkResult && (
            <div className="mt-1 text-xs">
              <span className="text-good">신규 {bulkResult.imported}</span> · <span className="text-teal">갱신 {bulkResult.updated}</span> · <span className={bulkResult.errors.length ? 'text-crit' : 'text-ink-3'}>오류 {bulkResult.errors.length}</span>
              {bulkResult.errors.slice(0, 8).map((er) => <div key={er.row} className="text-crit">행{er.row} {er.code}: {er.error}</div>)}
              {bulkResult.errors.length > 8 && <div className="text-ink-3">…외 {bulkResult.errors.length - 8}건</div>}
            </div>
          )}
        </div>
      )}
      <p className="text-xs text-ink-3 mb-4">병리 판독의 진단·SNOMED 자동완성에 쓰이는 용어 코드 마스터입니다. 전체 SNOMED-CT는 라이선스·대용량이라 실사용 코드를 부서가 큐레이션합니다. 하드 삭제 대신 <b>사용 중지</b>로 판독 이력을 보존합니다.</p>

      {/* 등록 */}
      {canWrite && (
        <section className="card mb-4">
          <h2 className="t-section mb-2 text-sm">코드 등록</h2>
          <div className="flex flex-wrap items-end gap-2">
            <div><label className="block text-xs text-ink-2 mb-1">체계</label><select className={inp} value={nw.system} onChange={(e) => setNw({ ...nw, system: e.target.value })}>{SYSTEMS.map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
            <div><label className="block text-xs text-ink-2 mb-1">코드</label><input aria-label="코드" className={`${inp} mono w-32`} value={nw.code} onChange={(e) => setNw({ ...nw, code: e.target.value })} placeholder="M-80703" /></div>
            <div className="flex-1 min-w-[10rem]"><label className="block text-xs text-ink-2 mb-1">용어(영문/표준)</label><input aria-label="용어(영문/표준)" className={`${inp} w-full`} value={nw.term} onChange={(e) => setNw({ ...nw, term: e.target.value })} placeholder="Squamous cell carcinoma" /></div>
            <div className="min-w-[8rem]"><label className="block text-xs text-ink-2 mb-1">한글명</label><input aria-label="한글명" className={`${inp} w-full`} value={nw.termKo} onChange={(e) => setNw({ ...nw, termKo: e.target.value })} placeholder="편평세포암" /></div>
            <div><label className="block text-xs text-ink-2 mb-1">구분</label><select className={inp} value={nw.category} onChange={(e) => setNw({ ...nw, category: e.target.value })}>{CATS.map((c) => <option key={c.v} value={c.v}>{c.l}</option>)}</select></div>
            <button onClick={register} className="py-1.5 px-4 rounded-lg bg-teal text-white text-sm font-semibold">등록</button>
          </div>
        </section>
      )}

      {/* 검색·필터 */}
      <section className="card">
        <form onSubmit={(e) => { e.preventDefault(); load(); }} className="flex flex-wrap gap-2 mb-3">
          <input aria-label="코드·용어·한글명 검색" className={`${inp} flex-1 min-w-[10rem]`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="코드·용어·한글명 검색" autoComplete="off" />
          <select className={inp} value={fSystem} onChange={(e) => setFSystem(e.target.value)}><option value="">전체 체계</option>{SYSTEMS.map((s) => <option key={s} value={s}>{s}</option>)}</select>
          <select className={inp} value={fCat} onChange={(e) => setFCat(e.target.value)}><option value="">전체 구분</option>{CATS.filter((c) => c.v).map((c) => <option key={c.v} value={c.v}>{c.l}</option>)}</select>
          <select className={inp} value={fStatus} onChange={(e) => setFStatus(e.target.value)}><option value="">전체 상태</option><option value="USE">사용</option><option value="STOP">중지</option></select>
          <button className="py-1.5 px-4 rounded-lg bg-teal text-white text-sm font-semibold">검색</button>
        </form>
        {loading ? <Loading /> : list.length === 0 ? <EmptyState title="코드 없음" hint={canWrite ? '위에서 등록하거나 스타터셋을 시딩하세요.' : '검색어를 바꿔보세요.'} /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-ink-2 border-b border-line"><th className="py-2">체계</th><th>코드</th><th>용어</th><th>한글명</th><th>구분</th><th>등록</th><th>상태</th>{canWrite && <th className="text-right">관리</th>}</tr></thead>
              <tbody>
                {list.map((t) => edit?.codeId === t.codeId ? (
                  <tr key={t.codeId} className="border-b border-line bg-teal/5">
                    <td className="py-1.5"><select className={`${inp} text-xs`} value={edit.system} onChange={(e) => setEdit({ ...edit, system: e.target.value })}>{SYSTEMS.map((s) => <option key={s} value={s}>{s}</option>)}</select></td>
                    <td><input aria-label="코드 수정" className={`${inp} mono text-xs w-28`} value={edit.code} onChange={(e) => setEdit({ ...edit, code: e.target.value })} /></td>
                    <td><input aria-label="용어 수정" className={`${inp} text-xs w-full`} value={edit.term} onChange={(e) => setEdit({ ...edit, term: e.target.value })} /></td>
                    <td><input aria-label="한글명 수정" className={`${inp} text-xs w-24`} value={edit.termKo ?? ''} onChange={(e) => setEdit({ ...edit, termKo: e.target.value })} /></td>
                    <td><select className={`${inp} text-xs`} value={edit.category ?? ''} onChange={(e) => setEdit({ ...edit, category: e.target.value })}>{CATS.map((c) => <option key={c.v} value={c.v}>{c.l}</option>)}</select></td>
                    <td colSpan={3} className="text-right whitespace-nowrap">
                      <button onClick={saveEdit} className="text-xs bg-teal text-white px-2 py-1 rounded-lg mr-1">저장</button>
                      <button onClick={() => setEdit(null)} className="text-xs border border-line px-2 py-1 rounded-lg">취소</button>
                    </td>
                  </tr>
                ) : (
                  <tr key={t.codeId} className={`border-b border-line last:border-0 ${t.status === 'STOP' ? 'opacity-50' : ''}`}>
                    <td className="py-2 text-xs">{t.system}</td>
                    <td className="mono text-xs text-teal">{t.code}</td>
                    <td>{t.term}</td>
                    <td>{t.termKo ?? '—'}</td>
                    <td className="text-xs">{t.category ? (CAT_LABEL[t.category] ?? t.category) : '—'}</td>
                    <td className="text-[11px] text-ink-3">{t.createdBy ?? '—'}{t.createdDt && <span className="block mono">{t.createdDt.slice(0, 10)}</span>}</td>
                    <td><span className={`text-xs px-2 py-0.5 rounded ${t.status === 'USE' ? 'bg-good/15 text-good' : 'bg-bg text-ink-3'}`}>{t.status === 'USE' ? '사용' : '중지'}</span></td>
                    {canWrite && (
                      <td className="text-right whitespace-nowrap">
                        <button onClick={() => setEdit(t)} className="text-xs text-teal underline mr-2">수정</button>
                        <button onClick={() => toggle(t)} className="text-xs underline text-ink-2">{t.status === 'USE' ? '중지' : '재개'}</button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-ink-3 mt-2">최대 500건. 병리 판독 화면의 진단·SNOMED 입력에서 이 마스터가 자동완성됩니다.</p>
      </section>
    </main>
  );
}
