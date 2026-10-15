/**
 * 전역 감사 인터셉터 — 모든 변경 요청과 **민감 조회**를 자동 기록한다.
 *
 * 감사는 사후에 붙일 수 없다. 서비스마다 호출을 심으면 반드시 빠지는 곳이 생기므로
 * 요청 경계에서 일괄 포착한다(APP_INTERCEPTOR 전역 등록).
 * 기록은 AuditChainService의 **해시체인**으로 이어지고, DB 트리거가 UPDATE를 막는다 —
 * 앱 버그로도 과거 감사 기록이 바뀌지 않게 하는 이중 방어.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Injectable, NestInterceptor, ExecutionContext, CallHandler, Logger } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { AuditChainService } from '../../modules/audit/audit-chain.service';

/**
 * 감사추적 인터셉터 — 근거: 06 §3.11 AuditLog, 08 §5.
 *  - 변경(POST/PUT/PATCH/DELETE)은 전건 기록 + 정제된 body·IP·UA(무엇을·어디서)
 *  - 조회(GET)는 PHI 반환 경로를 기본 READ 기록(비-PHI 경로만 NON_PHI_READ로 제외)
 *  - 감사 기록 실패는 조용히 삼키지 않고 크게 로깅(무추적 조치 감지)
 */
/**
 * PHI를 반환하지 않는 GET — 감사(READ) 대상에서 제외한다.
 * 여기에 추가할 때는 "이 응답에 환자 식별정보·검사결과가 절대 섞이지 않는가"를 확인할 것.
 * 애매하면 넣지 말 것(과다 기록은 비용 문제지만, 누락은 법적 소명 불가다).
 */
const NON_PHI_READ: RegExp[] = [
  /\/api\/v1\/health/,
  /\/api\/v1\/metrics/,
  /\/api\/v1\/auth\//,
  /\/api\/v1\/master\//, // 검사·참고치·패널·코드매핑 마스터(환자 무관)
  /\/api\/v1\/terminology/, // 용어·코드셋
  /\/api\/v1\/rbac/, // 권한 매트릭스
  /\/api\/v1\/dashboard/, // 집계 카운트만
  /\/api\/v1\/stats\//, // 워크로드·TAT 등 집계
  /\/api\/v1\/instruments($|\?|\/(?!logs))/, // 장비 목록·설정(로그는 PHI 포함 → 감사 대상)
  /\/api\/v1\/barcode\/config/,
  // 배지 카운트 — 개수만 반환(PHI 없음). 60초 폴링이라 여기 없으면 감사가 폴링으로 가득 찬다.
  /\/api\/v1\/notifications\/badge/,
  /\/api\/v1\/integration\/hl7\/health/,
];

const REDACT = new Set([
  'password', 'currentpassword', 'newpassword', 'client_secret', 'clientsecret',
  'secret', 'token', 'accesstoken', 'refreshtoken',
]);

/**
 * 본문을 통째로 가려야 하는 라우트(경로 접두). 필드명 기반 마스킹으로는 못 잡는 경우다.
 *  - 운영 설정: 시크릿을 **범용 `value` 필드**로 실어 REDACT를 빠져나간다. URL 값에도 쿼리
 *    토큰(?token=)이 실릴 수 있다. 설정 서비스가 값 없는 자체 감사(SETTING_UPDATE)를 이미 남기므로
 *    인터셉터가 본문을 또 기록하면 감사로그가 시크릿 저장소가 된다(보존 3년).
 * 값 대신 마킹만 남긴다 — "무엇을 바꿨나"는 서비스 자체 감사에 있다.
 */
const REDACT_BODY_ROUTES = ['/api/v1/admin/settings'];

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Audit');
  constructor(private readonly chain: AuditChainService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest();
    const method: string = req.method;
    const url: string = req.originalUrl || req.url;

    const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
    // 조회 감사는 allowlist(=감사 대상 몇 개)가 아니라 denylist 방식이어야 한다.
    //   의료법·개인정보보호법은 진료정보 '열람' 기록을 요구하는데, 감사 대상을 몇 개 패턴으로
    //   좁히면 새 조회 화면이 늘 때마다 무기록 열람 경로가 생긴다. 그래서 GET은 기본 기록하고,
    //   PHI를 반환하지 않는 경로만 아래에서 명시적으로 제외한다.
    const isSensitiveRead = method === 'GET' && !NON_PHI_READ.some((re) => re.test(url));

    const skip = url.includes('/auth/login') || url.includes('/health');
    if (skip || (!isMutation && !isSensitiveRead)) {
      return next.handle();
    }

    return next.handle().pipe(
      tap({
        next: () => this.write(req, method, url, isSensitiveRead, isMutation, 200),
        error: (err) => this.write(req, method, url, isSensitiveRead, isMutation, err?.status ?? 500),
      }),
    );
  }

  /**
   * 비밀·토큰 필드를 마스킹한 body 요약.
   * 중첩 객체·배열까지 재귀 순회한다 — 최상위 키만 훑으면 `{cred:{password:...}}` 형태의
   * 비밀이 감사로그(보존 3년)에 평문으로 남는다.
   */
  private sanitizeBody(body: unknown, depth = 0): unknown {
    if (depth > 6) return '[깊이초과]';
    if (Array.isArray(body)) return body.slice(0, 50).map((v) => this.sanitizeBody(v, depth + 1));
    if (!body || typeof body !== 'object') return depth === 0 ? undefined : body;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      out[k] = REDACT.has(k.toLowerCase()) ? '***' : this.sanitizeBody(v, depth + 1);
    }
    return out;
  }

  private write(
    req: { user?: { userId?: string }; params?: unknown; body?: unknown; ip?: string; headers?: Record<string, unknown>; socket?: { remoteAddress?: string } },
    method: string,
    url: string,
    sensitive: boolean,
    isMutation: boolean,
    status: number,
  ): void {
    // req.ip는 Express `trust proxy`(main.ts) 설정 하에서 nginx가 붙인 X-Forwarded-For의
    // 신뢰 홉을 반영한 값이다. 헤더를 직접 읽으면 클라이언트가 최좌측 값을 위조해 감사로그의
    // 접속지를 조작할 수 있으므로(= '어디서'가 무의미해짐) 절대 헤더를 직접 신뢰하지 말 것.
    const ip = req.ip || req.socket?.remoteAddress || null;
    const ua = (req.headers?.['user-agent'] as string) ?? null;
    // 라우트 자체가 민감하면(설정 등) 필드명 마스킹으로는 못 막으므로 본문을 통째로 가린다
    const redactBody = REDACT_BODY_ROUTES.some((p) => url.startsWith(p));
    const detailObj = {
      params: req.params && Object.keys(req.params).length ? req.params : undefined,
      body: isMutation ? (redactBody ? '[민감 라우트 — 값 미기록(서비스 자체 감사 참조)]' : this.sanitizeBody(req.body)) : undefined,
      ip,
      ua: ua ? String(ua).slice(0, 200) : undefined,
    };
    const detail = JSON.stringify(detailObj).slice(0, 4000); // 과대 방지 절단

    // 해시체인 append(직렬화) — 순서·prevHash 보장. 실패는 체인 서비스가 크게 로깅.
    void this.chain
      .append({
        userId: req.user?.userId ?? null,
        action: sensitive ? 'READ' : method,
        target: url,
        detail,
        status,
        sensitive,
      })
      .catch((e) => this.logger.error(`감사 기록 실패(${method} ${url}): ${e instanceof Error ? e.message : e}`));
  }
}
