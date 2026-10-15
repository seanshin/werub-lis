/**
 * require-permission.decorator.ts — decorators 모듈 구성요소.
 *
 * 제공: PERMISSION_KEY, PermissionMeta, RequirePermission.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { SetMetadata } from '@nestjs/common';
import { Feature, Access } from '../rbac/roles';

export const PERMISSION_KEY = 'permission';

export interface PermissionMeta {
  feature: Feature;
  access: Access;
}

/** 기능·접근유형 권한 요구 (PermissionGuard와 함께 사용, 08 매트릭스 판정) */
export const RequirePermission = (feature: Feature, access: Access) =>
  SetMetadata(PERMISSION_KEY, { feature, access } as PermissionMeta);
