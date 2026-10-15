/**
 * Auth (인증) HTTP 컨트롤러 — 라우트 3개 (`api/v1/auth`).
 *
 * 비즈니스 로직은 같은 폴더의 서비스에 위임하고, 여기서는 인가·검증·응답 형태만 책임진다.
 * 모든 응답은 `{ data }` 봉투로 감싼다(목록 페이지네이션은 `{ data, meta }`).
 * ⚠ 서명·검증 주체는 요청 본문이 아니라 @CurrentUser(JWT)에서 얻는다 — 클라이언트 위조 방지.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Controller, Post, Get, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { AuthService } from './auth.service';
import { LoginDto, ChangePasswordDto } from './dto/login.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Auth (인증)')
@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly service: AuthService) {}

  @Post('login')
  @Public() // 면제 사유: 토큰 발급 자체 — 아래 throttle + 계정 잠금이 무차별 대입을 막는다.
  @Throttle({ default: { limit: 5, ttl: 60000 } }) // 무차별 대입 방어: (IP+계정)당 분당 5회
  @ApiOperation({ summary: '로그인 — JWT 발급(roles 포함)' })
  async login(@Body() body: LoginDto) {
    return { data: await this.service.login(body.userId, body.password) };
  }

  @Get('me')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '내 정보(토큰 검증)' })
  me(@CurrentUser() user: AuthUser) {
    return { data: user };
  }

  @Post('change-password')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '비밀번호 변경(본인) — 강도 정책 적용' })
  async changePassword(@CurrentUser() user: AuthUser, @Body() body: ChangePasswordDto) {
    return { data: await this.service.changePassword(user.userId, body.currentPassword, body.newPassword) };
  }
}
