/**
 * transfusion 요청/응답 DTO — class-validator 검증 대상.
 *
 * 정의: IssueBloodDto, RegisterUnitDto, RecallUnitDto, RecordTypingDto, AntibodyPanelDto, AddRequirementDto, ReturnUnitDto, DiscardUnitDto, BloodTypingDto, AdministerDto….
 * 전역 ValidationPipe(whitelist)가 여기 없는 필드를 잘라낸다 — 새 필드는 반드시 DTO에 선언한다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { IsString, IsOptional, IsBoolean, IsArray, IsIn, ValidateNested, ArrayNotEmpty } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ABO_VALUES, RHD_VALUES, CROSSMATCH_RESULTS } from '../../../domain/transfusion-safety';

// 도메인이 정본. DTO는 참조만 한다(배열 리터럴을 여기 다시 쓰면 어긋난다).
export { ABO_VALUES, RHD_VALUES, CROSSMATCH_RESULTS } from '../../../domain/transfusion-safety';

export class IssueBloodDto {
  @ApiProperty({ example: 'W1234567890123' })
  @IsString()
  unitNo!: string;

  @ApiProperty({ example: '5678901' })
  @IsString()
  patientId!: string;

  @ApiProperty({ description: '출고자', example: 'U05' })
  @IsString()
  issuer!: string;

  @ApiProperty({ description: '인수자', example: '5W 간호사' })
  @IsString()
  receiver!: string;

  @ApiProperty({ description: '확인자1(2인 확인)', example: 'U05' })
  @IsString()
  confirm1!: string;

  @ApiProperty({ description: '확인자2(2인 확인)', example: '확인간호사' })
  @IsString()
  confirm2!: string;

  // 서버가 JWT에서 주입(클라이언트 미전송) — 실행자가 2인 확인 중 1인인지 검증용
  @IsOptional() @IsString() actingUserId?: string;

  @ApiProperty({ description: 'ABO 2회 확인 완료', example: true })
  @IsBoolean()
  aboVerifiedTwice!: boolean;

  @ApiProperty({ description: '현재 혈액형=과거이력', example: true })
  @IsBoolean()
  aboMatchesHistory!: boolean;

  @ApiPropertyOptional({ description: '특수요구(방사선조사 등)', example: [] })
  @IsOptional()
  @IsArray()
  specialRequired?: string[];

  @ApiPropertyOptional({ description: '응급(MTP·미교차) 출고 — 프로세스 게이트 사후처리, ABO 방벽은 유지', example: false })
  @IsOptional()
  @IsBoolean()
  emergency?: boolean;

  @ApiPropertyOptional({ description: '응급 출고 사유(emergency=true 시 필수)', example: '외상 대량출혈 MTP' })
  @IsOptional()
  @IsString()
  emergencyReason?: string;

  @ApiPropertyOptional({ description: 'HIS 동의서 확인함(attestation) — 확인한 담당자ID. 동의 정본은 HIS/EMR', example: 'U05' })
  @IsOptional()
  @IsString()
  consentAttestedBy?: string;
}

export class RegisterUnitDto {
  @ApiProperty({ example: 'W1234567890123' }) @IsString() unitNo!: string;
  @ApiProperty({ example: 'RBC' }) @IsString() productType!: string;
  @ApiProperty({ example: 'A+' }) @IsString() bloodGroup!: string;
  @ApiPropertyOptional({ example: '2026-07-01' }) @IsOptional() @IsString() drawnDate?: string;
  @ApiProperty({ description: '유효기간(YYYY-MM-DD)', example: '2026-08-10' }) @IsString() expiryDate!: string;
  @ApiPropertyOptional({ description: '방사선 조사' }) @IsOptional() @IsBoolean() irradiated?: boolean;
  @ApiPropertyOptional({ description: 'CMV 음성' }) @IsOptional() @IsBoolean() cmvNeg?: boolean;
  @ApiPropertyOptional({ description: '백혈구 제거' }) @IsOptional() @IsBoolean() leukoreduced?: boolean;
  @ApiPropertyOptional({ description: '세척' }) @IsOptional() @IsBoolean() washed?: boolean;
  @ApiPropertyOptional({ description: '항원음성 표현형(예: "K-neg, E-neg")' }) @IsOptional() @IsString() antigenNeg?: string;
  @ApiPropertyOptional({ description: '헌혈번호(look-back 그룹 키)', example: 'D-2026-00123' }) @IsOptional() @IsString() donationId?: string;
}

export class RecallUnitDto {
  @ApiProperty({ enum: ['RECALLED', 'QUARANTINED'], example: 'RECALLED' }) @IsIn(['RECALLED', 'QUARANTINED']) status!: string;
  @ApiPropertyOptional({ description: '회수 사유' }) @IsOptional() @IsString() reason?: string;
}

/**
 * 항체패널 판정과 함께 기록하는 혈액형 — ABO/RhD는 반드시 열거값이어야 한다.
 * 이 값이 BloodTyping 최신 레코드가 되고, issueBlood의 ABO 독립방벽(불가침)이 그것을 입력으로 쓴다.
 * 검증을 풀면 방벽이 오염된 혈액형으로 통과할 수 있다.
 */
export class RecordTypingDto {
  @ApiProperty({ enum: ABO_VALUES }) @IsIn(ABO_VALUES as unknown as string[]) abo!: string;
  @ApiProperty({ enum: RHD_VALUES }) @IsIn(RHD_VALUES as unknown as string[]) rhD!: string;
}

