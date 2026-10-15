/**
 * SignoffService — admin 도메인 서비스.
 *
 * 주요 진입점: `status()`, `sign()`, `history()`, `drift()`
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditChainService } from '../audit/audit-chain.service';
import { UserAdminService } from './user-admin.service';
import { genId } from '../../common/id.util';

/**
 * 검사실·법무 서명 — 워크시트를 **인쇄물에서 기록으로**.
 *
 * 이전 흐름: 화면 인쇄 → 손으로 확정값·서명 기입 → 회신을 사람이 seed로 옮김 → 재배포.
 * 사람이 옮겨 적는 구간이 있으면 임상값은 조용히 틀린다. 값 자체는 이미 화면에서 편집
 * 가능하므로(참고치·델타·EDI·QC), 여기서는 **"이 값들을 누가 언제 확정했는가"** 를 남긴다.
 *
 * 핵심은 스냅샷 해시다. 서명 시점의 값을 함께 저장해 두면, 이후 누군가 참고치를 고쳤을 때
 * **"서명 이후 변경됨"으로 드러난다**. 서명이 한 번 찍히고 값이 소리 없이 흘러가는 상황이
 * 임상에서 가장 위험하다.
 */
export const SIGNOFF_SECTIONS: { section: string; label: string; owner: string; editHref: string | null }[] = [
  { section: 'A', label: '임상 참고치(정상범위·위험치)', owner: '검사실', editHref: '/master' },
  { section: 'B', label: '자동검증·델타 정책', owner: '검사실', editHref: '/master' },
  { section: 'C', label: 'EDI 수가코드 매핑', owner: '원무·검사실', editHref: '/master' },
  { section: 'D', label: 'QC 목표(mean/SD)', owner: '검사실', editHref: '/master' },
  { section: 'E', label: '임상 결정 F-1~F-5', owner: '검사실·전문의', editHref: null },
  { section: 'F', label: '병리 코드 카탈로그', owner: '병리과', editHref: null },
  { section: 'G', label: '보존기간·법무', owner: '법무·정보보호', editHref: '/admin/lifecycle' },
];

@Injectable()
export class SignoffService {

  private readonly logger = new Logger(SignoffService.name);

  /**
   * 서명 이후 값 변경(drift) 감시 — 매일 09:10.
   *
   * `status()`가 스냅샷 해시로 drift를 정확히 탐지하지만, **그 화면을 열어야만 보인다.**
   * 검사실·법무가 서명한 값(참고치·임상 결정·보존기간 등)이 그 뒤에 바뀌면 서명의 소명력이
   * 사라지는데, 정작 서명자는 자기 서명이 무효해진 걸 모른다. 그래서 밀어서 알린다.
   * 미확인 알림이 있으면 새로 만들지 않는다.
   */
  @Cron('0 10 9 * * *')
  async signoffDriftAlert(): Promise<void> {
    // [cron-guard] 크론 예외는 프로세스를 죽인다 — 반드시 잡고 로깅.
    try {
      const sections = await this.status();
      const drifted = sections.filter((x: { drifted?: boolean }) => x.drifted);
      if (drifted.length === 0) return;
      const open = await this.prisma.notification.findFirst({ where: { ntype: '서명변경', ackDt: null } });
      if (open) return;
      const list = drifted.map((d: { section: string }) => d.section).join(', ');
      await this.prisma.notification.create({
        data: {
          notifyId: genId('NTF'),
          ntype: '서명변경',
          target: '검사실·법무',
          message: `서명 이후 값이 변경된 섹션 ${drifted.length}건: ${list} — 재서명 또는 변경 사유 확인 필요`.slice(0, 500),
          createdDt: new Date(),
        },
      });
    } catch (e) {
      this.logger.error(`서명 drift 감시 실패: ${e instanceof Error ? e.message : e}`);
    }
  }
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditChainService,
    private readonly worksheet: UserAdminService,
  ) {}

  /** 섹션별 현재 값 — 워크시트 집계를 그대로 쓴다(두 곳이 달라지면 서명이 무의미해진다). */
  private async sectionData(): Promise<Record<string, unknown>> {
    const w = await this.worksheet.signoffWorksheet();
    return {
      A: w.referenceRanges,
      B: w.deltaConfig,
      C: w.ediCodes,
      D: w.qcTargets,
      E: w.clinicalDecisions,
      F: w.pathologyCatalogs,
      G: w.legal,
    };
  }

  /**
   * 값 해시 — 키 순서에 흔들리지 않게 정렬해 직렬화한다.
   * (정렬하지 않으면 값이 그대로여도 조회 순서 차이만으로 "변경됨"이 뜬다 = 늑대소년)
   */
  private hash(v: unknown): string {
    return createHash('sha256').update(stableJson(v)).digest('hex');
  }

  /** 섹션별 현황 — 서명 여부·서명 이후 변경(drift) 여부. */
  async status() {
    const data = await this.sectionData();
    const records = await this.prisma.signoffRecord.findMany({ orderBy: { signedDt: 'desc' } });
    return SIGNOFF_SECTIONS.map((s) => {
      const latest = records.find((r) => r.section === s.section);
      const currentHash = this.hash(data[s.section]);
      return {
        ...s,
        itemCount: Array.isArray(data[s.section]) ? (data[s.section] as unknown[]).length : 0,
        currentHash,
        signed: latest
          ? {
              signoffId: latest.signoffId,
              signerName: latest.signerName,
              signerRole: latest.signerRole,
              signedBy: latest.signedBy,
              documentNo: latest.documentNo,
              note: latest.note,
              signedDt: latest.signedDt,
            }
          : null,
        // 서명된 값이 소리 없이 바뀌는 것이 가장 위험하다 — 여기서 드러낸다
        drifted: !!latest && latest.snapshotHash !== currentHash,
        history: records.filter((r) => r.section === s.section).length,
      };
    });
  }

  /** 서명 기입 — 현재 값의 스냅샷을 함께 굳힌다. */
  async sign(
    section: string,
    dto: { signerName: string; signerRole?: string; documentNo?: string; note?: string },
    userId: string | null,
  ) {
    const def = SIGNOFF_SECTIONS.find((s) => s.section === section);
    if (!def) throw new BadRequestException(`서명 섹션 오류: ${section}`);
    if (!dto.signerName?.trim()) throw new BadRequestException('확정한 사람(실명)이 필요합니다');
    const data = await this.sectionData();
    const snapshot = data[section];
    const snapshotJson = stableJson(snapshot);

    const rec = await this.prisma.signoffRecord.create({
      data: {
        signoffId: genId('SG'),
        section,
        signerName: dto.signerName.trim(),
        signerRole: dto.signerRole?.trim() || null,
        signedBy: userId,
        documentNo: dto.documentNo?.trim() || null,
        note: dto.note?.trim() || null,
        snapshotHash: createHash('sha256').update(snapshotJson).digest('hex'),
        snapshotJson,
      },
    });
    await this.audit.append({
      userId,
      action: 'SIGNOFF_RECORD',
      target: `${section}:${def.label}`,
      detail: `확정자 ${rec.signerName}${rec.documentNo ? ` · 문서 ${rec.documentNo}` : ''}`,
      status: 201,
      sensitive: false,
    });
    return { signoffId: rec.signoffId, section, signedDt: rec.signedDt, snapshotHash: rec.snapshotHash };
  }

  /** 이력 — 재서명 포함(수정·삭제 없이 쌓는다). */
  async history(section: string) {
    return this.prisma.signoffRecord.findMany({
      where: { section },
      orderBy: { signedDt: 'desc' },
      select: { signoffId: true, signerName: true, signerRole: true, signedBy: true, documentNo: true, note: true, signedDt: true, snapshotHash: true },
    });
  }

  /**
   * 서명 이후 무엇이 바뀌었는지 — "변경됨"만 알려주면 운영자가 다시 전수 대조해야 한다.
   * 항목 단위로 추가·삭제·변경을 뽑아 준다.
   */
  async drift(section: string) {
    const latest = await this.prisma.signoffRecord.findFirst({ where: { section }, orderBy: { signedDt: 'desc' } });
    if (!latest) return { section, signed: false, changes: [] };
    const data = await this.sectionData();
    const current = data[section];
    const before = JSON.parse(latest.snapshotJson);
    return {
      section,
      signed: true,
      signedDt: latest.signedDt,
      drifted: latest.snapshotHash !== createHash('sha256').update(stableJson(current)).digest('hex'),
      changes: diffRows(before, current),
    };
  }
}

