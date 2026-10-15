/**
 * SendoutService — sendout 도메인 서비스.
 *
 * 주요 진입점: `request()`, `markSent()`, `recordResult()`, `cancel()`, `list()`, `listBySpecimen()`
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Injectable, NotFoundException, BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { genId } from '../../common/id.util';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { ResultService } from '../result/result.service';
import { SubmitResultDto } from '../result/dto/result.dto';

/**
 * 외부검사 위탁(send-out) 서비스(C2) — 일반 검사의 외부 위탁검사실 의뢰·발송·결과회신 추적.
 * 상태: REQUESTED(의뢰) → SENT(발송) → RESULTED(회신). 취소는 CANCELLED.
 * 유전체 전용 수탁발송(genomic)과 별개로 일반 화학·면역 등 위탁 검사를 관리.
 */
@Injectable()
export class SendoutService {

  private readonly logger = new Logger(SendoutService.name);

  /** 미발송 노화 기준(일) — 의뢰만 하고 보내지 않은 검체가 이 기간을 넘기면 알린다. */
  private readonly STALE_DAYS = Number(process.env.SENDOUT_STALE_DAYS || 3);

  /**
   * 미발송 위탁 노화 감시 — 매일 09:00.
   *
   * 위탁은 "의뢰(REQUESTED) → 발송(SENT) → 회신"인데, 의뢰만 해두고 실제로 보내지 않으면
   * 검체는 조용히 늙는다. 화면에 노화 배지는 있었지만 **그 화면을 열어야만 보인다** —
   * 위탁은 매일 보는 화면이 아니라서 며칠씩 방치되기 쉽다.
   * 미확인 알림이 남아 있으면 새로 만들지 않는다(같은 사실을 매일 쌓지 않는다).
   */
  @Cron('0 0 9 * * *')
  async staleSendoutAlert(): Promise<void> {
    // [cron-guard] 크론 예외는 unhandledRejection이 되어 프로세스를 죽인다. 반드시 잡고 로깅한다.
    try {
      const cutoff = new Date(Date.now() - this.STALE_DAYS * 86400_000);
      const stale = await this.prisma.sendout.findMany({
        where: { status: 'REQUESTED', requestedDt: { lt: cutoff } },
        select: { sendoutId: true, specimenNo: true, testCode: true, requestedDt: true },
        take: 50,
      });
      if (stale.length === 0) return;
      const open = await this.prisma.notification.findFirst({ where: { ntype: '위탁지연', ackDt: null } });
      if (open) return; // 이미 미확인 알림이 있다 — 중복 적재 방지
      const list = stale.slice(0, 10).map((s) => `${s.specimenNo}(${s.testCode})`).join(', ');
      await this.prisma.notification.create({
        data: {
          notifyId: genId('NTF'),
          ntype: '위탁지연',
          target: '검사실',
          message: `미발송 위탁 ${stale.length}건(의뢰 후 ${this.STALE_DAYS}일 경과): ${list}${stale.length > 10 ? ' 외' : ''}`.slice(0, 500),
          createdDt: new Date(),
        },
      });
    } catch (e) {
      this.logger.error(`위탁 노화 감시 실패: ${e instanceof Error ? e.message : e}`);
    }
  }
  constructor(
    private readonly prisma: PrismaService,
    private readonly results: ResultService,
  ) {}

  /** 위탁 의뢰 등록 — 검체·검사·위탁검사실. */
  async request(dto: { specimenNo: string; testCode: string; referralLab: string; requestedBy?: string; note?: string }) {
    const spec = await this.prisma.specimen.findUnique({ where: { specimenNo: dto.specimenNo } });
    if (!spec) throw new NotFoundException(`검체 없음: ${dto.specimenNo}`);
    // ★미등록 검사코드를 허용하면 나중에 회신값으로 환자 결과를 만들 수 없다(Result는 TestMaster FK).
    //   위탁이 등록된 뒤에야 막다른 길임을 알게 되는 것을 의뢰 시점에 막는다.
    const test = await this.prisma.testMaster.findUnique({ where: { testCode: dto.testCode } });
    if (!test) throw new BadRequestException(`미등록 검사코드: ${dto.testCode} — 검사마스터에 먼저 등록하세요`);
    return this.prisma.sendout.create({
      data: {
        specimenNo: dto.specimenNo,
        testCode: dto.testCode,
        testName: test?.name ?? null,
        referralLab: dto.referralLab,
        requestedBy: dto.requestedBy ?? null,
        note: dto.note ?? null,
      },
    });
  }

