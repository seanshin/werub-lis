/**
 * json-logger.ts — logging 모듈 구성요소.
 *
 * 제공: JsonLogger, makeLogger.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { ConsoleLogger, LoggerService, LogLevel } from '@nestjs/common';

/**
 * 구조화(JSON) 로거 — 운영에서 로그를 한 줄 JSON으로 출력(수집·검색·알림 파이프라인 친화).
 * 개발에선 기본 ConsoleLogger(가독) 사용. 근거: 개시 전 백로그 C4(관측성).
 * 민감정보는 이미 상위(AuditInterceptor REDACT 등)에서 마스킹 — 로거는 메시지를 그대로 직렬화.
 */
export class JsonLogger implements LoggerService {
  private write(level: LogLevel, message: unknown, context?: string, extra?: unknown): void {
    const line = {
      level,
      ts: new Date().toISOString(),
      context: context ?? undefined,
      message: typeof message === 'string' ? message : safe(message),
      ...(extra !== undefined ? { detail: typeof extra === 'string' ? extra : safe(extra) } : {}),
    };
    // stdout/stderr 분리(오류는 stderr) — 컨테이너 로그 수집기가 레벨 구분.
    const out = JSON.stringify(line);
    if (level === 'error' || level === 'fatal') process.stderr.write(out + '\n');
    else process.stdout.write(out + '\n');
  }

  log(message: unknown, context?: string): void { this.write('log', message, context); }
  error(message: unknown, stackOrContext?: string, context?: string): void {
    // Nest는 error(message, stack, context) 형태로도 호출 — stack을 detail로.
    this.write('error', message, context ?? (stackOrContext && !stackOrContext.includes('\n') ? stackOrContext : undefined), stackOrContext?.includes('\n') ? stackOrContext : undefined);
  }
  warn(message: unknown, context?: string): void { this.write('warn', message, context); }
  debug(message: unknown, context?: string): void { this.write('debug', message, context); }
  verbose(message: unknown, context?: string): void { this.write('verbose', message, context); }
  fatal(message: unknown, context?: string): void { this.write('fatal', message, context); }
}

function safe(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}

/** 운영은 JSON, 그 외는 기본 ConsoleLogger. main.ts에서 사용. */
export function makeLogger(): LoggerService {
  return process.env.NODE_ENV === 'production' ? new JsonLogger() : new ConsoleLogger();
}
