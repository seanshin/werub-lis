/**
 * roles.guard.ts — guards 모듈 구성요소.
 *
 * 제공: RolesGuard.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { LisRole } from '../rbac/roles';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<LisRole[]>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const user = ctx.switchToHttp().getRequest().user;
    const roles: string[] = user?.roles ?? [];
    const ok = required.some((r) => roles.includes(r));
    if (!ok) throw new ForbiddenException('해당 작업 권한이 없습니다');
    return true;
  }
}
