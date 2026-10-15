/**
 * correlation id 미들웨어 — 모든 응답에 `x-request-id`를 실어 로그와 사용자 문의를 잇는다.
 *
 * 신뢰 형식 인바운드 헤더는 승계하고, 비신뢰 값은 재발급한다(위조된 id로 로그를 오염시키지 못하게).
 * 예외 로그에도 같은 id가 붙으므로, 사용자가 화면에서 본 id 하나로 서버 로그를 특정할 수 있다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { randomBytes } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

/**
 * 요청 correlation id(P2) — 장애 조사 시 클라이언트 응답·서버 로그를 이어붙이는 열쇠.
 * 인바운드 `x-request-id`(nginx/게이트웨이 발급)를 신뢰 형식일 때만 승계, 아니면 생성.
 * 응답 헤더로 항상 반환 — 사용자 문의·화면 오류에 rid를 첨부하면 그 요청의 로그를 바로 찾는다.
 */
const SAFE_ID = /^[A-Za-z0-9._-]{6,64}$/; // 로그 주입(개행·제어문자) 차단

export function resolveRequestId(inbound: unknown): string {
  if (typeof inbound === 'string' && SAFE_ID.test(inbound)) return inbound;
  return randomBytes(8).toString('hex');
}

export function requestIdMiddleware(req: Request & { requestId?: string }, res: Response, next: NextFunction): void {
  const id = resolveRequestId(req.headers['x-request-id']);
  req.requestId = id;
  res.setHeader('x-request-id', id);
  next();
}
