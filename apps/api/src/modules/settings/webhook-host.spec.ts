/**
 * 웹훅 대상 호스트 차단 규칙 — SSRF 완화(2026-07-30 보안 검토) 회귀 고정.
 *
 * validateSetting은 운영(NODE_ENV=production)에서만 이 판정을 적용하지만,
 * 판정 자체는 순수 함수라 여기서 환경과 무관하게 고정한다 — 규칙이 느슨해지면 여기서 깨진다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { isForbiddenWebhookHost } from './settings.catalog';

describe('isForbiddenWebhookHost', () => {
  it('루프백은 차단 — 서버 자신의 내부 포트를 훑는 통로가 된다', () => {
    for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', 'LocalHost', 'app.localhost', '::1', '::ffff:127.0.0.1']) {
      expect(isForbiddenWebhookHost(h)).toBe(true);
    }
  });

  it('링크로컬은 차단 — 169.254.169.254는 클라우드 인스턴스 메타데이터(자격증명) 주소다', () => {
    for (const h of ['169.254.169.254', '169.254.0.1', 'fe80::1', '::ffff:169.254.169.254']) {
      expect(isForbiddenWebhookHost(h)).toBe(true);
    }
  });

  it('비특정 주소는 차단', () => {
    expect(isForbiddenWebhookHost('0.0.0.0')).toBe(true);
    expect(isForbiddenWebhookHost('::')).toBe(true);
  });

  it('원내 사설대역·공인 호스트는 허용 — 실제 통보 게이트웨이가 여기 있다', () => {
    for (const h of ['10.0.1.20', '172.16.4.9', '192.168.0.5', 'gw.hospital.local', 'lis.example.org']) {
      expect(isForbiddenWebhookHost(h)).toBe(false);
    }
  });

  it('IPv6 대괄호 표기도 판정한다(URL.hostname은 대괄호를 남긴다)', () => {
    expect(isForbiddenWebhookHost('[::1]')).toBe(true);
  });
});
