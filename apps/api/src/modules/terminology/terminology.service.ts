/**
 * TerminologyService — terminology 도메인 서비스.
 *
 * 주요 진입점: `search()`, `list()`, `bulkImport()`, `create()`, `update()`, `setStatus()`, `seedStarter()`
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { genId } from '../../common/id.util';
import { USE_STATUSES, isOneOf } from '../../domain/enums';

export interface TerminologyDto {
  system?: string;
  code: string;
  term: string;
  termKo?: string | null;
  category?: string | null;
  status?: string;
}

const SYSTEMS = ['SNOMED', 'ICD-O', 'LOCAL'];
const CATEGORIES = ['MORPHOLOGY', 'TOPOGRAPHY', 'DIAGNOSIS'];

@Injectable()
export class TerminologyService {
  constructor(private readonly prisma: PrismaService) {}

  /** 자동완성 검색 — code/term/termKo 부분일치, 사용중(USE)만. 병리 판독 입력 공용. */
  async search(q?: string, system?: string, category?: string, limit = 25) {
    const term = (q ?? '').trim();
    const take = Math.min(Math.max(limit, 1), 50);
    return this.prisma.terminologyCode.findMany({
      where: {
        status: 'USE',
        ...(system ? { system } : {}),
        ...(category ? { category } : {}),
        ...(term
          ? {
              OR: [
                { code: { contains: term, mode: 'insensitive' } },
                { term: { contains: term, mode: 'insensitive' } },
                { termKo: { contains: term } },
              ],
            }
          : {}),
      },
      orderBy: [{ system: 'asc' }, { code: 'asc' }],
      take,
    });
  }

  /** 관리 목록 — 전 상태 포함. */
  async list(system?: string, category?: string, status?: string, q?: string) {
    const term = (q ?? '').trim();
    return this.prisma.terminologyCode.findMany({
      where: {
        ...(system ? { system } : {}),
        ...(category ? { category } : {}),
        ...(status ? { status } : {}),
        ...(term
          ? { OR: [{ code: { contains: term, mode: 'insensitive' } }, { term: { contains: term, mode: 'insensitive' } }, { termKo: { contains: term } }] }
          : {}),
      },
      orderBy: [{ status: 'asc' }, { system: 'asc' }, { code: 'asc' }],
      take: 500,
    });
  }

  /**
   * 용어 코드 대량 반입 — KHIS 라이선스 SNOMED 정식셋 등 CSV 수령 시 일괄 upsert(멱등, system+code 기준).
   * 유효성 위반 행은 오류로 보고하고 나머지는 계속 반입.
   */
  async bulkImport(rows: TerminologyDto[], userId?: string) {
    if (!Array.isArray(rows) || rows.length === 0) throw new BadRequestException('반입할 행이 없습니다');
    if (rows.length > 20000) throw new BadRequestException('한 번에 최대 20000행');
    const result = { total: rows.length, imported: 0, updated: 0, errors: [] as { row: number; code: string; error: string }[] };
    for (let i = 0; i < rows.length; i++) {
      try {
        const v = this.validate(rows[i]);
        const existing = await this.prisma.terminologyCode.findUnique({ where: { system_code: { system: v.system, code: v.code } } });
        await this.prisma.terminologyCode.upsert({
          where: { system_code: { system: v.system, code: v.code } },
          update: { term: v.term, termKo: v.termKo, category: v.category, status: 'USE' },
          create: { codeId: genId('TC'), ...v, status: 'USE', createdBy: userId ?? null },
        });
        if (existing) result.updated++; else result.imported++;
      } catch (e) { result.errors.push({ row: i + 1, code: (rows[i].code ?? '').trim(), error: e instanceof Error ? e.message : '실패' }); }
    }
    return result;
  }

  private validate(dto: TerminologyDto) {
    const system = (dto.system ?? 'SNOMED').trim().toUpperCase();
    if (!SYSTEMS.includes(system)) throw new BadRequestException(`system은 ${SYSTEMS.join('/')} 중 하나`);
    const code = (dto.code ?? '').trim();
    const t = (dto.term ?? '').trim();
    if (!code) throw new BadRequestException('code는 필수');
    if (!t) throw new BadRequestException('term은 필수');
    const category = dto.category ? dto.category.trim().toUpperCase() : null;
    if (category && !CATEGORIES.includes(category)) throw new BadRequestException(`category는 ${CATEGORIES.join('/')} 중 하나`);
    return { system, code, term: t, termKo: dto.termKo?.trim() || null, category };
  }

  async create(dto: TerminologyDto, userId?: string) {
    const v = this.validate(dto);
    const dup = await this.prisma.terminologyCode.findUnique({ where: { system_code: { system: v.system, code: v.code } } });
    if (dup) throw new ConflictException(`이미 등록된 코드: ${v.system} ${v.code}`);
    return this.prisma.terminologyCode.create({
      data: { codeId: genId('TC'), ...v, status: 'USE', createdBy: userId ?? null },
    });
  }

  async update(codeId: string, dto: Partial<TerminologyDto>) {
    const existing = await this.prisma.terminologyCode.findUnique({ where: { codeId } });
    if (!existing) throw new NotFoundException('코드 없음');
    // system/code 변경 시 유일성 재확인
    const nextSystem = (dto.system ?? existing.system).trim().toUpperCase();
    const nextCode = (dto.code ?? existing.code).trim();
    if ((nextSystem !== existing.system || nextCode !== existing.code)) {
      const dup = await this.prisma.terminologyCode.findUnique({ where: { system_code: { system: nextSystem, code: nextCode } } });
      if (dup && dup.codeId !== codeId) throw new ConflictException(`이미 등록된 코드: ${nextSystem} ${nextCode}`);
    }
    const category = dto.category !== undefined ? (dto.category ? dto.category.trim().toUpperCase() : null) : existing.category;
    if (category && !CATEGORIES.includes(category)) throw new BadRequestException(`category는 ${CATEGORIES.join('/')} 중 하나`);
    const status = dto.status ? dto.status.trim().toUpperCase() : existing.status;
    if (!isOneOf(USE_STATUSES, status)) throw new BadRequestException(`status는 ${USE_STATUSES.join('/')}`);
    return this.prisma.terminologyCode.update({
      where: { codeId },
      data: {
        system: nextSystem,
        code: nextCode,
        term: dto.term !== undefined ? (dto.term.trim() || existing.term) : existing.term,
        termKo: dto.termKo !== undefined ? (dto.termKo?.trim() || null) : existing.termKo,
        category,
        status,
      },
    });
  }

  /** 사용 중지/재개 토글(하드 삭제 대신 상태 전환 — 판독 이력 보존). */
  async setStatus(codeId: string, status: string) {
    const s = status.trim().toUpperCase();
    if (!isOneOf(USE_STATUSES, s)) throw new BadRequestException(`status는 ${USE_STATUSES.join('/')}`);
    const existing = await this.prisma.terminologyCode.findUnique({ where: { codeId } });
    if (!existing) throw new NotFoundException('코드 없음');
    return this.prisma.terminologyCode.update({ where: { codeId }, data: { status: s } });
  }

  /** 병리 대표 SNOMED 스타터셋 멱등 시딩(부서 큐레이션 시작점 — 전체 SNOMED는 별도 bulk import). */
  async seedStarter(userId?: string) {
    const starter: TerminologyDto[] = [
      // 형태(Morphology, M-codes)
      { system: 'SNOMED', code: 'M-00100', term: 'Normal', termKo: '정상', category: 'MORPHOLOGY' },
      { system: 'SNOMED', code: 'M-40000', term: 'Inflammation, NOS', termKo: '염증', category: 'MORPHOLOGY' },
      { system: 'SNOMED', code: 'M-72000', term: 'Adenoma, NOS', termKo: '선종', category: 'MORPHOLOGY' },
      { system: 'SNOMED', code: 'M-80000', term: 'Neoplasm, NOS', termKo: '신생물', category: 'MORPHOLOGY' },
      { system: 'SNOMED', code: 'M-80003', term: 'Neoplasm, malignant', termKo: '악성 신생물', category: 'MORPHOLOGY' },
      { system: 'SNOMED', code: 'M-80103', term: 'Carcinoma, NOS', termKo: '암종', category: 'MORPHOLOGY' },
      { system: 'SNOMED', code: 'M-80703', term: 'Squamous cell carcinoma, NOS', termKo: '편평세포암', category: 'MORPHOLOGY' },
      { system: 'SNOMED', code: 'M-81403', term: 'Adenocarcinoma, NOS', termKo: '선암', category: 'MORPHOLOGY' },
      { system: 'SNOMED', code: 'M-85003', term: 'Infiltrating duct carcinoma', termKo: '침윤성 관상피암', category: 'MORPHOLOGY' },
      { system: 'SNOMED', code: 'M-87203', term: 'Malignant melanoma, NOS', termKo: '악성 흑색종', category: 'MORPHOLOGY' },
      { system: 'SNOMED', code: 'M-88903', term: 'Leiomyosarcoma', termKo: '평활근육종', category: 'MORPHOLOGY' },
      { system: 'SNOMED', code: 'M-09450', term: 'Benign', termKo: '양성', category: 'MORPHOLOGY' },
      // 부위(Topography, T-codes)
      { system: 'SNOMED', code: 'T-04000', term: 'Breast', termKo: '유방', category: 'TOPOGRAPHY' },
      { system: 'SNOMED', code: 'T-59000', term: 'Stomach', termKo: '위', category: 'TOPOGRAPHY' },
      { system: 'SNOMED', code: 'T-67000', term: 'Colon', termKo: '대장', category: 'TOPOGRAPHY' },
      { system: 'SNOMED', code: 'T-28000', term: 'Lung', termKo: '폐', category: 'TOPOGRAPHY' },
      { system: 'SNOMED', code: 'T-71000', term: 'Liver', termKo: '간', category: 'TOPOGRAPHY' },
      { system: 'SNOMED', code: 'T-77000', term: 'Prostate', termKo: '전립선', category: 'TOPOGRAPHY' },
      { system: 'SNOMED', code: 'T-83000', term: 'Thyroid gland', termKo: '갑상선', category: 'TOPOGRAPHY' },
      { system: 'SNOMED', code: 'T-08000', term: 'Skin', termKo: '피부', category: 'TOPOGRAPHY' },
    ];
    let created = 0;
    for (const s of starter) {
      const v = this.validate(s);
      const dup = await this.prisma.terminologyCode.findUnique({ where: { system_code: { system: v.system, code: v.code } } });
      if (dup) continue;
      await this.prisma.terminologyCode.create({ data: { codeId: genId('TC'), ...v, status: 'USE', createdBy: userId ?? null } });
      created++;
    }
    return { created, total: starter.length };
  }
}
