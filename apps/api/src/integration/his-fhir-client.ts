/**
 * HIS FHIR 클라이언트 — HIS 회신서 v1.1 §B 준수.
 *  - 토큰: POST /oauth2/token (client_credentials, client_secret_post)
 *  - 결과: POST /fhir/R4/DiagnosticReport (scope system/DiagnosticReport.write)
 *  - 오더: GET /fhir/R4/ServiceRequest?category=laboratory&status=active
 * fetch 주입으로 단위 테스트 가능. 라이브는 client_id/secret(HIS 발급) 필요.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

export interface HisFhirConfig {
  tokenUrl: string; // https://his.example.org/oauth2/token
  fhirBase: string; // https://his.example.org/fhir/R4
  clientId: string;
  clientSecret: string;
  scopes: string; // "system/DiagnosticReport.write system/ServiceRequest.read ..."
}

/** HIS/PACS HTTP 호출 타임아웃(기본 15s) — 응답 없는 연결이 크론/이벤트루프를 무한 점유하지 않도록. */
export function httpTimeout(): AbortSignal {
  return AbortSignal.timeout(Number(process.env.HIS_HTTP_TIMEOUT_MS) || 15000);
}

/** client_credentials 토큰 발급 */
export async function getAccessToken(
  cfg: HisFhirConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    scope: cfg.scopes,
  });
  const res = await fetchImpl(cfg.tokenUrl, {
    signal: httpTimeout(),
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`토큰 발급 실패 (${res.status})`);
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error('access_token 없음');
  return json.access_token;
}

/**
 * HIS FHIR 쓰기 — ServiceRequest(Reflex PreOrder)를 transaction Bundle로 발신.
 * HIS는 Bundle의 ServiceRequest를 직접 POST와 동일 코어로 지원하며, entry 응답의
 * **response.location(= ServiceRequest/<PreOrder id>)** 에서 hisRef를 해소한다(2026-07-15 HIS 계약 명문화).
 * location이 없으면 hisRef=null(폴링 불가) — 과거 identifier 재조회 우회는 오결속을 유발해 제거함.
 */
