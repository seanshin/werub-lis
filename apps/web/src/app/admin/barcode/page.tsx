'use client';

/**
 * 바코드 스캔 설정 화면 (`/admin/barcode`).
 *
 * 사이드바 노출 역할: TEC, ADM.
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
import { Loading } from '@/components/ui';
import { BarcodeConfig, DEFAULT_BARCODE_CONFIG, normalizeBarcode } from '@/lib/barcode';
import { IconWarn } from '@/components/Icon';

const inp = 'px-2 py-1.5 rounded-lg border border-line bg-bg text-sm';

export default function BarcodeSettingsPage() {
  const router = useRouter();
  const toast = useToast();
  const [cfg, setCfg] = useState<BarcodeConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [testRaw, setTestRaw] = useState('');
  const isAdmin = getRoles().includes('ADM');

  const load = useCallback(async () => {
    try { setCfg(await apiFetch<BarcodeConfig>('/api/v1/barcode/config')); }
    catch (e) { toast(e instanceof Error ? e.message : '조회 실패', 'error'); setCfg(DEFAULT_BARCODE_CONFIG); }
    finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { if (!getToken()) router.push('/'); else load(); }, [router, load]);

  function set<K extends keyof BarcodeConfig>(k: K, v: BarcodeConfig[K]) { setCfg((c) => (c ? { ...c, [k]: v } : c)); }
  const numOrNull = (s: string): number | null => (s.trim() === '' ? null : Math.max(0, Number(s) || 0));

  async function save() {
    if (!cfg) return;
    try {
      await apiFetch('/api/v1/barcode/config', { method: 'PUT', body: JSON.stringify({
        trimWhitespace: cfg.trimWhitespace, prefixStrip: cfg.prefixStrip ?? '', suffixStrip: cfg.suffixStrip ?? '',
        stripPattern: cfg.stripPattern ?? '', minLength: cfg.minLength ?? undefined, maxLength: cfg.maxLength ?? undefined,
        autoSubmit: cfg.autoSubmit, autoSubmitLen: cfg.autoSubmitLen ?? undefined, idleMs: cfg.idleMs ?? undefined, beep: cfg.beep,
      }) });
      toast('바코드 설정 저장됨 — 스캔 화면에 즉시 적용', 'success');
      await load();
    } catch (e) { toast(e instanceof Error ? e.message : '저장 실패', 'error'); }
  }

  if (loading || !cfg) return <main className="page"><Loading /></main>;
  const test = testRaw ? normalizeBarcode(testRaw, cfg) : null;

  return (
    <main className="max-w-3xl mx-auto p-6">
      <h1 className="t-page mb-1">바코드 스캔 설정</h1>
      <p className="text-xs text-ink-3 mb-4">스캐너 혼재 환경 대응 — 라벨/스캐너 포맷 차이를 흡수하는 정규화 규칙과 스캔 동작. 키보드-웨지(HID) 스캐너는 별도 연결 설정 없이 동작하며, 심볼로지·접미(Enter)는 스캐너 기기에서 설정합니다.</p>

      <section className="card">
        <h2 className="t-section mb-3">정규화 규칙</h2>
        <div className="grid sm:grid-cols-2 gap-3">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={cfg.trimWhitespace} onChange={(e) => set('trimWhitespace', e.target.checked)} disabled={!isAdmin} />앞뒤 공백 제거</label>
          <div></div>
          <div><label className="block text-xs text-ink-2 mb-1">접두 제거(prefix)</label><input aria-label="접두 제거(prefix)" className={`${inp} w-full mono`} value={cfg.prefixStrip ?? ''} onChange={(e) => set('prefixStrip', e.target.value || null)} placeholder="예: ]C1 (심볼로지 ID)" disabled={!isAdmin} /></div>
          <div><label className="block text-xs text-ink-2 mb-1">접미 제거(suffix)</label><input aria-label="접미 제거(suffix)" className={`${inp} w-full mono`} value={cfg.suffixStrip ?? ''} onChange={(e) => set('suffixStrip', e.target.value || null)} placeholder="예: 개행문자" disabled={!isAdmin} /></div>
          <div><label className="block text-xs text-ink-2 mb-1">제거 정규식(문자셋)</label><input aria-label="제거 정규식(문자셋)" className={`${inp} w-full mono`} value={cfg.stripPattern ?? ''} onChange={(e) => set('stripPattern', e.target.value || null)} placeholder="예: [*] (체크섬 기호)" disabled={!isAdmin} /></div>
          <div className="flex gap-2">
            <div className="flex-1"><label className="block text-xs text-ink-2 mb-1">최소 길이</label><input aria-label="최소 길이" type="number" className={`${inp} w-full`} value={cfg.minLength ?? ''} onChange={(e) => set('minLength', numOrNull(e.target.value))} disabled={!isAdmin} /></div>
            <div className="flex-1"><label className="block text-xs text-ink-2 mb-1">최대 길이</label><input aria-label="최대 길이" type="number" className={`${inp} w-full`} value={cfg.maxLength ?? ''} onChange={(e) => set('maxLength', numOrNull(e.target.value))} disabled={!isAdmin} /></div>
          </div>
        </div>

        <h2 className="t-section mt-5 mb-3">스캔 동작</h2>
        <div className="grid sm:grid-cols-2 gap-3">
          <div><label className="block text-xs text-ink-2 mb-1">자동 제출 방식</label>
            <select className={`${inp} w-full`} value={cfg.autoSubmit} onChange={(e) => set('autoSubmit', e.target.value)} disabled={!isAdmin}>
              <option value="ENTER">Enter(스캐너 접미)로 제출 — 표준</option>
              <option value="LENGTH">지정 자릿수 도달 시 제출</option>
              <option value="IDLE">입력 유휴 후 제출</option>
            </select>
          </div>
          <div></div>
          {cfg.autoSubmit === 'LENGTH' && <div><label className="block text-xs text-ink-2 mb-1">제출 자릿수</label><input aria-label="제출 자릿수" type="number" className={`${inp} w-full`} value={cfg.autoSubmitLen ?? ''} onChange={(e) => set('autoSubmitLen', numOrNull(e.target.value))} disabled={!isAdmin} /></div>}
          {cfg.autoSubmit === 'IDLE' && <div><label className="block text-xs text-ink-2 mb-1">유휴 시간(ms)</label><input aria-label="유휴 시간(ms)" type="number" className={`${inp} w-full`} value={cfg.idleMs ?? ''} onChange={(e) => set('idleMs', numOrNull(e.target.value))} placeholder="예: 300" disabled={!isAdmin} /></div>}
          <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={cfg.beep} onChange={(e) => set('beep', e.target.checked)} disabled={!isAdmin} />스캔 성공 시 비프음</label>
        </div>

        {/* 라이브 테스트 */}
        <div className="mt-5 pt-4 border-t border-line">
          <label className="block text-xs text-ink-2 mb-1">테스트 — 원시 스캔값 입력</label>
          <input aria-label="테스트 — 원시 스캔값 입력" className={`${inp} w-full mono`} value={testRaw} onChange={(e) => setTestRaw(e.target.value)} placeholder="스캐너가 보낼 원시값(접두·개행 포함)을 붙여넣어 결과 확인" />
          {test && (
            <div className="mt-2 text-sm flex flex-wrap items-center gap-2">
              <span>정규화 →</span>
              <span className="mono font-bold">{test.value || '(빈 값)'}</span>
              {test.valid ? <span className="px-2 py-0.5 rounded bg-good/15 text-good text-xs font-bold">통과</span>
                : <span className="px-2 py-0.5 rounded bg-warn/15 text-warn text-xs font-bold"><IconWarn className="mr-1" />{test.warning}</span>}
            </div>
          )}
        </div>

        {isAdmin ? (
          <button onClick={save} className="mt-5 py-2 px-5 rounded-lg bg-teal text-white font-semibold text-sm">저장</button>
        ) : (
          <p className="mt-5 text-xs text-ink-3">설정 변경은 관리자(ADM) 권한이 필요합니다. (조회 전용)</p>
        )}
        <p className="mt-2 text-xs text-ink-3">최종 변경 {cfg.updatedBy ? `· ${cfg.updatedBy}` : ''}</p>
      </section>
    </main>
  );
}
