/**
 * HIS 참조 EP 클라이언트(read-only) — 조직 게이트 결재 상태 · 수혈 동의 상태.
 * 정본은 HIS(EApprovalRelay·FHIR Consent). LIS는 received-code-trust로 참조만.
 * 인증: x-integration-key(HIS_INTEGRATION_KEY). 미구성/오류 시 fail-safe(available:false) — 하드크래시·차단 없음.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { buildTargetToken, TARGET_TOKEN_TTL_SEC } from './his-target-token';

export type HisResult<T> = { available: true; data: T } | { available: false; reason: string };

/**
 * HIS 참조 EP의 베이스 URL.
 *
 * ★HIS 컨트롤러는 `@Controller('api/v1/integration/lis')`다. 이전에는 origin만 유도해
 *   `/integration/lis/...`로 호출했고 운영에서 **404**였다(2026-07-21 실측).
 *   클라이언트가 fail-safe라 404도 `available:false`로 조용히 삼켜져 수기 폴백으로 넘어가므로,
 *   시크릿이 주입돼도 "키 문제"로 오인한 채 영영 동작하지 않았을 경로다.
 *   유도 시 **`/api/v1` 프리픽스를 포함**한다. 명시 지정(HIS_INTEGRATION_BASE)은 프리픽스까지
 *   포함한 값으로 간주해 그대로 쓴다(다른 배포 형태 대응).
 */
function integrationBase(): string | null {
  const explicit = process.env.HIS_INTEGRATION_BASE;
  if (explicit) return explicit.replace(/\/+$/, '');
  // 미지정 시 HIS_FHIR_BASE의 origin에서 유도(예: https://his.example.org/fhir/R4 → https://his.example.org/api/v1)
  const fhir = process.env.HIS_FHIR_BASE;
  if (!fhir) return null;
  try { return `${new URL(fhir).origin}/api/v1`; } catch { return null; }
}

/** 호출 URL 조립(회귀 테스트 대상 — 경로 오류가 fail-safe에 삼켜지지 않도록 고정). */
export function hisIntegrationUrl(path: string): string | null {
  const base = integrationBase();
  return base ? `${base}${path}` : null;
}

function timeout(): AbortSignal { return AbortSignal.timeout(Number(process.env.HIS_HTTP_TIMEOUT_MS) || 15000); }