  /** 발송 처리 — REQUESTED → SENT(발송일 기록). */
  async markSent(sendoutId: string) {
    const s = await this.prisma.sendout.findUnique({ where: { sendoutId } });
    if (!s) throw new NotFoundException(`위탁 없음: ${sendoutId}`);
    if (s.status !== 'REQUESTED') throw new BadRequestException(`발송 불가 상태: ${s.status}`);
    return this.prisma.sendout.update({ where: { sendoutId }, data: { status: 'SENT', sentDt: new Date() } });
  }

  /**
   * 결과 회신 — SENT → RESULTED. **회신값은 환자 결과(Result)로도 적재한다.**
   *
   * ★이전에는 Sendout 행에만 저장해서, 외부위탁 결과가 환자 결과 조회·누적보고서·
   *   결과지·HIS 발신·청구 어디에도 나타나지 않았다. 임상의는 검사를 의뢰했는데
   *   결과가 영영 보이지 않고, 위탁 목록을 따로 열어봐야만 값을 알 수 있었다.
   *
   * 정본 경로(ResultService.submitResult)를 그대로 태워 참고치 판정·위험치 통보·
   * 델타체크가 위탁 결과에도 동일하게 적용되게 한다. 다만 **자동검증은 하지 않는다**
   * (forceHold: 'SENDOUT') — 사람이 외부 보고서를 보고 옮겨 적은 값이고 외부 검사실의
   * 방법·참고치가 우리와 다를 수 있어, 검토 후 확정(verify)하도록 워크리스트에 남긴다.
   */
  async recordResult(sendoutId: string, dto: { resultValue: string; resultUnit?: string; resultedBy?: string; note?: string }) {
    const s = await this.prisma.sendout.findUnique({ where: { sendoutId } });
    if (!s) throw new NotFoundException(`위탁 없음: ${sendoutId}`);
    if (s.status === 'CANCELLED') throw new BadRequestException('취소된 위탁입니다');
    // 재회신으로 환자 결과가 중복 생성되지 않게 한다. 값 정정은 결과 정정 경로(원본 보존·버전).
    if (s.status === 'RESULTED') {
      throw new BadRequestException(
        `이미 회신 기록된 위탁입니다${s.resultId ? ` (결과 ${s.resultId})` : ''} — 값 정정은 결과 정정(POST /api/v1/results/:resultId/correct)으로 진행하세요`,
      );
    }
    // 완료 근거 강제 — 외부 회신값은 사람이 전사해 환자 결과가 되므로, 외부 결과지(스캔/PDF)를 검체에 첨부해야
    // 회신 확정. 전사 오류를 대사할 원본이 없으면 감사·정정이 불가하다.
    const attachCount = await this.prisma.resultAttachment.count({ where: { specimenNo: s.specimenNo } });
    if (attachCount === 0) {
      throw new BadRequestException('외부 회신 결과지(스캔·PDF)를 검체에 첨부한 뒤 회신하세요 — 전사 결과의 근거가 필요합니다');
    }

    // 결과 적재를 먼저 한다. 여기서 실패하면(미등록 코드·중복 확정 등) 위탁은 SENT로 남아
    // 재시도할 수 있다 — 반대 순서면 "회신 완료인데 결과는 없는" 상태로 굳는다.
    const submitted = await this.submitAsPatientResult(s, sendoutId, dto);
    const updated = await this.prisma.sendout.update({
      where: { sendoutId },
      data: {
        status: 'RESULTED',
        resultValue: dto.resultValue,
        resultUnit: dto.resultUnit ?? null,
        resultedBy: dto.resultedBy ?? null,
        resultedDt: new Date(),
        resultId: submitted.result.resultId,
        ...(dto.note ? { note: dto.note } : {}),
      },
    });
    return { ...updated, evaluation: submitted.evaluation };
  }