/** 키 순서에 흔들리지 않는 직렬화(정렬). 해시 비교의 전제. */
export function stableJson(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === 'object') {
      return Object.fromEntries(
        Object.entries(x as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, val]) => [k, norm(val)]),
      );
    }
    return x;
  };
  return JSON.stringify(norm(v));
}

/**
 * 행 단위 비교. 각 섹션 데이터는 배열이고, 행을 식별할 키가 저마다 달라
 * 후보 키(testCode·lisCode·code·item)를 순서대로 본다.
 */
export function diffRows(before: unknown, after: unknown): { key: string; kind: 'ADDED' | 'REMOVED' | 'CHANGED'; before?: unknown; after?: unknown }[] {
  if (!Array.isArray(before) || !Array.isArray(after)) {
    return stableJson(before) === stableJson(after) ? [] : [{ key: '(전체)', kind: 'CHANGED', before, after }];
  }
  const keyOf = (r: unknown, i: number): string => {
    const o = (r ?? {}) as Record<string, unknown>;
    for (const k of ['testCode', 'lisCode', 'code', 'item', 'gateCode']) {
      if (typeof o[k] === 'string' && o[k]) {
        // 참고치는 같은 검사에 성별·연령대별로 여러 행이 있다 — 검사코드만으로는 겹친다
        const sub = [o.sex, o.ageMin, o.ageMax, o.instrument].filter((x) => x != null).map((x) => (typeof x === 'number' ? String(x) : typeof x === 'string' ? x : JSON.stringify(x))).join('/');
        return sub ? `${o[k] as string} (${sub})` : (o[k] as string);
      }
    }
    return `#${i}`;
  };
  const b = new Map(before.map((r, i) => [keyOf(r, i), r]));
  const a = new Map(after.map((r, i) => [keyOf(r, i), r]));
  const out: { key: string; kind: 'ADDED' | 'REMOVED' | 'CHANGED'; before?: unknown; after?: unknown }[] = [];
  for (const [k, v] of a) {
    if (!b.has(k)) out.push({ key: k, kind: 'ADDED', after: v });
    else if (stableJson(b.get(k)) !== stableJson(v)) out.push({ key: k, kind: 'CHANGED', before: b.get(k), after: v });
  }
  for (const [k, v] of b) if (!a.has(k)) out.push({ key: k, kind: 'REMOVED', before: v });
  return out;
}
