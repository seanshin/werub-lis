/**
 * InstrumentService — instrument 도메인 서비스.
 *
 * 주요 진입점: `listMappings()`, `upsertMapping()`, `logs()`, `ingest()`
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { ResultService } from '../result/result.service';
import { parseInstrumentPayload } from '../../domain/instrument-parsers';

/**
 * 장비 인터페이스 수집 서비스 — 자동 결과 수집 경로(협조 업체).
 * 원시 페이로드(ASTM/CSV) → 정규화 → 장비코드 매핑 → **수기 경로와 동일한**
 * ResultService 수집 파이프라인(자동평가·2차검증·감사)으로 수렴. (기획 22 §6-2)
 *
 * 비협조 업체는 수기·문서 경로가 영구 병존하며, 두 경로 모두 동일 결과 처리로 귀결.
 */
@Injectable()
export class InstrumentService {
  private readonly logger = new Logger(InstrumentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly results: ResultService,
  ) {}

  /** 장비코드→검사코드 매핑 목록(운영자 조회·설정). */
  listMappings(instrument?: string) {
    return this.prisma.instrumentMapping.findMany({
      where: instrument ? { instrument } : undefined,
      orderBy: [{ instrument: 'asc' }, { rawCode: 'asc' }],
    });
  }

  upsertMapping(dto: { instrument: string; rawCode: string; testCode: string }) {
    return this.prisma.instrumentMapping.upsert({
      where: { instrument_rawCode: { instrument: dto.instrument, rawCode: dto.rawCode } },
      update: { testCode: dto.testCode, status: 'USE' },
      create: { instrument: dto.instrument, rawCode: dto.rawCode, testCode: dto.testCode },
    });
  }

  /** 장비 통신 로그(최근순). */
  logs(limit = 50) {
    return this.prisma.interfaceLog.findMany({
      where: { ifId: 'IF-INSTR' },
      // payload는 ASTM/HL7 원문(환자ID·검체번호·검사값 전체)이라 목록에 실어 내보내지 않는다.
      // 이 API의 권한은 마스터 조회(MST:R)라 임상 결과 열람 권한과 등급이 다르다.
      // 원문이 필요한 장애조사는 연계 콘솔(integration)의 권한 경로를 쓸 것.
      select: {
        logId: true, ifId: true, direction: true, status: true, messageType: true,
        messageControlId: true, hisRef: true, createdDt: true, retryCount: true,
        // errorText: 스킵/실패 사유. 목록의 '오류' 열이 이 값을 렌더하므로 select에 포함해야 한다(누락 시 열이 항상 공백).
        errorText: true,
      },
      orderBy: { createdDt: 'desc' },
      take: limit,
    });
  }

  /**
   * 원시 결과 수집 — 파싱 → 코드매핑 → 결과 수집 파이프라인.
   * 매핑 미등록·검체 미존재는 건너뛰고 요약에 기록(부분 성공 허용).
   */
  async ingest(instrument: string, format: 'ASTM' | 'CSV', payload: string) {
    if (!payload || payload.trim() === '') throw new BadRequestException('빈 페이로드');

    const raws = parseInstrumentPayload(format, payload);
    const ingested: { specimenNo: string; testCode: string; flag: string | null; autoVerified: boolean }[] = [];
    const skipped: { specimenId: string; rawCode: string; reason: string }[] = [];

    // 장비 매핑 사전 로드
    const maps = await this.prisma.instrumentMapping.findMany({ where: { instrument, status: 'USE' } });
    const mapOf = new Map(maps.map((m) => [m.rawCode, m.testCode]));

    for (const r of raws) {
      const testCode = mapOf.get(r.rawCode);
      if (!testCode) {
        skipped.push({ specimenId: r.specimenId, rawCode: r.rawCode, reason: '매핑 미등록' });
        continue;
      }
      try {
        const res = await this.results.submitResult({
          specimenNo: r.specimenId,
          testCode,
          value: r.value,
          unit: r.unit,
          source: 'INSTRUMENT',
          enteredBy: instrument,
          instrument,
        });
        ingested.push({
          specimenNo: r.specimenId,
          testCode,
          flag: res.evaluation.flag,
          autoVerified: res.evaluation.autoVerified,
        });
      } catch (e) {
        skipped.push({ specimenId: r.specimenId, rawCode: r.rawCode, reason: e instanceof Error ? e.message : '수집 실패' });
      }
    }

    // 통신 로그(감사·재처리용 원문 보존)
    await this.prisma.interfaceLog.create({
      data: {
        ifId: 'IF-INSTR',
        direction: 'INBOUND',
        messageType: `INSTRUMENT(${format})`,
        // 배치 수집은 자연 멱등키가 없어 매 수집 고유값 부여(연속 호출 충돌 방지)
        messageControlId: `${instrument}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        status: skipped.length === 0 ? 'PROCESSED' : ingested.length > 0 ? 'PARTIAL' : 'FAILED',
        errorText: skipped.length ? JSON.stringify(skipped).slice(0, 500) : null,
        payload,
      },
    });

    // ★실패를 로그에 남긴다. 이전에는 interfaceLog 행에만 남아, 시약 로트 교체로 매핑이 어긋나면
    //   오전 검사 전량이 드롭돼도 로그 0줄·알림 0건이었다(검사자는 "결과가 아직 안 왔네"로 오인).
    if (skipped.length > 0) {
      const level = ingested.length > 0 ? 'warn' : 'error';
      const msg = `장비 결과 수집 ${ingested.length > 0 ? '부분' : ''}실패(${instrument}): 수신 ${raws.length} · 적재 ${ingested.length} · 누락 ${skipped.length} — ${JSON.stringify(skipped).slice(0, 300)}`;
      if (level === 'error') this.logger.error(msg); else this.logger.warn(msg);
    }
    return { instrument, format, received: raws.length, ingested, skipped };
  }
}
