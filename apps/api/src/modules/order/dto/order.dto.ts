/**
 * order 요청/응답 DTO — class-validator 검증 대상.
 *
 * 정의: ReceiveSpecimenDto, CreateAliquotsDto, RejectSpecimenDto, CorrectReceiptDto.
 * 전역 ValidationPipe(whitelist)가 여기 없는 필드를 잘라낸다 — 새 필드는 반드시 DTO에 선언한다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { IsString, IsOptional, IsArray, ArrayNotEmpty, IsIn, IsBoolean } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ReceiveSpecimenDto {
  @ApiProperty({ description: '접수할 오더ID', example: 'O-0001' })
  @IsString()
  orderId!: string;

  @ApiPropertyOptional({ description: '용기 코드', example: 'EDTA' })
  @IsOptional()
  @IsString()
  containerCode?: string;

  @ApiPropertyOptional({ description: '검체 종류', example: 'Whole blood' })
  @IsOptional()
  @IsString()
  specimenType?: string;

  @ApiPropertyOptional({ description: '채취 일시(ISO)', example: '2026-07-13T08:30:00Z' })
  @IsOptional()
  @IsString()
  collectedDt?: string;

  @ApiPropertyOptional({ description: '채취자', example: 'N-김간호' })
  @IsOptional()
  @IsString()
  collectedBy?: string;

  @ApiPropertyOptional({ description: '접수 시 분주할 분석기 목록', example: ['CHEM1', 'HEMA1'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  aliquotTargets?: string[];
}

export class CreateAliquotsDto {
  @ApiProperty({ description: '분주 대상 분석기 목록', example: ['CHEM1', 'COAG1'] })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  targets!: string[];
}

export class RejectSpecimenDto {
  @ApiProperty({ description: '거부 사유코드', enum: ['HEMOLYZED', 'INSUFFICIENT', 'CLOTTED', 'CONTAMINATED', 'OTHER'], example: 'HEMOLYZED' })
  @IsIn(['HEMOLYZED', 'INSUFFICIENT', 'CLOTTED', 'CONTAMINATED', 'OTHER'])
  reason!: string;

  @ApiPropertyOptional({ description: '재채취 오더 생성 여부(기본 true)', example: true })
  @IsOptional()
  @IsBoolean()
  recollect?: boolean;
}

export class CorrectReceiptDto {
  @ApiPropertyOptional({ description: '용기 코드' }) @IsOptional() @IsString() containerCode?: string;
  @ApiPropertyOptional({ description: '채취시각(ISO)' }) @IsOptional() @IsString() collectedDt?: string;
  @ApiPropertyOptional({ description: '채취자' }) @IsOptional() @IsString() collectedBy?: string;
}
