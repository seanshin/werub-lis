/**
 * resolveRequestId — correlation id 승계/생성 — 단위 테스트 3건.
 *
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { resolveRequestId } from './request-id';

describe('resolveRequestId — correlation id 승계/생성', () => {
  it('신뢰 형식의 인바운드 id는 승계한다(게이트웨이 발급 유지)', () => {
    expect(resolveRequestId('ngx-1a2b3c4d')).toBe('ngx-1a2b3c4d');
  });

  it('개행·제어문자·과대 길이는 승계하지 않는다(로그 주입 차단)', () => {
    for (const bad of ['a\nb-injected', 'short', 'x'.repeat(65), 'has space id', undefined, 123]) {
      const id = resolveRequestId(bad as unknown);
      expect(id).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('생성 id는 매번 다르다', () => {
    expect(resolveRequestId(undefined)).not.toBe(resolveRequestId(undefined));
  });
});
