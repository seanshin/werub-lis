/**
 * roles.decorator.ts — decorators 모듈 구성요소.
 *
 * 제공: ROLES_KEY, Roles.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { SetMetadata } from '@nestjs/common';
import { LisRole } from '../rbac/roles';

export const ROLES_KEY = 'roles';

/** 허용 역할 지정 (RolesGuard와 함께 사용) */
export const Roles = (...roles: LisRole[]) => SetMetadata(ROLES_KEY, roles);
