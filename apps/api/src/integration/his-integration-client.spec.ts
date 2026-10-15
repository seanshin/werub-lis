/**
 * hisIntegrationUrl — HIS 참조 EP 경로 — 단위 테스트 5건.
 *
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { hisIntegrationUrl } from './his-integration-client';

/**
 * ★HIS 참조 EP 경로 회귀(회귀 금지).
 *
 * HIS 컨트롤러는 `@Controller('api/v1/integration/lis')`인데 LIS 클라이언트는 origin만 유도해
 * `/integration/lis/...`를 호출했고 운영에서 **404**였다(2026-07-21 실측).
 * 클라이언트가 fail-safe라 404도 `available:false`로 삼켜져 수기 폴백으로 넘어가므로,
 * **시크릿이 주입돼도 "키 문제"로 오인한 채 영영 동작하지 않았을** 경로다.
 * 이 테스트는 프리픽스가 다시 빠지는 것을 막는다.
 */
describe('hisIntegrationUrl — HIS 참조 EP 경로', () => {
  const saved = { base: process.env.HIS_INTEGRATION_BASE, fhir: process.env.HIS_FHIR_BASE };
  beforeEach(() => { delete process.env.HIS_INTEGRATION_BASE; delete process.env.HIS_FHIR_BASE; });
  afterEach(() => {
    if (saved.base === undefined) delete process.env.HIS_INTEGRATION_BASE; else process.env.HIS_INTEGRATION_BASE = saved.base;
    if (saved.fhir === undefined) delete process.env.HIS_FHIR_BASE; else process.env.HIS_FHIR_BASE = saved.fhir;
  });

  it('FHIR base에서 유도할 때 /api/v1 프리픽스를 포함한다', () => {
    process.env.HIS_FHIR_BASE = 'https://his.example.org/fhir/R4';
    expect(hisIntegrationUrl('/integration/lis/lab-codes')).toBe('https://his.example.org/api/v1/integration/lis/lab-codes');
  });

  it('프리픽스 없는 경로를 만들지 않는다(404 회귀 방지)', () => {
    process.env.HIS_FHIR_BASE = 'https://his.example.org/fhir/R4';
    const url = hisIntegrationUrl('/integration/lis/eapproval/status');
    expect(url).not.toBe('https://his.example.org/integration/lis/eapproval/status');
    expect(url).toContain('/api/v1/');
  });

  it('명시 지정(HIS_INTEGRATION_BASE)은 프리픽스 포함 값으로 보고 그대로 쓴다', () => {
    process.env.HIS_INTEGRATION_BASE = 'https://his.example.org/api/v1/';
    expect(hisIntegrationUrl('/integration/lis/lab-codes')).toBe('https://his.example.org/api/v1/integration/lis/lab-codes');
  });

  it('base 미구성이면 null — 호출 자체를 만들지 않는다', () => {
    expect(hisIntegrationUrl('/integration/lis/lab-codes')).toBeNull();
  });

  it('FHIR base가 잘못된 URL이면 null(크래시 금지)', () => {
    process.env.HIS_FHIR_BASE = 'not-a-url';
    expect(hisIntegrationUrl('/integration/lis/lab-codes')).toBeNull();
  });
});
