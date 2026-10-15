/**
 * instrument 요청/응답 DTO — class-validator 검증 대상.
 *
 * 정의: IngestPayloadDto, UpsertInstrumentMappingDto.
 * 전역 ValidationPipe(whitelist)가 여기 없는 필드를 잘라낸다 — 새 필드는 반드시 DTO에 선언한다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { IsString, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class IngestPayloadDto {
  @ApiProperty({ enum: ['ASTM', 'CSV'], example: 'ASTM' })
  @IsIn(['ASTM', 'CSV'])
  format!: 'ASTM' | 'CSV';

  @ApiProperty({ description: '장비 원시 페이로드(ASTM 레코드 또는 CSV)', example: 'O|1||S-0088\\rR|1|^^^GLU^|105|mg/dL\\rL|1' })
  @IsString()
  payload!: string;
}

export class UpsertInstrumentMappingDto {
  @ApiProperty({ example: 'CHEM1' }) @IsString() instrument!: string;
  @ApiProperty({ description: '장비 검사코드', example: 'GLU' }) @IsString() rawCode!: string;
  @ApiProperty({ description: 'LIS 검사코드', example: 'CHE-GLU' }) @IsString() testCode!: string;
}
