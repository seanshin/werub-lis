/**
 * result 요청/응답 DTO — class-validator 검증 대상.
 *
 * 정의: SubmitResultDto, AckCriticalDto, CorrectResultDto, VerifyResultDto, VerifyBatchDto.
 * 전역 ValidationPipe(whitelist)가 여기 없는 필드를 잘라낸다 — 새 필드는 반드시 DTO에 선언한다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { IsString, IsOptional, IsArray, ArrayNotEmpty, IsIn, IsNumber, IsBoolean, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SubmitResultDto {
  @ApiProperty({ description: '검체번호', example: 'S-0088' })
  @IsString()
  specimenNo!: string;

  @ApiProperty({ description: '검사코드', example: 'CBC-HGB' })
  @IsString()
  testCode!: string;

  @ApiProperty({ description: '결과값', example: '6.5' })
  @IsString()
  value!: string;

  @ApiPropertyOptional({ description: '단위', example: 'g/dL' })
  @IsOptional()
  @IsString()
  unit?: string;

  @ApiPropertyOptional({ description: '검사자 ID', example: 'U01' })
  @IsOptional()
  @IsString()
  verifier?: string;

  @ApiPropertyOptional({ description: '이중입력 확인값(수기 경로 오타 방지) — 불일치 시 차단', example: '6.5' })
  @IsOptional()
  @IsString()
  valueConfirm?: string;

  @ApiPropertyOptional({ description: '결과 출처', enum: ['INSTRUMENT', 'MANUAL', 'DOCUMENT'], example: 'MANUAL' })
  @IsOptional()
  @IsIn(['INSTRUMENT', 'MANUAL', 'DOCUMENT'])
  source?: string;

  @ApiPropertyOptional({ description: '입력자 ID(수기)', example: 'U01' })
  @IsOptional()
  @IsString()
  enteredBy?: string;

  @ApiPropertyOptional({ description: '산출 장비(QC 차단 장비 귀속) — 자동수집 경로', example: 'CHEM1' })
  @IsOptional()
  @IsString()
  instrument?: string;

  @ApiPropertyOptional({ description: '기술 코멘트(검체상태·재검근거 등)', example: '검체 용혈(+) 참고' })
  @IsOptional()
  @IsString()
  comment?: string;

  @ApiPropertyOptional({ description: '해석 코멘트(임상 해석문) — 보고서 표출', example: '경도 상승, 임상 연관 권고' })
  @IsOptional()
  @IsString()
  interpretation?: string;

  @ApiPropertyOptional({ description: '원본문서 참조(장비 출력지·PDF) — 문서 경로 추적성', example: 'doc://scan/2026/GLU-0088.pdf' })
  @IsOptional()
  @IsString()
  sourceDocRef?: string;

  @ApiPropertyOptional({ description: '희석배수(재검) — 원값×배수=참값', example: 10 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  dilutionFactor?: number;

  @ApiPropertyOptional({ description: '재검 여부' })
  @IsOptional()
  @IsBoolean()
  rerun?: boolean;
}

export class AckCriticalDto {
  // 확인자는 컨트롤러가 토큰(user.userId)으로 덮어쓴다 — 본문 값은 무시되므로 필수로 두면
  // 클라이언트가 무의미한 값을 보내야 하고, 안 보내면 검증에서 400이 난다. 선택으로 둔다.
  @ApiPropertyOptional({ description: '확인자(토큰에서 결정, 본문 무시)', example: 'D001' })
  @IsOptional()
  @IsString()
  ackBy?: string;

  @ApiPropertyOptional({ description: '통보 수신자(복창 확인자)', example: '내과 김간호사' })
  @IsOptional()
  @IsString()
  readbackBy?: string;

  @ApiPropertyOptional({ description: '복창(read-back) 내용 — 환자·검사·값 복창 확인', example: '홍길동 K 6.8 복창 확인' })
  @IsOptional()
  @IsString()
  readbackNote?: string;
}

export class CorrectResultDto {
  @ApiProperty({ description: '정정 결과값', example: '6.7' })
  @IsString()
  value!: string;

  @ApiProperty({ description: '정정 사유', example: '재측정 결과 반영' })
  @IsString()
  reason!: string;

  @ApiPropertyOptional({ description: '정정자 ID', example: 'U02' })
  @IsOptional()
  @IsString()
  verifier?: string;
}

export class VerifyResultDto {
  @ApiProperty({ description: '검증자(검증의) ID', example: 'U02' })
  @IsString()
  verifier!: string;

  @ApiPropertyOptional({ description: '기술 코멘트(검증 시 추가/갱신)', example: '재검 확인함' })
  @IsOptional()
  @IsString()
  comment?: string;

  @ApiPropertyOptional({ description: '해석 코멘트(검증 시 추가/갱신)', example: '이전 대비 안정' })
  @IsOptional()
  @IsString()
  interpretation?: string;
}

export class VerifyBatchDto {
  @ApiProperty({ description: '검증 대상 결과 ID 목록', example: ['R-260713-0007', 'R-260713-0008'] })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  resultIds!: string[];

  @ApiProperty({ description: '검증자(검증의) ID', example: 'U02' })
  @IsString()
  verifier!: string;
}
