'use client';

/**
 * 알림센터 화면 (`/notifications`).
 *
 * 데이터는 `lib/api.ts`의 `apiFetch`로만 가져온다(HTTP 호출 정본).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, getToken } from '@/lib/api';
import { refreshBadge } from '@/lib/badge';
import { EmptyState, Loading, ErrorText } from '@/components/ui';
import { useToast } from '@/components/toast';
import { IconCheck } from '@/components/Icon';

interface Noti { notifyId: string; ntype: string | null; target: string | null; message: string | null; createdDt: string; ackDt?: string | null; }

export default function NotificationsPage() {
  const router = useRouter();
  const toast = useToast();
  const [items, setItems] = useState<Noti[]>([]);
  const [loading, setLoading] = useState(true);
  const [ntype, setNtype] = useState('');
  const [tab, setTab] = useState<'pending' | 'history'>('pending');
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const path = tab === 'history' ? 'history' : 'pending';
    // ★조회 실패를 삼키면 "미확인 알림이 없습니다"와 구별되지 않는다.
    //   당직자가 위험치·MDRO 알림 장애를 '이상 없음'으로 오인하게 된다.
    try {
      setItems(await apiFetch<Noti[]>(`/api/v1/notifications/${path}${ntype ? `?ntype=${encodeURIComponent(ntype)}` : ''}`));
      setErr('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : '알림 조회 실패 — 목록이 비어 보이는 것은 장애 때문일 수 있습니다');
    } finally { setLoading(false); }
  }, [ntype, tab]);

  useEffect(() => { if (!getToken()) router.push('/'); else load(); }, [router, load]);

  async function ack(id: string) {
    try { await apiFetch(`/api/v1/notifications/${id}/ack`, { method: 'POST', body: '{}' }); toast('확인 처리'); load(); refreshBadge(); }
    catch (e) { toast(e instanceof Error ? e.message : '실패', 'error'); }
  }

  // B9: 표시된 알림 일괄 확인
  async function ackAll() {
    if (items.length === 0) return;
    let ok = 0;
    for (const n of items) { try { await apiFetch(`/api/v1/notifications/${n.notifyId}/ack`, { method: 'POST', body: '{}' }); ok++; } catch { /* skip */ } }
    toast(`${ok}건 확인 처리`); load(); refreshBadge();
  }

  // 실제 발생 알림 유형(백엔드 ntype과 일치) — 정본 목록
  const NTYPES_BASE = ['법정감염병신고', '중대수혈반응', '제제회수추적', 'QC위반', 'MDRO알림', '내성균알림', 'AST검토', '혈액근접만료', '검체거부', '환자재귀속', '위탁지연', '서명변경', '개시승인무효', '연계경보', 'Reflex반려', '동의철회'] as const;
  // 표류 방지: 정본에 없는 ntype이 실제로 와도 필터에서 누락되지 않게 현재 목록의 유형을 합집합.
  const NTYPES = useMemo(() => {
    const seen = new Set<string>(NTYPES_BASE);
    for (const n of items) if (n.ntype) seen.add(n.ntype);
    return [...seen];
  }, [items]); // eslint-disable-line react-hooks/exhaustive-deps
  const typeCls: Record<string, string> = {
    법정감염병신고: 'bg-crit/15 text-crit', // 법정 신고 의무 — 우선 인지
    중대수혈반응: 'bg-crit/15 text-crit',   // 환자에게 이미 일어난 위해 — 조사 착수
    제제회수추적: 'bg-crit/15 text-crit',   // 회수 제제가 이미 들어간 환자 역추적
    QC위반: 'bg-warn/15 text-warn',
    검체거부: 'bg-warn/15 text-warn',       // 매일 발생하는 업무 이상 — 위험색 금지
    환자재귀속: 'bg-warn/20 text-warn',     // 결과 보유 시 사람 판단 필요 — 방치하면 이력 분절
    위탁지연: 'bg-warn/15 text-warn',
    서명변경: 'bg-warn/20 text-warn',       // 서명 소명력 상실 — 업무 이상 중 무거운 쪽
    개시승인무효: 'bg-warn/20 text-warn',
    MDRO알림: 'bg-warn/20 text-warn',
    내성균알림: 'bg-warn/20 text-warn',
    AST검토: 'bg-warn/15 text-warn',
    혈액근접만료: 'bg-warn/15 text-warn',
    연계경보: 'bg-crit/10 text-crit', // HIS/PACS 연계·DLQ·미전달 등 시스템 경보
    Reflex반려: 'bg-indigo/15 text-indigo',
    동의철회: 'bg-indigo/15 text-indigo', // 보고 차단·회수 대상 — 행정 상태(위험색 아님)
  };

  return (
    <main className="page">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <h1 className="t-page">알림센터 <span className="text-sm text-ink-2">({items.length})</span></h1>
          <div className="flex rounded-lg border border-line overflow-hidden text-sm">
            <button onClick={() => setTab('pending')} className={`px-3 py-1 ${tab === 'pending' ? 'bg-teal text-white font-semibold' : 'text-ink-2'}`}>미확인</button>
            <button onClick={() => setTab('history')} className={`px-3 py-1 ${tab === 'history' ? 'bg-teal text-white font-semibold' : 'text-ink-2'}`}>확인이력</button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <select aria-label="알림 유형 필터" value={ntype} onChange={(e) => setNtype(e.target.value)} className="px-2 py-1.5 rounded-lg border border-line bg-bg text-sm">
            <option value="">전체 유형</option>
            {NTYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          {tab === 'pending' && items.length > 0 && <button onClick={ackAll} className="py-1.5 px-3 rounded-lg border border-line text-sm font-semibold">모두 확인</button>}
          <button onClick={load} className="text-sm text-teal underline">새로고침</button>
        </div>
      </div>

      <section className="card">
      {err && <ErrorText message={err} />}

        {loading && items.length === 0 ? <Loading /> : items.length === 0 ? (
          tab === 'history'
            ? <EmptyState title="확인 처리된 알림이 없습니다" hint="확인(ack)한 알림이 여기에 이력으로 남습니다. 확인자는 감사로그에 기록됩니다." />
            : <EmptyState title="미확인 알림이 없습니다" hint="QC 위반·내성균 등 시스템 알림이 여기에 표시됩니다." />
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((n) => (
              <li key={n.notifyId} className="flex items-center justify-between gap-3 border-b border-line pb-2 last:border-0">
                <div className="text-sm">
                  <span className={`px-1.5 py-0.5 rounded text-xs font-bold mr-2 ${typeCls[n.ntype ?? ''] ?? 'bg-bg text-ink-2'}`}>{n.ntype}</span>
                  {n.message} <span className="text-xs text-ink-3">→ {n.target}</span>
                  <span className="block text-xs text-ink-3 mono">
                    발생 {n.createdDt?.slice(0, 16).replace('T', ' ')}
                    {tab === 'history' && n.ackDt && <span className="text-good"> · 확인 {n.ackDt.slice(0, 16).replace('T', ' ')}</span>}
                  </span>
                </div>
                {tab === 'pending'
                  ? <button onClick={() => ack(n.notifyId)} className="py-1 px-3 rounded-lg bg-teal text-white text-xs font-semibold whitespace-nowrap">확인</button>
                  : <span className="text-xs text-good font-semibold whitespace-nowrap"><IconCheck className="mr-1" />확인됨</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
