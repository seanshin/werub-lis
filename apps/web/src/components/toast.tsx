'use client';

/**
 * toast.tsx — 웹 공용 컴포넌트.
 *
 * 제공: useToast, ToastProvider.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { createContext, useContext, useState, useCallback, ReactNode } from 'react';

type Kind = 'success' | 'error' | 'info';
interface Toast { id: number; kind: Kind; message: string; }

const ToastCtx = createContext<(message: string, kind?: Kind) => void>(() => {});

/** 토스트 알림 — `const toast = useToast(); toast('저장됨'); toast('실패','error')` */
export function useToast() {
  return useContext(ToastCtx);
}

const kindCls: Record<Kind, string> = {
  success: 'bg-good text-white',
  error: 'bg-crit text-white',
  info: 'bg-ink text-white',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((message: string, kind: Kind = 'success') => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setItems((prev) => [...prev, { id, kind, message }]);
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), kind === 'error' ? 6000 : 3500);
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 no-print" aria-live="polite">
        {items.map((t) => (
          // 버튼으로 둔다 — div+onClick은 키보드로 닫을 수 없다(자동 소멸은 있지만 즉시 닫기가 불가)
          <button key={t.id} type="button" aria-label={`알림 닫기: ${t.message}`}
            onClick={() => setItems((prev) => prev.filter((x) => x.id !== t.id))}
            className={`text-left px-4 py-2 r-ctl e-overlay text-sm font-medium max-w-sm m-hover ${kindCls[t.kind]}`}>
            {t.message}
          </button>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