async function get<T>(path: string, extraHeaders?: Record<string, string>): Promise<HisResult<T>> {
  const base = integrationBase();
  const key = process.env.HIS_INTEGRATION_KEY;
  if (!base) return { available: false, reason: 'HIS 통합 base 미구성(HIS_INTEGRATION_BASE/HIS_FHIR_BASE)' };
  if (!key) return { available: false, reason: 'HIS_INTEGRATION_KEY 미구성(운영 시크릿 주입 필요) — fail-closed' };
  try {
    const res = await fetch(`${base}${path}`, { headers: { 'x-integration-key': key, Accept: 'application/json', ...(extraHeaders ?? {}) }, signal: timeout() });
    if (res.status === 401 || res.status === 403) return { available: false, reason: `HIS 인증 거부(${res.status}) — integrationKey 확인` };
    // ★404는 인증이 아니라 **경로 오류**다. 뭉뚱그리면 키 문제로 오인해 원인을 못 찾는다(실제로 겪음).
    if (res.status === 404) return { available: false, reason: `HIS 경로 없음(404): ${base}${path} — EP 경로·프리픽스 확인` };
    if (!res.ok) return { available: false, reason: `HIS 응답 오류(${res.status})` };
    return { available: true, data: (await res.json()) as T };
  } catch (e) {
    return { available: false, reason: `HIS 연결 실패: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ── 조직 게이트 결재 참조 ──
export interface HisEapproval { gateKey: string; status?: string; docNo?: string; approver?: string; approvedDate?: string; note?: string }

/** gateKey = lis.org_gate:{gateCode}. EApprovalRelay 조회. */
export function getEapprovalStatus(gateCode: string): Promise<HisResult<HisEapproval>> {
  return get<HisEapproval>(`/integration/lis/eapproval/status?gateKey=${encodeURIComponent(`lis.org_gate:${gateCode}`)}`);
}

/** HIS 결재 상태 문자열 → LIS lifecycle. 미상신/미상 등 매핑 불가는 null(적용 안 함). */
export function mapHisApprovalStatus(s: string | undefined | null): 'SUBMITTED' | 'IN_PROGRESS' | 'APPROVED' | 'REJECTED' | null {
  const t = (s ?? '').toString().toLowerCase();
  if (/완료|승인|approv|complete/.test(t)) return 'APPROVED';
  if (/반려|거부|reject|deny/.test(t)) return 'REJECTED';
  if (/진행|검토|progress|review/.test(t)) return 'IN_PROGRESS';
  if (/상신|기안|submit/.test(t)) return 'SUBMITTED';
  return null;
}

// ── 수혈 동의 참조 ──
export interface HisConsent { patientId: string; category?: string; _derivedState?: 'active' | 'expired' | 'withdrawn' | 'pending'; signedDate?: string; validUntil?: string }

/**
 * 동의 상태 조회 — **patientUuid는 HIS FHIR Patient uuid**(MRN 아님 — MRN은 HIS 500, 2026-07-22 실측).
 * S-3 대상 토큰(X-Target-Token)을 동봉한다(HIS는 현재 permissive — 동봉 시작을 통지하면 enforce 플립).
 */
export function getConsentStatus(patientUuid: string, category = 'TRANSFUSION'): Promise<HisResult<HisConsent>> {
  /**
   * ★토큰 서명 시크릿은 인증 키와 **분리 가능**하다 — HIS `lis.targetTokenSecret`과 대칭.
   *
   * 왜 분리하나: 예전엔 `HIS_INTEGRATION_KEY` 하나로 인증(x-integration-key)과 토큰 서명을
   * 겸용했다. 그러면 인증 키를 회전하는 순간 **서명 기준도 같이 바뀌어**, LIS가 .env를 교체·
   * 재기동할 때까지 X-Target-Token이 401이 된다(enforce=true 실측 확인).
   * 양측이 각자 명시 설정을 두면 두 시크릿을 **독립적으로 회전**할 수 있어 창이 생기지 않는다.
   *
   * 미설정 시 인증 키로 폴백 — HIS도 같은 폴백 규칙이라 기존 동작과 호환된다.
   */
  const key = process.env.HIS_INTEGRATION_KEY;
  const tokenSecret = process.env.HIS_TARGET_TOKEN_SECRET || key;
  const headers = key && tokenSecret
    ? { 'X-Target-Token': buildTargetToken(patientUuid, tokenSecret, Math.floor(Date.now() / 1000) + TARGET_TOKEN_TTL_SEC) }
    : undefined;
  return get<HisConsent>(`/integration/lis/consent/status?patientId=${encodeURIComponent(patientUuid)}&category=${encodeURIComponent(category)}`, headers);
}

// ── 검사코드 카탈로그(H1) ──

export interface HisLabCodeItem {
  code: string; // = edi_code(처방코드) — LIS 매핑 키
  nameKo: string | null;
  loincCode: string | null;
  category: string | null;
  meta?: { lastUpdated?: string | null };
  panel?: { resultItemCode?: string; code?: string; nameKo?: string | null; loincCode?: string | null; specimen?: string | null; unit?: string | null }[];
}

export interface HisLabCodePage {
  generatedAt?: string;
  since?: string | null;
  page: number;
  limit: number;
  total: number;
  count: number;
  panelSource?: string;
  items: HisLabCodeItem[];
}

/**
 * 검사코드 카탈로그 1페이지. HIS 응답은 `{ data: {...} }` 래핑이라 벗겨서 돌려준다.
 * 규격: HIS docs/05-reference/relay-his-lis-h1h5-response.md (H1).
 */
export async function getLabCodePage(page: number, limit: number, since?: string | null): Promise<HisResult<HisLabCodePage>> {
  const q = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (since) q.set('since', since);
  const r = await get<HisLabCodePage | { data: HisLabCodePage }>(`/integration/lis/lab-codes?${q.toString()}`);
  if (!r.available) return r;
  const body = r.data as { data?: HisLabCodePage };
  return { available: true, data: (body?.data ?? r.data) as HisLabCodePage };
}
