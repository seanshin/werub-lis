/**
 * 신뢰할 리버스 프록시 홉 수. 기본 1(nginx 1대).
 *
 * ⚠ compose는 미설정 env를 **빈 문자열**로 전달한다(`${VAR:-}`). `?? 1`은 빈 문자열을 거르지 못해
 * `Number('') === 0` → Express의 trust proxy가 비활성이 된다. 그러면 nginx·도커 NAT 뒤에서
 * 모든 요청이 도커 게이트웨이 단일 IP로 보여 ①레이트리밋이 전 병원 공용 버킷이 되고
 * ②감사로그의 접속 IP가 무의미해진다. 실제로 배포 후 이 경로로 조용히 무력화된 적이 있다.
 * 그래서 유한한 양수일 때만 사용하고 그 외에는 기본값으로 되돌린다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export function trustProxyHops(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
