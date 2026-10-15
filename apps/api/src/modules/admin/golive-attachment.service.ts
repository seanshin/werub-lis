/**
 * GoLiveAttachmentService — 개시 근거 문서함.
 *
 * 결재 공문·회신서·서명본 **원본**을 시스템 안에 둔다. `org_approval.docNo`(문자열)만으로는
 * 결재가 실재했는지 소명할 수 없고, 원본이 메일·파일서버에 흩어져 있으면 인증·실사에서
 * 1차 증빙을 제출하지 못한다.
 *
 * 검증은 임상 첨부(`ResultAttachment`)와 **같은 방어를 재사용**한다 —
 * MIME 화이트리스트 · 20MB 상한 · 파일명 정규화 · 다운로드 `nosniff`(컨트롤러).
 * 다만 테이블은 분리한다(보존정책·권한·수명주기가 다르다).
 *
 * 근거: docs/개시전환센터_기획서.md §3.3
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditChainService } from '../audit/audit-chain.service';
import { GOLIVE_TASK_BY_CODE } from '../../domain/golive-registry';

/** 임상 첨부와 동일한 화이트리스트 — 실행 가능한 형식을 들이지 않는다. */
const ATTACH_MIME = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
/** 선언 MIME과 짝이 맞아야 하는 확장자 — `법무의견.html`을 PDF로 올려 저장 후 로컬에서 열리는 경로 차단. */
const MIME_EXT: Record<string, string[]> = {
  'application/pdf': ['pdf'],
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/webp': ['webp'],
};
const MAX_BYTES = 20 * 1024 * 1024;

/**
 * 매직바이트 — 선언 MIME과 **실제 내용**이 맞는지 본다.
 * `file.mimetype`은 클라이언트가 보낸 값이라 그것만으로는 위장을 막지 못한다.
 * 증빙 문서함이라 "PDF라고 적힌 무언가"가 들어오는 것 자체가 문제다.
 */
function magicOk(mime: string, buf: Buffer): boolean {
  if (buf.length < 12) return false;
  switch (mime) {
    case 'application/pdf':
      return buf.subarray(0, 5).toString('latin1') === '%PDF-';
    case 'image/png':
      return buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/jpeg':
      return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case 'image/webp':
      return buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP';
    default:
      return false;
  }
}
/** 대상 하나당 첨부 상한 — 잡파일로 진짜 결재 공문을 목록에서 밀어내는 것을 막는다. */
const MAX_PER_TARGET = 30;
export const ATTACH_CATEGORIES = ['APPROVAL', 'REPLY', 'SIGNOFF', 'LEGAL', 'EVIDENCE'] as const;

interface UploadFile { buffer: Buffer; originalname: string; mimetype: string; size: number }
interface Target { taskCode?: string; gateCode?: string; signoffSec?: string; decisionKey?: string }

