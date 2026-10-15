/**
 * NotifyChannelTester — settings 도메인 서비스.
 *
 * 주요 진입점: `send()`
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Injectable, BadRequestException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { SettingsService } from './settings.service';
import { AuditChainService } from '../audit/audit-chain.service';

/**
 * 통보 채널 테스트 발송.
 *
 * 왜 필요한가: URL만 저장하고 끝내면 **실제로 도달하는지는 첫 위험치 때 알게 된다**.
 * 그때 실패하면 그건 곧 환자안전 사고다. 개시 전에 운영자가 스스로 확인할 수 있어야 한다.
 * 합성 페이로드만 보낸다 — 테스트 때문에 실제 환자 정보가 외부로 나가면 안 된다.
 */
@Injectable()
export class NotifyChannelTester {
  constructor(
    private readonly settings: SettingsService,
    private readonly audit: AuditChainService,
  ) {}

  async send(channel: string, userId: string | null) {
    const key = channel === 'critical' ? 'CRITICAL_WEBHOOK_URL' : channel === 'ops' ? 'OPS_WEBHOOK_URL' : null;
    if (!key) throw new BadRequestException(`채널 오류: ${channel} (critical|ops)`);
    const url = this.settings.get(key);
    if (!url) throw new BadRequestException('채널이 설정되지 않았습니다 — URL을 먼저 저장하세요');

    const body = JSON.stringify({
      test: true,
      channel,
      message: 'LIS 통보 채널 테스트입니다. 이 메시지는 환자 정보를 포함하지 않습니다.',
      sentBy: userId,
    });
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const secret = channel === 'critical' ? this.settings.get('CRITICAL_WEBHOOK_SECRET') : undefined;
    if (secret) headers['x-lis-signature'] = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

    let ok = false;
    let httpStatus: number | null = null;
    let error: string | null = null;
    const started = Date.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      // redirect 미추종: 저장 시점 호스트 검증을 302로 내부망에 우회하는 경로 차단(SSRF 완화)
      const res = await fetch(url, { method: 'POST', headers, body, signal: ctrl.signal, redirect: 'error' });
      clearTimeout(timer);
      httpStatus = res.status;
      ok = res.ok;
      if (!ok) error = `수신측이 ${res.status}로 거부했습니다`;
    } catch (e) {
      // 타임아웃·DNS·TLS 실패를 구분해서 보여줘야 운영자가 어디를 고칠지 안다
      const m = e instanceof Error ? e.message : String(e);
      error = /abort/i.test(m) ? '5초 안에 응답이 없습니다(방화벽·경로 확인)' : m;
    }
    const elapsedMs = Date.now() - started;

    await this.audit.append({
      userId,
      action: 'NOTIFY_CHANNEL_TEST',
      target: key,
      detail: ok ? `성공(${httpStatus}, ${elapsedMs}ms)` : `실패: ${error}`,
      status: httpStatus ?? 0,
      sensitive: false,
    });
    return { channel, ok, httpStatus, elapsedMs, error, signed: !!secret };
  }
}
