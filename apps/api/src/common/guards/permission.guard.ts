/**
 * 기능×역할 권한 가드 — `@RequirePermission(Feature, Access)`를 강제한다.
 *
 * 권한 판정의 정본은 `rbac/roles.ts`의 PERMISSION_MATRIX 하나뿐이며, 여기서는 조회만 한다.
 * ⚠ 화면이 열린다고 권한이 있는 것이 아니다 — 사이드바 노출 역할과 이 가드가 어긋나면
 *   사용자는 화면에 들어와 전부 403을 받는다(죽은 화면).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSION_KEY, PermissionMeta } from '../decorators/require-permission.decorator';
import { can, LisRole } from '../rbac/roles';

/**
 * 08 권한 매트릭스 기반 세밀 권한 검사.
 * @RequirePermission(feature, access) 가 붙은 핸들러에만 적용.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const meta = this.reflector.getAllAndOverride<PermissionMeta>(PERMISSION_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!meta) return true;

    const user = ctx.switchToHttp().getRequest().user;
    const roles = (user?.roles ?? []) as LisRole[];
    if (!can(roles, meta.feature, meta.access)) {
      throw new ForbiddenException(`권한 없음: ${meta.feature} (${meta.access})`);
    }
    return true;
  }
}
