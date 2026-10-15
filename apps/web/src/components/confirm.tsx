'use client';

/**
 * confirm.tsx — 웹 공용 컴포넌트.
 *
 * 제공: useConfirm, ConfirmProvider.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';

interface ConfirmOpts {
  title: string;
  message?: string;
  detail?: { label: string; value: string }[]; // 요약 표시(예: 환자·제제)
  confirmLabel?: string;
  danger?: boolean;
  /** 2단계 확인(임상 안전: 출고·수혈) — 체크박스 동의 필요 */
  doubleConfirm?: string;
}

type Resolver = (ok: boolean) => void;

const ConfirmCtx = createContext<(o: ConfirmOpts) => Promise<boolean>>(async () => false);

/** 위험 액션 확인 — 네이티브 dialog 대신 앱 내 모달. `if (!(await confirm({...}))) return;` */
export function useConfirm() {
  return useContext(ConfirmCtx);
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOpts | null>(null);
  const [resolver, setResolver] = useState<Resolver | null>(null);
  const [checked, setChecked] = useState(false);

  const confirm = useCallback((o: ConfirmOpts) => {
    setOpts(o); setChecked(false);
    return new Promise<boolean>((resolve) => setResolver(() => resolve));
  }, []);

  const close = (ok: boolean) => { resolver?.(ok); setResolver(null); setOpts(null); };

  // Escape 취소는 **포커스 위치와 무관하게** 동작해야 한다(모달 안에 포커스가 없을 수도 있다) →
  // div onKeyDown 대신 전역 리스너. 취소(false)로만 닫는다(위험 액션이 Escape로 실행되면 안 된다).
  useEffect(() => {
    if (!opts) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts, resolver]);

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {opts && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
          <div className="bg-surface border border-line r-card e-overlay max-w-md w-full p-5">
            <h2 className={`font-bold mb-2 ${opts.danger ? 'text-crit' : ''}`}>{opts.title}</h2>
            {opts.message && <p className="text-sm text-ink-2 mb-3">{opts.message}</p>}
            {opts.detail && (
              <dl className="text-sm bg-bg rounded-lg p-3 mb-3 space-y-1">
                {opts.detail.map((d) => (
                  <div key={d.label} className="flex justify-between gap-4">
                    <dt className="text-ink-2">{d.label}</dt><dd className="font-semibold mono text-xs">{d.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {opts.doubleConfirm && (
              <label className="flex items-center gap-2 text-sm mb-3 cursor-pointer">
                <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
                <span className="text-crit font-medium">{opts.doubleConfirm}</span>
              </label>
            )}
            <div className="flex justify-end gap-2">
              {/* ★위험 동작(danger)은 '취소'에 포커스를 둔다. 바코드 스캐너는 스캔 후 Enter를 보내므로,
                  모달이 떠 있는 상태에서 습관적으로 검체를 스캔하면 그 Enter가 '확인'을 눌러버린다. */}
              <button onClick={() => close(false)} autoFocus={!!opts.danger} className="py-1.5 px-4 rounded-lg border border-line text-sm font-medium">취소</button>
              <button onClick={() => close(true)} disabled={!!opts.doubleConfirm && !checked} autoFocus={!opts.danger}
                className={`py-1.5 px-4 rounded-lg text-white text-sm font-semibold disabled:opacity-40 ${opts.danger ? 'bg-crit' : 'bg-teal'}`}>
                {opts.confirmLabel ?? '확인'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmCtx.Provider>
  );
}
