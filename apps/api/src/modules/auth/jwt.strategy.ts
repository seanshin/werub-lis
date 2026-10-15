/**
 * jwt.strategy.ts — auth 모듈 구성요소.
 *
 * 제공: JwtPayload, JwtStrategy.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { getJwtSecret } from './jwt-secret.util';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export interface JwtPayload {
  sub: string;
  name: string;
  roles: string[];
  iat?: number; // 발급 시각(초) — 비밀번호 변경 이후 토큰 무효화 비교용
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: getJwtSecret(),
    });
  }

  async validate(payload: JwtPayload): Promise<AuthUser> {
    const user = await this.prisma.appUser.findUnique({
      where: { userId: payload.sub },
      select: { status: true, pwdUpdatedDt: true, mustChangePassword: true, providerId: true, roles: { select: { roleCode: true } } },
    });
    // 비활성/삭제 계정 즉시 차단(관리자 비활성화 반영)
    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedException('비활성 계정입니다. 관리자에게 문의하세요.');
    }
    // 비밀번호 변경/재설정 이후 발급된(iat 이전) 토큰 무효화 — 초 단위 비교로 동일초 오판 방지
    if (user.pwdUpdatedDt && payload.iat && Math.floor(user.pwdUpdatedDt.getTime() / 1000) > payload.iat) {
      throw new UnauthorizedException('비밀번호가 변경되어 세션이 만료되었습니다. 다시 로그인하세요.');
    }
    // 역할은 토큰이 아니라 DB를 권위 소스로 삼는다 — 토큰에 박힌 역할을 믿으면 관리자 권한을
    // 회수당한 계정이 토큰 만료(기본 8h)까지 계속 관리자로 행세한다(권한 회수 무력화).
    const roles = user.roles.map((r) => r.roleCode);
    return { userId: payload.sub, name: payload.name, roles, mustChangePassword: user.mustChangePassword, providerId: user.providerId };
  }
}
