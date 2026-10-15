/**
 * renderPathologyReportHtml — XSS 이스케이프(회귀 금지) — 단위 테스트 6건.
 *
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { renderPathologyReportHtml } from './pathology-report-html';

/**
 * 병리 보고서 HTML은 환자명·진단·소견을 그대로 문서에 넣는다.
 * 이스케이프가 **유일한 방어**이고(보안 검토 2026-07-21에서 확인), 이 파일에는 회귀 가드가 없었다.
 * 렌더 결과는 인쇄·포털로 나가므로 스크립트 주입이 성립하면 임상의 세션이 노출된다.
 * 근거: docs/재검토_2026-07-21_발견목록.md Q5 · docs/보안_점검_2026-07-21.md
 */
type CaseArg = Parameters<typeof renderPathologyReportHtml>[0];
const build = (over: Partial<{ name: string; findings: string; diagnosis: string }> = {}): CaseArg =>
  ({
    spNo: 'SP-2026-0001',
    patient: { patientId: 'P-1', name: over.name ?? '홍길동' },
    report: { findings: over.findings ?? '소견', diagnosis: over.diagnosis ?? '진단' },
  }) as CaseArg;

describe('renderPathologyReportHtml — XSS 이스케이프(회귀 금지)', () => {
  it('환자명의 스크립트 태그가 실행 가능한 형태로 남지 않는다', () => {
    const html = renderPathologyReportHtml(build({ name: '<script>alert(1)</script>' }));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('진단·소견의 태그도 이스케이프된다', () => {
    const html = renderPathologyReportHtml(build({ diagnosis: '<img src=x onerror=alert(1)>', findings: '<b>강조</b>' }));
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>강조</b>');
  });

  it('따옴표가 속성 경계를 깨지 않는다', () => {
    const html = renderPathologyReportHtml(build({ name: '" onload="alert(1)' }));
    expect(html).not.toContain('onload="alert(1)"');
    expect(html).toContain('&quot;');
  });

  it('앰퍼샌드가 이중 이스케이프 없이 처리된다', () => {
    const html = renderPathologyReportHtml(build({ diagnosis: 'A & B' }));
    expect(html).toContain('A &amp; B');
  });

  it('정상 입력은 그대로 표시된다(과도한 이스케이프로 판독을 방해하지 않음)', () => {
    const html = renderPathologyReportHtml(build());
    expect(html).toContain('홍길동');
    expect(html).toContain('SP-2026-0001');
  });

  it('외부 리소스를 참조하지 않는다(자체완결 — 오프라인 인쇄·포털 배포용)', () => {
    const html = renderPathologyReportHtml(build());
    expect(html).not.toMatch(/<script\s+src=/i);
    expect(html).not.toMatch(/<link\s+[^>]*href=["']https?:/i);
  });
});