export class AntibodyPanelDto {
  @ApiProperty({ example: '5678901' }) @IsString() patientId!: string;
  @ApiProperty({ description: '패널 세포별 반응(불리언 배열)', type: [Boolean] })
  @IsArray() @ArrayNotEmpty() @IsBoolean({ each: true }) reactivity!: boolean[];
  @ApiPropertyOptional({ description: '동정 성립 시 함께 기록할 혈액형', type: RecordTypingDto })
  @IsOptional() @ValidateNested() @Type(() => RecordTypingDto) recordTyping?: RecordTypingDto;
}

export class AddRequirementDto {
  @ApiProperty({ example: '5678901' }) @IsString() patientId!: string;
  @ApiProperty({ description: '특수수혈 요구', example: 'IRRADIATED' }) @IsString() requirement!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() reason?: string;
}

export class ReturnUnitDto {
  @ApiPropertyOptional({ description: '반납 사유' }) @IsOptional() @IsString() reason?: string;
}

export class DiscardUnitDto {
  @ApiProperty({ description: '폐기 사유' }) @IsString() reason!: string;
}

export class BloodTypingDto {
  @ApiProperty({ example: '5678901' }) @IsString() patientId!: string;
  @ApiProperty({ enum: ABO_VALUES }) @IsIn(ABO_VALUES as unknown as string[]) abo!: string;
  @ApiProperty({ enum: RHD_VALUES }) @IsIn(RHD_VALUES as unknown as string[]) rhD!: string;
  @ApiProperty({ description: '항체선별', enum: ['NEG', 'POS'] }) @IsIn(['NEG', 'POS']) antibodyScreen!: string;
  @ApiPropertyOptional({ description: '동정 항체' }) @IsOptional() @IsString() antibodyId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() tester?: string;
}

export class AdministerDto {
  @ApiProperty({ description: '출고ID', example: 'ISS-0001' }) @IsString() issueId!: string;
  @ApiPropertyOptional({ description: '시행자' }) @IsOptional() @IsString() administeredBy?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() note?: string;
}

export class ReactionDto {
  @ApiPropertyOptional({ description: '출고ID' }) @IsOptional() @IsString() issueId?: string;
  @ApiProperty({ example: '5678901' }) @IsString() patientId!: string;
  @ApiProperty({ enum: ['FEBRILE', 'ALLERGIC', 'HEMOLYTIC', 'TACO', 'OTHER'] }) @IsIn(['FEBRILE', 'ALLERGIC', 'HEMOLYTIC', 'TACO', 'OTHER']) reactionType!: string;
  @ApiProperty({ enum: ['MILD', 'MODERATE', 'SEVERE'] }) @IsIn(['MILD', 'MODERATE', 'SEVERE']) severity!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() symptoms?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() reportedBy?: string;
}

export class ReactionInvestigationDto {
  @ApiPropertyOptional({ description: '사무착오 확인(환자·제제 대조) 정상' }) @IsOptional() @IsBoolean() clericalCheckOk?: boolean;
  @ApiPropertyOptional({ enum: ['NEG', 'POS'], description: '반응 후 DAT' }) @IsOptional() @IsIn(['NEG', 'POS']) postDat?: string;
  @ApiPropertyOptional({ description: '반응 후 ABO/교차 재검 결과' }) @IsOptional() @IsString() postAboRecheck?: string;
  @ApiPropertyOptional({ enum: ['NONE', 'PRESENT'], description: '육안 용혈(혈장/뇨)' }) @IsOptional() @IsIn(['NONE', 'PRESENT']) hemolysisVisual?: string;
  @ApiPropertyOptional({ description: 'haptoglobin·LDH·bilirubin 등 요약' }) @IsOptional() @IsString() labFindings?: string;
  @ApiPropertyOptional({ description: '원인 의심 제제 unitNo' }) @IsOptional() @IsString() culpritUnitNo?: string;
  @ApiPropertyOptional({ enum: ['AHTR', 'FNHTR', 'TRALI', 'TACO', 'ALLERGIC', 'BACTERIAL', 'NONE'], description: '최종 분류' }) @IsOptional() @IsIn(['AHTR', 'FNHTR', 'TRALI', 'TACO', 'ALLERGIC', 'BACTERIAL', 'NONE']) finalClassification?: string;
  @ApiPropertyOptional({ description: '최종 결론·권고' }) @IsOptional() @IsString() conclusion?: string;
}

export class CrossmatchDto {
  @ApiProperty({ example: '5678901' }) @IsString() patientId!: string;
  @ApiProperty({ example: 'W1234567890123' }) @IsString() unitNo!: string;
  @ApiProperty({ enum: CROSSMATCH_RESULTS, description: '교차시험 결과' }) @IsIn(CROSSMATCH_RESULTS as unknown as string[]) result!: string;
  @ApiPropertyOptional({ description: '방법(식염수/효소/AHG 등)' }) @IsOptional() @IsString() method?: string;
  @ApiPropertyOptional({ description: '검사자 ID' }) @IsOptional() @IsString() tester?: string;
}

export class PerformCrossmatchDto {
  @ApiProperty({ example: '5678901', description: '환자ID(최신 혈액형·항체선별 사용)' }) @IsString() patientId!: string;
  @ApiProperty({ example: 'W1234567890123', description: '제제번호(혈액형 사용)' }) @IsString() unitNo!: string;
  @ApiPropertyOptional({ description: '검사자 ID' }) @IsOptional() @IsString() tester?: string;
}
