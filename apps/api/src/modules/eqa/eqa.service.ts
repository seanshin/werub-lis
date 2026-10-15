/**
 * EqaService — eqa 도메인 서비스.
 *
 * 주요 진입점: `submit()`, `evaluate()`, `list()`, `sdiTrend()`
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { computeSdi, eqaVerdict } from '../../domain/eqa';

/**
 * 외부정도관리(EQA) 서비스 — 외부 미지검체 결과 등록·또래군 대비 SDI 평가.
 * 근거: 기획 22 §5(EQA), 인증 필수 항목.
 */
@Injectable()
export class EqaService {
  constructor(private readonly prisma: PrismaService) {}

  /** EQA 결과 제출 — 또래군 통계 미도착이면 PENDING. */
  async submit(dto: {
    program: string; cycle: string; testCode: string; sampleId: string;
    submittedValue: number; submittedBy?: string;
  }) {
    return this.prisma.eqaSurvey.create({
      data: {
        program: dto.program, cycle: dto.cycle, testCode: dto.testCode, sampleId: dto.sampleId,
        submittedValue: dto.submittedValue, submittedBy: dto.submittedBy ?? null, verdict: 'PENDING',
      },
    });
  }

  /** 또래군 통계 입력 → SDI·판정 계산. */
  async evaluate(surveyId: string, dto: { peerMean: number; peerSd: number }) {
    const survey = await this.prisma.eqaSurvey.findUnique({ where: { surveyId } });
    if (!survey) throw new NotFoundException(`EQA 없음: ${surveyId}`);
    const sdi = computeSdi(survey.submittedValue, dto.peerMean, dto.peerSd);
    const verdict = eqaVerdict(sdi);
    return this.prisma.eqaSurvey.update({
      where: { surveyId },
      data: { peerMean: dto.peerMean, peerSd: dto.peerSd, sdi, verdict },
    });
  }

  /** EQA 목록(프로그램·주기 필터). */
  list(program?: string, cycle?: string) {
    return this.prisma.eqaSurvey.findMany({
      where: { program: program || undefined, cycle: cycle || undefined },
      orderBy: { submittedDt: 'desc' },
    });
  }

  /**
   * SDI 추세 — 평가완료(sdi 보유) 서베이를 검사별 시계열로. 다주기 편향(bias)·부적합 반복 감지.
   * 인증(CAP/KLQA): EQA는 단건 판정뿐 아니라 누적 추세로 계통편향을 관찰해야 함.
   */
  async sdiTrend(program?: string, testCode?: string) {
    const rows = await this.prisma.eqaSurvey.findMany({
      where: { program: program || undefined, testCode: testCode || undefined, sdi: { not: null } },
      orderBy: { submittedDt: 'asc' },
    });
    const byTest = new Map<string, { testCode: string; program: string; points: { cycle: string; sdi: number; verdict: string | null; sampleId: string; submittedDt: Date }[] }>();
    for (const r of rows) {
      let t = byTest.get(r.testCode);
      if (!t) { t = { testCode: r.testCode, program: r.program, points: [] }; byTest.set(r.testCode, t); }
      t.points.push({ cycle: r.cycle, sdi: r.sdi!, verdict: r.verdict, sampleId: r.sampleId, submittedDt: r.submittedDt });
    }
    return [...byTest.values()].map((t) => {
      const sdis = t.points.map((p) => p.sdi);
      const mean = sdis.reduce((a, b) => a + b, 0) / (sdis.length || 1);
      const meanSdi = Math.round(mean * 100) / 100;
      // 계통편향 경고: |평균 SDI| ≥1(지속적 한쪽 치우침) 또는 부적합/경고 반복
      const unacceptable = t.points.filter((p) => p.verdict === 'UNACCEPTABLE').length;
      const warning = t.points.filter((p) => p.verdict === 'WARNING').length;
      const biasFlag = Math.abs(meanSdi) >= 1 ? (meanSdi > 0 ? '양성 계통편향' : '음성 계통편향') : null;
      return { testCode: t.testCode, program: t.program, n: t.points.length, meanSdi, biasFlag, unacceptable, warning, points: t.points.map((p) => ({ cycle: p.cycle, sdi: p.sdi, verdict: p.verdict, sampleId: p.sampleId })) };
    }).sort((a, b) => Math.abs(b.meanSdi) - Math.abs(a.meanSdi));
  }
}
