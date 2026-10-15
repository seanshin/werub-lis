/**
 * master 요청/응답 DTO — class-validator 검증 대상.
 *
 * 정의: CreateTestDto, UpdateTestDto, UpsertReferenceRangeDto, UpsertCodeMappingDto, UpsertPanelDto, UpsertQcMaterialDto, UpsertQcTargetDto.
 * 전역 ValidationPipe(whitelist)가 여기 없는 필드를 잘라낸다 — 새 필드는 반드시 DTO에 선언한다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import {
  IsString,
  IsOptional,
  IsIn,
  IsNumber,
  IsInt,
  IsArray,
  IsBoolean,
  Min,
  Matches,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CODE_ID_PATTERN, CODE_ID_MESSAGE } from '../../../common/validation';

const DOMAINS = ['DIAGNOSTIC', 'MICROBIOLOGY', 'PATHOLOGY', 'TRANSFUSION', 'GENOMIC'];

// ── 검사항목(TestMaster) ──
export class CreateTestDto {
  @ApiProperty({ example: 'CHE-GLU' }) @IsString() @Matches(CODE_ID_PATTERN, { message: `testCode: ${CODE_ID_MESSAGE}` }) testCode!: string;
  @ApiProperty({ example: '포도당' }) @IsString() name!: string;
  @ApiPropertyOptional({ example: '2345-7' }) @IsOptional() @IsString() @Matches(CODE_ID_PATTERN, { message: `loinc: ${CODE_ID_MESSAGE}` }) loinc?: string;
  @ApiProperty({ enum: DOMAINS }) @IsIn(DOMAINS) domain!: string;
  @ApiPropertyOptional({ example: 'mg/dL' }) @IsOptional() @IsString() unitUcum?: string;
  @ApiPropertyOptional({ example: 'Serum' }) @IsOptional() @IsString() specimenType?: string;
}

export class UpdateTestDto {
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(CODE_ID_PATTERN, { message: `loinc: ${CODE_ID_MESSAGE}` }) loinc?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() unitUcum?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() specimenType?: string;
  @ApiPropertyOptional({ enum: ['USE', 'STOP'] }) @IsOptional() @IsIn(['USE', 'STOP']) status?: string;
  @ApiPropertyOptional({ description: '자동검증 허용(false면 항상 수동검증)' }) @IsOptional() @IsBoolean() autoVerify?: boolean;
  @ApiPropertyOptional({ description: '델타 %한계(미설정=50)' }) @IsOptional() @IsNumber() deltaPctLimit?: number;
  @ApiPropertyOptional({ description: '델타 절대값 한계' }) @IsOptional() @IsNumber() deltaAbsLimit?: number;
  @ApiPropertyOptional({ description: '델타 look-back 창(일)' }) @IsOptional() @IsInt() @Min(1) deltaWindowDays?: number;
}

// ── 참고치(ReferenceRange) ──
export class UpsertReferenceRangeDto {
  @ApiProperty({ example: 'CHE-GLU' }) @IsString() @Matches(CODE_ID_PATTERN, { message: `testCode: ${CODE_ID_MESSAGE}` }) testCode!: string;
  @ApiPropertyOptional({ enum: ['A', 'M', 'F'], default: 'A' })
  @IsOptional() @IsIn(['A', 'M', 'F']) sex?: string;
  @ApiPropertyOptional({ default: 0 }) @IsOptional() @IsInt() @Min(0) ageMin?: number;
  @ApiPropertyOptional({ default: 200 }) @IsOptional() @IsInt() @Min(0) ageMax?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() low?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() high?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() panicLow?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() panicHigh?: number;
}

// ── 코드매핑(CodeMapping) ──
export class UpsertCodeMappingDto {
  @ApiPropertyOptional({ description: 'HIS 처방코드' }) @IsOptional() @IsString() hisCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(CODE_ID_PATTERN, { message: `loinc: ${CODE_ID_MESSAGE}` }) loinc?: string;
  @ApiPropertyOptional({ description: '보험 EDI 코드' }) @IsOptional() @IsString() ediCode?: string;
  @ApiPropertyOptional({ enum: ['USE', 'STOP'] }) @IsOptional() @IsIn(['USE', 'STOP']) status?: string;
}

// ── 패널(Panel) ──
export class UpsertPanelDto {
  @ApiProperty({ example: 'E6512' }) @IsString() panelCode!: string;
  @ApiProperty({ example: '전해질검사' }) @IsString() name!: string;
  @ApiProperty({ type: [String], example: ['CHE-NA', 'CHE-K', 'CHE-CL'] })
  @IsArray() @IsString({ each: true }) testCodes!: string[];
}

// ── QC 물질/목표치 ──
export class UpsertQcMaterialDto {
  @ApiProperty({ example: 'QC-CH1' }) @IsString() qcCode!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() lot?: string;
  @ApiPropertyOptional({ example: '2026-12-31' }) @IsOptional() @IsString() expiry?: string;
}

export class UpsertQcTargetDto {
  @ApiProperty({ example: 'QC-CH1' }) @IsString() qcCode!: string;
  @ApiProperty({ example: '화학1호기' }) @IsString() instrument!: string;
  @ApiProperty({ example: 'CHE-GLU' }) @IsString() @Matches(CODE_ID_PATTERN, { message: `testCode: ${CODE_ID_MESSAGE}` }) testCode!: string;
  @ApiProperty({ example: 100 }) @IsNumber() mean!: number;
  @ApiProperty({ example: 2 }) @IsNumber() sd!: number;
}
