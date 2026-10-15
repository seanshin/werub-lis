/**
 * login 요청/응답 DTO — class-validator 검증 대상.
 *
 * 정의: LoginDto, ChangePasswordDto.
 * 전역 ValidationPipe(whitelist)가 여기 없는 필드를 잘라낸다 — 새 필드는 반드시 DTO에 선언한다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({ description: '사용자 ID', example: 'U02' })
  @IsString()
  userId!: string;

  @ApiProperty({ description: '비밀번호', example: 'demo1234' })
  @IsString()
  password!: string;
}

export class ChangePasswordDto {
  @ApiProperty({ description: '현재 비밀번호' })
  @IsString()
  currentPassword!: string;

  @ApiProperty({ description: '새 비밀번호(10자+·대소문자·숫자)', example: 'LisSecure2026' })
  @IsString()
  newPassword!: string;
}
