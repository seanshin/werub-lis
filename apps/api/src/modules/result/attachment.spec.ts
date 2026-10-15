/**
 * 결과 첨부(addAttachment) 검증 — 단위 테스트 9건.
 *
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { ResultService } from './result.service';

// 첨부 검증 로직(대상 존재·형식·크기)만 검증 — prisma는 조회만 스텁
function makeService(opts: { specimen?: boolean; pathology?: boolean } = { specimen: true }) {
  const prisma = {
    specimen: { findUnique: async () => (opts.specimen ? { specimenNo: 'S-1' } : null) },
    pathologyCase: { findUnique: async () => (opts.pathology ? { spNo: 'SP-1' } : null) },
    resultAttachment: { create: async ({ data }: { data: Record<string, unknown> }) => ({ attachmentId: 'ATT-x', ...data }) },
  };
  return new ResultService(prisma as never, {} as never, {} as never, {} as never);
}

const pdf = (size: number) => ({ buffer: Buffer.alloc(Math.min(size, 8)), originalname: 'r.pdf', mimetype: 'application/pdf', size });

describe('결과 첨부(addAttachment) 검증', () => {
  it('파일 없으면 400', async () => {
    await expect(makeService().addAttachment({ specimenNo: 'S-1' }, undefined, undefined, 'U1')).rejects.toThrow('파일');
  });

  it('대상(검체/병리) 미지정이면 400', async () => {
    await expect(makeService().addAttachment({}, pdf(100), undefined, 'U1')).rejects.toThrow('첨부 대상');
  });

  it('검체 없으면 404', async () => {
    await expect(makeService({ specimen: false }).addAttachment({ specimenNo: 'S-X' }, pdf(100), undefined, 'U1')).rejects.toThrow('검체 없음');
  });

  it('병리 케이스 없으면 404', async () => {
    await expect(makeService({ pathology: false }).addAttachment({ spNo: 'SP-X' }, pdf(100), undefined, 'U1')).rejects.toThrow('병리 케이스 없음');
  });

  it('허용되지 않는 형식은 400', async () => {
    const f = { buffer: Buffer.alloc(4), originalname: 'x.exe', mimetype: 'application/x-msdownload', size: 100 };
    await expect(makeService().addAttachment({ specimenNo: 'S-1' }, f, undefined, 'U1')).rejects.toThrow('허용되지 않는 형식');
  });

  it('20MB 초과는 400', async () => {
    await expect(makeService().addAttachment({ specimenNo: 'S-1' }, pdf(21 * 1024 * 1024), undefined, 'U1')).rejects.toThrow('너무 큽니다');
  });

  it('정상 PDF(검체)는 저장(파일명·업로더 반영, 경로문자 정규화)', async () => {
    const f = { buffer: Buffer.alloc(8), originalname: 'a/b\\c.pdf', mimetype: 'application/pdf', size: 1000 };
    const r = await makeService().addAttachment({ specimenNo: 'S-1' }, f, '외부검사 결과지', 'U7') as Record<string, unknown>;
    expect(r.filename).toBe('a_b_c.pdf');
    expect(r.specimenNo).toBe('S-1');
    expect(r.spNo).toBeNull();
    expect(r.uploadedBy).toBe('U7');
  });

  it('정상 이미지(병리 케이스)는 spNo로 저장', async () => {
    const f = { buffer: Buffer.alloc(8), originalname: 'slide.png', mimetype: 'image/png', size: 2000 };
    const r = await makeService({ pathology: true }).addAttachment({ spNo: 'SP-1' }, f, undefined, 'U4') as Record<string, unknown>;
    expect(r.spNo).toBe('SP-1');
    expect(r.specimenNo).toBeNull();
    expect(r.mimeType).toBe('image/png');
  });

  it('PNG·JPEG·WEBP 허용', () => {
    expect(ResultService.ATTACH_MIME).toEqual(expect.arrayContaining(['image/png', 'image/jpeg', 'image/webp']));
  });
});
