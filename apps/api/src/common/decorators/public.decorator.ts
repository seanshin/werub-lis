/**
 * public.decorator.ts — decorators 모듈 구성요소.
 *
 * 제공: IS_PUBLIC_KEY, Public.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * 인증 면제 표시. 전역 JwtAuthGuard(app.module)가 이 표시가 있는 핸들러만 통과시킨다.
 *
 * 기본이 '차단'이어야 하는 이유: 과거처럼 컨트롤러마다 @UseGuards를 붙이는 opt-in 구조에서는
 * 새 컨트롤러에 가드를 빠뜨리면 그 순간 조용히 전면 공개된다(환자 데이터). 면제는 여기 명시된
 * 소수만 — 붙일 때는 반드시 사유를 주석으로 남길 것.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
