/**
 * internal-only.guard.ts — guards 모듈 구성요소.
 *
 * 제공: InternalOnlyGuard, isInternalAddress.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';

/**
 * 무인증 엔드포인트를 **내부망에서만** 열어 두는 가드(지표 수집용).
 *
 * ★왜 앱에 있나 — 프록시 계층에만 있던 방어는 프록시를 갈아끼우면 조용히 사라진다.
 *   2026-09-09 파일럿 서버 이관에서 실제로 그랬다: nginx의
 *   `location = /api/v1/metrics { allow 127.0.0.1; deny all; }`이 Caddy에 재현되지 않아
 *   무인증 지표(DLQ 깊이·**미전달 임상 위험치 건수**)가 인터넷에서 200으로 열렸다.
 *   같은 이관에서 CSP·X-Frame-Options 등은 살아남았는데, 이유는 단 하나 — 앱(next.config)이
 *   이중으로 심고 있었기 때문이다. 그래서 이 방어도 앱으로 내렸다.
 *   프록시 측 차단(infra/nginx 설정·Caddy)은 **없애지 말고** 이중으로 함께 둔다.
 *
 * ★왜 '루프백만'이 아닌가 — **컨테이너 안에서는 호스트의 루프백이 보이지 않는다.**
 *   `127.0.0.1:4101->4100` 게시 포트로 들어온 요청은 도커 브리지 게이트웨이(예: `172.20.0.1`)
 *   출발지로 도착한다. 루프백만 허용했더니(v1.56.15) 외부는 물론 **호스트 내부 수집까지 404**가
 *   됐다(2026-09-09 실측). nginx의 `allow 127.0.0.1`이 통했던 것은 nginx가 호스트에서 돌아
 *   호스트 루프백을 그대로 봤기 때문이고, 앱은 같은 자리에 있지 않다.
 *   → 루프백 + 사설대역(RFC1918)까지 허용한다. 공인 IP는 전부 막힌다.
 *
 * ⚠ 판정은 반드시 `req.ip`로 한다. `X-Forwarded-For`를 직접 읽으면 클라이언트가 최좌측 값을
 *   위조해 통과한다. `req.ip`는 main.ts의 `trust proxy`(TRUST_PROXY_HOPS) 설정 하에서
 *   신뢰 홉을 반영한 값이라, 외부 요청은 어떤 헤더를 넣어도 사설대역으로 계산되지 않는다
 *   (프록시가 실제 클라이언트의 공인 IP를 체인에 넣고, 위조값은 왼쪽에 밀려 채택되지 않는다).
 *   홉 수가 틀리면 이 가드도 함께 틀어지므로 프록시 구성 변경 시 홉 수를 실측할 것.
 *
 * ⚠ 사설대역 허용은 **같은 호스트·같은 사설망의 다른 서비스는 수집할 수 있다**는 뜻이다.
 *   공용 호스트(파일럿)에서는 어차피 `127.0.0.1:4101`에 직접 도달 가능하므로 실질 차이가 없지만,
 *   더 좁혀야 하는 사이트에서는 프록시 계층(nginx `allow`)으로 함께 조인다.
 *
 * 403이 아니라 **404**를 준다 — 403은 "여기에 무언가 있다"를 확인해 주는 답이다.
 */
@Injectable()
export class InternalOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ ip?: string; socket?: { remoteAddress?: string } }>();
    const ip = req?.ip || req?.socket?.remoteAddress;
    if (isInternalAddress(ip)) return true;
    throw new NotFoundException();
  }
}

/**
 * 내부 주소 판정 — 루프백(127.0.0.0/8·`::1`) + 사설대역(10/8·172.16/12·192.168/16).
 * IPv4-mapped IPv6(`::ffff:...`)도 같은 규칙으로 본다. 값이 없으면 **차단 쪽**으로 판정한다.
 */
export function isInternalAddress(ip?: string | null): boolean {
  if (!ip) return false;
  // Node는 IPv4 연결을 `::ffff:127.0.0.1` 형태로 주기도 한다.
  const addr = ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
  if (addr === '::1') return true;

  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (m.slice(1).some((o) => Number(o) > 255)) return false;

  if (a === 127) return true; // 루프백 127.0.0.0/8
  if (a === 10) return true; // 사설 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 사설 172.16.0.0/12 — 도커 기본 브리지 대역
  if (a === 192 && b === 168) return true; // 사설 192.168.0.0/16
  return false;
}