export async function postFhirResourceViaBundle(
  cfg: HisFhirConfig,
  token: string,
  resource: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number; id: string | null }> {
  const base = cfg.fhirBase.replace(/\/+$/, '');
  const resourceType = (resource.resourceType as string) || 'ServiceRequest';
  const bundle = {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: [{ resource, request: { method: 'POST', url: resourceType } }],
  };
  const res = await fetchImpl(base, {
    signal: httpTimeout(),
    method: 'POST',
    headers: { 'Content-Type': 'application/fhir+json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(bundle),
  });
  if (!res.ok) return { ok: false, status: res.status, id: null };
  // ⚠️ transaction 외부가 201이어도 entry.response.status가 4xx/5xx면 실제 실패다.
  //    (HIS가 미지원/검증실패를 개별 entry로 반환 — 외부만 보면 '조용한 성공' 오판)
  let id: string | null = null;
  let entryStatus = 0;
  try {
    const body = (await res.json()) as { entry?: { response?: { status?: string; location?: string } }[] };
    const resp = body?.entry?.[0]?.response;
    entryStatus = parseInt(String(resp?.status ?? '').slice(0, 3), 10) || 0;
    const loc = resp?.location;
    if (loc) { const m = loc.match(/([A-Za-z]+)\/([^/]+?)(?:\/_history.*)?$/); if (m) id = m[2]; }
  } catch { /* noop */ }
  const entryOk = entryStatus >= 200 && entryStatus < 300; // 명시적 2xx만 성공
  return { ok: entryOk, status: entryStatus || res.status, id: entryOk ? id : null };
}

/** 결과(DiagnosticReport) POST → HIS 스테이징 큐 */
export async function postDiagnosticReport(
  cfg: HisFhirConfig,
  token: string,
  report: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string | null; ingestStatus: string | null; matchedOrderId: string | null }> {
  const res = await fetchImpl(`${cfg.fhirBase.replace(/\/+$/, '')}/DiagnosticReport`, {
    signal: httpTimeout(),
    method: 'POST',
    headers: {
      'Content-Type': 'application/fhir+json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(report),
  });
  if (!res.ok) throw new Error(`DiagnosticReport POST 실패 (${res.status})`);
  const json = (await res.json()) as {
    id?: string;
    _ingest?: { status?: string; matchedOrderId?: string };
  };
  return {
    id: json.id ?? null,
    ingestStatus: json._ingest?.status ?? null,
    matchedOrderId: json._ingest?.matchedOrderId ?? null,
  };
}

/** 검사 오더 폴링 — category=laboratory 클라이언트 필터(안전). status 기본 active(취소 감지 시 revoked). */
export interface PolledOrder { orderId: string; code: string | null; patientRef: string | null; mrn: string | null; isPathology: boolean; lastUpdated: string | null; }

/**
 * ServiceRequest 폴링 — 증분(_lastUpdated>since) + 커서 페이지네이션(next link, _count) 지원(HIS PR#528).
 * since 미지정 시 전체(status 필터). 최대 페이지 수 상한으로 폭주 방지.
 */
export async function pollLabOrders(
  cfg: HisFhirConfig,
  token: string,
  fetchImpl: typeof fetch = fetch,
  status = 'active',
  since?: string | null,
  count = 200,
): Promise<PolledOrder[]> {
  const base = cfg.fhirBase.replace(/\/+$/, '');
  let url: string | null = `${base}/ServiceRequest?category=laboratory&status=${encodeURIComponent(status)}&_count=${count}` +
    (since ? `&_lastUpdated=gt${encodeURIComponent(since)}&_sort=_lastUpdated` : '');
  const out: PolledOrder[] = [];
  const MAX_PAGES = 50; // 안전 상한(_count 200×50=10000)
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const res = await fetchImpl(url, { signal: httpTimeout(), headers: { Accept: 'application/fhir+json', Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`ServiceRequest 조회 실패 (${res.status})`);
    const bundle = (await res.json()) as { entry?: { resource?: Record<string, unknown> }[]; link?: { relation?: string; url?: string }[] };
    for (const e of bundle.entry ?? []) {
      const r = e.resource;
      if (!r || r.resourceType !== 'ServiceRequest' || !isLabCategory(r)) continue;
      out.push({
        orderId: typeof r.id === 'string' ? r.id : '',
        code: extractCode(r),
        patientRef: extractSubject(r),
        mrn: extractMrn(r),
        isPathology: hasPatCategory(r),
        lastUpdated: (r.meta as { lastUpdated?: string } | undefined)?.lastUpdated ?? null,
      });
    }
    // 다음 페이지(커서) — HIS가 절대/상대 next url 제공.
    //   ★절대 URL은 반드시 base와 같은 오리진이어야 한다. 응답 본문이 시키는 임의 호스트를
    //     그대로 따라가면 Bearer 토큰을 외부로 재전송하게 된다(침해·오설정 HIS → 토큰 탈취).
    const next = (bundle.link ?? []).find((l) => l.relation === 'next')?.url ?? null;
    url = next ? resolveNextUrl(base, next) : null;
  }
  return out;
}

/**
 * 페이지네이션 next 링크 해석 — 동일 오리진만 허용.
 * 상대 경로는 base에 이어 붙이고, 절대 URL은 오리진이 다르면 순회를 중단한다(null).
 */
export function resolveNextUrl(base: string, next: string): string | null {
  if (!next.startsWith('http')) return `${base}${next.startsWith('/') ? '' : '/'}${next}`;
  try {
    if (new URL(next).origin !== new URL(base).origin) return null;
    return next;
  } catch {
    return null;
  }
}

/** category coding에 병리(PAT, HL7 v2-0074) 포함 여부 — 병리 오더 라우팅 판정. */
function hasPatCategory(sr: Record<string, unknown>): boolean {
  const cats = (sr.category as { coding?: { system?: string; code?: string }[] }[] | undefined) ?? [];
  return cats.some((c) => (c.coding ?? []).some((cd) => cd.code === 'PAT'));
}

/**
 * 환자 성명 조회(Patient.read) — ServiceRequest.subject(Patient/{id})의 실제 이름.
 * 실패/미조회 시 null 반환(호출측에서 폴백 처리). scope: system/Patient.read.
 */
export async function fetchPatientName(
  cfg: HisFhirConfig,
  token: string,
  patientRef: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const id = patientRef.replace('Patient/', '').trim();
  if (!id) return null;
  try {
    const res = await fetchImpl(`${cfg.fhirBase.replace(/\/+$/, '')}/Patient/${encodeURIComponent(id)}`, {
    signal: httpTimeout(),
      headers: { Accept: 'application/fhir+json', Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const p = (await res.json()) as { name?: { text?: string; family?: string; given?: string[] }[] };
    const n = (p.name ?? [])[0];
    if (!n) return null;
    const composed = n.text?.trim() || `${n.family ?? ''}${(n.given ?? []).join('')}`.trim();
    return composed || null;
  } catch {
    return null;
  }
}

function isLabCategory(sr: Record<string, unknown>): boolean {
  const cats = (sr.category as { coding?: { code?: string }[] }[] | undefined) ?? [];
  return cats.some((c) => (c.coding ?? []).some((cd) => cd.code === 'LAB' || cd.code === 'laboratory'));
}

/**
 * 오더 코드 추출 — HIS EDI 수가코드(system urn:hospital-run:procedure) 우선.
 * LIS codeMapping은 EDI 수가코드(hisCode)로 매칭하므로 LOINC(coding[0])보다 procedure 코딩을 우선.
 * 없으면 code 있는 첫 coding으로 폴백.
 */
function extractCode(sr: Record<string, unknown>): string | null {
  const codings = (sr.code as { coding?: { system?: string; code?: string }[] } | undefined)?.coding ?? [];
  const proc = codings.find((c) => c?.code && (c.system ?? '').toLowerCase().includes('procedure'));
  if (proc?.code) return proc.code;
  return codings.find((c) => c?.code)?.code ?? null;
}

function extractSubject(sr: Record<string, unknown>): string | null {
  const subj = sr.subject as { reference?: string } | undefined;
  return subj?.reference ?? null;
}

/** subject.identifier에서 실 MRN 추출 — system이 'mrn'을 포함하는 identifier의 value(HIS 2026-07-15 계약). */
function extractMrn(sr: Record<string, unknown>): string | null {
  const subj = sr.subject as { identifier?: { system?: string; value?: string } | { system?: string; value?: string }[] } | undefined;
  const ids = subj?.identifier;
  const arr = Array.isArray(ids) ? ids : ids ? [ids] : [];
  const hit = arr.find((i) => i?.value && (i.system ?? '').toLowerCase().includes('mrn'));
  return hit?.value ?? null;
}