@Injectable()
export class GoLiveAttachmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditChain: AuditChainService,
  ) {}

  private assertTarget(t: Target): Target {
    const set = [t.taskCode, t.gateCode, t.signoffSec, t.decisionKey].filter((v) => v && v.trim());
    if (set.length !== 1) {
      throw new BadRequestException('첨부 대상은 정확히 하나여야 합니다(taskCode | gateCode | signoffSec | decisionKey)');
    }
    if (t.taskCode && !GOLIVE_TASK_BY_CODE.has(t.taskCode)) {
      throw new BadRequestException(`알 수 없는 체크리스트 항목: ${t.taskCode}`);
    }
    return {
      taskCode: t.taskCode?.trim() || undefined, gateCode: t.gateCode?.trim() || undefined,
      signoffSec: t.signoffSec?.trim() || undefined, decisionKey: t.decisionKey?.trim() || undefined,
    };
  }

  async upload(target: Target, category: string, file: UploadFile | undefined, note: string | undefined, userId: string | null) {
    const t = this.assertTarget(target);
    if (!(ATTACH_CATEGORIES as readonly string[]).includes(category)) {
      throw new BadRequestException(`category는 ${ATTACH_CATEGORIES.join('|')}: ${category}`);
    }
    if (!file) throw new BadRequestException('파일이 없습니다');
    if (!ATTACH_MIME.includes(file.mimetype)) {
      throw new BadRequestException(`허용되지 않는 형식: ${file.mimetype} (PDF·PNG·JPEG·WEBP만 가능)`);
    }
    if (file.size > MAX_BYTES) {
      throw new BadRequestException(`파일이 너무 큽니다(최대 20MB): ${(file.size / 1024 / 1024).toFixed(1)}MB`);
    }
    // 경로 구분자·개행·양방향 제어문자 제거 — 파일명이 헤더·경로로 새거나 목록에서 위장하는 것을 막는다.
    const safeName = (file.originalname || 'file')
      .replace(/[/\\\r\n\t]/g, '_')
      // U+202A~U+202E·U+2066~U+2069: RTL override 등 — `pdf.exe`를 `exe.pdf`로 보이게 만든다
      .replace(/[\u202A-\u202E\u2066-\u2069]/g, '')
      .slice(0, 200);
    // 확장자가 선언 MIME과 맞아야 한다. nosniff는 브라우저 렌더를 막지만,
    // 감사자가 **저장 후 로컬에서 여는 것**은 막지 못한다.
    const ext = safeName.includes('.') ? safeName.split('.').pop()!.toLowerCase() : '';
    if (!MIME_EXT[file.mimetype].includes(ext)) {
      throw new BadRequestException(`파일 확장자(.${ext || '없음'})가 형식(${file.mimetype})과 맞지 않습니다`);
    }
    if (!magicOk(file.mimetype, file.buffer)) {
      throw new BadRequestException(
        `파일 내용이 선언한 형식(${file.mimetype})과 다릅니다 — 확장자·MIME만 바꾼 파일은 증빙이 될 수 없습니다`,
      );
    }
    // 대상당 상한 — 넘으면 오래된 것을 정리하거나 다른 항목에 붙인다.
    const targetKey = t.taskCode ?? t.gateCode ?? t.signoffSec ?? t.decisionKey;
    const existing = await this.prisma.goLiveAttachment.count({
      where: { OR: [{ taskCode: targetKey }, { gateCode: targetKey }, { signoffSec: targetKey }, { decisionKey: targetKey }] },
    });
    if (existing >= MAX_PER_TARGET) {
      throw new BadRequestException(`이 대상의 첨부가 상한(${MAX_PER_TARGET})에 도달했습니다 — 불필요한 파일을 정리한 뒤 올리십시오`);
    }
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');

    const saved = await this.prisma.goLiveAttachment.create({
      data: {
        attachmentId: `GA-${randomUUID()}`,
        ...t, category, filename: safeName, mimeType: file.mimetype,
        sizeBytes: file.size, sha256, data: new Uint8Array(file.buffer),
        note: note?.slice(0, 500) ?? null, uploadedBy: userId,
      },
      select: { attachmentId: true, filename: true, sizeBytes: true, sha256: true, uploadedDt: true },
    });

    void this.auditChain.append({
      userId, action: 'POST', target: '/admin/golive/attachments',
      detail: `근거 문서 첨부 — ${category} ${safeName}(${file.size}B, sha256 ${sha256}) → ${JSON.stringify(t)}`.slice(0, 500),
      status: null, sensitive: false,
    });
    return saved;
  }

  /** 목록 — **바이너리는 반환하지 않는다**(메타데이터만). */
  async list(target: Partial<Target>) {
    const where = {
      ...(target.taskCode ? { taskCode: target.taskCode } : {}),
      ...(target.gateCode ? { gateCode: target.gateCode } : {}),
      ...(target.signoffSec ? { signoffSec: target.signoffSec } : {}),
      ...(target.decisionKey ? { decisionKey: target.decisionKey } : {}),
    };
    const total = await this.prisma.goLiveAttachment.count({ where });
    const rows = await this.prisma.goLiveAttachment.findMany({
      where,
      select: {
        attachmentId: true, taskCode: true, gateCode: true, signoffSec: true, decisionKey: true,
        category: true, filename: true, mimeType: true, sizeBytes: true, sha256: true,
        note: true, uploadedBy: true, uploadedDt: true,
      },
      orderBy: { uploadedDt: 'desc' },
      take: 200,
    });
    // 총건수를 함께 준다 — 잘렸다는 사실조차 모르면 "증빙이 없다"와 구분되지 않는다.
    return { total, truncated: total > rows.length, rows };
  }

  /** 항목별 첨부 수 — 체크리스트가 "근거 있음"을 표시하는 데 쓴다. */
  async countsByTask(): Promise<Map<string, number>> {
    const rows = await this.prisma.goLiveAttachment.groupBy({
      by: ['taskCode'], where: { taskCode: { not: null } }, _count: { _all: true },
    });
    return new Map(rows.filter((r) => r.taskCode).map((r) => [r.taskCode as string, r._count._all]));
  }

  async download(attachmentId: string, userId: string | null) {
    const a = await this.prisma.goLiveAttachment.findUnique({ where: { attachmentId } });
    if (!a) throw new NotFoundException('첨부를 찾을 수 없습니다');
    // 저장 후 교체 탐지 — 원본이 바뀌었으면 증빙으로 쓸 수 없다.
    const actual = createHash('sha256').update(Buffer.from(a.data)).digest('hex');
    const integrityOk = actual === a.sha256;
    if (!integrityOk) {
      // 헤더만으로는 아무도 모른다 — 감사에 남겨야 신호가 된다.
      void this.auditChain.append({
        userId, action: 'SYSTEM', target: `/admin/golive/attachments/${attachmentId}`,
        detail: `⚠ 첨부 무결성 불일치 — 저장 후 원본이 교체됐다(${a.filename}, 기록 ${a.sha256}, 실제 ${actual})`.slice(0, 500),
        status: null, sensitive: false,
      });
    }
    return { ...a, integrityOk };
  }

  /**
   * 삭제 — 잘못 올린 파일 정리용. 감사에 남긴다.
   * ⚠ 개시 승인 이후에는 증빙이므로 삭제하지 않는 것이 원칙이나, 기술적 차단은 두지 않는다
   *   (오업로드 정정을 막으면 잘못된 증빙이 남는다). 감사 기록으로 추적한다.
   */
  async remove(attachmentId: string, userId: string | null) {
    const a = await this.prisma.goLiveAttachment.findUnique({
      where: { attachmentId }, select: { filename: true, category: true, taskCode: true, gateCode: true, sha256: true },
    });
    if (!a) throw new NotFoundException('첨부를 찾을 수 없습니다');
    await this.prisma.goLiveAttachment.delete({ where: { attachmentId } });
    void this.auditChain.append({
      userId, action: 'DELETE', target: `/admin/golive/attachments/${attachmentId}`,
      // sha256을 남긴다 — 지워진 것이 승인 대상 문서와 동일한 파일인지 나중에 대조할 수 있어야 한다.
      detail: `근거 문서 삭제 — ${a.category} ${a.filename}(${a.taskCode ?? a.gateCode ?? '-'}) sha256=${a.sha256}`.slice(0, 500),
      status: null, sensitive: false,
    });
    return { deleted: true };
  }
}
