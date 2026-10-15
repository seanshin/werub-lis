/**
 * 전역 예외 필터 — 처리되지 않은 예외를 일관된 오류 응답으로 변환한다.
 *
 * 내부 오류 원문을 그대로 내보내지 않는다(스택·드라이버 메시지는 정보 수집의 단서가 된다).
 * 대신 correlation id를 함께 반환해, 사용자는 id만 알려주고 운영자가 로그에서 원문을 찾는다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';

/**
 * 전역 예외 필터 — 미처리 예외를 요청 컨텍스트와 함께 로깅하고 일관된 에러 봉투로 반환.
 * HttpException은 상태·메시지를 보존하고, 그 외는 500으로 정규화(내부 상세 비노출).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse();
    const req = ctx.getRequest();

    const isHttp = exception instanceof HttpException;
    // body-parser 등 Express 미들웨어는 HttpException이 아닌 raw 에러에 `status`(4xx)를 실어 던진다.
    // 예: 과대 본문 → PayloadTooLargeError(413). 이를 500으로 뭉개면 클라이언트 오류가 서버 오류로
    // 둔갑해 5xx 지표·스택 로그를 오염시키고, 사용자에겐 "고칠 수 없는 서버 문제"로 잘못 보인다.
    const rawStatus = !isHttp && exception && typeof exception === 'object'
      ? (exception as { status?: unknown; statusCode?: unknown }).status ?? (exception as { statusCode?: unknown }).statusCode
      : undefined;
    const isClientRaw = typeof rawStatus === 'number' && rawStatus >= 400 && rawStatus < 500;
    const status = isHttp ? exception.getStatus() : isClientRaw ? (rawStatus as number) : HttpStatus.INTERNAL_SERVER_ERROR;
    const payload = isHttp
      ? exception.getResponse()
      : isClientRaw
        ? { message: (exception as { type?: string }).type === 'entity.too.large' ? '요청 본문이 너무 큽니다' : '잘못된 요청입니다', statusCode: status }
        : { message: '서버 오류가 발생했습니다', statusCode: status };

    const method = req?.method ?? '?';
    // 쿼리스트링은 로그에 남기지 않는다 — `?q=홍길동` 같은 검색어가 그대로 PHI다.
    //   (경로 파라미터의 환자ID는 추적에 필요하므로 유지)
    const url = String(req?.originalUrl ?? req?.url ?? '?').split('?')[0];
    const user = req?.user?.userId ?? '-';
    const rid = req?.requestId ?? '-'; // correlation id — 응답 헤더 x-request-id와 동일(로그↔요청 결속)
    const msg = exception instanceof Error ? exception.message : String(exception);

    if (status >= 500) {
      // 5xx만 stack 포함(운영 진단), 4xx는 경량 로그
      this.logger.error(`${method} ${url} user=${user} rid=${rid} → ${status} · ${msg}`, exception instanceof Error ? exception.stack : undefined);
    } else {
      this.logger.warn(`${method} ${url} user=${user} rid=${rid} → ${status} · ${msg}`);
    }

    // 5xx 응답에 requestId 동봉 — 사용자가 이 값만 알려주면 해당 요청 로그를 바로 찾는다
    const body = typeof payload === 'object' ? { ...(payload as object), ...(status >= 500 ? { requestId: rid } : {}) } : { message: payload, statusCode: status, ...(status >= 500 ? { requestId: rid } : {}) };
    res.status(status).json(body);
  }
}
