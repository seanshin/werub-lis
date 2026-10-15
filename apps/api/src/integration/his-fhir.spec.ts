/**
 * FHIR DiagnosticReport (HIS §B.3 형식) — 단위 테스트 23건.
 *
 * 묶음: HIS FHIR 클라이언트 (fetch mock), fetchPatientName (Patient.read → 실이름/폴백), postFhirResourceViaBundle (ServiceRequest → transaction Bundle).
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { buildDiagnosticReport } from './fhir-mapper';
import { getAccessToken, postDiagnosticReport, pollLabOrders, fetchPatientName, postFhirResourceViaBundle, HisFhirConfig } from './his-fhir-client';

const cfg: HisFhirConfig = {
  tokenUrl: 'https://his.example.org/oauth2/token',
  fhirBase: 'https://his.example.org/fhir/R4',
  clientId: 'lis', clientSecret: 'secret',
  scopes: 'system/DiagnosticReport.write system/ServiceRequest.read',
};

describe('FHIR DiagnosticReport (HIS §B.3 형식)', () => {
  const dr = buildDiagnosticReport({
    patientId: 'p-1', specimenNo: 'S-0090', orderId: 'order-9',
    results: [{ loinc: '2823-3', testName: 'Potassium', value: '6.8', unit: 'mmol/L', flag: 'HH', status: 'F', refLow: 3.5, refHigh: 5.1 }],
  }) as Record<string, any>;

  it('DiagnosticReport 단건 + contained Observation(값 포함)', () => {
    expect(dr.resourceType).toBe('DiagnosticReport');
    expect(dr.contained).toHaveLength(1);
    expect(dr.contained[0].resourceType).toBe('Observation');
    expect(dr.contained[0].valueQuantity.value).toBe(6.8);
  });
  it('basedOn = ServiceRequest 결속', () => {
    expect(dr.basedOn[0].reference).toBe('ServiceRequest/order-9');
  });
  it('identifier = 검체 바코드', () => {
    expect(dr.identifier[0].value).toBe('S-0090');
  });
  it('위험치 interpretation·참고범위 포함', () => {
    expect(dr.contained[0].interpretation[0].coding[0].code).toBe('HH');
    expect(dr.contained[0].referenceRange[0].low.value).toBe(3.5);
  });
  it('orderId 없으면 basedOn 생략', () => {
    const d = buildDiagnosticReport({ patientId: 'p', specimenNo: 's', results: [] }) as Record<string, any>;
    expect(d.basedOn).toBeUndefined();
  });
  it('승인된 Reflex add-on 오더가 basedOn에 결속(원오더+reflex, 중복제거)', () => {
    const d = buildDiagnosticReport({ patientId: 'p', specimenNo: 's', orderId: 'order-9', reflexOrderIds: ['HORD-77', 'order-9'], results: [] }) as Record<string, any>;
    const refs = d.basedOn.map((b: { reference: string }) => b.reference);
    expect(refs).toEqual(['ServiceRequest/order-9', 'ServiceRequest/HORD-77']); // 중복(order-9) 1회
  });
});

describe('HIS FHIR 클라이언트 (fetch mock)', () => {
  it('client_credentials 토큰 발급', async () => {
    const mock = (async (_u: string, init: RequestInit) => {
      expect(String(init.body)).toContain('grant_type=client_credentials');
      return { ok: true, status: 200, json: async () => ({ access_token: 'TOK', expires_in: 3600 }) } as Response;
    }) as typeof fetch;
    expect(await getAccessToken(cfg, mock)).toBe('TOK');
  });

  it('DiagnosticReport POST → ingest 상태 파싱', async () => {
    const mock = (async () =>
      ({ ok: true, status: 201, json: async () => ({ id: 'dr-1', _ingest: { status: 'MATCHED', matchedOrderId: 'order-9' } }) }) as Response) as typeof fetch;
    const r = await postDiagnosticReport(cfg, 'TOK', {}, mock);
    expect(r.ingestStatus).toBe('MATCHED');
    expect(r.matchedOrderId).toBe('order-9');
  });

  it('ServiceRequest 폴링 — LAB만 클라이언트 필터', async () => {
    const bundle = {
      entry: [
        { resource: { resourceType: 'ServiceRequest', id: 'o1', category: [{ coding: [{ code: 'LAB' }] }], code: { coding: [{ code: 'CBC' }] }, subject: { reference: 'Patient/p1', identifier: { system: 'urn:hospital-run:mrn', value: 'P2026-0006' } } } },
        { resource: { resourceType: 'ServiceRequest', id: 'o2', category: [{ coding: [{ code: 'IMAGING' }] }] } },
      ],
    };
    const mock = (async () => ({ ok: true, status: 200, json: async () => bundle }) as Response) as typeof fetch;
    const orders = await pollLabOrders(cfg, 'TOK', mock);
    expect(orders).toHaveLength(1); // IMAGING 제외
    expect(orders[0].orderId).toBe('o1');
    expect(orders[0].code).toBe('CBC');
    expect(orders[0].mrn).toBe('P2026-0006'); // subject.identifier에서 실 MRN 추출
  });
  it('MRN 미동봉 시 mrn=null(폴백은 호출측)', async () => {
    const bundle = { entry: [{ resource: { resourceType: 'ServiceRequest', id: 'o3', category: [{ coding: [{ code: 'laboratory' }] }], code: { coding: [{ code: 'CRP' }] }, subject: { reference: 'Patient/uuid-x' } } }] };
    const mock = (async () => ({ ok: true, status: 200, json: async () => bundle }) as Response) as typeof fetch;
    const orders = await pollLabOrders(cfg, 'TOK', mock);
    expect(orders[0].mrn).toBeNull();
    expect(orders[0].patientRef).toBe('Patient/uuid-x');
  });
  it('코드 추출 — EDI 수가코드(procedure) 우선(LOINC보다)', async () => {
    const bundle = { entry: [{ resource: { resourceType: 'ServiceRequest', id: 'oc', category: [{ coding: [{ code: 'laboratory' }] }], code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }, { system: 'urn:hospital-run:procedure', code: 'E6591' }] }, subject: { reference: 'Patient/p' } } }] };
    const mock = (async () => ({ ok: true, status: 200, json: async () => bundle }) as Response) as typeof fetch;
    const orders = await pollLabOrders(cfg, 'TOK', mock);
    expect(orders[0].code).toBe('E6591'); // LOINC(4548-4) 아닌 수가코드 우선
  });
  it('증분 폴링 — since 지정 시 _lastUpdated=gt 쿼리 + meta.lastUpdated 추출', async () => {
    let calledUrl = '';
    const bundle = { entry: [{ resource: { resourceType: 'ServiceRequest', id: 'oi', category: [{ coding: [{ code: 'laboratory' }] }], code: { coding: [{ code: 'CBC' }] }, subject: { reference: 'Patient/p' }, meta: { lastUpdated: '2026-07-18T01:00:00Z' } } }] };
    const mock = (async (u: string) => { calledUrl = u; return { ok: true, status: 200, json: async () => bundle } as Response; }) as typeof fetch;
    const orders = await pollLabOrders(cfg, 'TOK', mock, 'active', '2026-07-18T00:00:00Z');
    expect(calledUrl).toContain('_lastUpdated=gt');
    expect(calledUrl).toContain('_count=');
    expect(orders[0].lastUpdated).toBe('2026-07-18T01:00:00Z');
  });
  it('커서 페이지네이션 — next link 따라 2페이지 병합', async () => {
    const page1 = { entry: [{ resource: { resourceType: 'ServiceRequest', id: 'p1a', category: [{ coding: [{ code: 'laboratory' }] }], code: { coding: [{ code: 'A' }] }, subject: { reference: 'Patient/x' } } }], link: [{ relation: 'next', url: 'https://his.example.org/fhir/R4/ServiceRequest?page=2' }] };
    const page2 = { entry: [{ resource: { resourceType: 'ServiceRequest', id: 'p2a', category: [{ coding: [{ code: 'laboratory' }] }], code: { coding: [{ code: 'B' }] }, subject: { reference: 'Patient/y' } } }] };
    let n = 0;
    const mock = (async () => { n++; return { ok: true, status: 200, json: async () => (n === 1 ? page1 : page2) } as Response; }) as typeof fetch;
    const orders = await pollLabOrders(cfg, 'TOK', mock);
    expect(orders.map((o) => o.orderId)).toEqual(['p1a', 'p2a']);
    expect(n).toBe(2);
  });
  it('타 오리진 next link는 따라가지 않음(토큰 유출 방지)', async () => {
    // HIS 응답이 지시하는 임의 호스트를 따라가면 Bearer 토큰을 외부로 재전송하게 된다.
    const page1 = { entry: [{ resource: { resourceType: 'ServiceRequest', id: 'p1a', category: [{ coding: [{ code: 'laboratory' }] }], code: { coding: [{ code: 'A' }] }, subject: { reference: 'Patient/x' } } }], link: [{ relation: 'next', url: 'https://evil.example/fhir/ServiceRequest?page=2' }] };
    let n = 0;
    const mock = (async () => { n++; return { ok: true, status: 200, json: async () => page1 } as Response; }) as typeof fetch;
    const orders = await pollLabOrders(cfg, 'TOK', mock);
    expect(orders.map((o) => o.orderId)).toEqual(['p1a']);
    expect(n).toBe(1); // 2페이지 요청 자체가 없어야 함
  });
  it('병리 오더(category PAT) → isPathology=true, 일반은 false', async () => {
    const bundle = {
      entry: [
        { resource: { resourceType: 'ServiceRequest', id: 'path1', category: [{ coding: [{ code: 'laboratory' }, { system: 'http://terminology.hl7.org/CodeSystem/v2-0074', code: 'PAT', display: 'Pathology' }] }], code: { coding: [{ code: 'C8511' }] }, subject: { reference: 'Patient/p', identifier: { system: 'urn:hospital-run:mrn', value: 'P2026-0001' } } } },
        { resource: { resourceType: 'ServiceRequest', id: 'lab1', category: [{ coding: [{ code: 'laboratory' }] }], code: { coding: [{ code: 'CRP' }] }, subject: { reference: 'Patient/p2' } } },
      ],
    };
    const mock = (async () => ({ ok: true, status: 200, json: async () => bundle }) as Response) as typeof fetch;
    const orders = await pollLabOrders(cfg, 'TOK', mock);
    const path = orders.find((o) => o.orderId === 'path1');
    const lab = orders.find((o) => o.orderId === 'lab1');
    expect(path?.isPathology).toBe(true);
    expect(path?.mrn).toBe('P2026-0001');
    expect(lab?.isPathology).toBe(false); // 병리는 LAB 폴링에 포함되나 PAT 없으면 일반
  });
});

describe('fetchPatientName (Patient.read → 실이름/폴백)', () => {
  it('name.text 우선 사용', async () => {
    const mock = (async () => ({ ok: true, status: 200, json: async () => ({ name: [{ text: '홍길동' }] }) }) as Response) as typeof fetch;
    expect(await fetchPatientName(cfg, 'TOK', 'Patient/p1', mock)).toBe('홍길동');
  });

  it('text 없으면 family+given 조합', async () => {
    const mock = (async () => ({ ok: true, status: 200, json: async () => ({ name: [{ family: '김', given: ['철수'] }] }) }) as Response) as typeof fetch;
    expect(await fetchPatientName(cfg, 'TOK', 'Patient/p2', mock)).toBe('김철수');
  });

  it('조회 실패(404)면 null 반환(호출측 폴백)', async () => {
    const mock = (async () => ({ ok: false, status: 404, json: async () => ({}) }) as Response) as typeof fetch;
    expect(await fetchPatientName(cfg, 'TOK', 'Patient/p3', mock)).toBeNull();
  });

  it('name 없으면 null', async () => {
    const mock = (async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response) as typeof fetch;
    expect(await fetchPatientName(cfg, 'TOK', 'Patient/p4', mock)).toBeNull();
  });
});

describe('postFhirResourceViaBundle (ServiceRequest → transaction Bundle)', () => {
  const sr = { resourceType: 'ServiceRequest', status: 'draft', identifier: [{ system: 'urn:lis:weve:reflex-order', value: 'RX-1' }] };

  it('entry 201 + location → ok·PreOrder id 해소(POST 단건)', async () => {
    const calls: { url: string; method: string }[] = [];
    const mock = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      expect(url).toBe('https://his.example.org/fhir/R4'); // base로만 POST
      const body = JSON.parse((init!.body as string));
      expect(body.resourceType).toBe('Bundle');
      expect(body.entry[0].request).toEqual({ method: 'POST', url: 'ServiceRequest' });
      return ({ ok: true, status: 201, json: async () => ({ entry: [{ response: { status: '201 Created', location: 'ServiceRequest/his-sr-99/_history/1' } }] }) }) as Response;
    }) as unknown as typeof fetch;
    const r = await postFhirResourceViaBundle(cfg, 'TOK', sr, mock);
    expect(r.ok).toBe(true);
    expect(r.id).toBe('his-sr-99');
    expect(calls).toHaveLength(1); // identifier 우회 없음(오결속 방지)
  });

  it('⚠️ 외부 201이어도 entry가 422면 실패(조용한 성공 방지)', async () => {
    const mock = (async () => ({ ok: true, status: 201, json: async () => ({ entry: [{ response: { status: '422 Unprocessable Entity' }, resource: { resourceType: 'DocumentReference', description: 'Bad Request Exception' } }] }) }) as Response) as unknown as typeof fetch;
    const r = await postFhirResourceViaBundle(cfg, 'TOK', sr, mock);
    expect(r.ok).toBe(false);
    expect(r.id).toBeNull();
  });

  it('entry 2xx인데 location 없으면 ok·id=null(우회 없음)', async () => {
    const mock = (async () => ({ ok: true, status: 201, json: async () => ({ entry: [{ response: { status: '200 OK' } }] }) }) as Response) as unknown as typeof fetch;
    const r = await postFhirResourceViaBundle(cfg, 'TOK', sr, mock);
    expect(r.ok).toBe(true);
    expect(r.id).toBeNull();
  });

  it('외부 400이면 ok=false·id=null', async () => {
    const mock = (async () => ({ ok: false, status: 400, json: async () => ({}) }) as Response) as unknown as typeof fetch;
    const r = await postFhirResourceViaBundle(cfg, 'TOK', sr, mock);
    expect(r.ok).toBe(false);
    expect(r.id).toBeNull();
  });
});
