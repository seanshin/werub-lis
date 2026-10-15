/**
 * TransfusionService — transfusion 도메인 서비스.
 *
 * 주요 진입점: `returnUnit()`, `listRequirements()`, `addRequirement()`, `deactivateRequirement()`, `antibodyPanelTemplate()`, `interpretAntibodyPanel()`, `compatibleUnits()`, `nearExpiry()`…
 * 스케줄 작업 1건 — env 스위치로 켜고 끈다(운영단계 정의서 §4 참조).
 * 일부 경로는 트랜잭션으로 묶인다 — 부분 반영 시 임상 상태가 깨지는 구간.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Injectable, BadRequestException, NotFoundException, ConflictException, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { IssueBloodDto, RegisterUnitDto, BloodTypingDto, AdministerDto, ReactionDto, ReactionInvestigationDto, CrossmatchDto } from './dto/transfusion.dto';
import { checkIssueEligibility, determineCrossmatch, parseBloodGroup, validateTypingValues, type Abo, type RhD } from '../../domain/transfusion-safety';
import { antigenCompatible } from '../../domain/antibody-match';
import { buildTransfusionEvidenceContext } from '../../domain/transfusion-evidence-context';
import { interpretPanel, STANDARD_PANEL } from '../../domain/antibody-panel';
import { expiryStatus, isValidReaction, reactionGuidance, addDays } from '../../domain/transfusion-lifecycle';
import { getConsentStatus } from '../../integration/his-integration-client';
import { genId } from '../../common/id.util';

@Injectable()
export class TransfusionService {
  private readonly logger = new Logger(TransfusionService.name);
  constructor(private readonly prisma: PrismaService) {}

  /** 출고 취소·반납 — 아직 시행 전(제제 ISSUED)인 출고를 되돌려 재고 복원(IN_STOCK). */
  /** 출고 후 재입고 허용 시간(분) — 통제온도 이탈 규칙(기본 30분). 초과분은 재출고 금지·폐기. */
  private returnWindowMinutes(): number {
    const n = Number(process.env.TRANSFUSION_RETURN_MINUTES);
    return Number.isFinite(n) && n > 0 ? n : 30;
  }

  async returnUnit(issueId: string, reason?: string) {
    const issue = await this.prisma.bloodIssue.findUnique({ where: { issueId } });
    if (!issue) throw new NotFoundException(`출고 기록 없음: ${issueId}`);
    if (issue.status === 'RETURNED') throw new BadRequestException('이미 반납된 출고입니다');

    // 냉장 30분 규칙(A2): 출고 후 통제온도 이탈 시간이 창을 넘으면 재입고 불가 → 폐기(DISCARDED).
    //   RBC가 통제온도 밖 >30분이면 재출고 불가(용혈·세균증식 위험). 경과판정은 issuedDt 기준.
    const window = this.returnWindowMinutes();
    const elapsedMin = issue.issuedDt ? (Date.now() - issue.issuedDt.getTime()) / 60000 : 0;
    const discard = elapsedMin > window;

    return this.prisma.$transaction(async (tx) => {
      // 제제가 ISSUED일 때만 전이(TRANSFUSED면 반납 불가). 창 내=IN_STOCK 복원, 초과=DISCARDED 폐기.
      const nextStatus = discard ? 'DISCARDED' : 'IN_STOCK';
      const claim = await tx.bloodUnit.updateMany({ where: { unitNo: issue.unitNo, status: 'ISSUED' }, data: { status: nextStatus } });
      if (claim.count === 0) throw new BadRequestException('반납 불가 — 이미 시행(TRANSFUSED)되었거나 재고 상태가 아닙니다');
      const noteReason = discard
        ? `${reason ? reason + ' · ' : ''}통제온도 이탈 ${Math.round(elapsedMin)}분(>${window}분) — 재입고 불가 폐기`
        : (reason ?? null);
      const updated = await tx.bloodIssue.update({ where: { issueId }, data: { status: 'RETURNED', returnReason: noteReason, returnedDt: new Date() } });
      return { issue: updated, unitNo: issue.unitNo, restored: nextStatus, discarded: discard, elapsedMin: Math.round(elapsedMin) };
    });
  }

  /** 환자별 특수수혈 요구 조회(활성). */
  async listRequirements(patientId: string) {
    return this.prisma.patientTransfusionReq.findMany({ where: { patientId }, orderBy: [{ active: 'desc' }, { createdDt: 'desc' }] });
  }

  /** 특수수혈 요구 등록 — 이후 이 환자 출고는 서버가 해당 속성을 강제(요청 누락 무관). */
  async addRequirement(dto: { patientId: string; requirement: string; reason?: string; createdBy?: string }) {
    const valid = ['IRRADIATED', 'CMV_NEG', 'LEUKOREDUCED', 'WASHED'];
    if (!valid.includes(dto.requirement)) throw new BadRequestException(`요구 유형 오류: ${dto.requirement}`);
    // 동일 활성 요구 중복 방지
    const dup = await this.prisma.patientTransfusionReq.findFirst({ where: { patientId: dto.patientId, requirement: dto.requirement, active: true } });
    if (dup) return dup;
    return this.prisma.patientTransfusionReq.create({
      data: { patientId: dto.patientId, requirement: dto.requirement, reason: dto.reason ?? null, createdBy: dto.createdBy ?? null },
    });
  }

  /** 특수수혈 요구 해제(비활성화) — 이력 보존 위해 삭제 대신 active=false. */
  async deactivateRequirement(reqId: string) {
    const r = await this.prisma.patientTransfusionReq.findUnique({ where: { reqId } });
    if (!r) throw new NotFoundException(`요구 없음: ${reqId}`);
    return this.prisma.patientTransfusionReq.update({ where: { reqId }, data: { active: false } });
  }

  /** 항체동정 패널(11-cell) 반응 조회용 템플릿 — 세포별 항원 프로파일. */
  antibodyPanelTemplate() {
    return { cells: STANDARD_PANEL, antigens: Object.keys(STANDARD_PANEL[0].antigens) };
  }

  /**
   * 항체동정 패널 판정 — 환자 혈청 반응(세포별 +/0)으로 룰아웃·후보·동정 산출.
   * 동정 시 옵션(recordTyping)으로 혈액형 이력에 항체 기록(항원음성 매칭에 반영).
   */
  async interpretAntibodyPanel(dto: { patientId: string; reactivity: boolean[]; tester?: string; recordTyping?: { abo: string; rhD: string } }) {
    if (!Array.isArray(dto.reactivity) || dto.reactivity.length !== STANDARD_PANEL.length) {
      throw new BadRequestException(`반응 배열 길이는 ${STANDARD_PANEL.length}(세포 수)여야 합니다`);
    }
    if (!dto.reactivity.every((r) => typeof r === 'boolean')) {
      throw new BadRequestException('반응 배열 요소는 불리언이어야 합니다');
    }
    const result = interpretPanel(STANDARD_PANEL, dto.reactivity);
    let typingId: string | null = null;
    if (dto.recordTyping && result.identified.length > 0) {
      // ★ABO/RhD 재검증(불가침): 이 레코드가 최신 typing이 되어 issueBlood의 ABO 독립방벽 입력이 된다.
      //   컨트롤러 DTO 검증에만 의존하지 않고 서비스 진입점에서 열거값을 강제한다(방벽 입력 오염 차단).
      const bad = validateTypingValues(dto.recordTyping.abo, dto.recordTyping.rhD);
      if (bad) throw new BadRequestException(bad);
      const t = await this.prisma.bloodTyping.create({
        data: { patientId: dto.patientId, abo: dto.recordTyping.abo, rhD: dto.recordTyping.rhD, antibodyScreen: 'POS', antibodyId: result.antibodies, tester: dto.tester ?? null },
      });
      typingId = t.typingId;
    }
    return { patientId: dto.patientId, ...result, recordedTypingId: typingId };
  }

  /** 항원음성 적합 유닛 매칭 — 환자 동정 항체에 대응하는 항원음성 재고. 동종면역 환자 수혈 준비. */
  async compatibleUnits(patientId: string, bloodGroup?: string) {
    // F3: 전체 이력에서 동정 항체 합집합(항체 소실 대비)
    const typings = await this.prisma.bloodTyping.findMany({ where: { patientId }, orderBy: { testedDt: 'desc' } });
    const allAntibodies = typings.map((t) => t.antibodyId).filter((x): x is string => !!x && x.trim() !== '').join(', ') || null;
    const units = await this.prisma.bloodUnit.findMany({
      where: { status: 'IN_STOCK', ...(bloodGroup ? { bloodGroup } : {}) },
      orderBy: { expiryDate: 'asc' },
    });
    const matched = units
      .map((u) => ({ unit: u, antigen: antigenCompatible(allAntibodies, u.antigenNeg) }))
      .filter((x) => x.antigen.compatible)
      .map((x) => ({ ...x.unit, antigenCompatible: true }));
    return {
      patientId,
      antibodies: allAntibodies,
      requiredAntigenNeg: antigenCompatible(allAntibodies, null).requiredNeg,
      units: matched,
    };
  }

  /** 근접만료 재고 — IN_STOCK 중 지정 일수(기본 7) 내 만료 제제. 폐기 예방 워크리스트. */
  async nearExpiry(days = 7) {
    const today = this.today();
    const limit = addDays(today, days);
    const units = await this.prisma.bloodUnit.findMany({
      where: { status: 'IN_STOCK', expiryDate: { not: null, lte: limit } },
      orderBy: { expiryDate: 'asc' },
    });
    return units.map((u) => ({ ...u, expiryStatus: expiryStatus(u.expiryDate, today, days) }));
  }

  /** 매일 08:00 근접만료 재고 알림 생성(혈액은행). 폐기 예방. */
  @Cron('0 0 8 * * *')
  async nearExpiryAlert(): Promise<void> {
    // [cron-guard:nearExpiryAlert] 크론에서 던진 예외는 unhandledRejection이 되어 프로세스를 죽인다.
    //   죽지 않더라도 조용히 멈추면 다음 주기까지 아무도 모르므로 반드시 로깅한다.
    try {
      const soon = await this.nearExpiry(7);
      if (soon.length === 0) return;
      const list = soon.map((u) => `${u.unitNo}(${u.bloodGroup}·${u.expiryDate})`).join(', ');
      await this.prisma.notification
        .create({ data: { notifyId: genId('NTF'), ntype: '혈액근접만료', target: '혈액은행', message: `7일 내 만료 제제 ${soon.length}건: ${list}`.slice(0, 500), createdDt: new Date() } })
        .catch((e) => this.logger.warn(`근접만료 알림 실패: ${e instanceof Error ? e.message : e}`));
  
    } catch (e) {
      this.logger.error(`크론 nearExpiryAlert 실패: ${e instanceof Error ? e.message : e}`);
    }
}

  private today(): string {
    // 병원 표준시(KST) 기준 날짜. toISOString()은 UTC라, KST 오전(≈09시 이전)엔 전날로 계산돼
    //   'KST 어제' 만료 제제가 만료 게이트를 통과하는 창(≈9시간)이 생긴다(T4). 명시적 Asia/Seoul로 산출.
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
  }

  async getInventory(bloodGroup?: string, status?: string) {
    const units = await this.prisma.bloodUnit.findMany({
      where: {
        bloodGroup: bloodGroup || undefined,
        status: status || undefined,
      },
      orderBy: { expiryDate: 'asc' },
    });
    const today = this.today();
    return units.map((u) => ({ ...u, expiryStatus: expiryStatus(u.expiryDate, today) }));
  }

  /** 혈액제제 입고 — 신규 제제 등록. */
  async registerUnit(dto: RegisterUnitDto) {
    const dup = await this.prisma.bloodUnit.findUnique({ where: { unitNo: dto.unitNo } });
    if (dup) throw new BadRequestException(`이미 등록된 제제: ${dto.unitNo}`);
    if (dto.expiryDate < this.today()) throw new BadRequestException(`유효기간이 지난 제제는 입고 불가: ${dto.expiryDate}`);
    return this.prisma.bloodUnit.create({
      data: {
        unitNo: dto.unitNo,
        productType: dto.productType,
        bloodGroup: dto.bloodGroup,
        drawnDate: dto.drawnDate ?? null,
        expiryDate: dto.expiryDate,
        status: 'IN_STOCK',
        irradiated: dto.irradiated ?? false,
        cmvNeg: dto.cmvNeg ?? false,
        leukoreduced: dto.leukoreduced ?? false,
        washed: dto.washed ?? false,
        antigenNeg: dto.antigenNeg ?? null,
        donationId: dto.donationId ?? null,
      },
    });
  }

  /** 환자 혈액형·항체선별 검사 등록. */
  async recordTyping(dto: BloodTypingDto) {
    // 컨트롤러 DTO와 동일 검증을 서비스에서도 강제(ABO 독립방벽 입력 정본 보호).
    const bad = validateTypingValues(dto.abo, dto.rhD);
    if (bad) throw new BadRequestException(bad);
    return this.prisma.bloodTyping.create({
      data: {
        patientId: dto.patientId,
        abo: dto.abo,
        rhD: dto.rhD,
        antibodyScreen: dto.antibodyScreen,
        antibodyId: dto.antibodyId ?? null,
        tester: dto.tester ?? null,
      },
    });
  }

  /** 환자 최신 혈액형·항체 이력. */
  async getTyping(patientId: string) {
    return this.prisma.bloodTyping.findMany({ where: { patientId }, orderBy: { testedDt: 'desc' } });
  }

  /**
   * 출고 대상 환자 확인 컨텍스트(P1-17) — **성명**·생년·성별 + 최신 혈액형 + 특수요구.
   *
   * 출고 화면의 환자ID는 자유입력이다. 이름 없이 ID만 대조시키면 오타를 눈으로 잡을 수 없고,
   * 하필 그 오타가 실재하는 타 환자 ID면 ABO 방벽이 **엉뚱한 환자의 혈액형**으로 검증한다.
   * 접수 화면에는 환자확인 스트립이 있는데 정작 가장 위험한 출고에 없던 역전을 메운다.
   */
  async issueContext(patientId: string) {
    const patient = await this.prisma.patient.findUnique({
      where: { patientId },
      select: { patientId: true, name: true, birthDate: true, sex: true },
    });
    if (!patient) throw new NotFoundException(`환자 없음: ${patientId}`);
    const [typings, reqs] = await Promise.all([
      this.prisma.bloodTyping.findMany({ where: { patientId }, orderBy: { testedDt: 'desc' } }),
      this.prisma.patientTransfusionReq.findMany({ where: { patientId, active: true } }),
    ]);
    const latest = typings[0] ?? null;
    return {
      patient,
      latestTyping: latest,
      typingCount: typings.length,
      // 이력이 갈리면 화면에서 경고해야 한다(출고 게이트도 막지만, 조작자가 미리 알아야 재검을 건다).
      typingDiscordant: !!latest && typings.some((t) => t.abo !== latest.abo || t.rhD !== latest.rhD),
      requirements: reqs.map((r) => r.requirement),
    };
  }

  /** 교차시험(Crossmatch) 기록 — 출고 안전게이트(적합) 근거. */
  async recordCrossmatch(dto: CrossmatchDto) {
    const unit = await this.prisma.bloodUnit.findUnique({ where: { unitNo: dto.unitNo } });
    if (!unit) throw new NotFoundException(`제제 없음: ${dto.unitNo}`);
    const patient = await this.prisma.patient.findUnique({ where: { patientId: dto.patientId } });
    if (!patient) throw new NotFoundException(`환자 없음: ${dto.patientId}`);
    return this.prisma.crossmatch.create({
      data: {
        xmId: genId('XM'),
        patientId: dto.patientId,
        unitNo: dto.unitNo,
        result: dto.result,
        method: dto.method ?? null,
        tester: dto.tester ?? null,
      },
    });
  }

  /**
   * 교차시험 생성(혈청학적 판정) — 환자 최신 혈액형·항체선별 + 제제 혈액형으로 ABO/RhD 적합성을 판정·기록.
   * 판정: 적합(전자교차) / 부적합(ABO·RhD 불일치) / 추가검사필요(항체양성 → AHG 교차 필요, 자동 적합 금지).
   * 결과는 crossmatch에 기록되어 출고 안전게이트('적합'만 통과) 근거가 된다.
   */
  async performCrossmatch(dto: { patientId: string; unitNo: string; tester?: string }) {
    const unit = await this.prisma.bloodUnit.findUnique({ where: { unitNo: dto.unitNo } });
    if (!unit) throw new NotFoundException(`제제 없음: ${dto.unitNo}`);
    const patient = await this.prisma.patient.findUnique({ where: { patientId: dto.patientId } });
    if (!patient) throw new NotFoundException(`환자 없음: ${dto.patientId}`);

    const typings = await this.prisma.bloodTyping.findMany({ where: { patientId: dto.patientId }, orderBy: { testedDt: 'desc' } });
    const typing = typings[0];
    if (!typing) throw new BadRequestException('환자 혈액형·항체선별 검사가 선행되어야 합니다(혈액형 미등록)');

    const unitBg = parseBloodGroup(unit.bloodGroup);
    if (!unitBg) throw new BadRequestException(`제제 혈액형 정보 없음/파싱 불가: ${unit.bloodGroup ?? '(없음)'}`);

    // F3 항체 소실 대비: 과거에 한 번이라도 항체선별 양성/동정 항체가 있으면 최신이 음성이어도 항체 있는 것으로 취급
    //   → 전자교차 금지(AHG 필요). 한 번 동정된 항체는 영구 존중.
    const everHadAntibody = typings.some((t) => t.antibodyScreen === 'POS' || (t.antibodyId != null && t.antibodyId.trim() !== ''));
    const effectiveScreen = everHadAntibody ? 'POS' : typing.antibodyScreen;

    const determination = determineCrossmatch({
      recipientAbo: typing.abo as Abo,
      recipientRhD: typing.rhD as RhD,
      antibodyScreen: effectiveScreen,
      unitAbo: unitBg.abo,
      unitRhD: unitBg.rhD,
      productType: unit.productType,
    });

    const saved = await this.prisma.crossmatch.create({
      data: {
        xmId: genId('XM'),
        patientId: dto.patientId,
        unitNo: dto.unitNo,
        result: determination.result,
        method: determination.method,
        tester: dto.tester ?? null,
      },
    });
    return { determination, crossmatch: saved };
  }

  /** 환자+제제 최신 교차시험 결과. */
  async getCrossmatch(patientId: string, unitNo: string) {
    return this.prisma.crossmatch.findFirst({ where: { patientId, unitNo }, orderBy: { testedDt: 'desc' } });
  }

  /** 수혈 시행 기록 — 출고된 제제를 환자에게 시행. */
  async administer(dto: AdministerDto) {
    const issue = await this.prisma.bloodIssue.findUnique({ where: { issueId: dto.issueId } });
    if (!issue) throw new NotFoundException(`출고 기록 없음: ${dto.issueId}`);
    // C4 원자적 전이: 제제가 ISSUED일 때만 TRANSFUSED로 클레임(이중 시행·미출고 시행 방지)
    return this.prisma.$transaction(async (tx) => {
      // ★출고건(BloodIssue) 자체도 원자적으로 클레임한다.
      //   제제 상태만 보면, 이 출고가 반납된 뒤 **다른 환자에게 재출고**된 경우에도
      //   제제가 ISSUED라는 이유로 통과해 시행이 이전 환자 앞으로 기록된다.
      //   룩백·환자별 수혈이력이 모두 BloodIssue 기준이라 추적성이 깨진다.
      const issueClaim = await tx.bloodIssue.updateMany({
        where: { issueId: dto.issueId, status: 'ISSUED' },
        data: { status: 'TRANSFUSED' },
      });
      if (issueClaim.count === 0) {
        throw new BadRequestException('시행 불가 — 이 출고 건이 유효한 출고(ISSUED) 상태가 아닙니다(이미 시행/반납?)');
      }
      const claim = await tx.bloodUnit.updateMany({
        where: { unitNo: issue.unitNo, status: 'ISSUED' },
        data: { status: 'TRANSFUSED' },
      });
      if (claim.count === 0) throw new BadRequestException('시행 불가 — 제제가 출고(ISSUED) 상태가 아닙니다(이미 시행/반납?)');
      return tx.transfusionAct.create({
        data: {
          issueId: dto.issueId,
          patientId: issue.patientId,
          administeredBy: dto.administeredBy ?? null,
          note: dto.note ?? null,
          status: 'ONGOING',
        },
      });
    });
  }

  /** 수혈 부작용 보고 — 유형·중증도별 권고 조치 포함. */
  async reportReaction(dto: ReactionDto) {
    if (!isValidReaction(dto.reactionType, dto.severity)) {
      throw new BadRequestException(`부작용 유형/중증도 오류: ${dto.reactionType}/${dto.severity}`);
    }
    const guidance = reactionGuidance(dto.reactionType, dto.severity);
    const reaction = await this.prisma.transfusionReaction.create({
      data: {
        issueId: dto.issueId ?? null,
        patientId: dto.patientId,
        reactionType: dto.reactionType,
        severity: dto.severity,
        symptoms: dto.symptoms ?? null,
        action: guidance,
        reportedBy: dto.reportedBy ?? null,
      },
    });
    // 중증/용혈은 시행 중단 처리
    const severe = dto.severity === 'SEVERE' || dto.reactionType === 'HEMOLYTIC';
    if (dto.issueId && severe) {
      await this.prisma.transfusionAct.updateMany({ where: { issueId: dto.issueId, status: 'ONGOING' }, data: { status: 'STOPPED' } });
    }
    /**
     * 중대 반응은 알림함에도 올린다.
     *
     * 기존엔 시행 중단만 하고 통보가 없어서, **보고 화면을 연 사람 말고는 아무도 몰랐다.**
     * 중대 수혈반응은 원인 제제 격리·조사 착수·(필요 시) 동일 헌혈자 제제 추적이 뒤따라야
     * 하는데, 그 착수 주체가 혈액은행이라 인지 경로가 없으면 조사가 늦어진다.
     * (위험치처럼 복창까지 요구하지는 않는다 — 여기서는 인지·착수가 목적이다.)
     */
    if (severe) {
      await this.prisma.notification
        .create({
          data: {
            notifyId: genId('NTF'),
            ntype: '중대수혈반응',
            target: '혈액은행',
            message: `중대 수혈반응 — 환자 ${dto.patientId} · ${dto.reactionType}/${dto.severity}${dto.issueId ? ` · 출고 ${dto.issueId}(시행 중단됨)` : ''} · 조사 착수 필요`.slice(0, 500),
            createdDt: new Date(),
          },
        })
        .catch((e) => this.logger.error(`중대 수혈반응 알림 생성 실패 ${reaction.reactionId}: ${e instanceof Error ? e.message : e}`));
    }
    return { reaction, guidance };
  }

  /**
   * 수혈 반응 조사 워크업(A5) — 보고 후 구조화 조사 기록(사무착오·DAT·post ABO 재검·용혈지표·원인제제·최종분류).
   * 최종분류 입력 시 조사 CLOSED, 아니면 IN_PROGRESS. 제공된 필드만 갱신(부분 진행 허용).
   */
  /** 반응 조사 상태 조회(C5) — 워크업 폼 prefill·종결 여부 확인용. 등록만 있고 읽기 EP가 없어 재방문 시 상태를 못 봤다. */
  async getReaction(reactionId: string) {
    const rx = await this.prisma.transfusionReaction.findUnique({ where: { reactionId } });
    if (!rx) throw new NotFoundException(`반응 기록 없음: ${reactionId}`);
    const attachmentCount = await this.prisma.resultAttachment.count({ where: { reactionId } });
    return { ...rx, attachmentCount };
  }

  async investigateReaction(reactionId: string, dto: ReactionInvestigationDto, investigatedBy?: string) {
    const rx = await this.prisma.transfusionReaction.findUnique({ where: { reactionId } });
    if (!rx) throw new NotFoundException(`반응 기록 없음: ${reactionId}`);
    // ★중대 반응(급성용혈 AHTR·세균오염 BACTERIAL) 종결 근거 강제 — 상태만 CLOSED로 넘기지 못하게.
    //   혈액관리법/혈액안전: 사무착오 대조·post-DAT·post-ABO 재검이 결론 전 최소 워크업이고, 조사서를 남긴다.
    const SERIOUS = ['AHTR', 'BACTERIAL'];
    if (dto.finalClassification && SERIOUS.includes(dto.finalClassification)) {
      const clerical = dto.clericalCheckOk ?? rx.clericalCheckOk;
      const dat = dto.postDat ?? rx.postDat;
      const abo = dto.postAboRecheck ?? rx.postAboRecheck;
      if (clerical == null || dat == null || abo == null) {
        throw new BadRequestException('중대 반응(급성용혈·세균오염) 종결에는 사무착오 대조·post-DAT·post-ABO 재검이 필수입니다');
      }
      const attachCount = await this.prisma.resultAttachment.count({ where: { reactionId } });
      if (attachCount === 0) {
        throw new BadRequestException('중대 반응 종결에는 이상반응 조사서(스캔/사진)를 첨부하세요');
      }
    }
    return this.prisma.transfusionReaction.update({
      where: { reactionId },
      data: {
        ...(dto.clericalCheckOk != null ? { clericalCheckOk: dto.clericalCheckOk } : {}),
        ...(dto.postDat != null ? { postDat: dto.postDat } : {}),
        ...(dto.postAboRecheck != null ? { postAboRecheck: dto.postAboRecheck } : {}),
        ...(dto.hemolysisVisual != null ? { hemolysisVisual: dto.hemolysisVisual } : {}),
        ...(dto.labFindings != null ? { labFindings: dto.labFindings } : {}),
        ...(dto.culpritUnitNo != null ? { culpritUnitNo: dto.culpritUnitNo } : {}),
        ...(dto.finalClassification != null ? { finalClassification: dto.finalClassification } : {}),
        ...(dto.conclusion != null ? { conclusion: dto.conclusion } : {}),
        investigationStatus: dto.finalClassification ? 'CLOSED' : 'IN_PROGRESS',
        investigatedBy: investigatedBy ?? rx.investigatedBy,
        investigatedDt: new Date(),
      },
    });
  }

  /**
   * 혈액제제 출고 — 출고 전 안전 게이트(04 A-3) 통과 + 2인 확인 필수.
   */
  /**
   * ★출고 적격성 평가 정본(단일 구현) — issueBlood(실제 출고)와 issueEligibility(사전점검)가 공유한다.
   *
   * 판정 로직이 두 곳에 복제되면 사전점검과 실제 게이트가 갈릴 수 있고, 그건 곧 조작자가
   * "통과"를 보고 출고를 시도했다 막히거나(신뢰 상실) **반대로 통과할 줄 알았는데 통과하는**
   * 위험이다. 그래서 평가는 여기 한 곳에서만 한다.
   *
   * 부수효과 없음(읽기 전용). 확인자 2인·응급 여부처럼 요청에 종속된 조건은 호출자가 덧붙인다.
   * softReasons: 응급 시 사후처리 조건으로 우회 가능 / hardReasons: 응급에도 불가침.
   */
  private async evaluateIssueEligibility(patientId: string, unitNo: string, specialRequired?: string[]) {
    const patient = await this.prisma.patient.findUnique({ where: { patientId }, select: { patientId: true, name: true } });
    if (!patient) throw new NotFoundException(`환자 없음: ${patientId} — 환자ID를 확인하세요(오타 시 타 환자 오출고 위험)`);
    const unit = await this.prisma.bloodUnit.findUnique({ where: { unitNo } });
    if (!unit) throw new NotFoundException(`제제 없음: ${unitNo}`);

    const xm = await this.prisma.crossmatch.findFirst({
      where: { patientId, unitNo },
      orderBy: { testedDt: 'desc' }, // 시간순 최신(같은날 재검 안전)
    });

    // C3 서버측 ABO 검증 — 클라 자기신고를 신뢰하지 않고 실 혈액형 이력에서 도출
    const typings = await this.prisma.bloodTyping.findMany({ where: { patientId }, orderBy: { testedDt: 'desc' } });
    const latest = typings[0];
    const concordant = latest ? typings.filter((t) => t.abo === latest.abo && t.rhD === latest.rhD) : [];
    const aboVerifiedTwice = concordant.length >= 2; // 독립 2회 동일 판정
    const aboMatchesHistory = typings.length > 0 && typings.every((t) => t.abo === latest!.abo && t.rhD === latest!.rhD);

    // C3b 교차시험 72시간 유효창 — 만료 교차는 재검 필요(항체 신생·최근 수혈 대비)
    const XM_VALID_MS = 72 * 3600 * 1000;
    const xmAgeMs = xm ? Date.now() - new Date(xm.testedDt).getTime() : null;
    const xmExpired = xmAgeMs != null && xmAgeMs > XM_VALID_MS;

    // C5 제제 특수속성 → 특수요구 게이트 근거(방사선조사·CMV음성 등)
    const unitAttributes = [
      unit.irradiated && 'IRRADIATED',
      unit.cmvNeg && 'CMV_NEG',
      unit.leukoreduced && 'LEUKOREDUCED',
      unit.washed && 'WASHED',
    ].filter((x): x is string => typeof x === 'string');

    // F7: 환자별 특수수혈 요구를 서버가 강제 — 요청에 누락돼도 이력에서 도출해 합집합
    const activeReqs = await this.prisma.patientTransfusionReq.findMany({ where: { patientId, active: true } });
    const requiredFromProfile = activeReqs.map((r) => r.requirement);
    const effectiveSpecialRequired = [...new Set([...(specialRequired ?? []), ...requiredFromProfile])];

    const today = this.today(); // KST 기준 — UTC면 KST 오전에 '어제' 만료품이 통과(T4)
    const check = checkIssueEligibility({
      aboVerifiedTwice,
      aboMatchesHistory,
      crossmatchResult: xm?.result ?? null,
      expiryDate: unit.expiryDate ?? '9999-12-31',
      now: today,
      specialRequired: effectiveSpecialRequired,
      unitAttributes,
    });
    const softReasons = [...check.reasons];
    if (typings.length === 0) softReasons.push('환자 혈액형 검사 이력 없음(선행 필요)');
    if (xmExpired) softReasons.push('교차시험 72시간 초과 — 재검 필요');

    const hardReasons: string[] = [];
    // 유효기간 만료 제제는 응급에도 출고 불가(불가침).
    if (unit.expiryDate && unit.expiryDate < today) hardReasons.push(`제제 유효기간 만료(${unit.expiryDate})`);

    // ★2차 방벽(F1/F2, 불가침): 교차시험 기록 문자열과 무관하게, 환자 최신 혈액형 vs 제제 혈액형으로
    //   ABO/RhD 적합성을 서버가 독립 재계산. 수기 '적합' 오입력·응급 무관하게 실제 부적합이면 무조건 차단.
    const unitBg = parseBloodGroup(unit.bloodGroup);
    let indepResult: string | null = null;
    if (latest && unitBg) {
      const indep = determineCrossmatch({
        recipientAbo: latest.abo as Abo,
        recipientRhD: latest.rhD as RhD,
        antibodyScreen: 'NEG', // ABO/RhD 혈청학만(항체는 항원음성 매칭에서 별도 처리)
        unitAbo: unitBg.abo,
        unitRhD: unitBg.rhD,
        productType: unit.productType,
      });
      indepResult = indep.result;
      if (indep.result === '부적합') hardReasons.push(`ABO/RhD 독립검증 부적합(2차 방벽): ${indep.reasons.join('; ')}`);
    } else if (latest && !unitBg) {
      hardReasons.push(`제제 혈액형 파싱 불가(${unit.bloodGroup ?? '미상'}) — ABO/RhD 독립검증 불가`);
    }

    // 동종면역 환자 항원음성 매칭 — 과거 포함 전체 이력에서 동정 항체 합집합(항체 소실 대비 F3).
    const allAntibodies = typings.map((t) => t.antibodyId).filter((x): x is string => !!x && x.trim() !== '').join(', ');
    const antigen = antigenCompatible(allAntibodies || null, unit.antigenNeg);
    if (!antigen.compatible) softReasons.push(`항원 부적합 — 동정 항체(${antigen.requiredNeg.join(',')}) 대응 항원음성 제제 필요(미확인: ${antigen.missing.join(',')})`);

    // 동종면역(항체양성 이력) 환자는 전자/즉시원심 교차의 '적합'을 신뢰할 수 없다 — AHG(항글로불린법) 교차 필요.
    //   수기 recordCrossmatch가 method 무관하게 '적합' 저장 가능하므로, 이력상 항체양성이면 AHG가 아닌 '적합'은
    //   지연성 용혈 위험(미동정 동종항체)으로 보고 소프트 차단(비응급 차단·MTP는 사후 재확인으로 우회).
    //   performCrossmatch의 everHadAntibody(항체 소실 대비 이력 전체)와 동일 기준.
    const everHadAntibody = typings.some((t) => t.antibodyScreen === 'POS' || (t.antibodyId != null && t.antibodyId.trim() !== ''));
    const xmIsAhg = !!xm?.method && /AHG|항글로불린/i.test(xm.method);
    if (everHadAntibody && xm?.result === '적합' && !xmIsAhg) {
      softReasons.push('항체양성(동종면역) 이력 — 전자/즉시원심 교차 부적절, AHG(항글로불린법) 교차로 재확인 필요');
    }

    return {
      patient, unit, xm, typings, latest, concordantCount: concordant.length,
      checkEligible: check.eligible, // checkIssueEligibility 자체 판정(원래 safety.eligible 의미 보존)
      aboVerifiedTwice, aboMatchesHistory, xmExpired,
      xmAgeHours: xmAgeMs == null ? null : Math.floor(xmAgeMs / 3600000),
      unitAttributes, effectiveSpecialRequired, requiredFromProfile,
      unitBg, indepResult, antigen, allAntibodies,
      softReasons, hardReasons,
      statusBlock: unit.status !== 'IN_STOCK',
      recallBlock: !!unit.recallStatus,
    };
  }

  /**
   * 출고 적격성 사전점검(읽기 전용) — 근거 종합 번들.
   *
   * 이전엔 출고를 **시도해야만** 차단 사유를 알 수 있었다(예외로 튀어나옴). 조작자가 제제를 들고
   * 온 뒤에야 "교차시험 만료"를 알게 되는 식이다. 같은 판정 정본으로 미리 점검해 근거를 보여준다.
   */
  async issueEligibility(patientId: string, unitNo: string) {
    const ev = await this.evaluateIssueEligibility(patientId, unitNo);
    const blockers = [...ev.softReasons, ...ev.hardReasons];
    if (ev.statusBlock) blockers.unshift(`출고 불가 상태: ${ev.unit.status}`);
    if (ev.recallBlock) blockers.unshift(`제제 ${ev.unit.recallStatus}(회수/격리): ${ev.unit.recallReason ?? ''}`);
    return buildTransfusionEvidenceContext({
      patient: ev.patient,
      unit: {
        unitNo: ev.unit.unitNo, bloodGroup: ev.unit.bloodGroup, productType: ev.unit.productType,
        status: ev.unit.status, expiryDate: ev.unit.expiryDate,
        recallStatus: ev.unit.recallStatus, recallReason: ev.unit.recallReason,
        attributes: ev.unitAttributes, antigenNeg: ev.unit.antigenNeg,
      },
      typings: ev.typings.map((t) => ({ abo: t.abo, rhD: t.rhD, testedDt: t.testedDt ? new Date(t.testedDt).toISOString().slice(0, 16).replace('T', ' ') : null, tester: t.tester, antibodyId: t.antibodyId })),
      concordantCount: ev.concordantCount,
      aboVerifiedTwice: ev.aboVerifiedTwice,
      aboMatchesHistory: ev.aboMatchesHistory,
      crossmatch: ev.xm ? { result: ev.xm.result, method: ev.xm.method, tester: ev.xm.tester, testedDt: new Date(ev.xm.testedDt).toISOString().slice(0, 16).replace('T', ' '), ageHours: ev.xmAgeHours, expired: ev.xmExpired } : null,
      independentAboResult: ev.indepResult,
      specialRequired: ev.effectiveSpecialRequired,
      requiredFromProfile: ev.requiredFromProfile,
      identifiedAntibodies: ev.allAntibodies || null,
      antigenCompatible: ev.antigen.compatible,
      antigenMissing: ev.antigen.missing,
      softReasons: ev.softReasons,
      hardReasons: ev.hardReasons,
      blockers,
    });
  }

  async issueBlood(dto: IssueBloodDto) {
    // ★환자 실재 확인을 **가장 먼저** 한다. patientId는 화면에서 자유입력이라 오타가 나면
    //   존재하지 않는 환자에게 출고 기록이 생기고, 더 나쁘게는 **다른 실제 환자의 ID로 들어간다**.
    //   그 경우 아래 ABO 방벽이 엉뚱한 환자의 혈액형으로 검증하므로(둘이 같은 형이면 통과)
    //   방벽이 무력해진다. 제제 상태 오류가 먼저 뜨면 조작자는 제제만 바꿔 들고 오고
    //   환자ID가 틀렸다는 사실은 끝내 모른다.
    const patient = await this.prisma.patient.findUnique({
      where: { patientId: dto.patientId },
      select: { patientId: true, name: true },
    });
    if (!patient) throw new NotFoundException(`환자 없음: ${dto.patientId} — 환자ID를 확인하세요(오타 시 타 환자 오출고 위험)`);

    // ★출고 적격성 평가는 evaluateIssueEligibility 단일 정본을 쓴다(사전점검 API와 같은 판정).
    //   판정 로직을 복제하면 사전점검이 "통과"라 해놓고 실제 출고가 막히거나(혹은 반대로) 갈릴 수 있다.
    const ev = await this.evaluateIssueEligibility(dto.patientId, dto.unitNo, dto.specialRequired);
    // antigen 부적합은 evaluateIssueEligibility가 이미 softReasons에 넣는다(정본 단일화) — 여기서 다시 읽지 않는다.
    const { unit, typings, latest, unitBg } = ev;
    if (ev.statusBlock) throw new BadRequestException(`출고 불가 상태: ${unit.status}`);
    // B2: 회수/격리 제제는 응급에도 출고 불가(hemovigilance).
    if (ev.recallBlock) {
      throw new BadRequestException(`출고 불가 — 제제 ${unit.recallStatus}(회수/격리): ${unit.recallReason ?? ''}`);
    }
    const reasons = [...ev.softReasons];

    // B1: 응급(MTP·code-transfusion) 출고 — 프로세스 게이트(미교차·2회검증·특수요구 등)는 사후처리 조건으로
    //   우회 허용하되, ABO/RhD 독립 부적합·확인자 무결·유효기간·범용제제 요건은 **불가침(hardReasons)**.
    const emergency = dto.emergency === true;
    const hardReasons: string[] = [];

    // F8: 2인 확인은 실제 활성 계정(AppUser) 2인 — 응급에도 우회 불가(불가침).
    const confirmers = await this.prisma.appUser.findMany({ where: { userId: { in: [dto.confirm1, dto.confirm2] }, status: 'ACTIVE' } });
    const confirmerIds = new Set(confirmers.map((u) => u.userId));
    if (!confirmerIds.has(dto.confirm1)) hardReasons.push(`확인자1(${dto.confirm1})는 유효한 활성 계정이 아닙니다`);
    if (!confirmerIds.has(dto.confirm2)) hardReasons.push(`확인자2(${dto.confirm2})는 유효한 활성 계정이 아닙니다`);
    if (dto.confirm1 === dto.confirm2) hardReasons.push('출고 2인 확인은 서로 다른 확인자여야 합니다');
    // T3(불가침): 실제 출고를 실행한 인증 계정이 2인 확인 중 1인이어야 한다 — 그래야 한 사람이 남의 ID 둘을
    //   타이핑해 독립 witness를 위조하는 것을 막는다(현장 부재자 ID 도용 차단). actingUserId는 서버가 JWT에서 결속.
    if (dto.actingUserId && dto.actingUserId !== dto.confirm1 && dto.actingUserId !== dto.confirm2) {
      hardReasons.push(`출고 실행자(${dto.actingUserId})는 2인 확인자 중 1인이어야 합니다(현장 확인 위조 방지)`);
    }

    // 유효기간 만료·ABO 독립검증(2차 방벽)은 평가 정본이 산출(원래 순서 보존).
    hardReasons.push(...ev.hardReasons);

    // 응급 + (환자 혈액형 미상 OR ABO 이력 불일치) → 범용제제(O RhD-)만 허용(불가침).
    //   이력이 서로 어긋나면(예: 최신 AB+/과거 O+ — 오입력/실검체 불일치) 형별 신뢰 불가 →
    //   미상과 동일하게 O형 강제. 미상만 막고 '모순'은 최신값으로 형별 출고를 허용하면 O형 환자에
    //   AB형 응급 출고 같은 치명적 ABO 부적합이 열린다(불일치는 소프트가 아니라 불가침으로 격상).
    const aboHistoryDiscordant = typings.length > 0 && !!latest && !typings.every((t) => t.abo === latest.abo && t.rhD === latest.rhD);
    const aboUnresolved = typings.length === 0 || aboHistoryDiscordant;
    if (emergency && aboUnresolved && !(unitBg?.abo === 'O' && unitBg?.rhD === 'NEG')) {
      hardReasons.push(aboHistoryDiscordant
        ? '응급 미교차 출고는 O RhD- 범용제제만 허용(환자 ABO 이력 불일치 — 형별 신뢰 불가, 재검 필요)'
        : '응급 미교차 출고는 O RhD- 범용제제만 허용(환자 혈액형 미상)');
    }

    if (emergency) {
      if (!dto.emergencyReason?.trim()) throw new BadRequestException('응급 출고는 사유(emergencyReason) 필수');
      if (hardReasons.length > 0) throw new BadRequestException({ message: '응급 출고 차단 — 불가침 방벽', reasons: hardReasons });
      // soft reasons(미교차·2회검증·특수요구 등)는 사후 처리 조건으로 기록만 하고 출고 진행.
    } else {
      const allReasons = [...reasons, ...hardReasons];
      if (allReasons.length > 0) throw new BadRequestException({ message: '출고 차단', reasons: allReasons });
    }

    // T1 동의 자동확인: 수기 attestation 없고 비응급이면 HIS 동의 참조(active면 자동 attest). fail-safe.
    let consentAttestedBy = dto.consentAttestedBy ?? null;
    let hisConsent: { available: boolean; active: boolean; reason?: string } | null = null;
    if (!consentAttestedBy && !emergency) {
      hisConsent = await this.hisConsentStatus(dto.patientId);
      if (hisConsent.available && hisConsent.active) consentAttestedBy = 'HIS(자동확인)';
    }

    // C4 원자적 전이: IN_STOCK일 때만 ISSUED로 클레임 후 출고 생성(동일 유닛 이중출고 방지)
    const issue = await this.prisma.$transaction(async (tx) => {
      const claim = await tx.bloodUnit.updateMany({
        where: { unitNo: dto.unitNo, status: 'IN_STOCK' },
        data: { status: 'ISSUED' },
      });
      if (claim.count === 0) throw new BadRequestException('출고 경합 — 이미 출고/처리된 제제입니다');
      return tx.bloodIssue.create({
        data: {
          issueId: genId('ISS'),
          unitNo: dto.unitNo,
          patientId: dto.patientId,
          issuer: dto.issuer,
          receiver: dto.receiver,
          confirm1: dto.confirm1,
          confirm2: dto.confirm2,
          issuedDt: new Date(),
          emergency,
          emergencyReason: emergency ? (dto.emergencyReason ?? null) : null,
          // 응급 우회한 프로세스 게이트 기록 + 사후 교차확인 대기(PENDING)
          bypassedChecks: emergency && reasons.length > 0 ? reasons.join(' · ').slice(0, 1000) : null,
          retroCrossmatchStatus: emergency && reasons.length > 0 ? 'PENDING' : null,
          consentAttestedBy,
        },
      });
    });
    // T1 동의: 정본은 HIS. 수기 attestation 없고 비응급이면 HIS 동의 자동확인 결과로 판단, 그래도 없으면 경고.
    const consentWarning = !consentAttestedBy && !emergency
      ? (hisConsent && !hisConsent.available ? `HIS 동의 참조 불가(${hisConsent.reason}) — 수기 확인 필요` : 'HIS 수혈 동의서 확인 미기록/미승인 — 출고 전 확인 필요')
      : null;
    return { issue, emergency, bypassed: emergency ? reasons : [], consentWarning, consentSource: consentAttestedBy === 'HIS(자동확인)' ? 'HIS' : (dto.consentAttestedBy ? 'MANUAL' : null), safety: { eligible: ev.checkEligible, reasons, aboVerifiedTwice: ev.aboVerifiedTwice, aboMatchesHistory: ev.aboMatchesHistory, xmExpired: ev.xmExpired } };
  }

  /** 제제 완전추적성(B2) — 제제→출고→수혈자 체인. 헌혈유래(donationId)부터 최종 수혈까지. */
  async traceUnit(unitNo: string) {
    const unit = await this.prisma.bloodUnit.findUnique({
      where: { unitNo },
      include: { issues: { include: { patient: { select: { patientId: true, name: true } } } } },
    });
    if (!unit) throw new NotFoundException(`제제 없음: ${unitNo}`);
    return {
      unitNo: unit.unitNo,
      donationId: unit.donationId,
      productType: unit.productType,
      bloodGroup: unit.bloodGroup,
      status: unit.status,
      recallStatus: unit.recallStatus,
      recipients: unit.issues.map((i) => ({ issueId: i.issueId, patientId: i.patientId, name: i.patient.name, status: i.status, issuedDt: i.issuedDt, emergency: i.emergency })),
    };
  }

  /** 환자 수혈 이력(B2) — 이 환자가 받은 모든 제제(추적성 역방향). */
  async patientTransfusions(patientId: string) {
    const issues = await this.prisma.bloodIssue.findMany({
      where: { patientId },
      include: { unit: { select: { unitNo: true, donationId: true, productType: true, bloodGroup: true, recallStatus: true } } },
      orderBy: { issuedDt: 'desc' },
    });
    return issues.map((i) => ({ issueId: i.issueId, unitNo: i.unitNo, donationId: i.unit.donationId, productType: i.unit.productType, bloodGroup: i.unit.bloodGroup, status: i.status, emergency: i.emergency, recallStatus: i.unit.recallStatus, retroCrossmatchStatus: i.retroCrossmatchStatus, issuedDt: i.issuedDt }));
  }

  /**
   * 제제 회수/격리(B2) — 오염·부적격 제제 회수. 이미 출고/수혈됐으면 수혈자를 반환해 look-back 대상 제시.
   * (IN_STOCK이면 이후 issueBlood의 recallStatus 가드로 출고 차단됨.)
   */
  /**
   * HIS 수혈 동의 상태 참조(T1 자동경로) — 정본 HIS 환자포털/EMR. FHIR Consent 파생상태.
   * 미구성/오류 시 available:false(하드블록 아님 — attestation 병행). 출고 전 화면 확인용.
   */
  async hisConsentStatus(patientId: string) {
    // HIS 동의 EP는 **환자 uuid만 수용**(MRN은 HIS 500 — 2026-07-22 실측). 폴링이 저장한 uuid로 변환.
    // uuid 미보유(HL7 유입·수기 등록 환자)는 fail-safe — 수기 확인(consentAttestedBy) 폴백이 그대로 동작한다.
    const p = await this.prisma.patient.findUnique({ where: { patientId }, select: { hisPatientUuid: true } });
    if (!p?.hisPatientUuid) {
      return { patientId, available: false, reason: 'HIS 환자 uuid 미보유(폴링 유입 전 환자) — 동의 수기 확인 필요', active: false };
    }
    const r = await getConsentStatus(p.hisPatientUuid, 'TRANSFUSION');
    if (!r.available) return { patientId, available: false, reason: r.reason, active: false };
    const state = r.data._derivedState ?? 'pending';
    return { patientId, available: true, state, active: state === 'active', signedDate: r.data.signedDate ?? null, validUntil: r.data.validUntil ?? null };
  }

  /**
   * 명시적 혈액 폐기(T2) — 만료·손상·오염 등. 냉장30분 자동 폐기 외의 수동 폐기 사유 추적.
   * 출고(ISSUED)·수혈(TRANSFUSED) 제제는 폐기 불가(추적 무결성). IN_STOCK/RETURNED/DISCARDED만.
   */
  async discardUnit(unitNo: string, dto: { reason: string; discardedBy?: string }) {
    const unit = await this.prisma.bloodUnit.findUnique({ where: { unitNo } });
    if (!unit) throw new NotFoundException(`제제 없음: ${unitNo}`);
    if (!dto.reason?.trim()) throw new BadRequestException('폐기 사유(reason) 필요');
    if (unit.status === 'ISSUED' || unit.status === 'TRANSFUSED') {
      throw new BadRequestException(`출고/수혈된 제제는 폐기 불가(현재 ${unit.status}) — 반납 후 폐기하세요`);
    }
    // ★상태 술어를 건 원자적 전이. `update({where:{unitNo}})`는 읽기 시점 판단을 그대로 덮어써,
    //   폐기 화면을 연 사이 다른 담당이 출고하면 **환자에게 달려 있는 유닛이 재고상 폐기**된다.
    //   (같은 파일 issueBlood의 클레임 패턴과 동일하게 맞춘다)
    const claim = await this.prisma.bloodUnit.updateMany({
      where: { unitNo, status: { notIn: ['ISSUED', 'TRANSFUSED', 'DISCARDED'] } },
      data: { status: 'DISCARDED', discardReason: dto.reason.trim(), discardedBy: dto.discardedBy ?? null, discardedDt: new Date() },
    });
    if (claim.count === 0) {
      // 409 — 사전검사(위 400)와 달리 여기는 화면 조회 후 커밋 사이의 경합(Q8)
      throw new ConflictException('폐기 불가 — 그사이 제제 상태가 변경되었습니다(출고/수혈/이미 폐기). 재고를 다시 확인하세요');
    }
    return this.prisma.bloodUnit.findUnique({ where: { unitNo } });
  }

  async recallUnit(unitNo: string, status: 'RECALLED' | 'QUARANTINED', reason?: string) {
    const unit = await this.prisma.bloodUnit.findUnique({ where: { unitNo }, include: { issues: { include: { patient: { select: { patientId: true, name: true } } } } } });
    if (!unit) throw new NotFoundException(`제제 없음: ${unitNo}`);
    await this.prisma.bloodUnit.update({ where: { unitNo }, data: { recallStatus: status, recallReason: reason ?? null, recalledDt: new Date() } });
    const affected = unit.issues.filter((i) => i.status !== 'RETURNED').map((i) => ({ issueId: i.issueId, patientId: i.patientId, name: i.patient.name, transfused: i.status === 'TRANSFUSED' }));
    /**
     * 이미 환자에게 나간 제제가 회수되면 **역추적(lookback)** 이 필요하다.
     *
     * 기존엔 대상자를 HTTP 응답으로만 돌려줬다 — 회수를 누른 사람이 화면을 닫으면 그걸로 끝이고,
     * 감염·부적합 사유로 회수된 제제가 이미 들어간 환자를 아무도 추적하지 않는다.
     * 회수는 보통 헌혈자측 사후 정보(감염 확인 등)로 시작되므로 시간이 지나 발생하고,
     * 그래서 더더욱 화면을 보고 있을 이유가 없다. 알림함에 남겨 착수 주체를 만든다.
     */
    if (affected.length > 0) {
      const who = affected.map((a) => `${a.patientId}${a.transfused ? '(수혈완료)' : '(출고)'}`).join(', ');
      await this.prisma.notification
        .create({
          data: {
            notifyId: genId('NTF'),
            ntype: '제제회수추적',
            target: '혈액은행',
            message: `제제 ${unitNo} ${status === 'RECALLED' ? '회수' : '격리'}${reason ? `(${reason})` : ''} — 대상자 ${affected.length}명 역추적 필요: ${who}`.slice(0, 500),
            createdDt: new Date(),
          },
        })
        .catch((e) => this.logger.error(`제제 회수 추적 알림 생성 실패 ${unitNo}: ${e instanceof Error ? e.message : e}`));
    }
    return { unitNo, recallStatus: status, affectedRecipients: affected, lookbackRequired: affected.length > 0 };
  }

  /**
   * Look-back(B2) — 공혈자 사후 양성 등으로 특정 헌혈(donationId)의 모든 제제→수혈자를 역추적.
   * donationId로 그룹된 제제 전부의 수혈자를 반환(추가 검사·통보 대상).
   */
  async lookback(donationId: string) {
    const units = await this.prisma.bloodUnit.findMany({
      where: { donationId },
      include: { issues: { where: { status: { not: 'RETURNED' } }, include: { patient: { select: { patientId: true, name: true } } } } },
    });
    if (units.length === 0) throw new NotFoundException(`헌혈번호 유래 제제 없음: ${donationId}`);
    const recipients = units.flatMap((u) => u.issues.map((i) => ({ unitNo: u.unitNo, issueId: i.issueId, patientId: i.patientId, name: i.patient.name, transfused: i.status === 'TRANSFUSED' })));
    return { donationId, units: units.map((u) => u.unitNo), recipients, recipientCount: recipients.length };
  }
}
