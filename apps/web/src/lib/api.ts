'use client';

/** LIS API 클라이언트 — JWT 토큰(localStorage) 기반.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 *  NEXT_PUBLIC_API_URL='' → same-origin(prod, nginx 프록시). 미설정 → 로컬 개발 기본값. */
const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('lis_token');
}

export function setToken(token: string): void {
  localStorage.setItem('lis_token', token);
}

export function clearToken(): void {
  localStorage.removeItem('lis_token');
}

/** 현재 토큰(JWT) payload 디코드(실패 시 null). */
function decodeToken(): { sub?: string; name?: string; roles?: string[] } | null {
  const token = getToken();
  if (!token) return null;
  try {
    return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

/** 현재 토큰(JWT)의 역할 목록.
 *  토큰에 roles 클레임이 없거나 비면(구 토큰·구 세션) 로그인 시 저장한 사용자 객체(lis_user)로 폴백한다.
 *  ★서버 authz는 매 요청 DB에서 역할을 재판정(jwt.strategy)하므로, 토큰 roles가 낡아도 API는 정상 허용된다 —
 *   문제는 클라이언트 사이드바가 토큰만 보고 전 메뉴를 숨겨 "메뉴가 사라진" 것처럼 보이는 것뿐. 표시 일관성 회복.
 *   (클라이언트 roles는 표시 전용 — 실제 접근은 서버가 강제하므로 폴백이 권한 상승이 되지 않는다.) */
export function getRoles(): string[] {
  const p = decodeToken();
  if (Array.isArray(p?.roles) && (p!.roles as string[]).length) return p!.roles as string[];
  if (typeof window !== 'undefined') {
    try {
      const u = JSON.parse(localStorage.getItem('lis_user') || 'null');
      if (Array.isArray(u?.roles) && u.roles.length) return u.roles as string[];
    } catch { /* noop */ }
  }
  return Array.isArray(p?.roles) ? (p!.roles as string[]) : [];
}

/** 현재 로그인 사용자 ID(sub) — 작성자·검증자 기록용. */
export function getUserId(): string | null {
  return decodeToken()?.sub ?? null;
}

/** 현재 로그인 사용자 이름. */
export function getUserName(): string | null {
  return decodeToken()?.name ?? null;
}

export interface ApiResult<T> {
  data: T;
}

/** 세션 만료(401) 처리 — 토큰 정리 후 재로그인 안내로 이동. */
function handleUnauthorized(): void {
  clearToken();
  if (typeof window !== 'undefined' && window.location.pathname !== '/') {
    window.location.href = '/?expired=1';
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 401) { handleUnauthorized(); throw new Error('세션이 만료되었습니다. 다시 로그인해 주세요.'); }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const msg = body?.message ?? `요청 실패 (${res.status})`;
    // 5xx는 서버가 requestId를 동봉한다 — 사용자가 이 번호만 알려주면 해당 요청 로그를 바로 찾는다
    throw new Error(body?.requestId ? `${msg} (문의번호 ${body.requestId})` : msg);
  }
  const json = (await res.json()) as ApiResult<T>;
  return json.data;
}

/** 인증 포함 raw 텍스트 응답(HTML 보고서 등). */
export async function apiText(path: string): Promise<string> {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  if (res.status === 401) { handleUnauthorized(); throw new Error('세션이 만료되었습니다. 다시 로그인해 주세요.'); }
  if (!res.ok) throw new Error(`요청 실패 (${res.status})`);
  return res.text();
}

/** data + meta(페이지네이션 등) 전체 봉투 반환. */
export async function apiFetchFull<T, M = { total: number; count: number; skip: number; take: number }>(
  path: string,
  init?: RequestInit,
): Promise<{ data: T; meta?: M }> {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init?.headers ?? {}) },
  });
  if (res.status === 401) { handleUnauthorized(); throw new Error('세션이 만료되었습니다. 다시 로그인해 주세요.'); }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.message ?? `요청 실패 (${res.status})`);
  }
  return (await res.json()) as { data: T; meta?: M };
}

/** 멀티파트 업로드 — Content-Type 미지정(브라우저가 boundary 설정). */
export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: form,
  });
  if (res.status === 401) { handleUnauthorized(); throw new Error('세션이 만료되었습니다. 다시 로그인해 주세요.'); }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.message ?? `업로드 실패 (${res.status})`);
  }
  const json = (await res.json()) as ApiResult<T>;
  return json.data;
}

/** 인증 헤더로 바이너리 조회 → Blob(미리보기·다운로드용). */
export async function apiBlob(path: string): Promise<Blob> {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (res.status === 401) { handleUnauthorized(); throw new Error('세션이 만료되었습니다. 다시 로그인해 주세요.'); }
  if (!res.ok) throw new Error(`다운로드 실패 (${res.status})`);
  return res.blob();
}

/**
 * 첨부 다운로드 — 본문(blob)과 함께 **응답 헤더**를 돌려준다.
 *
 * 왜 전용 헬퍼인가: 근거 문서는 `X-Attachment-Integrity`로 "저장 후 교체됐는가"를 알린다.
 * 일반 `apiFetch`는 JSON만 다뤄 이 헤더를 볼 수 없고, `<a href>`는 인증 헤더를 못 싣는다.
 * 무결성 경고를 화면이 읽지 못하면 그 방어는 서버 로그에만 존재한다.
 */
export async function apiDownload(path: string): Promise<{ blob: Blob; integrity: string | null; filename: string | null }> {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  if (res.status === 401) { handleUnauthorized(); throw new Error('세션이 만료되었습니다. 다시 로그인해 주세요.'); }
  if (!res.ok) throw new Error(`다운로드 실패 (${res.status})`);
  const cd = res.headers.get('content-disposition');
  const m = cd?.match(/filename\*=UTF-8''(.+)$/);
  return {
    blob: await res.blob(),
    integrity: res.headers.get('x-attachment-integrity'),
    filename: m ? decodeURIComponent(m[1]) : null,
  };
}
