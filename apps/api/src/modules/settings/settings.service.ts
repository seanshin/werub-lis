/**
 * SettingsService — settings 도메인 서비스.
 *
 * 주요 진입점: `onModuleInit()`, `reload()`, `get()`, `getNumber()`, `getBool()`, `list()`, `set()`
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Injectable, Logger, OnModuleInit, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditChainService } from '../audit/audit-chain.service';
import { SETTING_BY_KEY, SETTING_DEFS, maskSettingValue, validateSetting } from './settings.catalog';

/**
 * 운영 설정(DB) — env를 대체하지 않고 **앞선다**.
 *
 * 우선순위: DB 설정 > 환경변수 > 코드 기본값.
 * env를 남겨 두는 이유는 두 가지다. ①기존 배포가 그대로 동작해야 하고 ②DB가 비어 있는
 * 최초 기동에서도 채널이 살아 있어야 한다. 반대로 DB를 우선하는 이유는 운영자가 화면에서
 * 고친 값이 재기동 없이 즉시 먹혀야 하기 때문이다.
 *
 * 소비 지점은 동기 함수(`webhookUrl()` 등)라 캐시를 메모리에 들고 있고, 쓰기 때마다
 * 갱신한다. 단일 인스턴스 전제(감사 체인 뮤텍스와 동일 전제).
 */
@Injectable()
export class SettingsService implements OnModuleInit {
  private readonly logger = new Logger(SettingsService.name);
  private cache = new Map<string, string>();
  /** 화면에서 **명시적으로 비운** 키 — env가 되살아나지 않도록 기억한다. */
  private cleared = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditChainService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reload().catch((e) => {
      // 설정 테이블을 못 읽어도 env 폴백으로 계속 동작해야 한다(기동 실패로 만들지 않는다).
      this.logger.warn(`운영 설정 로드 실패 — 환경변수로 동작합니다: ${e instanceof Error ? e.message : e}`);
    });
  }

  async reload(): Promise<void> {
    const rows = await this.prisma.systemSetting.findMany();
    this.cache = new Map(rows.filter((r) => r.value !== '').map((r) => [r.key, r.value]));
    this.cleared = new Set(rows.filter((r) => r.value === '').map((r) => r.key));
  }

  /** DB → env 순으로 조회. 빈 문자열은 '해제'로 보고 폴백하지 않는다. */
  get(key: string): string | undefined {
    const v = this.cache.get(key);
    if (v != null) return v;
    // 화면에서 비운 것을 env가 덮어쓰면, 운영자는 "껐는데 계속 나간다"를 겪는다.
    if (this.cleared.has(key)) return undefined;
    const e = process.env[key];
    return e && e !== '' ? e : undefined;
  }

  getNumber(key: string, fallback: number): number {
    const n = Number(this.get(key));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  getBool(key: string): boolean {
    return this.get(key) === 'on';
  }

  /** 화면용 목록 — 민감 값은 마스킹해 내보낸다. */
  async list() {
    const rows = await this.prisma.systemSetting.findMany();
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return SETTING_DEFS.map((def) => {
      const row = byKey.get(def.key);
      const effective = this.get(def.key) ?? '';
      return {
        key: def.key,
        label: def.label,
        kind: def.kind,
        group: def.group,
        help: def.help,
        placeholder: def.placeholder ?? null,
        // 숫자 설정의 허용범위 — 입력 attr·힌트로 노출(거부당하고 나서야 알게 되던 것)
        min: def.min ?? null,
        max: def.max ?? null,
        configured: effective !== '',
        // 파일럿 시드 sink(_seed) 여부 — 마스킹된 display로는 판별 못 하므로 원값에서 서버가 계산해 내려준다
        seed: def.kind === 'url' && /_seed\//.test(effective),
        // 값의 출처를 보여준다 — "화면에서 바꿨는데 왜 안 바뀌지"를 없앤다
        source: row && row.value !== '' ? 'DB' : effective !== '' ? 'ENV' : 'NONE',
        display: maskSettingValue(def, effective),
        updatedBy: row?.updatedBy ?? null,
        updatedDt: row?.updatedDt ?? null,
      };
    });
  }

  /** 저장(빈 값이면 해제). 감사 기록에 값은 남기지 않는다. */
  async set(key: string, raw: string, userId: string | null) {
    const def = SETTING_BY_KEY.get(key);
    if (!def) throw new NotFoundException(`설정 키 없음: ${key}`);
    const allowHttp = key === 'CRITICAL_WEBHOOK_ALLOW_HTTP' ? raw.trim() === 'on' : this.getBool('CRITICAL_WEBHOOK_ALLOW_HTTP');
    const r = validateSetting(def, raw, allowHttp);
    if ('error' in r) throw new BadRequestException(`${def.label}: ${r.error}`);

    await this.prisma.systemSetting.upsert({
      where: { key },
      create: { key, value: r.value, updatedBy: userId },
      update: { value: r.value, updatedBy: userId },
    });
    if (r.value === '') {
      this.cache.delete(key);
      this.cleared.add(key);
    } else {
      this.cache.set(key, r.value);
      this.cleared.delete(key);
    }

    // 통보 채널 변경은 환자안전에 직결된다(누가 언제 껐는지 남아야 한다).
    // 값 자체는 남기지 않는다 — 감사로그가 시크릿 저장소가 되면 안 된다.
    await this.audit.append({
      userId,
      action: 'SETTING_UPDATE',
      target: key,
      detail: r.value === '' ? '해제' : '설정 변경',
      status: 200,
      sensitive: true,
    });
    return { key, configured: r.value !== '', display: maskSettingValue(def, r.value) };
  }
}
