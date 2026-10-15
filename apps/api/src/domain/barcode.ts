/**
 * 바코드 정규화 — **정본은 `@lis/shared`**.
 *
 * 이 파일은 기존 import 경로 호환을 위한 재export다. 서버와 클라이언트가 같은 규칙을 써야 하므로
 * 로직을 여기 다시 두지 말 것(과거에 API·웹에 바이트 동일한 사본이 있었고, 테스트된 사본은 죽고
 * 실제로 도는 사본은 무테스트인 상태였다).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export { normalizeBarcode } from '@lis/shared';
export type { BarcodeNormalizeCfg, BarcodeNormalizeResult } from '@lis/shared';
