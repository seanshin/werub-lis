'use client';

/**
 * 개시 전환 센터 (`/admin/golive`).
 *
 * 사이드바 노출 역할: ADM, AUD.
 * ⚠ 노출 역할과 화면이 호출하는 API 권한이 어긋나면 전부 403인 죽은 화면이 된다 —
 *   역할을 바꿀 때는 `Sidebar.tsx`(정본)와 API 권한 매트릭스를 함께 본다.
 * 데이터는 `lib/api.ts`의 `apiFetch`로만 가져온다(HTTP 호출 정본).
 *
 * 이 화면이 답하는 질문: **개시까지 무엇이 남았고, 지금 무엇을 할 수 있는가.**
 * 상태 판정은 화면이 하지 않는다 — 서버가 준 status를 그대로 보여준다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, apiUpload, apiDownload, getToken } from '@/lib/api';
import { Loading, ErrorText, PageHeader, Section, TableSkeleton } from '@/components/ui';
import { useToast } from '@/components/toast';
import CutoverPanel from './CutoverPanel';

type Status = 'OPEN' | 'DONE' | 'NA' | 'UNKNOWN';
interface Item {
  code: string; phase: string; group: string; title: string; owner: string;
  blocking: boolean; evidence: string; status: Status; autoJudged: boolean;
  autoStatus: string | null; detail: string | null; note: string | null; naReason: string | null;
  completedBy: string | null; completedDt: string | null;
  blockedBy: string[]; irreversible?: boolean; docRef?: string; hint?: string;
  attachments: number;
}
interface KeyRow { key: string; label: string; blocking: boolean; fix: string | null; status: string; detail: string | null; gate: string }
interface Attach {
  attachmentId: string; category: string; filename: string; sizeBytes: number;
  sha256: string; uploadedBy: string | null; uploadedDt: string;
}
interface Excluded { code: string; title: string; blocking: boolean; requires: string[] }
interface Checklist {
  registryVersion: string;
  site: { siteCode: string; siteName: string | null; capabilities: string[]; configured: boolean };
  excluded: Excluded[]; excludedBlocking: number;
  summary: { total: number; done: number; open: number; blockingOpen: number; na: number; canApprove: boolean };
  phases: { phase: string; items: Item[] }[];
}

const PHASE_LABEL: Record<string, string> = { PREP: '준비(개시 전)', CUTOVER: '전환 당일', POST: '개시 직후 검증' };
const PHASE_HINT: Record<string, string> = {
  PREP: '값·결재·회신 — 대부분 외부 부서 몫이다',
  CUTOVER: '되돌리기 어려운 1회성 작업. 순서를 지킨다',
  POST: '전환이 실제로 성립했는지 확인한다',
};

function tone(s: Status): string {
  if (s === 'DONE') return 'bg-good/10 text-good';
  if (s === 'NA') return 'bg-bg text-ink-3';
  if (s === 'UNKNOWN') return 'bg-warn/10 text-warn';
  return 'bg-crit/10 text-crit';
}
const STATUS_LABEL: Record<Status, string> = { DONE: '완료', OPEN: '미완', NA: '해당없음', UNKNOWN: '미판정' };

export default function GoLivePage() {
  const router = useRouter();
  const toast = useToast();
  const [data, setData] = useState<Checklist | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [tab, setTab] = useState<'checklist' | 'keys' | 'cutover'>('checklist');
  const [openDocs, setOpenDocs] = useState<string | null>(null);
  const [docs, setDocs] = useState<Record<string, Attach[]>>({});
  const [keys, setKeys] = useState<KeyRow[] | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try { setData(await apiFetch<Checklist>('/api/v1/admin/golive/checklist')); }
    catch (e) { setErr(e instanceof Error ? e.message : '조회 실패'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { if (!getToken()) { router.push('/'); return; } void load(); }, [router, load]);

  useEffect(() => {
    if (tab !== 'keys' || keys) return;
    void apiFetch<{ keys: KeyRow[] }>('/api/v1/admin/golive/keys')
      .then((r) => setKeys(r.keys))
      .catch((e) => toast(e instanceof Error ? e.message : '키 조회 실패', 'error'));
  }, [tab, keys, toast]);

  async function setStatus(item: Item, status: 'OPEN' | 'DONE' | 'NA') {
    let naReason: string | undefined;
    if (status === 'NA') {
      const r = window.prompt(`"${item.title}"을(를) 해당없음으로 처리합니다.\n사유를 입력하세요(필수 — 나중에 왜 뺐는지 답할 수 있어야 합니다).`);
      if (!r?.trim()) return;
      naReason = r.trim();
    }
    setBusy(item.code);
    try {
      await apiFetch(`/api/v1/admin/golive/tasks/${encodeURIComponent(item.code)}`, {
        method: 'POST', body: JSON.stringify({ status, naReason }),
      });
      toast(`${item.code} → ${STATUS_LABEL[status]}`, 'success');
      await load();
    } catch (e) { toast(e instanceof Error ? e.message : '변경 실패', 'error'); }
    finally { setBusy(''); }
  }

  async function upload(item: Item, file: File) {
    // 근거 원본은 시스템 안에 둔다 — 문서번호 문자열만으로는 결재가 실재했는지 소명할 수 없다.
    const fd = new FormData();
    fd.append('file', file);
    fd.append('taskCode', item.code);
    fd.append('category', item.code.startsWith('E') ? 'APPROVAL' : item.code.startsWith('H') ? 'LEGAL' : 'EVIDENCE');
    setBusy(item.code);
    try {
      await apiUpload('/api/v1/admin/golive/attachments', fd);
      toast(`${item.code} 근거 문서 첨부: ${file.name}`, 'success');
      await load();
    } catch (e) { toast(e instanceof Error ? e.message : '첨부 실패', 'error'); }
    finally { setBusy(''); }
  }

  /** 근거 문서 목록 — 올린 증빙을 화면에서 확인할 수 있어야 감사 대응이 된다. */
  async function toggleDocs(code: string) {
    setOpenDocs((c) => (c === code ? null : code));
    if (docs[code]) return;
    try {
      const r = await apiFetch<{ total: number; rows: Attach[] }>(`/api/v1/admin/golive/attachments?taskCode=${encodeURIComponent(code)}`);
      setDocs((m) => ({ ...m, [code]: r.rows }));
    } catch (e) { toast(e instanceof Error ? e.message : '문서 조회 실패', 'error'); }
  }

  /** 다운로드 — 무결성 헤더를 읽어 **교체된 파일이면 경고**한다(헤더만으로는 아무도 모른다). */
  async function openDoc(a: Attach) {
    try {
      const { blob, integrity } = await apiDownload(`/api/v1/admin/golive/attachments/${encodeURIComponent(a.attachmentId)}/download`);
      if (integrity === 'MISMATCH') {
        toast(`⚠ 무결성 불일치 — 저장 후 원본이 교체됐습니다(${a.filename}). 증빙으로 쓸 수 없습니다`, 'error');
      }
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) { toast(e instanceof Error ? e.message : '다운로드 실패', 'error'); }
  }

  async function removeDoc(code: string, a: Attach) {
    if (!window.confirm(`근거 문서를 삭제합니다: ${a.filename}\n감사 기록에 남습니다. 계속할까요?`)) return;
    try {
      await apiFetch(`/api/v1/admin/golive/attachments/${encodeURIComponent(a.attachmentId)}`, { method: 'DELETE' });
      toast('삭제됨', 'success');
      setDocs((m) => ({ ...m, [code]: (m[code] ?? []).filter((x) => x.attachmentId !== a.attachmentId) }));
      await load();
    } catch (e) { toast(e instanceof Error ? e.message : '삭제 실패', 'error'); }
  }

  async function exportSnapshot() {
    try {
      const snap = await apiFetch<Record<string, unknown>>('/api/v1/admin/golive/export');
      const blob = new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = `golive-readiness_${data?.site.siteCode ?? 'site'}_${new Date().toISOString().slice(0, 10)}.json`;
      a.click(); URL.revokeObjectURL(a.href);
      toast('준비도 내보냄(환자정보 미포함)', 'success');
    } catch (e) { toast(e instanceof Error ? e.message : '내보내기 실패', 'error'); }
  }

  return (
    <main className="page">
      <PageHeader
        title="개시 전환 센터"
        hint="개시까지 남은 항목을 한곳에서 본다. 상태는 서버가 판정하며, 자동 판정 항목은 수동으로 완료할 수 없다."
        action={
          <div className="flex items-center gap-2">
            {tab === 'checklist' && (
              <button onClick={() => setOnlyOpen((v) => !v)}
                className={`text-xs px-2 py-1 rounded border ${onlyOpen ? 'border-crit/50 text-crit bg-crit/5' : 'border-line text-ink-2'}`}>
                미완만
              </button>
            )}
            <button onClick={exportSnapshot} className="text-xs px-2 py-1 rounded border border-line text-ink-2">준비도 내보내기</button>
            <button onClick={load} className="text-xs text-teal underline">새로고침</button>
          </div>
        }
      />
      <div className="flex gap-1 mb-3">
        {([['checklist', '체크리스트'], ['keys', '개시 키'], ['cutover', '전환 실행']] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-3 py-1.5 r-ctl text-sm font-semibold m-hover ${tab === k ? 'bg-teal text-white' : 'border border-line text-ink-2 hover:border-teal hover:text-teal'}`}>
            {label}
          </button>
        ))}
      </div>

      {err && <ErrorText message={err} />}
      {/* 스켈레톤은 체크리스트 탭 안에서만 — 전에는 로딩 중 전체를 대체해
          체크리스트 조회가 실패하면 다른 탭에 영영 도달하지 못했다. */}
      {tab === 'checklist' && loading && !data && <TableSkeleton rows={6} cols={4} />}
      {tab === 'checklist' && loading && data && <Loading />}

      {tab === 'cutover' && <CutoverPanel />}

      {tab === 'keys' && (
        <Section title="개시 필수 키" hint="값은 여기서 다루지 않는다 — /admin/settings에서 입력하고, 여기서는 판정만 본다">
          <div className="flex flex-col gap-1.5">
            {(keys ?? []).map((k) => (
              <div key={k.key} className="border border-line rounded-lg p-2.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded ${
                    k.status === 'OK' ? 'bg-good/10 text-good' : k.status === 'BLOCK' ? 'bg-crit/10 text-crit'
                      : k.status === 'SEED' ? 'bg-indigo/10 text-indigo' : 'bg-warn/10 text-warn'}`}>
                    {k.status}
                  </span>
                  <span className="mono text-xs text-ink-3">{k.key}</span>
                  <span className="text-sm font-semibold">{k.label}</span>
                  {k.blocking && <span className="text-[11px] font-bold text-crit">개시 차단</span>}
                  {k.fix && <a href={k.fix} className="text-xs text-teal underline ml-auto">설정으로</a>}
                </div>
                {k.detail && <p className="t-meta mt-1">{k.detail}</p>}
                <p className="text-xs text-ink-3 mt-1">{k.gate}</p>
              </div>
            ))}
            {!keys && <p className="t-meta">불러오는 중…</p>}
          </div>
        </Section>
      )}

      {tab === 'checklist' && data && (
        <>
          <section className="card mb-4">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="px-2 py-0.5 rounded bg-bg text-ink-2">
                사이트 <b className="mono">{data.site.siteCode}</b>
                {!data.site.configured && <span className="text-warn ml-1">(프로파일 미설정 — 전 기능 활성으로 간주)</span>}
              </span>
              {data.summary.blockingOpen > 0
                ? <span className="px-2 py-0.5 rounded bg-crit/15 text-crit font-bold">개시 차단 {data.summary.blockingOpen}</span>
                : <span className="px-2 py-0.5 rounded bg-good/15 text-good font-bold">차단 없음</span>}
              <span className="px-2 py-0.5 rounded bg-good/10 text-good font-semibold">완료 {data.summary.done}/{data.summary.total}</span>
              {data.summary.na > 0 && <span className="px-2 py-0.5 rounded bg-bg text-ink-3">해당없음 {data.summary.na}</span>}
              <span className="text-xs text-ink-3 ml-auto">레지스트리 v{data.registryVersion}</span>
            </div>
            {data.excludedBlocking > 0 && (
              <p className="text-xs text-crit font-bold mt-2">
                ⚠ 이 사이트 구성(기능: {data.site.capabilities.join('·') || '없음'})이 <b>개시 차단 {data.excludedBlocking}건을 제외</b>하고 있습니다 —{' '}
                {data.excluded.filter((e) => e.blocking).map((e) => `${e.code} ${e.title}`).join(' · ')}.
                해당 기능을 실제로 쓰지 않는 경우에만 정상입니다.
              </p>
            )}
            {data.excluded.length > 0 && data.excludedBlocking === 0 && (
              <p className="t-meta mt-2">
                미사용 기능으로 제외된 항목 {data.excluded.length}건(개시 차단 아님):{' '}
                {data.excluded.map((e) => e.code).join(' · ')}
              </p>
            )}
            {!data.summary.canApprove && (
              <p className="t-meta mt-2">
                개시 승인은 <b>차단 항목이 0</b>일 때 가능하다. 잔존 상태에서 강행하려면 운영관리콘솔에서 사유·잔여위험을 기록해야 한다.
              </p>
            )}
          </section>

          {data.phases.map((p) => {
            const items = onlyOpen ? p.items.filter((i) => i.status !== 'DONE' && i.status !== 'NA') : p.items;
            if (items.length === 0) return null;
            return (
              <Section key={p.phase} title={PHASE_LABEL[p.phase] ?? p.phase} hint={PHASE_HINT[p.phase]}>
                <div className="flex flex-col gap-1.5">
                  {items.map((i) => (
                    <div key={i.code} className="border border-line rounded-lg p-2.5">
                      <div className="flex items-start gap-2 flex-wrap">
                        <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded shrink-0 ${tone(i.status)}`}>
                          {STATUS_LABEL[i.status]}
                        </span>
                        <span className="mono text-xs text-ink-3 shrink-0">{i.code}</span>
                        <span className="text-sm font-semibold">{i.title}</span>
                        {i.blocking && <span className="text-[11px] font-bold text-crit">개시 차단</span>}
                        {i.irreversible && <span className="text-[11px] font-bold text-crit">비가역</span>}
                        {i.autoJudged && <span className="text-[11px] text-indigo">자동 판정</span>}
                        <span className="text-xs text-ink-3 ml-auto">{i.owner}</span>
                      </div>

                      {(i.detail || i.hint) && (
                        <p className="t-meta mt-1">{i.detail ?? i.hint}</p>
                      )}
                      {i.blockedBy.length > 0 && (
                        <p className="text-xs text-warn mt-1">선행 미완: {i.blockedBy.join(' · ')}</p>
                      )}
                      {i.naReason && <p className="text-xs text-ink-3 mt-1">해당없음 사유: {i.naReason}</p>}
                      {i.completedDt && (
                        <p className="text-xs text-ink-3 mt-1">
                          완료 {new Date(i.completedDt).toLocaleString('ko-KR')} · {i.completedBy ?? '-'}
                        </p>
                      )}
                      {i.docRef && <p className="text-xs text-ink-3 mt-1 mono">{i.docRef}</p>}
                      {i.evidence !== 'NONE' && (
                        <p className="text-xs mt-1">
                          <span className={i.attachments > 0 ? 'text-good' : i.evidence === 'DOC_REQUIRED' ? 'text-crit' : 'text-ink-3'}>
                            근거 문서 {i.attachments}건
                            {i.evidence === 'DOC_REQUIRED' && i.attachments === 0 && ' — 첨부해야 완료할 수 있습니다'}
                          </span>
                          <label className="ml-2 underline text-teal cursor-pointer">
                            첨부
                            <input type="file" className="hidden" accept="application/pdf,image/png,image/jpeg,image/webp"
                              onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(i, f); e.target.value = ''; }} />
                          </label>
                          {i.attachments > 0 && (
                            <button onClick={() => toggleDocs(i.code)} className="ml-2 underline text-teal">
                              {openDocs === i.code ? '문서 닫기' : '문서 보기'}
                            </button>
                          )}
                        </p>
                      )}
                      {openDocs === i.code && (
                        <div className="mt-1.5 border-t border-line pt-1.5 flex flex-col gap-1">
                          {(docs[i.code] ?? []).map((a) => (
                            <div key={a.attachmentId} className="flex items-center gap-2 text-xs flex-wrap">
                              <span className="px-1.5 py-0.5 rounded bg-bg text-ink-3">{a.category}</span>
                              <button onClick={() => openDoc(a)} className="underline text-teal">{a.filename}</button>
                              <span className="text-ink-3">{Math.round(a.sizeBytes / 1024)}KB</span>
                              <span className="text-ink-3 mono" title={`sha256 ${a.sha256}`}>{a.sha256.slice(0, 8)}…</span>
                              <span className="text-ink-3">{a.uploadedBy ?? '-'} · {new Date(a.uploadedDt).toLocaleDateString('ko-KR')}</span>
                              <button onClick={() => removeDoc(i.code, a)} className="text-crit underline ml-auto">삭제</button>
                            </div>
                          ))}
                          {(docs[i.code] ?? []).length === 0 && <p className="text-xs text-ink-3">불러오는 중…</p>}
                        </div>
                      )}

                      {!i.autoJudged && (
                        <div className="flex gap-1.5 mt-2">
                          {i.status !== 'DONE' && (
                            <button disabled={busy === i.code} onClick={() => setStatus(i, 'DONE')}
                              className="text-xs px-2 py-1 rounded border border-good/40 text-good font-semibold disabled:opacity-50">완료</button>
                          )}
                          {i.status !== 'NA' && (
                            <button disabled={busy === i.code} onClick={() => setStatus(i, 'NA')}
                              className="text-xs px-2 py-1 rounded border border-line text-ink-2 disabled:opacity-50">해당없음</button>
                          )}
                          {i.status !== 'OPEN' && (
                            <button disabled={busy === i.code} onClick={() => setStatus(i, 'OPEN')}
                              className="text-xs px-2 py-1 rounded border border-line text-ink-2 disabled:opacity-50">되돌리기</button>
                          )}
                        </div>
                      )}
                      {i.autoJudged && (
                        <p className="text-xs text-ink-3 mt-1.5">
                          시스템이 판정한다 — 실제 상태를 바꾸면 반영된다(수동 완료 불가).
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </Section>
            );
          })}
        </>
      )}
    </main>
  );
}
