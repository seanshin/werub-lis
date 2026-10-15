/**
 * AuthService — auth 도메인 서비스.
 *
 * 주요 진입점: `login()`, `changePassword()`
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { validatePasswordStrength, nextLockState, isLocked } from '../../domain/password-policy';

/** 로그인 실패 응답은 원인을 구분하지 않는다(사용자 열거 방지). 잠금 안내는 별도 유지. */
const LOGIN_FAIL_MESSAGE = '아이디 또는 비밀번호가 올바르지 않습니다';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  /** userId + password 검증 후 JWT 발급 (roles 포함). 실패 누적 시 계정 잠금. */
  async login(userId: string, password: string) {
    const user = await this.prisma.appUser.findUnique({
      where: { userId },
      include: { roles: true },
    });
    // 사용자 열거 방지: 미존재·비활성·비번불일치를 같은 메시지로 응답한다.
    //   응답이 갈리면 유효 계정 ID를 수집한 뒤 표적 계정 잠금(가용성 공격)으로 이어진다.
    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedException(LOGIN_FAIL_MESSAGE);
    }
    if (isLocked(user.lockedUntil, Date.now())) {
      throw new UnauthorizedException('연속 로그인 실패로 계정이 잠금되었습니다. 잠시 후 다시 시도하세요');
    }

    const ok = user.passwordHash ? await bcrypt.compare(password, user.passwordHash) : false;
    if (!ok) {
      const { attempts, lockedUntilMs } = nextLockState(user.failedAttempts);
      await this.prisma.appUser.update({
        where: { userId },
        data: {
          failedAttempts: attempts,
          lockedUntil: lockedUntilMs ? new Date(Date.now() + lockedUntilMs) : user.lockedUntil,
        },
      });
      throw new UnauthorizedException(LOGIN_FAIL_MESSAGE);
    }

    // 성공 → 실패 카운트 초기화
    if (user.failedAttempts > 0 || user.lockedUntil) {
      await this.prisma.appUser.update({
        where: { userId },
        data: { failedAttempts: 0, lockedUntil: null },
      });
    }

    const roles = user.roles.map((r) => r.roleCode);
    const accessToken = await this.jwt.signAsync({
      sub: user.userId,
      name: user.name,
      roles,
    });
    return {
      accessToken,
      user: { userId: user.userId, name: user.name, roles, mustChangePassword: user.mustChangePassword },
    };
  }

  /** 비밀번호 변경 — 현재 비번 확인 + 강도 정책 검증. */
  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await this.prisma.appUser.findUnique({ where: { userId } });
    if (!user) throw new UnauthorizedException('사용자를 찾을 수 없습니다');
    const ok = user.passwordHash ? await bcrypt.compare(currentPassword, user.passwordHash) : false;
    if (!ok) throw new UnauthorizedException('현재 비밀번호가 일치하지 않습니다');

    const violation = validatePasswordStrength(newPassword);
    if (violation) throw new BadRequestException(violation);
    if (await bcrypt.compare(newPassword, user.passwordHash ?? '')) {
      throw new BadRequestException('기존 비밀번호와 다르게 설정하세요');
    }

    await this.prisma.appUser.update({
      where: { userId },
      data: {
        passwordHash: await bcrypt.hash(newPassword, 10),
        pwdUpdatedDt: new Date(),
        failedAttempts: 0,
        lockedUntil: null,
        mustChangePassword: false,
      },
    });
    return { userId, changed: true };
  }

  /** 비밀번호 해시 유틸(시드/관리용) */
  static hash(password: string): Promise<string> {
    return bcrypt.hash(password, 10);
  }
}
