/**
 * AuditInterceptor — 첨부 감사 기록 — 단위 테스트 4건.
 *
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect, vi } from 'vitest';
import { of } from 'rxjs';
import { AuditInterceptor } from './audit.interceptor';

// 감사 체인 append를 캡처하는 mock AuditChainService
function makeInterceptor() {
  const created: Record<string, unknown>[] = [];
  const chain = { append: (rec: Record<string, unknown>) => { created.push(rec); return Promise.resolve(); } };
  return { interceptor: new AuditInterceptor(chain as never), created };
}

function ctx(method: string, url: string, userId = 'U1') {
  const req = { method, originalUrl: url, url, user: { userId }, params: { id: 'x' } };
  return { switchToHttp: () => ({ getRequest: () => req }) } as never;
}
const handler = { handle: () => of({}) } as never;

async function run(method: string, url: string) {
  const { interceptor, created } = makeInterceptor();
  await new Promise<void>((resolve) => {
    (interceptor.intercept(ctx(method, url), handler) as ReturnType<typeof of>).subscribe({ complete: () => resolve() });
  });
  // tap 콜백(비동기 create) flush
  await Promise.resolve();
  return created;
}

describe('AuditInterceptor — 첨부 감사 기록', () => {
  it('첨부 업로드(POST)는 변경으로 기록', async () => {
    const c = await run('POST', '/api/v1/results/specimens/S-1/attachments');
    expect(c).toHaveLength(1);
    expect(c[0].action).toBe('POST');
    expect(c[0].sensitive).toBe(false);
  });

  it('첨부 삭제(DELETE)는 변경으로 기록', async () => {
    const c = await run('DELETE', '/api/v1/results/attachments/ATT-1');
    expect(c).toHaveLength(1);
    expect(c[0].action).toBe('DELETE');
  });

  it('첨부 다운로드(GET)는 민감 READ로 기록', async () => {
    const c = await run('GET', '/api/v1/results/attachments/ATT-1/download');
    expect(c).toHaveLength(1);
    expect(c[0].action).toBe('READ');
    expect(c[0].sensitive).toBe(true);
  });

  it('유전정보 변이 조회(GET)는 민감 READ로 기록(회귀)', async () => {
    const c = await run('GET', '/api/v1/genomic/G-1/variants');
    expect(c).toHaveLength(1);
    expect(c[0].sensitive).toBe(true);
  });

  // 조회 감사는 denylist 방식 — PHI를 반환하는 GET은 기본 기록한다(의료법 열람기록).
  it.each([
    ['/api/v1/patients?q=%ED%99%8D', '환자 검색'],
    ['/api/v1/patients/P-1', '환자 상세'],
    ['/api/v1/results/specimens/S-1/attachments', '첨부 목록'],
    ['/api/v1/results/report/S-1', '결과 보고서'],
    ['/api/v1/genomic/G-1/report', '유전체 보고서'],
    ['/api/v1/pathology/cases/SP-1', '병리 케이스'],
  ])('PHI 조회 %s(%s)는 READ로 기록', async (url) => {
    const c = await run('GET', url);
    expect(c).toHaveLength(1);
    expect(c[0].action).toBe('READ');
    expect(c[0].sensitive).toBe(true);
  });

  // 환자 무관 조회는 감사에서 제외(로그 폭증 방지) — 여기 추가 시 PHI 미포함을 반드시 확인할 것.
  it.each([
    ['/api/v1/health', '헬스체크'],
    ['/api/v1/metrics', '지표'],
    ['/api/v1/master/tests', '검사 마스터'],
    ['/api/v1/dashboard/summary', '대시보드 집계'],
    ['/api/v1/stats/workload', '통계'],
    ['/api/v1/notifications/badge', '배지 카운트'],
  ])('비-PHI 조회 %s(%s)는 미기록', async (url) => {
    const c = await run('GET', url);
    expect(c).toHaveLength(0);
  });
});
