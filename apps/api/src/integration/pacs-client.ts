/**
 * PACS DICOMweb(QIDO) 클라이언트 + 뷰어 딥링크 — 근거: PACS 회신(§1·P4).
 * 흐름: QIDO(AccessionNumber) → StudyInstanceUID → 뷰어 딥링크.
 * 라이브 조회는 서비스계정 토큰(R1) 필요 — URL 빌드·파싱은 순수 함수(무의존, 테스트 가능).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

/** QIDO 검색 URL — GET {base}/studies?AccessionNumber={acc} */
export function buildQidoUrl(base: string, accessionNumber: string): string {
  const b = base.replace(/\/+$/, '');
  return `${b}/studies?AccessionNumber=${encodeURIComponent(accessionNumber)}`;
}

/** PACS 뷰어 런처 URL(AccessionNumber 직접, 새 창) — PACS 파일럿 제공 */
export function buildLauncherUrl(pacsBase: string, accessionNumber: string): string {
  const b = pacsBase.replace(/\/+$/, '');
  return `${b}/pacs-api/api/v1/viewer/launch?AccessionNumber=${encodeURIComponent(accessionNumber)}`;
}

/** PACS 서비스계정 로그인 → JWT (POST /pacs-api/api/v1/auth/login) */
export async function pacsLogin(
  pacsBase: string,
  username: string,
  password: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(`${pacsBase.replace(/\/+$/, '')}/pacs-api/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`PACS 로그인 실패 (${res.status})`);
  const json = (await res.json()) as { token?: string; access_token?: string; accessToken?: string };
  const token = json.token ?? json.access_token ?? json.accessToken;
  if (!token) throw new Error('PACS JWT 없음');
  return token;
}

/** 뷰어 딥링크 — {viewerBase}?StudyInstanceUIDs={uid} */
export function buildViewerUrl(viewerBase: string, studyInstanceUid: string): string {
  const b = viewerBase.replace(/\/+$/, '');
  return `${b}?StudyInstanceUIDs=${encodeURIComponent(studyInstanceUid)}`;
}

/** DICOM JSON 태그 값 추출 헬퍼 */
function tagValue(study: Record<string, unknown>, tag: string): string | null {
  const el = study[tag] as { Value?: unknown[] } | undefined;
  if (el && Array.isArray(el.Value) && el.Value.length > 0) {
    return String(el.Value[0]);
  }
  return null;
}

/**
 * QIDO 응답(DICOM JSON 배열)에서 첫 스터디의 StudyInstanceUID(0020000D) 추출.
 * 없으면 null.
 */
export function extractStudyUid(qidoResponse: unknown): string | null {
  if (!Array.isArray(qidoResponse) || qidoResponse.length === 0) return null;
  return tagValue(qidoResponse[0] as Record<string, unknown>, '0020000D');
}

export interface QidoStudy {
  studyInstanceUid: string | null;
  accessionNumber: string | null;
}

/** QIDO 응답 → 간략 스터디 목록 */
export function parseQidoStudies(qidoResponse: unknown): QidoStudy[] {
  if (!Array.isArray(qidoResponse)) return [];
  return qidoResponse.map((s) => ({
    studyInstanceUid: tagValue(s as Record<string, unknown>, '0020000D'),
    accessionNumber: tagValue(s as Record<string, unknown>, '00080050'),
  }));
}

export interface ViewerLinkResult {
  accession: string;
  studyInstanceUid: string | null;
  viewerUrl: string | null;
  found: boolean;
}

/**
 * AccessionNumber로 PACS 스터디 조회 후 뷰어 딥링크 생성 (라이브).
 * 서비스계정 토큰 필요. 스터디 미존재 시 found=false.
 */
export async function resolveViewerLink(
  qidoBase: string,
  viewerBase: string,
  token: string,
  accession: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ViewerLinkResult> {
  const url = buildQidoUrl(qidoBase, accession);
  const res = await fetchImpl(url, {
    headers: {
      Accept: 'application/dicom+json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (res.status === 204) {
    return { accession, studyInstanceUid: null, viewerUrl: null, found: false };
  }
  if (!res.ok) {
    throw new Error(`QIDO 조회 실패 (${res.status})`);
  }
  const json = await res.json();
  const uid = extractStudyUid(json);
  return {
    accession,
    studyInstanceUid: uid,
    viewerUrl: uid ? buildViewerUrl(viewerBase, uid) : null,
    found: !!uid,
  };
}
