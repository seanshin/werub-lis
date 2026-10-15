/**
 * JWT 인증 가드 — Bearer 토큰을 검증해 요청 주체를 확정한다.
 *
 * ⚠ 역할은 이 토큰이 아니라 `GET /auth/me`(DB 권위)로 조회한다. 토큰에 역할을 담아 쓰면
 *   권한을 바꿔도 기존 토큰이 만료될 때까지 반영되지 않아 "작업 중 메뉴가 사라지는" 문제가 났다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Injectable, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import type { AuthUser } from '../decorators/current-user.decorator';

/**
 * JWT 인증 가드. app.module에 APP_GUARD로 전역 등록되어 **기본 차단**이며,
 * @Public()이 붙은 핸들러·컨트롤러만 통과시킨다(health/metrics/login/HIS 웹훅).
 * 개별 컨트롤러의 @UseGuards(JwtAuthGuard, ...)는 그대로 두어도 무방하다(중복 적용 무해).
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }

  /**
   * 인증 성공 후 후처리 — 초기·재설정 비밀번호 상태(mustChangePassword)면
   * 비밀번호 변경 외 API 사용을 막는다. 관리자가 정한 비번을 그대로 계속 쓰는 상태를 없애기 위함.
   */
  handleRequest<TUser = AuthUser>(err: unknown, user: TUser, info: unknown, context: ExecutionContext): TUser {
    const result = super.handleRequest(err, user, info, context) as TUser;
    const u = result as AuthUser | undefined;
    if (u?.mustChangePassword) {
      const req = context.switchToHttp().getRequest();
      const url: string = String(req?.originalUrl ?? req?.url ?? '');
      if (!url.includes('/auth/change-password') && !url.includes('/auth/me')) {
        throw new ForbiddenException('초기 비밀번호를 변경해야 다른 기능을 사용할 수 있습니다');
      }
    }
    return result;
  }
}
