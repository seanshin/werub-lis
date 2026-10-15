/**
 * BarcodeService — barcode 도메인 서비스.
 *
 * 주요 진입점: `getConfig()`, `updateConfig()`
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AUTO_SUBMIT_MODES, isOneOf } from '../../domain/enums';

const SINGLETON = 'SINGLETON';

export interface BarcodeConfigDto {
  trimWhitespace?: boolean;
  prefixStrip?: string | null;
  suffixStrip?: string | null;
  stripPattern?: string | null;
  minLength?: number | null;
  maxLength?: number | null;
  autoSubmit?: string; // ENTER | LENGTH | IDLE
  autoSubmitLen?: number | null;
  idleMs?: number | null;
  beep?: boolean;
}



@Injectable()
export class BarcodeService {
  constructor(private readonly prisma: PrismaService) {}

  /** 싱글톤 설정 조회 — 없으면 기본값 생성. */
  async getConfig() {
    const existing = await this.prisma.barcodeConfig.findUnique({ where: { id: SINGLETON } });
    if (existing) return existing;
    return this.prisma.barcodeConfig.create({ data: { id: SINGLETON } });
  }

  /**
   * 저장 전 정규식 안전성 검사 — 컴파일 가능성 + 대표 입력에 대한 실행 시간.
   * 이 패턴은 전 검사자 브라우저에서 스캔마다 실행되므로, 파국적 백트래킹 패턴이 저장되면
   * 검사실 전체 스캔이 동시에 멈춘다(가용성 사고).
   */
  private assertSafePattern(pattern: string): void {
    let re: RegExp;
    try {
      re = new RegExp(pattern, 'g');
    } catch {
      throw new BadRequestException('stripPattern이 올바른 정규식이 아닙니다');
    }
    // 백트래킹 유발용 대표 입력으로 실행 시간 측정(정상 패턴은 1ms 미만).
    const probe = 'a'.repeat(40) + '!' + 'X1234567890'.repeat(4);
    const started = process.hrtime.bigint();
    probe.replace(re, '');
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    if (elapsedMs > 25) {
      throw new BadRequestException(`stripPattern 처리가 지나치게 느립니다(${elapsedMs.toFixed(0)}ms) — 백트래킹 위험 패턴`);
    }
  }

  async updateConfig(dto: BarcodeConfigDto, actor?: string) {
    if (dto.stripPattern) this.assertSafePattern(dto.stripPattern);
    const autoSubmit = dto.autoSubmit && isOneOf(AUTO_SUBMIT_MODES, dto.autoSubmit) ? dto.autoSubmit : undefined;
    const data = {
      ...(dto.trimWhitespace !== undefined ? { trimWhitespace: dto.trimWhitespace } : {}),
      ...(dto.prefixStrip !== undefined ? { prefixStrip: dto.prefixStrip || null } : {}),
      ...(dto.suffixStrip !== undefined ? { suffixStrip: dto.suffixStrip || null } : {}),
      ...(dto.stripPattern !== undefined ? { stripPattern: dto.stripPattern || null } : {}),
      ...(dto.minLength !== undefined ? { minLength: dto.minLength } : {}),
      ...(dto.maxLength !== undefined ? { maxLength: dto.maxLength } : {}),
      ...(autoSubmit ? { autoSubmit } : {}),
      ...(dto.autoSubmitLen !== undefined ? { autoSubmitLen: dto.autoSubmitLen } : {}),
      ...(dto.idleMs !== undefined ? { idleMs: dto.idleMs } : {}),
      ...(dto.beep !== undefined ? { beep: dto.beep } : {}),
      updatedBy: actor ?? null,
    };
    return this.prisma.barcodeConfig.upsert({
      where: { id: SINGLETON },
      update: data,
      create: { id: SINGLETON, ...data },
    });
  }
}
