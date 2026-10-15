/**
 * barcode.ts — lib 모듈 구성요소.
 *
 * 제공: BarcodeConfig, DEFAULT_BARCODE_CONFIG, fetchBarcodeConfig, useBarcodeNormalize, beep.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from './api';
import { normalizeBarcode, type BarcodeNormalizeResult } from '@lis/shared';

export interface BarcodeConfig {
  trimWhitespace: boolean;
  prefixStrip: string | null;
  suffixStrip: string | null;
  stripPattern: string | null;
  minLength: number | null;
  maxLength: number | null;
  autoSubmit: string; // ENTER | LENGTH | IDLE
  autoSubmitLen: number | null;
  idleMs: number | null;
  beep: boolean;
  updatedBy?: string | null;
}

export const DEFAULT_BARCODE_CONFIG: BarcodeConfig = {
  trimWhitespace: true, prefixStrip: null, suffixStrip: null, stripPattern: null,
  minLength: null, maxLength: null, autoSubmit: 'ENTER', autoSubmitLen: null, idleMs: null, beep: false,
};

// 정규화 로직 정본은 @lis/shared — 서버와 동일 규칙이어야 하므로 여기 복제하지 말 것.
export { normalizeBarcode };
export type { BarcodeNormalizeResult };

export async function fetchBarcodeConfig(): Promise<BarcodeConfig> {
  try { return await apiFetch<BarcodeConfig>('/api/v1/barcode/config'); }
  catch { return DEFAULT_BARCODE_CONFIG; }
}

/**
 * 바코드 설정을 로드해 스캔값 정규화 함수를 제공하는 훅.
 * normalize(raw) → {value, valid, warning}. cfg.beep면 성공 시 비프.
 */
export function useBarcodeNormalize() {
  const [cfg, setCfg] = useState<BarcodeConfig>(DEFAULT_BARCODE_CONFIG);
  useEffect(() => { fetchBarcodeConfig().then(setCfg); }, []);
  const normalize = useCallback((raw: string): BarcodeNormalizeResult => normalizeBarcode(raw, cfg), [cfg]);
  return { cfg, normalize };
}

/** 스캔 성공 비프(WebAudio, 짧은 톤). 사용자 제스처(스캔) 컨텍스트에서 호출. */
export function beep() {
  try {
    const AC = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
    const ctx = new AC();
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.frequency.value = 1200; o.connect(g); g.connect(ctx.destination);
    g.gain.setValueAtTime(0.05, ctx.currentTime);
    o.start(); o.stop(ctx.currentTime + 0.08);
    setTimeout(() => void ctx.close(), 200);
  } catch { /* 오디오 미지원 무시 */ }
}
