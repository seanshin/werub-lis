/**
 * 위험치 웹훅 환자명 마스킹 — 단위 테스트 6건.
 *
 * 묶음: 위험치 웹훅 서명.
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect, afterEach } from 'vitest';
import { maskName, signHeaders } from './critical-notifier.service';

const ENV_KEYS = ['CRITICAL_WEBHOOK_FULL_NAME', 'CRITICAL_WEBHOOK_SECRET'] as const;

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe('위험치 웹훅 환자명 마스킹', () => {
  // 이 페이로드는 사내 메신저·SMS 게이트웨이 등 LIS 밖으로 나간다.
  it('기본은 성 + 마지막 글자만 노출', () => {
    expect(maskName('홍길동')).toBe('홍*동');
    expect(maskName('남궁민수')).toBe('남**수');
    expect(maskName('김철')).toBe('김*');
    expect(maskName('김')).toBe('김');
  });

  it('빈 값은 null', () => {
    expect(maskName(null)).toBeNull();
    expect(maskName(undefined)).toBeNull();
  });

  it('명시 승인(CRITICAL_WEBHOOK_FULL_NAME=on) 시에만 전체 이름', () => {
    process.env.CRITICAL_WEBHOOK_FULL_NAME = 'on';
    expect(maskName('홍길동')).toBe('홍길동');
  });
});

describe('위험치 웹훅 서명', () => {
  it('시크릿 미설정 시 서명 헤더 없음', () => {
    expect(signHeaders('{}')).toEqual({});
  });

  it('시크릿 설정 시 본문 HMAC-SHA256 서명(수신측 진위 검증용)', () => {
    // 시크릿은 인자로만 — env 폴백 제거(화면 해제가 되살아나지 않도록)
    const h = signHeaders('{"a":1}', 'test-secret');
    expect(h['x-lis-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    // 본문이 다르면 서명도 달라야 한다(위조 통보 주입 차단)
    expect(signHeaders('{"a":2}', 'test-secret')['x-lis-signature']).not.toBe(h['x-lis-signature']);
  });

  it('env에 시크릿이 있어도 인자로 안 주면 서명 안 함(화면 해제 존중 — cleared 무력화 방지)', () => {
    process.env.CRITICAL_WEBHOOK_SECRET = 'env-secret';
    expect(signHeaders('{"a":1}')).toEqual({}); // 폴백 없음
    delete process.env.CRITICAL_WEBHOOK_SECRET;
  });
});