  /**
   * 회신값 → 환자 결과 적재. 정본 경로를 쓰되, 실패 사유는 위탁 문맥으로 바꿔 전달한다
   * (ResultService의 "재입력 대신 정정/재검" 안내는 위탁 담당자에게 맞지 않는다).
   */
  private async submitAsPatientResult(
    s: { specimenNo: string; testCode: string; referralLab: string },
    sendoutId: string,
    dto: { resultValue: string; resultUnit?: string; resultedBy?: string },
  ) {
    try {
      return await this.results.submitResult(
        {
          specimenNo: s.specimenNo,
          testCode: s.testCode,
          value: dto.resultValue,
          unit: dto.resultUnit ?? undefined,
          source: 'SENDOUT',
          enteredBy: dto.resultedBy ?? undefined,
          sourceDocRef: `SENDOUT:${sendoutId}`, // 외부 회신 원본 추적성
          comment: `외부위탁 회신(${s.referralLab})`,
        } satisfies Partial<SubmitResultDto> as SubmitResultDto,
        { forceHold: 'SENDOUT' },
      );
    } catch (e) {
      if (e instanceof ConflictException) {
        // 같은 검체·검사에 이미 원내 확정 결과가 있다. 위탁 회신을 조용히 버리거나
        // 덮어쓰지 않고, 사람이 어느 값이 맞는지 판단하도록 세운다.
        throw new ConflictException(
          `검체 ${s.specimenNo}의 ${s.testCode}에 이미 확정 결과가 있어 위탁 회신을 적재할 수 없습니다 — ` +
            `원내 결과와 위탁 회신 중 어느 값이 유효한지 확인 후, 필요하면 기존 결과를 정정하세요`,
        );
      }
      throw e;
    }
  }

  /** 위탁 취소. */
  async cancel(sendoutId: string, reason?: string) {
    const s = await this.prisma.sendout.findUnique({ where: { sendoutId } });
    if (!s) throw new NotFoundException(`위탁 없음: ${sendoutId}`);
    if (s.status === 'RESULTED') throw new BadRequestException('이미 결과회신된 위탁은 취소 불가');
    return this.prisma.sendout.update({ where: { sendoutId }, data: { status: 'CANCELLED', note: reason ?? s.note } });
  }

  /** 상태별 위탁 목록(기본 미회신=REQUESTED+SENT). */
  /**
   * 위탁 목록 — 기본은 미회신(REQUESTED+SENT). 기간(의뢰일) 지정 시 회신분 포함.
   * 회신된 건은 기본 목록에서 빠지므로, 지난 건은 기간으로 찾는다.
   */
  async list(status?: string, from?: string, to?: string) {
    const bound = (v: string, end: boolean): Date | null => {
      const d = new Date(v);
      if (isNaN(d.getTime())) return null;
      if (!v.includes('T')) { if (end) d.setHours(23, 59, 59, 999); else d.setHours(0, 0, 0, 0); }
      return d;
    };
    const range: { gte?: Date; lte?: Date } = {};
    if (from) { const d = bound(from, false); if (d) range.gte = d; }
    if (to) { const d = bound(to, true); if (d) range.lte = d; }
    const hasRange = range.gte || range.lte;
    const where = {
      ...(status ? { status } : hasRange ? {} : { status: { in: ['REQUESTED', 'SENT'] } }),
      ...(hasRange ? { requestedDt: range } : {}),
    };
    const rows = await this.prisma.sendout.findMany({ where, orderBy: { requestedDt: 'desc' }, take: 500 });
    return this.withMasterUnit(rows);
  }

  /** 검체별 위탁 이력. */
  async listBySpecimen(specimenNo: string) {
    const rows = await this.prisma.sendout.findMany({ where: { specimenNo }, orderBy: { requestedDt: 'desc' } });
    return this.withMasterUnit(rows);
  }

  /**
   * 각 위탁 행에 위탁검사의 **검사마스터 단위**(unitUcum)를 얹는다.
   * 회신값 입력 시 단위를 매번 손으로 치지 않고 이 값으로 자동 채우게 한다 — 오타·표기 불일치
   * (mIU/L vs miu/l 등)가 환자 결과에 섞이는 것을 줄인다. testCode는 Sendout의 평문 필드라
   * 관계가 없어 배치 조회로 붙인다.
   */
  private async withMasterUnit<T extends { testCode: string }>(rows: T[]): Promise<(T & { unitUcum: string | null })[]> {
    const codes = [...new Set(rows.map((r) => r.testCode))];
    const tests = codes.length
      ? await this.prisma.testMaster.findMany({ where: { testCode: { in: codes } }, select: { testCode: true, unitUcum: true } })
      : [];
    const unitBy = new Map(tests.map((t) => [t.testCode, t.unitUcum]));
    return rows.map((r) => ({ ...r, unitUcum: unitBy.get(r.testCode) ?? null }));
  }
}
