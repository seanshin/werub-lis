/**
 * PACS QIDO/뷰어 URL — 단위 테스트 12건.
 *
 * 묶음: PACS 서비스계정 로그인, QIDO DICOM JSON 파싱, resolveViewerLink (라이브 조회 — fetch mock).
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import {
  buildQidoUrl,
  buildViewerUrl,
  buildLauncherUrl,
  pacsLogin,
  extractStudyUid,
  parseQidoStudies,
  resolveViewerLink,
} from './pacs-client';

describe('PACS QIDO/뷰어 URL', () => {
  it('QIDO 검색 URL (AccessionNumber 인코딩)', () => {
    expect(buildQidoUrl('https://his.example.org/pacs-api/api/v1/dicomweb', 'ACC-SP-2026-0456')).toBe(
      'https://his.example.org/pacs-api/api/v1/dicomweb/studies?AccessionNumber=ACC-SP-2026-0456',
    );
  });
  it('base 뒤 슬래시 정규화', () => {
    expect(buildQidoUrl('http://x/dicomweb/', 'A')).toBe('http://x/dicomweb/studies?AccessionNumber=A');
  });
  it('뷰어 딥링크', () => {
    expect(buildViewerUrl('/werub-viewer/viewer', '1.2.3')).toBe(
      '/werub-viewer/viewer?StudyInstanceUIDs=1.2.3',
    );
  });
  it('뷰어 런처 URL(AccessionNumber 직접)', () => {
    expect(buildLauncherUrl('https://his.example.org', 'ACC-TEST-0001')).toBe(
      'https://his.example.org/pacs-api/api/v1/viewer/launch?AccessionNumber=ACC-TEST-0001',
    );
  });
});

describe('PACS 서비스계정 로그인', () => {
  it('login → JWT(token/access_token/accessToken 유연)', async () => {
    const mock = (async (u: string) => {
      expect(u).toContain('/pacs-api/api/v1/auth/login');
      return { ok: true, status: 200, json: async () => ({ token: 'PACS-JWT' }) } as Response;
    }) as typeof fetch;
    expect(await pacsLogin('https://his.example.org', 'svc-lis', 'pw', mock)).toBe('PACS-JWT');
  });
  it('로그인 실패 → throw', async () => {
    const mock = (async () => ({ ok: false, status: 401 }) as Response) as typeof fetch;
    await expect(pacsLogin('https://x', 'u', 'p', mock)).rejects.toThrow(/로그인 실패/);
  });
});

const QIDO_SAMPLE = [
  {
    '00080050': { vr: 'SH', Value: ['ACC-SP-2026-0456'] },
    '0020000D': { vr: 'UI', Value: ['1.2.840.113619.2.55.3.12345'] },
  },
];

describe('QIDO DICOM JSON 파싱', () => {
  it('StudyInstanceUID(0020000D) 추출', () => {
    expect(extractStudyUid(QIDO_SAMPLE)).toBe('1.2.840.113619.2.55.3.12345');
  });
  it('빈 응답 → null', () => {
    expect(extractStudyUid([])).toBeNull();
    expect(extractStudyUid(null)).toBeNull();
  });
  it('스터디 목록 파싱', () => {
    const list = parseQidoStudies(QIDO_SAMPLE);
    expect(list[0].accessionNumber).toBe('ACC-SP-2026-0456');
    expect(list[0].studyInstanceUid).toBe('1.2.840.113619.2.55.3.12345');
  });
});

describe('resolveViewerLink (라이브 조회 — fetch mock)', () => {
  it('스터디 존재 → 뷰어 URL', async () => {
    const mockFetch = (async () =>
      ({ ok: true, status: 200, json: async () => QIDO_SAMPLE }) as Response) as typeof fetch;
    const r = await resolveViewerLink('http://pacs/dicomweb', '/werub-viewer/viewer', 'tok', 'ACC-SP-2026-0456', mockFetch);
    expect(r.found).toBe(true);
    expect(r.viewerUrl).toBe('/werub-viewer/viewer?StudyInstanceUIDs=1.2.840.113619.2.55.3.12345');
  });
  it('스터디 없음(204) → found=false', async () => {
    const mockFetch = (async () => ({ ok: false, status: 204 }) as Response) as typeof fetch;
    const r = await resolveViewerLink('http://pacs/dicomweb', '/v', 'tok', 'ACC-NONE', mockFetch);
    expect(r.found).toBe(false);
    expect(r.viewerUrl).toBeNull();
  });
  it('조회 실패(500) → throw', async () => {
    const mockFetch = (async () => ({ ok: false, status: 500 }) as Response) as typeof fetch;
    await expect(
      resolveViewerLink('http://pacs/dicomweb', '/v', 'tok', 'ACC-X', mockFetch),
    ).rejects.toThrow(/QIDO 조회 실패/);
  });
});
