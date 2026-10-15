'use client';

/**
 * 사용자 · 권한 관리 화면 (`/admin/users`).
 *
 * 사이드바 노출 역할: ADM.
 * ⚠ 노출 역할과 화면이 호출하는 API 권한이 어긋나면 전부 403인 죽은 화면이 된다 —
 *   역할을 바꿀 때는 `Sidebar.tsx`(정본)와 API 권한 매트릭스를 함께 본다.
 * 데이터는 `lib/api.ts`의 `apiFetch`로만 가져온다(HTTP 호출 정본).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, getToken } from '@/lib/api';
import { Loading, ErrorText } from '@/components/ui';
import { useConfirm } from '@/components/confirm';

interface User { userId: string; name: string; dept: string | null; status: string; locked: boolean; failedAttempts: number; roles: string[]; providerId?: string | null; mustChangePassword?: boolean; }
interface ProviderRef { providerId: string; name: string; dept: string | null; roleType: string | null; }
interface RoleRef { code: string; label: string; }
interface Matrix { features: { code: string; label: string; roles: Record<string, string[]> }[]; roles: RoleRef[]; }

export default function UsersAdminPage() {
  const router = useRouter();
  const confirm = useConfirm();
  const [users, setUsers] = useState<User[]>([]);
  const [providers, setProviders] = useState<ProviderRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [matrix, setMatrix] = useState<Matrix | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editRoles, setEditRoles] = useState<string[]>([]);
  const [nu, setNu] = useState({ userId: '', name: '', password: '', roles: ['TEC'] });
  const [pw, setPw] = useState<Record<string, string>>({});
  const [uq, setUq] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    setErr('');
    setLoading(true);
    try {
      const [u, p, m] = await Promise.all([
        apiFetch<User[]>('/api/v1/admin/users'),
        apiFetch<ProviderRef[]>('/api/v1/admin/providers').catch(() => [] as ProviderRef[]),
        apiFetch<Matrix>('/api/v1/admin/permission-matrix'),
      ]);
      setUsers(u); setProviders(p); setMatrix(m);
    } catch (e) { setErr(e instanceof Error ? e.message : '조회 실패(관리자 권한 필요)'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { if (!getToken()) router.push('/'); else load(); }, [router, load]);

  const roleDefs = matrix?.roles ?? [];

  async function act(fn: () => Promise<unknown>, ok: string) {
    setErr(''); setMsg('');
    try { await fn(); setMsg(ok); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : '실패'); }
  }

  return (
    <main className="page">
      <h1 className="t-page mb-1">사용자 · 권한 관리</h1>
      <p className="text-xs text-ink-2 mb-4">관리자(ADM) 전용. 역할 배정에 따라 각 기능 접근이 결정됩니다(하단 매트릭스).</p>
      {err && <ErrorText message={err} />}
      {msg && <p className="text-sm text-good mb-3">{msg}</p>}

      {/* 사용자 생성 */}
      <section className="card mb-4">
        <h2 className="t-section text-sm mb-2">사용자 생성</h2>
        <div className="flex flex-wrap gap-2 items-center">
          <input aria-label="사용자 ID" placeholder="ID" value={nu.userId} onChange={(e) => setNu({ ...nu, userId: e.target.value })} className="mono px-2 py-1.5 rounded-lg border border-line bg-bg text-sm w-24" />
          <input aria-label="이름" placeholder="이름" value={nu.name} onChange={(e) => setNu({ ...nu, name: e.target.value })} className="px-2 py-1.5 rounded-lg border border-line bg-bg text-sm w-28" />
          <input type="password" aria-label="초기 비밀번호" placeholder="초기 비번(10자+·대소문자·숫자)" value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} className="px-2 py-1.5 rounded-lg border border-line bg-bg text-sm w-56" />
          <select multiple aria-label="역할 선택" value={nu.roles} onChange={(e) => setNu({ ...nu, roles: Array.from(e.target.selectedOptions, (o) => o.value) })} className="px-2 py-1 rounded-lg border border-line bg-bg text-xs h-16">
            {roleDefs.map((r) => <option key={r.code} value={r.code}>{r.code} {r.label}</option>)}
          </select>
          <button onClick={() => act(() => apiFetch('/api/v1/admin/users', { method: 'POST', body: JSON.stringify(nu) }).then(() => setNu({ userId: '', name: '', password: '', roles: ['TEC'] })), '사용자 생성됨')} className="py-1.5 px-3 rounded-lg bg-teal text-white font-semibold text-xs">생성</button>
        </div>
      </section>

      {/* 사용자 목록 */}
      <section className="card mb-4">
        <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
          <h2 className="t-section">사용자 <span className="text-xs text-ink-2">({users.filter((u) => { const s = uq.trim().toLowerCase(); return !s || u.userId.toLowerCase().includes(s) || u.name.toLowerCase().includes(s); }).length})</span></h2>
          <input aria-label="사용자 검색" value={uq} onChange={(e) => setUq(e.target.value)} placeholder="ID·이름 검색" className="px-2 py-1.5 rounded-lg border border-line bg-bg text-sm w-44" />
        </div>
        {loading && users.length === 0 ? <Loading /> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-ink-2 border-b border-line"><th className="py-2">ID</th><th>이름</th><th>부서</th><th>역할</th><th>상태</th><th className="text-right">관리</th></tr></thead>
            <tbody>
              {users.filter((u) => { const s = uq.trim().toLowerCase(); return !s || u.userId.toLowerCase().includes(s) || u.name.toLowerCase().includes(s); }).map((u) => (
                <tr key={u.userId} className="border-b border-line last:border-0 align-top">
                  <td className="py-2 mono text-xs">{u.userId}</td>
                  <td>{u.name}</td>
                  <td className="text-xs text-ink-2">{u.dept ?? '—'}</td>
                  <td>
                    {editing === u.userId ? (
                      <div className="flex flex-wrap gap-1 max-w-md">
                        {roleDefs.map((r) => (
                          <label key={r.code} className={`px-1.5 py-0.5 rounded text-xs cursor-pointer border ${editRoles.includes(r.code) ? 'bg-teal/15 text-teal border-teal/30' : 'border-line text-ink-2'}`}>
                            <input type="checkbox" className="hidden" checked={editRoles.includes(r.code)} onChange={(e) => setEditRoles(e.target.checked ? [...editRoles, r.code] : editRoles.filter((x) => x !== r.code))} />
                            {r.code}
                          </label>
                        ))}
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-1">{u.roles.map((r) => <span key={r} className="px-1.5 py-0.5 rounded bg-bg text-xs mono">{r}</span>)}</div>
                    )}
                  </td>
                  <td>
                    <span className={`text-xs font-bold ${u.status === 'ACTIVE' ? 'text-good' : 'text-ink-3'}`}>{u.status}</span>
                    {u.locked && <span className="ml-1 text-xs text-crit">🔒잠금</span>}
                  </td>
                  <td className="text-right">
                    <div className="flex flex-col items-end gap-1">
                      {editing === u.userId ? (
                        <span className="flex gap-1">
                          <button onClick={() => act(() => apiFetch(`/api/v1/admin/users/${u.userId}/roles`, { method: 'PATCH', body: JSON.stringify({ roles: editRoles }) }), '역할 저장됨').then(() => setEditing(null))} className="py-0.5 px-2 rounded bg-teal text-white text-xs">저장</button>
                          <button onClick={() => setEditing(null)} className="py-0.5 px-2 rounded border border-line text-xs">취소</button>
                        </span>
                      ) : (
                        <button onClick={() => { setEditing(u.userId); setEditRoles(u.roles); }} className="py-0.5 px-2 rounded border border-line text-xs">역할편집</button>
                      )}
                      <button onClick={async () => {
                        if (u.status === 'ACTIVE' && !(await confirm({ title: '계정 비활성화', message: '이 계정은 로그인이 차단됩니다.', detail: [{ label: '사용자', value: `${u.userId} ${u.name}` }], danger: true, confirmLabel: '비활성화' }))) return;
                        act(() => apiFetch(`/api/v1/admin/users/${u.userId}/status`, { method: 'PATCH', body: JSON.stringify({ status: u.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }) }), '상태 변경됨');
                      }} className="py-0.5 px-2 rounded border border-line text-xs">{u.status === 'ACTIVE' ? '비활성' : '활성'}</button>
                      {/* ★잠금해제를 상태 토글과 분리한다. 예전엔 "비활성·잠금해제" 한 버튼이 상태만
                          토글해서, 잠긴 검사자를 풀어주려던 관리자가 계정을 아예 비활성화시켰다. */}
                      {u.locked && (
                        <button onClick={() => act(() => apiFetch(`/api/v1/admin/users/${u.userId}/unlock`, { method: 'POST' }), '잠금 해제됨')}
                          className="py-0.5 px-2 rounded border border-warn text-warn text-xs">🔓 잠금해제</button>
                      )}
                      <span className="flex gap-1">
                        <input type="password" aria-label="새 비밀번호" placeholder="새 비번" value={pw[u.userId] ?? ''} onChange={(e) => setPw({ ...pw, [u.userId]: e.target.value })} className="px-1.5 py-0.5 rounded border border-line bg-bg text-xs w-28" />
                        <button onClick={async () => {
                          if (!(await confirm({ title: '비밀번호 재설정', message: '해당 사용자의 비밀번호가 변경됩니다.', detail: [{ label: '사용자', value: `${u.userId} ${u.name}` }], confirmLabel: '재설정' }))) return;
                          act(() => apiFetch(`/api/v1/admin/users/${u.userId}/reset-password`, { method: 'POST', body: JSON.stringify({ newPassword: pw[u.userId] ?? '' }) }).then(() => setPw({ ...pw, [u.userId]: '' })), '비번 재설정됨');
                        }} className="py-0.5 px-2 rounded border border-line text-xs">재설정</button>
                      </span>
                      {/* 계정↔판독의(Provider) 연결 — 병리 사인아웃 서명자는 이 연결로 서버가 결정한다.
                          미연결 계정은 서명 자체가 차단되므로 판독의 계정에는 반드시 지정할 것. */}
                      <span className="flex items-center gap-1">
                        <label className="text-[11px] text-ink-3" htmlFor={`prv-${u.userId}`}>판독의</label>
                        <select
                          id={`prv-${u.userId}`}
                          value={u.providerId ?? ''}
                          onChange={(e) => act(() => apiFetch(`/api/v1/admin/users/${u.userId}/provider`, { method: 'PATCH', body: JSON.stringify({ providerId: e.target.value || null }) }), '판독의 연결 변경됨')}
                          className="px-1.5 py-0.5 rounded border border-line bg-bg text-xs w-32"
                        >
                          <option value="">(미연결)</option>
                          {providers.map((p) => <option key={p.providerId} value={p.providerId}>{p.providerId} {p.name}</option>)}
                        </select>
                      </span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )}
      </section>

      {/* 권한 매트릭스 */}
      {matrix && (
        <section className="card">
          <h2 className="t-section mb-3">권한 매트릭스 <span className="text-xs text-ink-2">(기능 × 역할, 읽기 전용)</span></h2>
          <div className="overflow-x-auto">
            <table className="text-xs">
              <thead>
                <tr className="border-b border-line">
                  <th className="text-left py-1 pr-3 sticky left-0 bg-surface">기능</th>
                  {matrix.roles.map((r) => <th key={r.code} className="px-1.5 py-1 mono" title={r.label}>{r.code}</th>)}
                </tr>
              </thead>
              <tbody>
                {matrix.features.map((f) => (
                  <tr key={f.code} className="border-b border-line last:border-0">
                    <td className="py-1 pr-3 sticky left-0 bg-surface whitespace-nowrap">{f.label} <span className="mono text-ink-3">{f.code}</span></td>
                    {matrix.roles.map((r) => {
                      const acc = f.roles[r.code];
                      return <td key={r.code} className="px-1.5 py-1 text-center">{acc ? <span className="mono text-teal font-bold">{acc.join('')}</span> : <span className="text-ink-3">·</span>}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-ink-3 mt-2">접근유형: R 조회 · W 입력/수정 · V 검증 · S 서명/확정 · A 승인</p>
        </section>
      )}
    </main>
  );
}
