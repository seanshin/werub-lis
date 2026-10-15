'use client';

/**
 * AttachmentPanel.tsx — 웹 공용 컴포넌트.
 *
 * 제공: AttachmentPanel.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { apiFetch, apiUpload, apiBlob, getRoles } from '@/lib/api';
import { useToast } from '@/components/toast';
import { useConfirm } from '@/components/confirm';

interface Attachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  note: string | null;
  uploadedBy: string | null;
  uploadedDt: string;
}

const WRITE_ROLES = ['TEC', 'PHY', 'MIC', 'PAT', 'ADM'];
const GEN_WRITE_ROLES = ['GEN', 'GC', 'PHY', 'ADM'];
const BB_WRITE_ROLES = ['BB', 'PHY', 'ADM'];
const EQA_WRITE_ROLES = ['TEC', 'PHY', 'MIC', 'ADM'];
const fmtSize = (n: number) => (n < 1024 ? `${n}B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)}KB` : `${(n / 1024 / 1024).toFixed(1)}MB`);
const isImage = (m: string) => m.startsWith('image/');

/**
 * 검사결과 첨부 문서(PDF·이미지) 패널 — 검체(specimenNo)·병리 케이스(spNo)·유전체 오더(genomicOrderId) 단위.
 * 문서 기반 결과 수집 지원(수탁 PDF·비협조 장비 원본). compact=true 시 업로드 없이 목록만(읽기 화면용).
 */
export default function AttachmentPanel({ specimenNo, spNo, genomicOrderId, reactionId, eqaId, reportId, compact }: { specimenNo?: string; spNo?: string; genomicOrderId?: string; reactionId?: string; eqaId?: string; reportId?: string; compact?: boolean }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [list, setList] = useState<Attachment[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const writeRoles = genomicOrderId ? GEN_WRITE_ROLES : reactionId ? BB_WRITE_ROLES : eqaId ? EQA_WRITE_ROLES : WRITE_ROLES;
  const canWrite = !compact && getRoles().some((r) => writeRoles.includes(r));

  // 소유자별 컬렉션 경로(검체 → 유전체 → 수혈 이상반응 → EQA → 법정감염병 신고 → 병리 케이스)
  const ownerPath = specimenNo
    ? `/api/v1/results/specimens/${encodeURIComponent(specimenNo)}/attachments`
    : genomicOrderId
    ? `/api/v1/results/genomic/${encodeURIComponent(genomicOrderId)}/attachments`
    : reactionId
    ? `/api/v1/results/transfusion-reactions/${encodeURIComponent(reactionId)}/attachments`
    : eqaId
    ? `/api/v1/results/eqa/${encodeURIComponent(eqaId)}/attachments`
    : reportId
    ? `/api/v1/results/notifiable/${encodeURIComponent(reportId)}/attachments`
    : `/api/v1/results/pathology/${encodeURIComponent(spNo ?? '')}/attachments`;

  const load = useCallback(async () => {
    try { setList(await apiFetch<Attachment[]>(ownerPath)); }
    catch { /* noop */ }
  }, [ownerPath]);

  useEffect(() => { load(); }, [load]);

  async function upload() {
    const f = fileRef.current?.files?.[0];
    if (!f) { toast('파일을 선택하세요', 'info'); return; }
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', f);
      if (note.trim()) form.append('note', note.trim());
      await apiUpload(ownerPath, form);
      toast(`첨부 완료: ${f.name}`, 'success');
      setNote('');
      if (fileRef.current) fileRef.current.value = '';
      await load();
    } catch (e) { toast(e instanceof Error ? e.message : '업로드 실패', 'error'); }
    finally { setBusy(false); }
  }

  async function view(a: Attachment) {
    try {
      const blob = await apiBlob(`/api/v1/results/attachments/${a.attachmentId}/download`);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) { toast(e instanceof Error ? e.message : '열기 실패', 'error'); }
  }

  async function remove(a: Attachment) {
    if (!(await confirm({ title: '첨부 삭제', message: '이 문서를 삭제합니다.', detail: [{ label: '파일', value: a.filename }], danger: true, confirmLabel: '삭제' }))) return;
    try {
      await apiFetch(`/api/v1/results/attachments/${a.attachmentId}`, { method: 'DELETE' });
      toast('삭제됨', 'success');
      await load();
    } catch (e) { toast(e instanceof Error ? e.message : '삭제 실패', 'error'); }
  }

  return (
    <section className="card mt-4">
      <h2 className="font-bold text-sm mb-1">검사결과 문서 · 이미지 첨부</h2>
      <p className="text-xs text-ink-3 mb-3">외부검사 결과지, 비협조 장비 원본 리포트, 슬라이드 이미지 등(PDF·PNG·JPEG·WEBP, ≤20MB).</p>

      {canWrite && (
        <div className="flex flex-wrap gap-2 items-center mb-3">
          <input ref={fileRef} type="file" aria-label="첨부 파일 선택" accept="application/pdf,image/png,image/jpeg,image/webp"
            className="text-xs file:mr-2 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-teal/10 file:text-teal file:text-xs file:font-semibold" />
          <input aria-label="첨부 설명" value={note} onChange={(e) => setNote(e.target.value)} placeholder="설명(선택)"
            className="px-2 py-1.5 rounded-lg border border-line bg-bg text-sm flex-1 min-w-[8rem]" />
          <button onClick={upload} disabled={busy} className="py-1.5 px-4 rounded-lg bg-teal text-white font-semibold text-sm disabled:opacity-50">
            {busy ? '업로드중…' : '첨부'}
          </button>
        </div>
      )}

      {list.length === 0 ? (
        <p className="text-xs text-ink-3 py-2">첨부된 문서가 없습니다.</p>
      ) : (
        <ul className="divide-y divide-line">
          {list.map((a) => (
            <li key={a.attachmentId} className="flex items-center gap-2 py-2">
              <span className="text-lg" aria-hidden>{isImage(a.mimeType) ? '🖼️' : '📄'}</span>
              <div className="min-w-0 flex-1">
                <button onClick={() => view(a)} className="text-sm font-medium text-teal hover:underline truncate max-w-full block text-left">{a.filename}</button>
                <div className="text-[11px] text-ink-3">
                  {fmtSize(a.sizeBytes)}
                  {a.note ? ` · ${a.note}` : ''}
                  {a.uploadedBy ? ` · ${a.uploadedBy}` : ''}
                  {` · ${a.uploadedDt.slice(0, 16).replace('T', ' ')}`}
                </div>
              </div>
              <button onClick={() => view(a)} className="text-xs px-2 py-1 rounded-lg border border-line text-ink-2 hover:border-teal">보기</button>
              {canWrite && <button onClick={() => remove(a)} className="text-xs px-2 py-1 rounded-lg border border-line text-crit hover:bg-crit/10">삭제</button>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
