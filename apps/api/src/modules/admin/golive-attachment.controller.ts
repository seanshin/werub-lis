/**
 * Admin · Go-Live Attachment (근거 문서함) HTTP 컨트롤러 — 라우트 4개.
 *
 * 비즈니스 로직은 같은 폴더의 서비스에 위임하고, 여기서는 인가·검증·응답 형태만 책임진다.
 * 인가: 업로드·삭제 ADM · 열람 ADM/AUD(감사자가 증빙을 봐야 한다).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import {
  Body, Controller, Delete, Get, Param, Post, Query, Res, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes, ApiBody } from '@nestjs/swagger';
import type { Response } from 'express';
import { GoLiveAttachmentService } from './golive-attachment.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { LisRole } from '../../common/rbac/roles';

interface UploadedFileLike { buffer: Buffer; originalname: string; mimetype: string; size: number }
const UPLOAD_LIMITS = { limits: { fileSize: 20 * 1024 * 1024, files: 1 } };

@ApiTags('Admin · Go-Live Attachment (근거 문서함)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(LisRole.ADM, LisRole.AUD)
@Controller('api/v1/admin/golive/attachments')
export class GoLiveAttachmentController {
  constructor(private readonly service: GoLiveAttachmentService) {}

  @Get()
  @ApiOperation({ summary: '근거 문서 목록(메타데이터만 — 바이너리 미반환)' })
  async list(
    @Query('taskCode') taskCode?: string,
    @Query('gateCode') gateCode?: string,
    @Query('signoffSec') signoffSec?: string,
    @Query('decisionKey') decisionKey?: string,
  ) {
    return { data: await this.service.list({ taskCode, gateCode, signoffSec, decisionKey }) };
  }

  @Post()
  @Roles(LisRole.ADM)
  @UseInterceptors(FileInterceptor('file', UPLOAD_LIMITS))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        category: { type: 'string', example: 'APPROVAL' },
        taskCode: { type: 'string' }, gateCode: { type: 'string' },
        signoffSec: { type: 'string' }, decisionKey: { type: 'string' },
        note: { type: 'string' },
      },
    },
  })
  @ApiOperation({ summary: '근거 문서 첨부(PDF·PNG·JPEG·WEBP, ≤20MB) — 대상 1개 필수' })
  async upload(
    @UploadedFile() file: UploadedFileLike,
    @Body('category') category: string,
    @Body('taskCode') taskCode: string | undefined,
    @Body('gateCode') gateCode: string | undefined,
    @Body('signoffSec') signoffSec: string | undefined,
    @Body('decisionKey') decisionKey: string | undefined,
    @Body('note') note: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return {
      data: await this.service.upload(
        { taskCode, gateCode, signoffSec, decisionKey }, category, file, note, user?.userId ?? null,
      ),
    };
  }

  @Get(':attachmentId/download')
  @ApiOperation({ summary: '근거 문서 다운로드 — 저장 후 교체 여부(sha256)를 헤더로 알린다' })
  async download(@Param('attachmentId') attachmentId: string, @Res() res: Response, @CurrentUser() user: AuthUser) {
    const a = await this.service.download(attachmentId, user?.userId ?? null);
    res.setHeader('Content-Type', a.mimeType);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(a.filename)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // 무결성 결과를 헤더로 — 본문을 바꾸지 않으면서 "이 파일이 올린 그대로인가"를 알린다.
    res.setHeader('X-Attachment-Integrity', a.integrityOk ? 'ok' : 'MISMATCH');
    res.send(Buffer.from(a.data));
  }

  @Delete(':attachmentId')
  @Roles(LisRole.ADM)
  @ApiOperation({ summary: '근거 문서 삭제(오업로드 정정) — 감사 기록' })
  async remove(@Param('attachmentId') attachmentId: string, @CurrentUser() user: AuthUser) {
    return { data: await this.service.remove(attachmentId, user?.userId ?? null) };
  }
}
