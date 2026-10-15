/**
 * app-throttler.guard.ts — guards 모듈 구성요소.
 *
 * 제공: AppThrottlerGuard.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * 레이트리밋 식별자 — 기본 구현은 `req.ip` 하나만 쓴다.
 *
 * ① nginx·도커 NAT 뒤에서는 `trust proxy`(main.ts)가 설정돼야 req.ip가 실제 클라이언트가 된다.
 *    미설정 시 전 병원이 단일 버킷을 공유해, 외부인 한 명이 분당 5회만 시도해도 전 직원 로그인이
 *    차단되고 정상 업무만으로도 429가 난다.
 * ② 로그인은 IP 단독으로 세면 공용 NAT 뒤 검사실 전체가 서로의 시도에 영향을 받는다.
 *    따라서 로그인 경로만 (IP + 시도 대상 userId) 복합 키로 센다 — 계정별로 독립 계수.
 *    계정 자체의 무차별 대입은 별도로 계정 잠금(password-policy)이 막는다.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const ip = (req.ip as string) || 'unknown';
    const url = String((req.originalUrl as string) ?? (req.url as string) ?? '');
    if (url.includes('/auth/login')) {
      const body = req.body as { userId?: unknown } | undefined;
      const uid = typeof body?.userId === 'string' ? body.userId.slice(0, 64) : '-';
      return `login:${ip}:${uid}`;
    }
    return ip;
  }
}
