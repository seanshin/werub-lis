/**
 * current-user.decorator.ts — decorators 모듈 구성요소.
 *
 * 제공: AuthUser, CurrentUser.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface AuthUser {
  userId: string;
  name: string;
  roles: string[];
  /** 관리자 발급·재설정 비밀번호 상태 — true면 비밀번호 변경 외 API 사용 불가. */
  mustChangePassword?: boolean;
  /** 연결된 의사 마스터(Provider) — 병리 사인아웃 등 Provider 기준 임상 서명의 주체. */
  providerId?: string | null;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    return ctx.switchToHttp().getRequest().user;
  },
);
