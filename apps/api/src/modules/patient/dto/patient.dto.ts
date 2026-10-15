/**
 * patient 요청/응답 DTO — class-validator 검증 대상.
 *
 * 정의: CreatePatientDto, UpdatePatientDto.
 * 전역 ValidationPipe(whitelist)가 여기 없는 필드를 잘라낸다 — 새 필드는 반드시 DTO에 선언한다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { IsString, IsOptional, IsIn, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CODE_ID_PATTERN, CODE_ID_MESSAGE } from '../../../common/validation';

export class CreatePatientDto {
  @ApiProperty({ description: '환자ID(= HIS 등록번호)', example: '1234567' })
  @IsString()
  @Matches(CODE_ID_PATTERN, { message: `patientId: ${CODE_ID_MESSAGE}` })
  patientId!: string;

  @ApiProperty({ example: '홍길동' })
  @IsString()
  name!: string;

  @ApiPropertyOptional({ enum: ['M', 'F', 'O', 'U'] })
  @IsOptional()
  @IsIn(['M', 'F', 'O', 'U'])
  sex?: 'M' | 'F' | 'O' | 'U';

  @ApiPropertyOptional({ example: '1980-01-01' })
  @IsOptional()
  @IsString()
  birthDate?: string;
}

export class UpdatePatientDto {
  @ApiPropertyOptional({ example: '홍길동' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ enum: ['M', 'F', 'O', 'U'] })
  @IsOptional()
  @IsIn(['M', 'F', 'O', 'U'])
  sex?: 'M' | 'F' | 'O' | 'U';

  @ApiPropertyOptional({ example: '1980-01-01' })
  @IsOptional()
  @IsString()
  birthDate?: string;
}
