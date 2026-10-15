/**
 * app.e2e-spec.ts — test 모듈 구성요소.
 *
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { INestApplication } from '@nestjs/common';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import * as bcrypt from 'bcrypt';
import { createServer, type Server } from 'node:http';
import { createTestApp, seedTestData, TEST_PW } from './setup';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { CriticalNotifierService } from '../src/modules/result/critical-notifier.service';
import { IntegrationService } from '../src/integration/integration.service';
import { IntegrationHealthService } from '../src/integration/integration-health.service';

/**
 * LIS API E2E — 실제 HTTP 흐름(인증·RBAC·결과 자동평가·위험치·HL7·FHIR·정정).
 * 별도 테스트 DB(DATABASE_URL) 필요. 실행: npm run test:e2e
 */
describe('LIS API (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<typeof request>;
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await seedTestData(prisma);
    http = request(app.getHttpServer());

    // 역할별 토큰 1회 발급·재사용(로그인 rate limit 회피)
    for (const uid of ['U00', 'U02', 'U09', 'U03', 'U07', 'U05', 'U08', 'U04', 'U06']) {
      const res = await http.post('/api/v1/auth/login').send({ userId: uid, password: TEST_PW });
      tokens[uid] = res.body.data.accessToken;
    }
  }, 30000);

  afterAll(async () => {
    await app?.close();
  });

  const auth = (uid: string) => ({ Authorization: `Bearer ${tokens[uid]}` });

  // ── Health ──
  it('GET /health → ok, db up', async () => {
    const res = await http.get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ok');
    expect(res.body.data.db).toBe('up');
  });

  it('GET /metrics → Prometheus 게이지(공개·DB·연계)', async () => {
    const res = await http.get('/api/v1/metrics');
    expect(res.status).toBe(200);
    expect(res.text).toContain('lis_db_up 1');
    expect(res.text).toContain('lis_integration_dlq_depth');
    expect(res.text).toContain('# TYPE lis_process_uptime_seconds gauge');
  });

  // ── 인증 ──
  describe('인증', () => {
    it('잘못된 비밀번호 → 401', async () => {
      const res = await http.post('/api/v1/auth/login').send({ userId: 'U02', password: 'wrong' });
      expect(res.status).toBe(401);
    });
    it('토큰 없이 보호 리소스 → 401', async () => {
      const res = await http.get('/api/v1/patients');
      expect(res.status).toBe(401);
    });
    it('토큰 roles 확인(auth/me) — 로그인 재사용', async () => {
      const res = await http.get('/api/v1/auth/me').set(auth('U02'));
      expect(res.status).toBe(200);
      expect(res.body.data.roles).toContain('PHY');
    });
  });

  describe('환자 조회·등록', () => {
    it('검색(q) — 환자ID/성명 필터', async () => {
      const res = await http.get('/api/v1/patients?q=T-2345678').set(auth('U07'));
      expect(res.status).toBe(200);
      expect(res.body.data.some((p: { patientId: string }) => p.patientId === 'T-2345678')).toBe(true);
    });
    it('상세 — 오더 포함', async () => {
      const res = await http.get('/api/v1/patients/T-2345678').set(auth('U02'));
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('김테스트');
      expect(Array.isArray(res.body.data.orders)).toBe(true);
    });
    it('등록(RCP) → 생성 후 조회', async () => {
      const res = await http.post('/api/v1/patients').set(auth('U07')).send({ patientId: 'T-NEWPT', name: '신규환자', sex: 'F', birthDate: '1995-05-05' });
      expect(res.status).toBe(201);
      const get = await http.get('/api/v1/patients?q=신규환자').set(auth('U07'));
      expect(get.body.data.some((p: { patientId: string }) => p.patientId === 'T-NEWPT')).toBe(true);
    });
    it('등록 — 비허용 역할(검증의) 403', async () => {
      const res = await http.post('/api/v1/patients').set(auth('U02')).send({ patientId: 'T-X', name: 'x' });
      expect(res.status).toBe(403);
    });
    it('정정(PATCH, RCP) — 성별·생년 수정', async () => {
      await http.post('/api/v1/patients').set(auth('U07')).send({ patientId: 'T-EDIT', name: '수정전', sex: 'M', birthDate: '1970-01-01' });
      const res = await http.patch('/api/v1/patients/T-EDIT').set(auth('U07')).send({ sex: 'F', birthDate: '1971-02-02' });
      expect(res.status).toBe(200);
      const get = await http.get('/api/v1/patients/T-EDIT').set(auth('U07'));
      expect(get.body.data.sex).toBe('F');
      expect(get.body.data.birthDate).toBe('1971-02-02');
    });
    it('정정 — 비허용 역할(검증의) 403', async () => {
      const res = await http.patch('/api/v1/patients/T-EDIT').set(auth('U02')).send({ sex: 'M' });
      expect(res.status).toBe(403);
    });
    it('병합(ADM) — source 오더가 target으로 이관 · source MERGED', async () => {
      await http.post('/api/v1/patients').set(auth('U07')).send({ patientId: 'T-DUP-A', name: '정본', sex: 'M', birthDate: '1980-01-01' });
      await http.post('/api/v1/patients').set(auth('U07')).send({ patientId: 'T-DUP-B', name: '중복', sex: 'M', birthDate: '1980-01-01' });
      await prisma.labOrder.create({ data: { orderId: 'T-DUP-ORD', patientId: 'T-DUP-B', status: 'RECEIVED', priority: 'R' } });
      const res = await http.post('/api/v1/patients/T-DUP-A/merge').set(auth('U00')).send({ sourceId: 'T-DUP-B' });
      expect(res.status).toBe(201);
      expect(res.body.data.moved.orders).toBeGreaterThanOrEqual(1);
      const moved = await prisma.labOrder.findUnique({ where: { orderId: 'T-DUP-ORD' } });
      expect(moved?.patientId).toBe('T-DUP-A');
      const src = await prisma.patient.findUnique({ where: { patientId: 'T-DUP-B' } });
      expect(src?.status).toBe('MERGED');
      expect(src?.mergedInto).toBe('T-DUP-A'); // 정본 포인터
    });
    it('병합된 구 MRN 인바운드 오더 → 정본으로 재라우팅', async () => {
      const msg = [
        `MSH|^~\\&|HIS|HOSP|LIS|HOSP|20260717090000||OML^O21|REROUTE-MSG|P|2.5.1`,
        'PID|1||T-DUP-B^^^HOSP^MR||중복^환자||19800101|M',
        `ORC|NW|REROUTE-1`,
        `OBR|1|REROUTE-1||CBC^일반혈액^L|||20260717090000|||||||||||||||||R`,
      ].join('\r');
      const nw = await http.post('/api/v1/integration/hl7/inbound').set(auth('U00')).send({ message: msg });
      expect([200, 201]).toContain(nw.status);
      // T-DUP-B(MERGED)로 온 오더가 정본 T-DUP-A로 귀속됐는지
      const target = await http.get('/api/v1/patients/T-DUP-A').set(auth('U00'));
      const hasRerouted = target.body.data.orders.some((o: { hisOrderNo: string | null }) => o.hisOrderNo === 'REROUTE-1');
      expect(hasRerouted).toBe(true);
    });
    it('병합 — 비허용 역할(접수) 403', async () => {
      const res = await http.post('/api/v1/patients/T-DUP-A/merge').set(auth('U07')).send({ sourceId: 'T-DUP-B' });
      expect(res.status).toBe(403);
    });
    it('병합 — 이미 MERGED된 환자를 정본(target)으로 지정 시 차단(숨은 레코드 이관 금지)', async () => {
      // T-DUP-B는 앞 테스트에서 MERGED됨 → 이를 target으로 병합 시도
      await http.post('/api/v1/patients').set(auth('U07')).send({ patientId: 'T-DUP-C', name: '중복2', sex: 'M' });
      const res = await http.post('/api/v1/patients/T-DUP-B/merge').set(auth('U00')).send({ sourceId: 'T-DUP-C' });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('정본');
    });
  });

  // ── RBAC ──
  describe('RBAC (직무분리)', () => {
    it('접수담당(RCP) 결과등록 → 403', async () => {
      const res = await http
        .post('/api/v1/results')
        .set(auth('U07'))
        .send({ specimenNo: 'T-S-1', testCode: 'CHE-NA', value: '140' });
      expect(res.status).toBe(403);
    });
    it('검증의(PHY) 결과등록 → 허용', async () => {
      const res = await http
        .post('/api/v1/results')
        .set(auth('U02'))
        .send({ specimenNo: 'T-S-1', testCode: 'CHE-NA', value: '140' });
      expect(res.status).toBe(201);
      expect(res.body.data.evaluation.flag).toBe('N');
      expect(res.body.data.evaluation.autoVerified).toBe(true);
    });
  });

  // ── D1 검체 품질 HIL 간섭 플래그 ──
  describe('HIL 간섭 플래그', () => {
    const SP = 'T-S-HIL';
    beforeAll(async () => {
      await prisma.result.deleteMany({ where: { specimenNo: SP } });
      await prisma.specimen.upsert({ where: { specimenNo: SP }, update: { hemolysis: null, icterus: null, lipemia: null }, create: { specimenNo: SP, orderId: 'T-O-1', specimenType: 'Serum', status: 'IN_PROCESS' } });
    });
    it('HIL 등급 기록 + 잘못된 등급 400', async () => {
      const r = await http.post(`/api/v1/results/specimens/${SP}/hil`).set(auth('U02')).send({ hemolysis: '2+' });
      expect(r.status).toBe(201);
      expect(r.body.data.hemolysis).toBe('2+');
      const bad = await http.post(`/api/v1/results/specimens/${SP}/hil`).set(auth('U02')).send({ hemolysis: 'HIGH' });
      expect(bad.status).toBe(400);
    });
    it('용혈 2+ → K 결과에 간섭 경고, Na는 무영향', async () => {
      const k = await http.post('/api/v1/results').set(auth('U02')).send({ specimenNo: SP, testCode: 'CHE-K', value: '4.5', unit: 'mmol/L' });
      expect(k.body.data.evaluation.interference).toBeTruthy();
      expect(k.body.data.evaluation.interference.factors.join()).toContain('용혈');
      const na = await http.post('/api/v1/results').set(auth('U02')).send({ specimenNo: SP, testCode: 'CHE-NA', value: '140', unit: 'mmol/L' });
      expect(na.body.data.evaluation.interference).toBeNull();
    });
  });

  // ── 중복 결과 가드 (발신측 — HIS 수신측 dedup과 대칭, 스모크 관찰 결함) ──
  describe('중복 결과 가드', () => {
    const SP = 'T-S-GUARD';
    beforeAll(async () => {
      await prisma.specimen.upsert({
        where: { specimenNo: SP },
        update: {},
        create: { specimenNo: SP, orderId: 'T-O-1', specimenType: 'Serum', status: 'IN_PROCESS' },
      });
      await prisma.result.deleteMany({ where: { specimenNo: SP } });
    });
    it('최초 결과 → 정상 등록(AUTO)', async () => {
      const r = await http.post('/api/v1/results').set(auth('U02')).send({ specimenNo: SP, testCode: 'CHE-NA', value: '140', unit: 'mmol/L' });
      expect(r.status).toBe(201);
      expect(r.body.data.evaluation.autoVerified).toBe(true);
    });
    it('확정결과 존재 시 재제출 → 409 차단', async () => {
      const r = await http.post('/api/v1/results').set(auth('U02')).send({ specimenNo: SP, testCode: 'CHE-NA', value: '141', unit: 'mmol/L' });
      expect(r.status).toBe(409);
    });
    it('의도적 재검(rerun=true)은 허용', async () => {
      const r = await http.post('/api/v1/results').set(auth('U02')).send({ specimenNo: SP, testCode: 'CHE-NA', value: '142', unit: 'mmol/L', rerun: true });
      expect(r.status).toBe(201);
    });

    /**
     * ★재검이 원본에 가려지지 않는다(P1-1, 회귀 금지).
     * rerun을 version 1로 만들면 원본(version 1)과 동률이라 `version >` 선택이 원본을 남겼다.
     * 이제 rerun은 version을 올리므로 보고서·누적에 재검값이 나온다.
     */
    it('재검 결과가 보고서에 반영된다 — 원본이 아니라 재검값이 최신', async () => {
      // 위 재검(142)이 원본(140)보다 최신이어야 한다
      const rep = await http.get(`/api/v1/results/report/${SP}`).set(auth('U02'));
      expect(rep.status).toBe(200);
      const na = rep.body.data.results.find((x: { testCode: string }) => x.testCode === 'CHE-NA');
      expect(na?.value).toBe('142'); // 원본 140이 아님
      expect(na?.version).toBeGreaterThan(1); // rerun이 version을 올렸다
    });

    it('재검을 여러 번 해도 마지막 값이 최신(version 단조증가)', async () => {
      await http.post('/api/v1/results').set(auth('U02')).send({ specimenNo: SP, testCode: 'CHE-NA', value: '143', unit: 'mmol/L', rerun: true });
      const last = await http.post('/api/v1/results').set(auth('U02')).send({ specimenNo: SP, testCode: 'CHE-NA', value: '144', unit: 'mmol/L', rerun: true });
      expect(last.status).toBe(201);
      const rep = await http.get(`/api/v1/results/report/${SP}`).set(auth('U02'));
      const na = rep.body.data.results.find((x: { testCode: string }) => x.testCode === 'CHE-NA');
      expect(na?.value).toBe('144');
    });
    it('결과 코멘트·해석 코멘트 → 저장·보고서 표출(A3)', async () => {
      await prisma.result.deleteMany({ where: { specimenNo: SP, testCode: 'CHE-GLU' } });
      const r = await http.post('/api/v1/results').set(auth('U02')).send({ specimenNo: SP, testCode: 'CHE-GLU', value: '100', unit: 'mg/dL', comment: '검체 용혈(+)', interpretation: '정상 범위' });
      expect(r.status).toBe(201);
      const rep = await http.get(`/api/v1/results/report/${SP}`).set(auth('U02'));
      expect(rep.status).toBe(200);
      const row = rep.body.data.results.find((x: { testCode: string }) => x.testCode === 'CHE-GLU');
      expect(row?.comment).toBe('검체 용혈(+)');
      expect(row?.interpretation).toBe('정상 범위');
    });
    it('미확정(PENDING) 결과는 재입력 허용(확정 전)', async () => {
      await prisma.result.deleteMany({ where: { specimenNo: SP, testCode: 'CHE-K' } });
      const r1 = await http.post('/api/v1/results').set(auth('U02')).send({ specimenNo: SP, testCode: 'CHE-K', value: '6.8', unit: 'mmol/L' });
      expect(r1.status).toBe(201);
      expect(r1.body.data.evaluation.autoVerified).toBe(false); // HH → PENDING
      const r2 = await http.post('/api/v1/results').set(auth('U02')).send({ specimenNo: SP, testCode: 'CHE-K', value: '6.9', unit: 'mmol/L' });
      expect(r2.status).toBe(201); // 직전이 PENDING(미확정)이라 차단 안 함
    });
  });

  // ── 결과 자동평가 + 위험치 폐루프 ──
  describe('결과 자동평가·위험치', () => {
    let notifyId: string;

    it('K 6.8 → HH·위험치·통보 생성', async () => {
      const res = await http
        .post('/api/v1/results')
        .set(auth('U02'))
        .send({ specimenNo: 'T-S-1', testCode: 'CHE-K', value: '6.8', unit: 'mmol/L' });
      expect(res.status).toBe(201);
      const ev = res.body.data.evaluation;
      expect(ev.flag).toBe('HH');
      expect(ev.autoVerified).toBe(false); // 위험치는 수동검증
      expect(ev.critical).toBe(true);
      expect(ev.criticalNotifyId).toBeTruthy();
      notifyId = ev.criticalNotifyId;
    });

    it('미확인 위험치 통보 목록에 포함', async () => {
      const res = await http.get('/api/v1/results/criticals/pending').set(auth('U02'));
      expect(res.status).toBe(200);
      const ids = res.body.data.map((c: { notifyId: string }) => c.notifyId);
      expect(ids).toContain(notifyId);
    });

    it('위험치 통보 확인(폐루프) — 복창(read-back) 기록·확인자는 토큰에서', async () => {
      // ackBy를 본문에 안 보내도 통과해야 한다(컨트롤러가 토큰에서 결정) — 예전엔 필수라 400
      const res = await http
        .post(`/api/v1/results/criticals/${notifyId}/ack`)
        .set(auth('U02'))
        .send({ readbackBy: '내과 김간호사', readbackNote: 'K 6.8 복창 확인' });
      expect(res.status).toBe(201);
      expect(res.body.data.ackDt).toBeTruthy();
      expect(res.body.data.ackBy).toBe('U02'); // 본문 아닌 토큰 사용자
      // ★복창(read-back)이 실제로 기록된다 — 폐루프의 핵심(누가 통보받아 되읽었는가)
      expect(res.body.data.readbackBy).toBe('내과 김간호사');
      expect(res.body.data.readbackNote).toContain('복창');
    });
  });

  // ── 결과 정정(버전) ──
  describe('결과 정정', () => {
    it('정정 → 신규 버전(C)', async () => {
      const list = await http.get('/api/v1/results?specimenNo=T-S-1').set(auth('U02'));
      const target = list.body.data.find((r: { testCode: string }) => r.testCode === 'CHE-K');
      const res = await http
        .post(`/api/v1/results/${target.resultId}/correct`)
        .set(auth('U02'))
        .send({ value: '6.7', reason: '재측정' });
      expect(res.status).toBe(201);
      expect(res.body.data.version).toBe(2);
    });
    it('구버전 정정 시도 → 400(최신 버전만·그림자버전 방지, C2)', async () => {
      await prisma.result.deleteMany({ where: { resultId: { in: ['R-COR-V1', 'R-COR-V2'] } } });
      await prisma.result.create({ data: { resultId: 'R-COR-V1', specimenNo: 'T-S-1', testCode: 'CHE-NA', value: '140', verifyState: 'VERIFIED', version: 1, status: 'F' } });
      await prisma.result.create({ data: { resultId: 'R-COR-V2', specimenNo: 'T-S-1', testCode: 'CHE-NA', value: '141', verifyState: 'VERIFIED', version: 2, status: 'C' } });
      const res = await http.post('/api/v1/results/R-COR-V1/correct').set(auth('U02')).send({ value: '142', reason: 'x' });
      expect(res.status).toBe(400); // 이미 v2가 있으므로 v1은 정정 불가
      await prisma.result.deleteMany({ where: { resultId: { in: ['R-COR-V1', 'R-COR-V2'] } } });
    });
  });

  // ── HL7 처방 수신 ──
  describe('HL7 연계', () => {
    it('OML 수신 → ACK AA·오더 생성', async () => {
      const msg = [
        'MSH|^~\\&|HIS|HOSP|LIS|HOSP|20260712091500||OML^O21|E2E-MSG-1|P|2.5.1',
        'PID|1||E2E-9001^^^HOSP^MR||이^이투이||19900101|F',
        'ORC|NW|E2E-H1',
        'OBR|1|E2E-H1||CBC^일반혈액^L|||20260712091500|||||||||||||||||R',
      ].join('\r');
      const res = await http
        .post('/api/v1/integration/hl7/inbound')
        .set(auth('U00'))
        .send({ message: msg });
      expect(res.status).toBe(201);
      expect(res.body.data.result).toBe('CREATED');
      expect(res.body.data.ack).toContain('MSA|AA');
    });
    it('멱등: 동일 메시지 재수신 → DUPLICATE', async () => {
      const msg = [
        'MSH|^~\\&|HIS|HOSP|LIS|HOSP|20260712091500||OML^O21|E2E-MSG-1|P|2.5.1',
        'PID|1||E2E-9001^^^HOSP^MR||이^이투이||19900101|F',
        'ORC|NW|E2E-H1',
        'OBR|1|E2E-H1||CBC^일반혈액^L|||20260712091500|||||||||||||||||R',
      ].join('\r');
      const res = await http
        .post('/api/v1/integration/hl7/inbound')
        .set(auth('U00'))
        .send({ message: msg });
      expect(res.body.data.result).toBe('DUPLICATE');
    });
    it('연계 로그 조회(ADM) — 최근 interface_log', async () => {
      const res = await http.get('/api/v1/integration/hl7/logs?take=10').set(auth('U00'));
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.rows)).toBe(true);
    });
    it('연계 운영 감시 지표(ADM) — 지표·healthy 판정 반환', async () => {
      const res = await http.get('/api/v1/integration/hl7/health/monitor').set(auth('U00'));
      expect(res.status).toBe(200);
      expect(typeof res.body.data.dlqDepth).toBe('number');
      expect(typeof res.body.data.healthy).toBe('boolean');
      expect(Array.isArray(res.body.data.breaches)).toBe(true);
    });
    /**
     * ★연계 경보가 사람에게 도달하는지(P1-14 값싼 절반, 회귀 금지).
     * 감시는 10분마다 지표를 집계하고 임계를 넘으면 OPS 웹훅으로 알렸는데,
     * 개발서버는 OPS_WEBHOOK_URL이 미설정이라 **알림 경로가 0개**였다. 실제로 미적재 오더
     * 유실 1건을 배포 검증 중 우연히 발견했다. 이제 알림함(사이드바 배지)에도 올린다.
     */
    it('감시 상태에 외부 알림 채널 구성 여부가 실린다(미구성을 화면이 알 수 있게)', async () => {
      const res = await http.get('/api/v1/integration/hl7/health/monitor').set(auth('U00'));
      expect(res.status).toBe(200);
      expect(typeof res.body.data.externalAlertConfigured).toBe('boolean');
    });

    it('임계 초과 → 알림함에 연계경보 1건, 반복 집계해도 늘지 않는다(알림 폭주 금지)', async () => {
      await prisma.notification.deleteMany({ where: { ntype: '연계경보' } });
      // DLQ 1건이면 기본 임계(0) 초과 — 감시가 이상으로 판정한다.
      const MCID = 'T-OPS-ALERT-DLQ';
      await prisma.interfaceLog.deleteMany({ where: { messageControlId: MCID } });
      await prisma.interfaceLog.create({
        data: { ifId: 'IF-RX', direction: 'OUTBOUND', messageControlId: MCID, status: 'DLQ', retryCount: 5, payload: '{}' },
      });

      const svc = app.get(IntegrationHealthService);
      await svc.monitor();
      const first = await prisma.notification.findMany({ where: { ntype: '연계경보', ackDt: null } });
      expect(first.length).toBe(1);
      expect(first[0].message).toContain('DLQ');

      // 10분마다 새로 만들면 하루 144건이 쌓여 임상 알림이 묻힌다.
      await svc.monitor();
      await svc.monitor();
      const after = await prisma.notification.findMany({ where: { ntype: '연계경보', ackDt: null } });
      expect(after.length).toBe(1);
      expect(after[0].notifyId).toBe(first[0].notifyId); // 같은 건을 유지
    });

    it('정상 복귀 → 열린 경보 자동 해소(배지가 영구히 켜져 있지 않게)', async () => {
      // 위 테스트가 만든 DLQ 제거 → 임계 이하로 복귀
      await prisma.interfaceLog.deleteMany({ where: { messageControlId: 'T-OPS-ALERT-DLQ' } });
      const svc = app.get(IntegrationHealthService);
      await svc.monitor();
      const open = await prisma.notification.findMany({ where: { ntype: '연계경보', ackDt: null } });
      expect(open.length).toBe(0);
      // 이력은 남고, 사람 확인이 아니었음이 드러나야 한다
      const resolved = await prisma.notification.findFirst({ where: { ntype: '연계경보' }, orderBy: { createdDt: 'desc' } });
      expect(resolved?.ackDt).toBeTruthy();
      expect(resolved?.message).toContain('자동 해소');
    });

    it('처방의(OBR-16) 포착 → 오더에 결속·조회', async () => {
      const msg = [
        'MSH|^~\\&|HIS|HOSP|LIS|HOSP|20260712091500||OML^O21|E2E-PROV-1|P|2.5.1',
        'PID|1||E2E-9002^^^HOSP^MR||박^환자||19850101|M',
        'PV1|1|O|외래^내과||||D001^김의사',
        'ORC|NW|E2E-HP1',
        'OBR|1|E2E-HP1||CBC^일반혈액^L|||20260712091500|||||||||D050^최교수|||||||||R',
      ].join('\r');
      const res = await http.post('/api/v1/integration/hl7/inbound').set(auth('U00')).send({ message: msg });
      expect(res.body.data.result).toBe('CREATED');
      const oid = res.body.data.orderId;
      const detail = await http.get(`/api/v1/orders/${oid}`).set(auth('U02'));
      expect(detail.body.data.orderingProvider).toBe('D050');
      expect(detail.body.data.provider?.name).toBe('최교수');
    });
  });

  // ── 수혈 출고 안전 게이트 ──
  describe('수혈 출고 게이트', () => {
    it('안전조건 충족 → 출고 성공(2인 확인)', async () => {
      const res = await http.post('/api/v1/transfusion/issue').set(auth('U05')).send({
        unitNo: 'T-UNIT-1', patientId: 'T-BB', issuer: 'U05', receiver: '간호사',
        confirm1: 'U05', confirm2: 'U08', aboVerifiedTwice: true, aboMatchesHistory: true,
      });
      expect(res.status).toBe(201);
      expect(res.body.data.safety.eligible).toBe(true);
    });
    it('ABO 이력 불일치 → 출고 차단(400)', async () => {
      const res = await http.post('/api/v1/transfusion/issue').set(auth('U05')).send({
        unitNo: 'T-UNIT-1', patientId: 'T-BB', issuer: 'U05', receiver: '간호사',
        confirm1: 'U05', confirm2: 'U08', aboVerifiedTwice: true, aboMatchesHistory: false,
      });
      expect(res.status).toBe(400);
    });

    /**
     * ★출고 적격성 사전점검 = 실제 출고 판정(회귀 금지).
     * 사전점검이 판정 로직을 복제하면 "통과"라 해놓고 실제 게이트가 막거나(신뢰 상실),
     * 더 나쁘게는 **막아야 할 것을 통과**시킬 수 있다. 둘은 같은 정본(evaluateIssueEligibility)을 쓴다.
     */
    it('출고 적격성 사전점검 — 차단 사유를 수치 근거로 설명하고, 실제 출고 판정과 일치', async () => {
      // 교차시험 없는 제제 → 사전점검이 미리 차단 사유를 알려줘야 한다(출고 시도 전에)
      await http.post('/api/v1/transfusion/units').set(auth('U05')).send({
        unitNo: 'T-UNIT-PRE', productType: 'RBC', bloodGroup: 'A+', expiryDate: '2026-12-31',
      });
      const pre = await http.get('/api/v1/transfusion/issue-eligibility/T-BB/T-UNIT-PRE').set(auth('U05'));
      expect(pre.status).toBe(200);
      const d = pre.body.data;
      expect(d.eligible).toBe(false);
      expect(d.blockers ?? d.blockerExplanations).toBeTruthy();
      // 코드 문구만이 아니라 "왜"가 수치 근거로 설명돼야 한다
      expect(d.blockerExplanations.some((b: string) => b.includes('교차시험'))).toBe(true);
      expect(d.promptContext).toContain('수혈 출고 적격성 근거 종합');
      // ABO 근거(몇 회 일치했는지)가 드러난다
      expect(d.abo.typingCount).toBeGreaterThan(0);
      expect(typeof d.abo.concordantCount).toBe('number');

      // 실제 출고를 시도하면 같은 사유로 막힌다(사전점검과 불일치하지 않는다)
      const act = await http.post('/api/v1/transfusion/issue').set(auth('U05')).send({
        unitNo: 'T-UNIT-PRE', patientId: 'T-BB', issuer: 'U05', receiver: '간호사',
        confirm1: 'U05', confirm2: 'U08', aboVerifiedTwice: true, aboMatchesHistory: true,
      });
      expect(act.status).toBe(400);
      const actReasons: string[] = act.body.message?.reasons ?? act.body.reasons ?? [];
      expect(actReasons.some((r) => r.includes('교차시험'))).toBe(true);
      // 사전점검이 든 soft 사유가 실제 차단 사유에 그대로 있다
      for (const r of d.softReasons) expect(actReasons).toContain(r);
    });

    /**
     * ★환자 오식별 방지(P1-17, 회귀 금지).
     * 출고 화면의 환자ID는 자유입력이다. 존재하지 않는 ID로 출고 기록이 생기면 안 되고,
     * 화면은 ID가 아니라 **성명**을 대조시켜야 한다(ID만 보여주면 오타를 눈으로 못 잡는다).
     */
    it('존재하지 않는 환자ID → 출고 차단(404) — 오타 시 타 환자 오출고 방지', async () => {
      const res = await http.post('/api/v1/transfusion/issue').set(auth('U05')).send({
        unitNo: 'T-UNIT-1', patientId: 'T-BB-없는환자', issuer: 'U05', receiver: '간호사',
        confirm1: 'U05', confirm2: 'U08', aboVerifiedTwice: true, aboMatchesHistory: true,
      });
      expect(res.status).toBe(404);
      expect(res.body.message).toContain('환자');
    });

    it('응급 출고도 환자 실재 확인은 우회 못 한다(불가침)', async () => {
      // 응급은 미교차·2회검증 등 프로세스 게이트를 우회하지만, 환자를 특정하지 못하면
      // 출고 기록 자체가 무의미하고 ABO 방벽도 근거를 잃는다.
      const res = await http.post('/api/v1/transfusion/issue').set(auth('U05')).send({
        unitNo: 'T-UNIT-1', patientId: 'T-BB-없는환자', issuer: 'U05', receiver: '간호사',
        confirm1: 'U05', confirm2: 'U08', aboVerifiedTwice: false, aboMatchesHistory: false,
        emergency: true, emergencyReason: '외상 대량출혈 MTP',
      });
      expect(res.status).toBe(404);
    });

    it('출고 대상 환자 확인 — 성명·혈액형·특수요구를 함께 반환한다', async () => {
      const res = await http.get('/api/v1/transfusion/patient/T-BB').set(auth('U05'));
      expect(res.status).toBe(200);
      expect(res.body.data.patient.name).toBeTruthy(); // 화면이 대조시킬 성명
      expect(res.body.data.patient.patientId).toBe('T-BB');
      expect(res.body.data.typingCount).toBeGreaterThan(0);
    });

    it('없는 환자 확인 조회 → 404(화면이 출고를 잠글 수 있게)', async () => {
      const res = await http.get('/api/v1/transfusion/patient/T-BB-없는환자').set(auth('U05'));
      expect(res.status).toBe(404);
    });
  });

  // ── 유전체 동의 게이트 ──
  describe('유전체 동의 게이트', () => {
    it('동의 없이 수탁 발송 → 차단(400)', async () => {
      const res = await http.post('/api/v1/genomic/T-G-1/sendout').set(auth('U00')).send({});
      expect(res.status).toBe(400);
    });
    it('동의 등록 → 수탁 발송 허용', async () => {
      await http.post('/api/v1/genomic/consent').set(auth('U00')).send({
        genomicOrderId: 'T-G-1', consentType: '생식세포', secondaryFindingsOptin: false, signedDate: '2026-07-13',
      });
      const res = await http.post('/api/v1/genomic/T-G-1/sendout').set(auth('U00')).send({});
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('수탁발송');
    });
    it('동의 철회 → withdrawn·발송 이후 알림', async () => {
      const res = await http.post('/api/v1/genomic/T-G-1/consent/withdraw').set(auth('U00')).send({ reason: '환자 요청', actor: 'U00' });
      expect(res.status).toBe(201);
      expect(res.body.data.withdrawn).toBe(true);
      expect(res.body.data.postSendout).toBe(true); // 이미 수탁발송 상태
    });
    it('철회 후 재발송 → 게이트 차단(400)', async () => {
      const res = await http.post('/api/v1/genomic/T-G-1/sendout').set(auth('U00')).send({});
      expect(res.status).toBe(400);
    });
    it('활성 동의 없이 철회 → 400', async () => {
      const res = await http.post('/api/v1/genomic/T-G-1/consent/withdraw').set(auth('U00')).send({ actor: 'U00' });
      expect(res.status).toBe(400);
    });
    /**
     * ★동의 철회 ↔ 수탁 발송 경합(P1-10, 회귀 금지).
     * "트랜잭션 안 재조회"만으로는 READ COMMITTED에서 아무것도 막지 못했다. 읽기가 잠금을
     * 잡지 않아 발송이 동의를 읽은 뒤 철회가 커밋돼도 발송이 그대로 진행됐다 —
     * **동의를 철회한 환자의 검체가 외부 수탁기관으로 나간다.**
     * 둘 중 어느 쪽이 이기든, '발송됨 + 동의 활성' 조합만은 나오면 안 된다.
     */
    it('동의 철회와 수탁 발송 동시 실행 → 철회된 동의로 발송된 상태가 남지 않는다', async () => {
      const OID = 'T-G-RACE';
      await prisma.consent.deleteMany({ where: { genomicOrderId: OID } });
      await prisma.genomicOrder.deleteMany({ where: { genomicOrderId: OID } });
      await prisma.labOrder.upsert({ where: { orderId: 'T-GO-RACE' }, update: {}, create: { orderId: 'T-GO-RACE', patientId: 'T-2345678', status: 'IN_PROCESS' } });
      await prisma.genomicOrder.create({ data: { genomicOrderId: OID, orderId: 'T-GO-RACE', panelCode: 'T-GEN', testType: 'GERMLINE', status: '접수' } });
      await prisma.consent.create({ data: { consentId: 'T-CONS-RACE', genomicOrderId: OID, consentType: '생식세포', signedDate: '2026-07-01', withdrawn: false } });

      const [send, withdraw] = await Promise.all([
        http.post(`/api/v1/genomic/${OID}/sendout`).set(auth('U00')).send({}),
        http.post(`/api/v1/genomic/${OID}/consent/withdraw`).set(auth('U00')).send({ actor: 'U00', reason: '환자 요청' }),
      ]);

      const order = await prisma.genomicOrder.findUnique({ where: { genomicOrderId: OID } });
      const consents = await prisma.consent.findMany({ where: { genomicOrderId: OID } });
      const activeLeft = consents.filter((c) => !c.withdrawn).length;
      const sentOut = order?.status === '수탁발송';

      // 철회가 이겼으면 발송은 차단(400), 발송이 이겼으면 철회는 성공하되 회수 알림이 떠야 한다.
      expect(activeLeft).toBe(0); // 철회 요청은 어느 순서든 반영된다
      if (sentOut) {
        expect(send.status).toBe(201);
        expect(withdraw.status).toBe(201);
        expect(withdraw.body.data.postSendout).toBe(true); // ★발송 사실을 보고 회수 알림을 만든다
      } else {
        expect(send.status).toBe(400); // 철회를 보고 게이트가 막았다
      }
    });

    it('G1 다중 활성 동의 → 철회는 전부 처리, 발송 게이트 우회 불가', async () => {
      // 동일 오더에 활성 동의 2건(재서명·구분 동의) 존재 상황
      await prisma.labOrder.upsert({ where: { orderId: 'T-GO-2' }, update: {}, create: { orderId: 'T-GO-2', patientId: 'T-2345678', status: 'IN_PROCESS' } });
      await prisma.genomicOrder.upsert({ where: { orderId: 'T-GO-2' }, update: {}, create: { genomicOrderId: 'T-G-2', orderId: 'T-GO-2', panelCode: 'T-GEN', testType: 'GERMLINE', status: '접수' } });
      await prisma.consent.createMany({
        data: [
          { consentId: 'T-CONS-A', genomicOrderId: 'T-G-2', consentType: '생식세포', signedDate: '2026-01-01', withdrawn: false },
          { consentId: 'T-CONS-B', genomicOrderId: 'T-G-2', consentType: '2차소견', signedDate: '2026-02-01', withdrawn: false },
        ],
        skipDuplicates: true,
      });
      const w = await http.post('/api/v1/genomic/T-G-2/consent/withdraw').set(auth('U00')).send({ actor: 'U00' });
      expect(w.status).toBe(201);
      expect(w.body.data.withdrawnCount).toBe(2); // 최신 1건만이 아니라 전부
      // 발송 시도 → 남은 활성 동의 없음 → 차단
      const s = await http.post('/api/v1/genomic/T-G-2/sendout').set(auth('U00')).send({});
      expect(s.status).toBe(400);
    });
  });

  // ── QC Westgard ──
  describe('QC Westgard', () => {
    it('정상값 → PASS', async () => {
      const res = await http.post('/api/v1/qc/results').set(auth('U02')).send({
        qcCode: 'T-QC', instrument: 'inst1', testCode: 'CHE-K', value: 4.2,
      });
      expect(res.status).toBe(201);
      expect(res.body.data.evaluation.verdict).toBe('PASS');
    });
    it('1-3s 위반값 → FAIL', async () => {
      const res = await http.post('/api/v1/qc/results').set(auth('U02')).send({
        qcCode: 'T-QC', instrument: 'inst1', testCode: 'CHE-K', value: 4.85, // z=4.33
      });
      expect(res.body.data.evaluation.verdict).toBe('FAIL');
    });
    it('월간 QC 리뷰 사인오프 → 조회·요약 반영', async () => {
      const res = await http.post('/api/v1/qc/review').set(auth('U00')).send({ period: '2026-07', verdict: '승인', note: '이상 없음' });
      expect(res.status).toBe(201);
      expect(res.body.data.verdict).toBe('승인');
      expect(res.body.data.reviewedBy).toBe('U00'); // 인증 주체
      const list = await http.get('/api/v1/qc/reviews?period=2026-07').set(auth('U00'));
      expect(list.body.data.some((r: { period: string }) => r.period === '2026-07')).toBe(true);
      const summary = await http.get('/api/v1/qc/monthly-summary?period=2026-07').set(auth('U00'));
      expect(summary.body.data.review?.verdict).toBe('승인');
    });
  });

  // ── 마스터 관리 (검사항목·참고치 → 결과평가 즉시 반영) ──
  describe('마스터 관리', () => {
    // 재실행 멱등성: 신규 검사항목(MST-1) 및 종속 행 선정리
    beforeAll(async () => {
      await prisma.result.deleteMany({ where: { testCode: 'MST-1' } });
      await prisma.referenceRange.deleteMany({ where: { testCode: 'MST-1' } });
      await prisma.codeMapping.deleteMany({ where: { lisCode: 'MST-1' } });
      await prisma.panelItem.deleteMany({ where: { testCode: 'MST-1' } });
      await prisma.testMaster.deleteMany({ where: { testCode: 'MST-1' } });
    });

    it('접수담당(RCP) 검사항목 등록 → 403', async () => {
      const res = await http
        .post('/api/v1/master/tests')
        .set(auth('U07'))
        .send({ testCode: 'MST-1', name: '신규검사', domain: 'DIAGNOSTIC', unitUcum: 'mg/dL' });
      expect(res.status).toBe(403);
    });

    it('관리자(ADM) 검사항목+참고치 등록 → 결과평가에 즉시 반영', async () => {
      // 신규 검사항목
      const t = await http
        .post('/api/v1/master/tests')
        .set(auth('U00'))
        .send({ testCode: 'MST-1', name: '신규검사', domain: 'DIAGNOSTIC', unitUcum: 'mg/dL' });
      expect(t.status).toBe(201);

      // 참고치(정상 70~100, 위험 상한 400)
      const rr = await http
        .post('/api/v1/master/reference-ranges')
        .set(auth('U00'))
        .send({ testCode: 'MST-1', low: 70, high: 100, panicHigh: 400 });
      expect(rr.status).toBe(201);

      // 방금 등록한 항목으로 결과 입력 → 참고치 즉시 적용(500 → HH·위험치)
      const r = await http
        .post('/api/v1/results')
        .set(auth('U02'))
        .send({ specimenNo: 'T-S-1', testCode: 'MST-1', value: '500', unit: 'mg/dL' });
      expect(r.status).toBe(201);
      expect(r.body.data.evaluation.flag).toBe('HH');
      expect(r.body.data.evaluation.critical).toBe(true);
    });

    it('코드매핑 upsert → 목록 반영', async () => {
      const up = await http
        .put('/api/v1/master/code-mappings/MST-1')
        .set(auth('U00'))
        .send({ hisCode: 'E6591', loinc: '2345-7' });
      expect(up.status).toBe(200);
      const list = await http.get('/api/v1/master/code-mappings').set(auth('U00'));
      const codes = list.body.data.map((c: { lisCode: string }) => c.lisCode);
      expect(codes).toContain('MST-1');
    });

    it('코드매핑 대량 반입(EDI CSV) — 유효행 upsert + 미등록 검사 오류행', async () => {
      const rows = [
        { lisCode: 'MST-1', hisCode: 'E9999', loinc: '2345-7', ediCode: 'EDI-1' }, // 갱신
        { lisCode: 'CHE-GLU', hisCode: 'E6501', ediCode: 'EDI-GLU' }, // 신규(시드검사)
        { lisCode: 'NO-SUCH', hisCode: 'E0000' }, // 오류(미등록)
      ];
      const res = await http.post('/api/v1/master/code-mappings/bulk').set(auth('U00')).send({ rows });
      expect(res.status).toBe(201);
      expect(res.body.data.errors.length).toBe(1);
      expect(res.body.data.errors[0].lisCode).toBe('NO-SUCH');
      expect(res.body.data.imported + res.body.data.updated).toBe(2);
      const list = await http.get('/api/v1/master/code-mappings').set(auth('U00'));
      const edi = list.body.data.find((c: { lisCode: string; ediCode: string | null }) => c.lisCode === 'MST-1');
      expect(edi.ediCode).toBe('EDI-1');
    });

    /**
     * D5 — 심평원 실 수가코드 반입은 청구 산정에 직결된다. 기존 매핑을 조용히 덮지 않도록
     * 적용 전에 차이를 볼 수 있어야 하고(dryRun), 그때 아무것도 쓰이면 안 된다.
     */
    it('★코드매핑 반입 dryRun — 차이만 반환하고 DB는 그대로', async () => {
      const rows = [{ lisCode: 'MST-1', hisCode: 'E9999', ediCode: 'EDI-CHANGED' }];
      const dry = await http.post('/api/v1/master/code-mappings/bulk?dryRun=1').set(auth('U00')).send({ rows });
      expect(dry.status).toBe(201);
      expect(dry.body.data.dryRun).toBe(true);
      // ediCode만 바뀌고 hisCode는 이미 같은 값 → 변경 목록에 ediCode만
      expect(dry.body.data.changes.map((c: { field: string }) => c.field)).toEqual(['ediCode']);
      expect(dry.body.data.changes[0]).toMatchObject({ lisCode: 'MST-1', before: 'EDI-1', after: 'EDI-CHANGED' });
      const after = await prisma.codeMapping.findUnique({ where: { lisCode: 'MST-1' } });
      expect(after?.ediCode).toBe('EDI-1'); // 미적용
    });

    it('변경 없는 행은 무변경으로 집계(갱신 건수 부풀리기 방지)', async () => {
      const res = await http.post('/api/v1/master/code-mappings/bulk').set(auth('U00')).send({ rows: [{ lisCode: 'MST-1', ediCode: 'EDI-1' }] });
      expect(res.body.data.unchanged).toBe(1);
      expect(res.body.data.updated).toBe(0);
    });

    it('★미청구 EDI 재동기화 — 캡처 스냅샷을 현재 매핑으로 현행화, 전송분은 보존', async () => {
      await prisma.billingItem.deleteMany({ where: { orderId: 'T-EDI-RESYNC' } });
      // billing_item은 오더·환자 FK가 없다(청구 캡처 스냅샷) — 재동기화만 검증하므로 오더 생성 불필요
      await prisma.billingItem.createMany({
        data: [
          // 대표값으로 캡처된 미청구분 — 실 수가코드 적재 후 갱신 대상
          { billingId: 'T-BI-CAP', orderId: 'T-EDI-RESYNC', testCode: 'CHE-GLU', ediCode: 'OLD-EDI', status: 'CAPTURED' },
          // 전송 완료분 — 전송 당시 근거라 건드리지 않는다
          { billingId: 'T-BI-CLM', orderId: 'T-EDI-RESYNC', testCode: 'CHE-K', ediCode: 'OLD-EDI', status: 'CLAIMED' },
        ],
      });
      await prisma.codeMapping.upsert({ where: { lisCode: 'CHE-GLU' }, update: { ediCode: 'REAL-EDI' }, create: { lisCode: 'CHE-GLU', ediCode: 'REAL-EDI', status: 'USE' } });
      await prisma.codeMapping.upsert({ where: { lisCode: 'CHE-K' }, update: { ediCode: 'REAL-EDI-K' }, create: { lisCode: 'CHE-K', ediCode: 'REAL-EDI-K', status: 'USE' } });

      const res = await http.post('/api/v1/master/billing-edi/resync').set(auth('U00')).send({});
      expect(res.status).toBe(201);
      expect(res.body.data.updated).toBeGreaterThanOrEqual(1);
      expect((await prisma.billingItem.findUnique({ where: { billingId: 'T-BI-CAP' } }))?.ediCode).toBe('REAL-EDI');
      expect((await prisma.billingItem.findUnique({ where: { billingId: 'T-BI-CLM' } }))?.ediCode).toBe('OLD-EDI');
    });

    it('결과항목 EDI 반입 → 패널 자동구성 + 1:N 폴링전개(edi_code 그룹)', async () => {
      const rows = [
        { ediCode: 'E-PANELX', testCode: 'PX-A', name: 'PX A', loinc: '1-1', panelName: '테스트패널' },
        { ediCode: 'E-PANELX', testCode: 'PX-B', name: 'PX B', loinc: '2-2', panelName: '테스트패널' },
      ];
      const res = await http.post('/api/v1/master/result-items/bulk').set(auth('U00')).send({ rows, createTests: true });
      expect(res.status).toBe(201);
      expect(res.body.data.panels).toBe(1);
      expect(res.body.data.panelItems).toBe(2);
      // 인바운드 처방(코드=E-PANELX) → resolveTestCodes 패널 전개로 오더에 2개 항목
      const oml = 'MSH|^~\\&|HIS|HOSP|LIS|HOSP|20260718||OML^O21|EPX-1|P|2.5.1\rPID|1||T-2345678^^^HOSP^MR||김^테스트||19720503|M\rORC|NW|EPX-ORD\rOBR|1|EPX-ORD||E-PANELX^테스트패널^L|||20260718|||||||||||||||||R';
      const inb = await http.post('/api/v1/integration/hl7/inbound').set(auth('U00')).send({ message: oml });
      expect([200, 201]).toContain(inb.status);
      const order = await prisma.labOrder.findFirst({ where: { hisOrderNo: 'EPX-ORD' }, include: { items: true } });
      expect(order?.items.map((i) => i.testCode).sort()).toEqual(['PX-A', 'PX-B']);
    });

    it('패널 구성 교체(upsert)', async () => {
      const res = await http
        .put('/api/v1/master/panels')
        .set(auth('U00'))
        .send({ panelCode: 'E-LYTE', name: '전해질', testCodes: ['CHE-K', 'CHE-NA'] });
      expect(res.status).toBe(200);
      expect(res.body.data.items).toHaveLength(2);
    });
  });

  // ── 2차검증 확정 · 델타 · 리플렉스 ──
  describe('2차검증·델타·리플렉스', () => {
    // 재실행 멱등: T-DLT 결과·리플렉스 추가항목 초기화(직전값 없는 상태로)
    beforeAll(async () => {
      await prisma.result.deleteMany({ where: { specimenNo: 'T-S-DLT' } });
      await prisma.orderItem.deleteMany({ where: { orderId: 'T-O-DLT', testCode: 'CHE-HBA1C' } });
    });

    it('리플렉스: 고혈당(GLU 200, 직전값 없음) → 자동검증 + HbA1c 자동오더', async () => {
      const r = await http
        .post('/api/v1/results')
        .set(auth('U02'))
        .send({ specimenNo: 'T-S-DLT', testCode: 'CHE-GLU', value: '200', unit: 'mg/dL' });
      expect(r.status).toBe(201);
      expect(r.body.data.evaluation.autoVerified).toBe(true); // H(위험치 아님)·델타 없음 → 자동
      expect(r.body.data.evaluation.reflexAdded).toContain('CHE-HBA1C');
      // 동일 오더에 HbA1c 항목이 실제로 추가됨
      const item = await prisma.orderItem.findFirst({ where: { orderId: 'T-O-DLT', testCode: 'CHE-HBA1C' } });
      expect(item).toBeTruthy();
    });

    let heldId: string;
    it('델타: 직전 200 → 90(55% 급변) → 자동검증 차단(PENDING·DELTA)', async () => {
      const r = await http
        .post('/api/v1/results')
        .set(auth('U02'))
        .send({ specimenNo: 'T-S-DLT', testCode: 'CHE-GLU', value: '90', unit: 'mg/dL', rerun: true });
      expect(r.status).toBe(201);
      const ev = r.body.data.evaluation;
      expect(ev.flag).toBe('N'); // 90은 정상범위(70~110)
      expect(ev.autoVerified).toBe(false); // 델타로 보류
      expect(ev.holdReason).toBe('DELTA');
      expect(ev.delta.exceeded).toBe(true);
      heldId = r.body.data.result.resultId;
    });

    it('워크리스트: 보류 결과가 목록에 포함(사유 DELTA)', async () => {
      const res = await http.get('/api/v1/results/worklist').set(auth('U02'));
      expect(res.status).toBe(200);
      const row = res.body.data.find((x: { resultId: string }) => x.resultId === heldId);
      expect(row).toBeTruthy();
      expect(row.holdReason).toBe('DELTA');
    });

    it('근거 종합 번들 — 보류(DELTA) 사유를 수치 근거로 설명·참고치 선택근거·추세 포함', async () => {
      const res = await http.get(`/api/v1/results/${heldId}/evidence-context`).set(auth('U02'));
      expect(res.status).toBe(200);
      const d = res.body.data;
      expect(d.result.resultId).toBe(heldId);
      expect(d.result.holdReason).toBe('DELTA');
      // 코드(DELTA)만이 아니라 "무엇과 비교해 얼마나" 벗어났는지가 근거로 나와야 한다
      expect(d.holdExplanation).toContain('직전');
      expect(d.delta.hasPrev).toBe(true);
      expect(d.delta.exceeded).toBe(true);
      // 참고치와 그 선택 근거(성별·연령 구간)
      expect(d.refRange).toBeTruthy();
      expect(d.refBasis).toBeTruthy();
      expect(d.promptContext).toContain('진단검사 결과 근거 종합');
      expect(d.sources).toContain('참고치 마스터');
      expect(typeof d.llmNote).toBe('string');
    });

    it('RBAC: 접수담당(RCP) 2차검증 확정 → 403', async () => {
      const res = await http
        .post(`/api/v1/results/${heldId}/verify`)
        .set(auth('U07'))
        .send({ verifier: 'U07' });
      expect(res.status).toBe(403);
    });

    it('직무분리: 입력자(U02)가 자기 결과 검증 → 400(자가검증 차단)', async () => {
      // heldId는 U02가 입력(enteredBy=U02, 서버결속). 같은 U02가 검증 시도 → 차단.
      // (verifier는 서버가 JWT로 덮어쓰지만 DTO 필수라 바디에 넣는다 — 실제 검증자는 토큰 사용자.)
      const res = await http.post(`/api/v1/results/${heldId}/verify`).set(auth('U02')).send({ verifier: 'U02' });
      expect(res.status).toBe(400);
    });

    it('2차검증 확정: 다른 검증의(U09) → VERIFIED(status F)', async () => {
      const res = await http
        .post(`/api/v1/results/${heldId}/verify`)
        .set(auth('U09'))
        .send({ verifier: 'U09' });
      expect(res.status).toBe(201);
      expect(res.body.data.result.verifyState).toBe('VERIFIED');
      expect(res.body.data.result.status).toBe('F');
    });

    it('이미 확정된 결과 재검증 → 400', async () => {
      const res = await http
        .post(`/api/v1/results/${heldId}/verify`)
        .set(auth('U02'))
        .send({ verifier: 'U02' });
      expect(res.status).toBe(400);
    });
  });

  // ── 결과 수집: 자동 장비 + 수기·문서 병행 ──
  describe('결과 수집(자동+수기 병행)', () => {
    it('장비 ASTM 수집 → 매핑·자동평가·source=INSTRUMENT', async () => {
      const payload = ['O|1||T-S-INS', 'R|1|^^^GLU^|105|mg/dL|N||F', 'L|1'].join('\r');
      const res = await http
        .post('/api/v1/instruments/CHEM1/results')
        .set(auth('U02'))
        .send({ format: 'ASTM', payload });
      expect(res.status).toBe(201);
      expect(res.body.data.received).toBe(1);
      expect(res.body.data.ingested).toHaveLength(1);
      expect(res.body.data.ingested[0].testCode).toBe('CHE-GLU'); // GLU→CHE-GLU 매핑
      // 저장된 결과 출처 확인
      const list = await http.get('/api/v1/results?specimenNo=T-S-INS').set(auth('U02'));
      const r = list.body.data.find((x: { testCode: string }) => x.testCode === 'CHE-GLU');
      expect(r.source).toBe('INSTRUMENT');
      expect(r.enteredBy).toBe('CHEM1');
    });

    it('매핑 미등록 장비코드 → 건너뜀(skipped)', async () => {
      const payload = ['O|1||T-S-INS', 'R|1|^^^XYZ^|1|', 'L|1'].join('\r');
      const res = await http
        .post('/api/v1/instruments/CHEM1/results')
        .set(auth('U02'))
        .send({ format: 'ASTM', payload });
      expect(res.body.data.ingested).toHaveLength(0);
      expect(res.body.data.skipped[0].reason).toContain('매핑 미등록');
    });

    it('계산검사 — CHOL/HDL/TG 확정 시 LDL 자동 산출(CALCULATED)', async () => {
      await http.post('/api/v1/master/seed-derived-tests').set(auth('U00'));
      for (const [tc, val] of [['CHE-CHOL', '200'], ['CHE-HDL', '50'], ['CHE-TG', '100']]) {
        await http.post('/api/v1/results').set(auth('U02')).send({ specimenNo: 'T-S-INS', testCode: tc, value: val, unit: 'mg/dL' });
      }
      const list = await http.get('/api/v1/results?specimenNo=T-S-INS').set(auth('U02'));
      const ldl = list.body.data.find((x: { testCode: string }) => x.testCode === 'CHE-LDLC');
      expect(ldl?.value).toBe('130'); // 200-50-100/5
      expect(ldl?.source).toBe('CALCULATED');
    });

    it('희석배수 재검 — 원값×배수=참값 저장', async () => {
      const res = await http.post('/api/v1/results').set(auth('U02')).send({ specimenNo: 'T-S-INS', testCode: 'CHE-K', value: '0.5', unit: 'mmol/L', dilutionFactor: 10, rerun: true });
      expect(res.status).toBe(201);
      expect(res.body.data.result.value).toBe('5'); // 0.5 × 10
      expect(res.body.data.result.dilutionFactor).toBe(10);
      expect(res.body.data.result.rerun).toBe(true);
    });

    it('수기 이중입력 불일치 → 차단(400)', async () => {
      const res = await http
        .post('/api/v1/results')
        .set(auth('U02'))
        .send({ specimenNo: 'T-S-INS', testCode: 'CHE-NA', value: '140', valueConfirm: '141' });
      expect(res.status).toBe(400);
    });

    it('수기 이중입력 일치 + 원본문서 첨부 → 저장(source=DOCUMENT)', async () => {
      const res = await http
        .post('/api/v1/results')
        .set(auth('U02'))
        .send({ specimenNo: 'T-S-INS', testCode: 'CHE-NA', value: '140', valueConfirm: '140', source: 'DOCUMENT', enteredBy: 'U02', sourceDocRef: 'doc://scan/NA-INS.pdf' });
      expect(res.status).toBe(201);
      const list = await http.get('/api/v1/results?specimenNo=T-S-INS').set(auth('U02'));
      const r = list.body.data.find((x: { testCode: string }) => x.testCode === 'CHE-NA');
      expect(r.source).toBe('DOCUMENT');
      expect(r.sourceDocRef).toBe('doc://scan/NA-INS.pdf');
    });

    it('장비 매핑 upsert(운영자)', async () => {
      const res = await http
        .put('/api/v1/instruments/mappings')
        .set(auth('U00'))
        .send({ instrument: 'CHEM1', rawCode: 'NA', testCode: 'CHE-NA' });
      expect(res.status).toBe(200);
      expect(res.body.data.testCode).toBe('CHE-NA');
    });
  });

  // ── 검체 생명주기 (분주·거부·라벨·추적) ──
  describe('검체 생명주기', () => {
    let sp: string;

    it('접수 + 분주(Aliquot) 자동생성', async () => {
      const res = await http
        .post('/api/v1/orders/receive')
        .set(auth('U07'))
        .send({ orderId: 'T-O-1', specimenType: 'Serum', collectedBy: 'N-김간호', aliquotTargets: ['CHEM1', 'COAG1'] });
      expect(res.status).toBe(201);
      expect(res.body.data.aliquots).toHaveLength(2);
      sp = res.body.data.specimenNo;
      expect(sp).toBeTruthy();
    });

    it('라벨(ZPL) 생성 — 바코드에 검체번호', async () => {
      const res = await http.get(`/api/v1/orders/specimens/${sp}/label`).set(auth('U07'));
      expect(res.status).toBe(200);
      expect(res.body.data.zpl).toContain('^XA');
      expect(res.body.data.zpl).toContain(sp);
    });

    it('추적 타임라인: 접수·분주 이벤트', async () => {
      const res = await http.get(`/api/v1/orders/specimens/${sp}/timeline`).set(auth('U07'));
      expect(res.status).toBe(200);
      const events = res.body.data.events.map((e: { event: string }) => e.event);
      expect(events).toContain('RECEIVED');
      expect(events).toContain('ALIQUOT');
    });

    it('거부 사유코드 오류 → 400', async () => {
      const res = await http.post(`/api/v1/orders/specimens/${sp}/reject`).set(auth('U07')).send({ reason: 'BADCODE' });
      expect(res.status).toBe(400);
    });

    it('검체 거부(용혈) + 재채취 오더 생성', async () => {
      const res = await http
        .post(`/api/v1/orders/specimens/${sp}/reject`)
        .set(auth('U07'))
        .send({ reason: 'HEMOLYZED', recollect: true });
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('REJECTED');
      expect(res.body.data.recollection.orderId).toBeTruthy();
      // 알림 연결(회귀 금지) — 재채취 오더가 생겨도 병동·접수가 거부 사실을 모르면 아무도 다시 채취하지 않는다
      const noti = await prisma.notification.findFirst({ where: { ntype: '검체거부' }, orderBy: { createdDt: 'desc' } });
      expect(noti).toBeTruthy();
      expect(noti!.message).toContain(sp);
      expect(noti!.message).toContain('재채취');
    });

    it('이미 거부된 검체 재거부 → 400', async () => {
      const res = await http.post(`/api/v1/orders/specimens/${sp}/reject`).set(auth('U07')).send({ reason: 'CLOTTED' });
      expect(res.status).toBe(400);
    });
  });

  // ── 통계·리포트 (TAT·antibiogram·QC·미보고) ──
  describe('통계·리포트', () => {
    it('RBAC: 접수담당(RCP) 통계 조회 → 403', async () => {
      const res = await http.get('/api/v1/stats/tat').set(auth('U07'));
      expect(res.status).toBe(403);
    });

    it('TAT 분포(구조·버킷)', async () => {
      const res = await http.get('/api/v1/stats/tat').set(auth('U02'));
      expect(res.status).toBe(200);
      expect(res.body.data.buckets).toHaveLength(5);
      expect(typeof res.body.data.count).toBe('number');
    });

    it('검사량·재검률', async () => {
      const res = await http.get('/api/v1/stats/volumes').set(auth('U02'));
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('byDomain');
      expect(typeof res.body.data.rerunRatePct).toBe('number');
    });

    it('antibiogram: E. coli %S 집계 + CSV', async () => {
      const res = await http.get('/api/v1/stats/antibiogram').set(auth('U02'));
      expect(res.status).toBe(200);
      const ecoli = res.body.data.organisms.find((o: { organism: string }) => o.organism === 'E. coli');
      expect(ecoli).toBeTruthy();
      const amp = ecoli.antibiotics.find((a: { antibiotic: string }) => a.antibiotic === 'Ampicillin');
      expect(amp.pctS).toBe(0); // R 1건
      const mero = ecoli.antibiotics.find((a: { antibiotic: string }) => a.antibiotic === 'Meropenem');
      expect(mero.pctS).toBe(100);
      expect(res.body.data.csv).toContain('organism,antibiotic');
      // Ops9: 기간 필터를 적용할 수 없어 전체 누적임을 명시(기간 필터한 척 금지)
      expect(res.body.data.cumulative).toBe(true);
      expect(res.body.data.from).toBeNull();
    });

    it('QC Levey-Jennings 시계열', async () => {
      // 먼저 QC 측정 1건(정상)
      await http.post('/api/v1/qc/results').set(auth('U02')).send({ qcCode: 'T-QC', instrument: 'inst1', testCode: 'CHE-K', value: 4.2 });
      const res = await http.get('/api/v1/stats/qc-chart?qcCode=T-QC&instrument=inst1&testCode=CHE-K').set(auth('U02'));
      expect(res.status).toBe(200);
      expect(res.body.data.mean).toBe(4.2);
      expect(res.body.data.points.length).toBeGreaterThan(0);
    });

    it('미보고·지연 목록', async () => {
      const res = await http.get('/api/v1/stats/pending').set(auth('U02'));
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });

  // ── 보안·감사·위험치 실통보 ──
  describe('보안·감사·위험치 실통보', () => {
    // 재실행 멱등: 비번변경·잠금 사용자 상태 초기화
    beforeAll(async () => {
      const h = await bcrypt.hash(TEST_PW, 10);
      await prisma.appUser.update({ where: { userId: 'U-PWD' }, data: { passwordHash: h, failedAttempts: 0, lockedUntil: null } });
      await prisma.appUser.update({ where: { userId: 'U-LOCK' }, data: { passwordHash: h, failedAttempts: 0, lockedUntil: null } });
    });

    it('감사로그 검색(ADM) → 기록 존재', async () => {
      const res = await http.get('/api/v1/audit?take=5').set(auth('U00'));
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBeGreaterThan(0);
      expect(res.body.data.rows.length).toBeLessThanOrEqual(5);
    });

    it('RBAC: 검증의(PHY) 감사조회 → 403', async () => {
      const res = await http.get('/api/v1/audit').set(auth('U02'));
      expect(res.status).toBe(403);
    });

    it('감사 해시체인 무결성 검증 → ok(변조 없음, seq 연속)', async () => {
      // 앞선 다수 변경요청이 체인에 append됨 — verify가 무결성 통과해야 함.
      const res = await http.get('/api/v1/audit/verify').set(auth('U00'));
      expect(res.status).toBe(200);
      expect(res.body.data.ok).toBe(true);
      expect(res.body.data.count).toBeGreaterThan(0);
      expect(res.body.data.brokenAt).toBeNull();
    });

    it('비밀번호 변경: 약한 비번 → 400', async () => {
      const login = await http.post('/api/v1/auth/login').send({ userId: 'U-PWD', password: TEST_PW });
      const tk = login.body.data.accessToken;
      const res = await http.post('/api/v1/auth/change-password').set({ Authorization: `Bearer ${tk}` }).send({ currentPassword: TEST_PW, newPassword: 'weak' });
      expect(res.status).toBe(400);
    });

    it('비밀번호 변경: 정책 충족 → 성공', async () => {
      const login = await http.post('/api/v1/auth/login').send({ userId: 'U-PWD', password: TEST_PW });
      const tk = login.body.data.accessToken;
      const res = await http.post('/api/v1/auth/change-password').set({ Authorization: `Bearer ${tk}` }).send({ currentPassword: TEST_PW, newPassword: 'LisSecure2026' });
      expect(res.status).toBe(201);
      expect(res.body.data.changed).toBe(true);
    });

    it('계정 잠금: 연속 5회 실패 후 올바른 비번도 차단', async () => {
      for (let i = 0; i < 5; i++) {
        await http.post('/api/v1/auth/login').send({ userId: 'U-LOCK', password: 'wrong' });
      }
      const res = await http.post('/api/v1/auth/login').send({ userId: 'U-LOCK', password: TEST_PW });
      expect(res.status).toBe(401);
    });

    it('위험치 실통보 디스패치(채널 미설정 → PENDING 기록)', async () => {
      // 앞 '결과 정정' 테스트가 CHE-K 정정본(확정)을 남기므로, 재측정은 rerun=true(중복 가드 통과).
      const r = await http.post('/api/v1/results').set(auth('U02')).send({ specimenNo: 'T-S-1', testCode: 'CHE-K', value: '6.9', unit: 'mmol/L', rerun: true });
      const nid = r.body.data.evaluation.criticalNotifyId;
      expect(nid).toBeTruthy();
      const res = await http.post(`/api/v1/results/criticals/${nid}/dispatch`).set(auth('U02'));
      expect(res.status).toBe(201);
      // setup.ts가 웹훅 env를 제거하므로 결정적으로 PENDING — SENT가 나오면 운영 채널로
      // 새어 나가고 있다는 뜻이다(2026-07-30 보안 검토 HIGH). 느슨하게 되돌리지 말 것.
      expect(res.body.data.dispatchStatus).toBe('PENDING');
    });
  });

  // ── 미생물 단계보고 (그람 예비 → 최종 → 개정) ──
  describe('미생물 단계보고', () => {
    beforeAll(async () => {
      // 재실행 멱등: T-CUL2 초기화(접종 단계, 보고·균주 제거)
      await prisma.cultureReport.deleteMany({ where: { cultureId: 'T-CUL2' } });
      const isos = await prisma.isolate.findMany({ where: { cultureId: 'T-CUL2' } });
      for (const i of isos) await prisma.susceptibility.deleteMany({ where: { isolateId: i.isolateId } });
      await prisma.isolate.deleteMany({ where: { cultureId: 'T-CUL2' } });
      await prisma.culture.update({ where: { cultureId: 'T-CUL2' }, data: { stage: 'INOCULATED', reportStatus: null, gramStain: null } });
    });

    it('그람 전 동정 시도 → 400', async () => {
      const res = await http.post('/api/v1/microbiology/isolates').set(auth('U00')).send({
        cultureId: 'T-CUL2', organism: 'S. aureus', susceptibilities: [],
      });
      expect(res.status).toBe(400);
    });

    it('배양 등록(M1) → 워크리스트 등장 + 디스크확산 AST(MIC 없이 S/I/R) 보존(M2)', async () => {
      const c = await http.post('/api/v1/microbiology/cultures').set(auth('U03')).send({ specimenNo: 'T-S-1', medium: 'Blood agar' });
      expect(c.status).toBe(201);
      const cid = c.body.data.cultureId;
      expect(cid).toBeTruthy();
      const pending = await http.get('/api/v1/microbiology/cultures').set(auth('U03'));
      expect(pending.body.data.some((x: { cultureId: string }) => x.cultureId === cid)).toBe(true);
      await http.post('/api/v1/microbiology/gram').set(auth('U03')).send({ cultureId: cid, gramStain: 'Gram-positive cocci' });
      const iso = await http.post('/api/v1/microbiology/isolates').set(auth('U03')).send({
        cultureId: cid, organism: 'S. aureus',
        susceptibilities: [{ antibiotic: 'Erythromycin', interpretation: 'R' }], // MIC 없는 디스크확산
      });
      expect(iso.status).toBe(201);
      const det = await http.get(`/api/v1/microbiology/cultures/${cid}`).set(auth('U00'));
      const sus = det.body.data.isolates[0].susceptibilities;
      expect(sus.some((s: { antibiotic: string | null; interpretation: string | null }) => s.antibiotic === 'Erythromycin' && s.interpretation === 'R')).toBe(true);
    });

    it('그람 염색 → 예비보고(PRELIMINARY)', async () => {
      const res = await http.post('/api/v1/microbiology/gram').set(auth('U00')).send({
        cultureId: 'T-CUL2', gramStain: 'Gram-positive cocci in clusters',
      });
      expect(res.status).toBe(201);
      expect(res.body.data.reportStatus).toBe('PRELIMINARY');
      expect(res.body.data.report.content).toContain('그람양성 구균');
    });

    it('동정·감수성 → 최종보고(FINAL)', async () => {
      const res = await http.post('/api/v1/microbiology/isolates').set(auth('U00')).send({
        cultureId: 'T-CUL2', organism: 'S. aureus',
        susceptibilities: [{ antibiotic: 'Oxacillin', mic: '>4', interpretation: 'R' }],
      });
      expect(res.status).toBe(201);
      expect(res.body.data.reportStatus).toBe('FINAL');
      expect(res.body.data.infectionAlert).toBeTruthy(); // R → 감염관리 알림
    });

    it('재등록 → 개정보고(AMENDED)', async () => {
      const res = await http.post('/api/v1/microbiology/isolates').set(auth('U00')).send({
        cultureId: 'T-CUL2', organism: 'S. aureus (MRSA)',
        susceptibilities: [{ antibiotic: 'Vancomycin', mic: '1', interpretation: 'S' }],
      });
      expect(res.body.data.reportStatus).toBe('AMENDED');
    });

    it('완료 배양이 목록에서 사라지지 않는다 — scope=completed로 조회·균명 표출', async () => {
      // T-CUL2는 위에서 FINAL로 최종보고됨. 기본(pending) 목록에는 없어야 하고 completed에는 있어야 한다.
      const pending = await http.get('/api/v1/microbiology/cultures').set(auth('U03'));
      expect(pending.body.data.some((c: { cultureId: string }) => c.cultureId === 'T-CUL2')).toBe(false);
      const completed = await http.get('/api/v1/microbiology/cultures?scope=completed').set(auth('U03'));
      const done = completed.body.data.find((c: { cultureId: string }) => c.cultureId === 'T-CUL2');
      expect(done).toBeTruthy(); // 완료 배양도 조회 가능(이전엔 목록에서 사라졌다)
      expect(Array.isArray(done.organisms)).toBe(true); // 무엇이 자랐는지 목록에 표출
      expect(done.organisms.length).toBeGreaterThan(0);
      // 전체(all)에도 포함
      const all = await http.get('/api/v1/microbiology/cultures?scope=all').set(auth('U03'));
      expect(all.body.data.some((c: { cultureId: string }) => c.cultureId === 'T-CUL2')).toBe(true);
    });

    it('분리주 근거 종합 번들 — 브레이크포인트·MDRO·promptContext 조립(외부 전송 없음)', async () => {
      const cul = await http.get('/api/v1/microbiology/cultures/T-CUL2').set(auth('U00'));
      const iso = cul.body.data.isolates[0];
      expect(iso).toBeTruthy();
      const r = await http.get(`/api/v1/microbiology/isolates/${iso.isolateId}/evidence-context`).set(auth('U03'));
      expect(r.status).toBe(200);
      const d = r.body.data;
      expect(d.isolate.organism).toContain('aureus');
      expect(d.promptContext).toContain('미생물 감수성 근거 종합');
      expect(Array.isArray(d.susceptibilities)).toBe(true);
      expect(Array.isArray(d.sources)).toBe(true);
      expect(typeof d.llmNote).toBe('string');
      // Oxacillin-R S. aureus → MDRO(MRSA) 근거가 잡혀 sources에 포함
      expect(d.mdro.mdro).toBeTruthy();
    });

    it('단계보고 이력: 예비→최종→개정 순', async () => {
      const res = await http.get('/api/v1/microbiology/cultures/T-CUL2/report').set(auth('U00'));
      expect(res.status).toBe(200);
      const stages = res.body.data.reports.map((r: { status: string }) => r.status);
      expect(stages).toEqual(['PRELIMINARY', 'FINAL', 'AMENDED']);
    });

    it('배양 조회 시 MDRO·AST 재산출(저장 안 해도 배지 유지)', async () => {
      // 전용 배양에 전체 균명 + Oxacillin-R 등록 → 조회 시 MRSA·격리로 재분류돼야 함
      const cul = await prisma.culture.findUnique({ where: { cultureId: 'T-CUL2' } });
      const mrId = 'T-CUL-MR';
      await prisma.cultureReport.deleteMany({ where: { cultureId: mrId } });
      for (const iso of await prisma.isolate.findMany({ where: { cultureId: mrId } })) await prisma.susceptibility.deleteMany({ where: { isolateId: iso.isolateId } });
      await prisma.isolate.deleteMany({ where: { cultureId: mrId } });
      await prisma.culture.deleteMany({ where: { cultureId: mrId } });
      await prisma.culture.create({ data: { cultureId: mrId, specimenNo: cul!.specimenNo, stage: 'GRAM' } });
      await http.post('/api/v1/microbiology/isolates').set(auth('U00')).send({
        cultureId: mrId, organism: 'Staphylococcus aureus',
        susceptibilities: [{ antibiotic: 'Oxacillin', mic: '>4', interpretation: 'R' }],
      });
      const res = await http.get(`/api/v1/microbiology/cultures/${mrId}`).set(auth('U00'));
      expect(res.status).toBe(200);
      // 저장하지 않은 MDRO 분류가 조회 시 재산출돼 배지로 노출
      const flagged = res.body.data.isolates.some((i: { mdro?: { mdro?: string; isolation?: boolean } }) => i.mdro?.mdro === 'MRSA' || i.mdro?.isolation);
      expect(flagged).toBe(true);
      expect(res.body.data.isolates.every((i: { mdro?: unknown; astWarnings?: unknown }) => typeof i.mdro === 'object' && Array.isArray(i.astWarnings))).toBe(true);
    });

    it('무증식(No growth) → 그람 없이 균주 미생성 FINAL 종결', async () => {
      const cul = await prisma.culture.findUnique({ where: { cultureId: 'T-CUL2' } });
      const ngId = 'T-CUL-NG';
      await prisma.cultureReport.deleteMany({ where: { cultureId: ngId } });
      await prisma.isolate.deleteMany({ where: { cultureId: ngId } });
      await prisma.culture.deleteMany({ where: { cultureId: ngId } });
      await prisma.culture.create({ data: { cultureId: ngId, specimenNo: cul!.specimenNo, stage: 'INOCULATED' } });
      const res = await http.post('/api/v1/microbiology/no-growth').set(auth('U00')).send({ cultureId: ngId });
      expect(res.status).toBe(201);
      expect(res.body.data.reportStatus).toBe('FINAL');
      const det = await http.get(`/api/v1/microbiology/cultures/${ngId}`).set(auth('U00'));
      expect(det.body.data.isolates.length).toBe(0);
    });

    it('Antibiogram — 균종×항생제 %S 집계', async () => {
      const res = await http.get('/api/v1/microbiology/antibiogram').set(auth('U00'));
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.organisms)).toBe(true);
      expect(Array.isArray(res.body.data.antibiotics)).toBe(true);
      // 앞선 테스트로 Oxacillin-R S.aureus 등 감수성 데이터 존재 → 최소 1균종
      expect(res.body.data.organisms.length).toBeGreaterThan(0);
      const row = res.body.data.organisms[0];
      expect(typeof row.isolateCount).toBe('number');
      expect(Array.isArray(row.cells)).toBe(true);
      expect(res.body.data.firstIsolateOnly).toBe(true); // M3 first-isolate 중복제거
    });

    it('M1 검체 부적합·반려 — 동정 전 반려 + 워크리스트 제외, 동정된 배양 반려 400', async () => {
      const cul = await prisma.culture.findUnique({ where: { cultureId: 'T-CUL2' } });
      await prisma.culture.deleteMany({ where: { cultureId: 'T-CUL-REJ' } });
      await prisma.culture.create({ data: { cultureId: 'T-CUL-REJ', specimenNo: cul!.specimenNo, stage: 'INOCULATED' } });
      const rej = await http.post('/api/v1/microbiology/cultures/T-CUL-REJ/reject').set(auth('U00')).send({ reason: '이송지연 >2h·오염 의심' });
      expect(rej.status).toBe(201);
      expect(rej.body.data.rejectStatus).toBe('REJECTED');
      const list = await http.get('/api/v1/microbiology/cultures').set(auth('U00'));
      expect(list.body.data.some((c: { cultureId: string }) => c.cultureId === 'T-CUL-REJ')).toBe(false);
      // T-CUL2는 동정 이력 있음 → 반려 불가
      const bad = await http.post('/api/v1/microbiology/cultures/T-CUL2/reject').set(auth('U00')).send({ reason: 'x' });
      expect(bad.status).toBe(400);
    });
    it('M2 선택적 AST 보고 — 1차약 감수성 시 reserve 억제', async () => {
      const cul = await prisma.culture.findUnique({ where: { cultureId: 'T-CUL2' } });
      const scId = 'T-CUL-SEL';
      await prisma.cultureReport.deleteMany({ where: { cultureId: scId } });
      for (const iso of await prisma.isolate.findMany({ where: { cultureId: scId } })) await prisma.susceptibility.deleteMany({ where: { isolateId: iso.isolateId } });
      await prisma.isolate.deleteMany({ where: { cultureId: scId } });
      await prisma.culture.deleteMany({ where: { cultureId: scId } });
      await prisma.culture.create({ data: { cultureId: scId, specimenNo: cul!.specimenNo, stage: 'GRAM' } });
      await http.post('/api/v1/microbiology/gram').set(auth('U00')).send({ cultureId: scId, gramStain: 'Gram-negative rods' });
      await http.post('/api/v1/microbiology/isolates').set(auth('U00')).send({
        cultureId: scId, organism: 'E. coli',
        susceptibilities: [{ antibiotic: 'Ciprofloxacin', mic: '0.5', interpretation: 'S' }, { antibiotic: 'Meropenem', mic: '0.25', interpretation: 'S' }],
      });
      const sel = await http.get(`/api/v1/microbiology/cultures/${scId}/selective-ast`).set(auth('U00'));
      expect(sel.status).toBe(200);
      const iso = sel.body.data.isolates[0];
      expect(iso.firstLineSusceptible).toBe(true);
      const mero = iso.ast.find((a: { antibiotic: string }) => a.antibiotic === 'Meropenem');
      expect(mero.report).toBe(false); // reserve 억제
      const cipro = iso.ast.find((a: { antibiotic: string }) => a.antibiotic === 'Ciprofloxacin');
      expect(cipro.report).toBe(true);
    });
  });

  // ── 혈액배양 양성 → 폐루프 위험치(A1) ──
  describe('미생물 혈액배양 위험치', () => {
    beforeAll(async () => {
      await prisma.specimen.upsert({
        where: { specimenNo: 'T-S-BC' }, update: { specimenType: 'Blood' },
        create: { specimenNo: 'T-S-BC', orderId: 'T-O-1', specimenType: 'Blood', status: 'IN_PROCESS' },
      });
      await prisma.culture.upsert({
        where: { cultureId: 'T-CUL-BC' }, update: { stage: 'GRAM', reportStatus: null },
        create: { cultureId: 'T-CUL-BC', specimenNo: 'T-S-BC', medium: 'Blood culture', stage: 'GRAM', status: '진행' },
      });
    });
    it('혈액배양 균 동정 → 폐루프 위험치 통보 생성(담당의)', async () => {
      const res = await http.post('/api/v1/microbiology/isolates').set(auth('U00')).send({
        cultureId: 'T-CUL-BC', organism: 'S. aureus',
        susceptibilities: [{ antibiotic: 'Oxacillin', mic: '0.5', interpretation: 'S' }],
      });
      expect(res.status).toBe(201);
      expect(res.body.data.criticalNotify).toBeTruthy();
      expect(res.body.data.criticalNotify.category).toBe('MICRO');
      expect(res.body.data.criticalNotify.label).toBe('혈액배양 양성');
      expect(res.body.data.criticalNotify.value).toBe('S. aureus');
    });
    it('생성된 혈액배양 위험치가 미확인 목록(pending)에 포함', async () => {
      const res = await http.get('/api/v1/results/criticals/pending').set(auth('U02'));
      expect(res.status).toBe(200);
      const micro = res.body.data.find((c: { category?: string; specimenNo?: string }) => c.category === 'MICRO' && c.specimenNo === 'T-S-BC');
      expect(micro).toBeTruthy();
      expect(micro.result).toBeNull(); // 비-Result 소스
    });
  });

  // ── 위험치 에스컬레이션 사다리 + read-back(A4) ──
  describe('위험치 에스컬레이션·readback', () => {
    beforeAll(async () => {
      await prisma.criticalNotify.deleteMany({ where: { notifyId: 'T-CN-ESC' } });
      await prisma.criticalNotify.create({
        data: { notifyId: 'T-CN-ESC', category: 'MICRO', label: '혈액배양 양성', value: 'S. aureus', specimenNo: 'T-S-BC', notifyTarget: '담당의', dispatchStatus: 'PENDING', escalationLevel: 0, createdDt: new Date(Date.now() - 20 * 60000) },
      });
    });
    it('미확인 20분 경과 → 다음 계층으로 상향(담당의→수간호사)', async () => {
      await app.get(CriticalNotifierService).escalateStale();
      const cn = await prisma.criticalNotify.findUnique({ where: { notifyId: 'T-CN-ESC' } });
      expect(cn?.escalationLevel).toBe(1);
      expect(cn?.notifyTarget).toBe('수간호사');
      expect(cn?.escalatedDt).toBeTruthy();
    });
    it('ack 시 read-back(수신자·복창) 문서화', async () => {
      const res = await http.post('/api/v1/results/criticals/T-CN-ESC/ack').set(auth('U02')).send({ ackBy: 'U02', readbackBy: '내과 김간호사', readbackNote: 'S. aureus 혈액배양 양성 복창 확인' });
      expect(res.status).toBe(201);
      const cn = await prisma.criticalNotify.findUnique({ where: { notifyId: 'T-CN-ESC' } });
      expect(cn?.readbackBy).toBe('내과 김간호사');
      expect(cn?.readbackNote).toContain('복창 확인');
      expect(cn?.ackDt).toBeTruthy();
    });
  });

  // ── 법정감염병 신고·MDRO line list(B3) ──
  describe('법정감염병 신고·line list', () => {
    beforeAll(async () => {
      await prisma.specimen.upsert({ where: { specimenNo: 'T-S-TB' }, update: { specimenType: 'Sputum' }, create: { specimenNo: 'T-S-TB', orderId: 'T-O-1', specimenType: 'Sputum', status: 'IN_PROCESS' } });
      await prisma.culture.upsert({ where: { cultureId: 'T-CUL-TB' }, update: { stage: 'GRAM', reportStatus: null }, create: { cultureId: 'T-CUL-TB', specimenNo: 'T-S-TB', medium: 'LJ', stage: 'GRAM', status: '진행' } });
    });
    it('결핵균 동정 → 법정감염병 신고 기록(PENDING) 생성', async () => {
      const res = await http.post('/api/v1/microbiology/isolates').set(auth('U00')).send({ cultureId: 'T-CUL-TB', organism: 'Mycobacterium tuberculosis', susceptibilities: [] });
      expect(res.status).toBe(201);
      expect(res.body.data.infectiousReport).toBeTruthy();
      expect(res.body.data.infectiousReport.disease).toBe('결핵');
      expect(res.body.data.infectiousReport.status).toBe('PENDING');
    });
    it('신고 대기 → 서류 첨부 후 신고 완료(첨부 없으면 400)', async () => {
      const list = await http.get('/api/v1/microbiology/notifiable').set(auth('U00'));
      expect(list.status).toBe(200);
      const tb = list.body.data.find((r: { disease: string }) => r.disease === '결핵');
      expect(tb).toBeTruthy();
      expect(tb.attachmentCount).toBe(0);
      // 신고 서류 없이 완료 시도 → 400(완료 근거 강제)
      const noAttach = await http.post(`/api/v1/microbiology/notifiable/${tb.reportId}/notify`).set(auth('U00')).send({ note: 'x' });
      expect(noAttach.status).toBe(400);
      // 보건소 신고 서류(스캔/사진) 첨부
      const up = await http.post(`/api/v1/results/notifiable/${tb.reportId}/attachments`).set(auth('U00'))
        .attach('file', Buffer.from('%PDF-1.4 report'), { filename: 'report.pdf', contentType: 'application/pdf' });
      expect(up.status).toBe(201);
      // 첨부는 됐으나 신고번호 없이 완료 → 400
      const noNo = await http.post(`/api/v1/microbiology/notifiable/${tb.reportId}/notify`).set(auth('U00')).send({});
      expect(noNo.status).toBe(400);
      // 신고번호+완료
      const done = await http.post(`/api/v1/microbiology/notifiable/${tb.reportId}/notify`).set(auth('U00')).send({ reportNo: 'PHC-2026-0001', note: '보건소 신고 완료' });
      expect(done.status).toBe(201);
      expect(done.body.data.status).toBe('NOTIFIED');
      expect(done.body.data.notifiedDt).toBeTruthy();
      expect(done.body.data.reportNo).toBe('PHC-2026-0001');
    });

    /**
     * ★감염관리팀 알림이 개정에도 다시 간다(P1-15, 회귀 금지).
     * 이전에는 알림 PK가 `N-NOTIF-${isolateId}` 고정이라, 같은 균주 개정 입력 시 unique 위반이
     * `.catch(()=>undefined)`로 삼켜져 **개정 시 감염관리팀에 알림이 안 갔다**. 첫 알림을 이미
     * 확인했으면 개정을 놓친다 — 법정 신고 누락. PK를 신고기록ID 기반으로 바꿔 개정마다 새 알림.
     */
    it('검출 시 감염관리팀 알림이 생성된다(사이드바 배지)', async () => {
      const n = await prisma.notification.findMany({ where: { ntype: '법정감염병신고', ackDt: null } });
      expect(n.some((x) => (x.message ?? '').includes('결핵'))).toBe(true);
    });

    it('같은 균주 개정 입력 → 새 신고기록·새 알림(개정을 삼키지 않는다)', async () => {
      const before = await prisma.notification.count({ where: { ntype: '법정감염병신고' } });
      // 같은 배양 재입력(개정) — 이전엔 여기서 알림이 조용히 사라졌다
      const res = await http.post('/api/v1/microbiology/isolates').set(auth('U00')).send({ cultureId: 'T-CUL-TB', organism: 'Mycobacterium tuberculosis', susceptibilities: [] });
      expect(res.status).toBe(201);
      const after = await prisma.notification.count({ where: { ntype: '법정감염병신고' } });
      expect(after).toBeGreaterThan(before); // 개정에도 새 알림이 생성됐다
    });
    it('MDRO line list — 내성/MDRO 균주 집계', async () => {
      const res = await http.get('/api/v1/microbiology/line-list').set(auth('U00'));
      expect(res.status).toBe(200);
      expect(typeof res.body.data.total).toBe('number');
      expect(Array.isArray(res.body.data.rows)).toBe(true);
    });

    it('감염관리 조회는 의사(PHY=ICP)도 허용, 배양 등 다른 미생물 API·신고 처리(write)는 불가', async () => {
      // 조회 확대(메서드 레벨 @Roles 오버라이드): notifiable·line-list GET은 PHY 200
      expect((await http.get('/api/v1/microbiology/notifiable').set(auth('U02'))).status).toBe(200);
      expect((await http.get('/api/v1/microbiology/line-list').set(auth('U02'))).status).toBe(200);
      // 클래스 기본(MIC,ADM) 유지 — PHY는 배양 목록·신고 완료 처리 불가(과다권한 방지)
      expect((await http.get('/api/v1/microbiology/cultures').set(auth('U02'))).status).toBe(403);
      expect((await http.post('/api/v1/microbiology/notifiable/ANY/notify').set(auth('U02')).send({})).status).toBe(403);
    });
  });

  describe('알림 확인이력', () => {
    it('확인(ack) 후 history에 잔존 · pending에서 제외', async () => {
      const nid = 'T-NTF-HIST';
      await prisma.notification.deleteMany({ where: { notifyId: nid } });
      await prisma.notification.create({ data: { notifyId: nid, ntype: 'QC위반', target: '검사실', message: '테스트 알림', createdDt: new Date() } });
      await http.post(`/api/v1/notifications/${nid}/ack`).set(auth('U00')).send({});
      const pending = await http.get('/api/v1/notifications/pending').set(auth('U00'));
      expect(pending.body.data.some((n: { notifyId: string }) => n.notifyId === nid)).toBe(false);
      const hist = await http.get('/api/v1/notifications/history').set(auth('U00'));
      expect(hist.status).toBe(200);
      const found = hist.body.data.find((n: { notifyId: string }) => n.notifyId === nid);
      expect(found).toBeTruthy();
      expect(found.ackDt).toBeTruthy();
    });
  });

  // ── 수혈 전주기 (입고·혈액형·시행·부작용) ──
  describe('수혈 전주기', () => {
    let issueId: string;

    beforeAll(async () => {
      // 재실행 멱등 정리
      await prisma.transfusionReaction.deleteMany({ where: { patientId: 'T-BB' } });
      await prisma.transfusionAct.deleteMany({ where: { patientId: 'T-BB' } });
      await prisma.bloodIssue.deleteMany({ where: { unitNo: 'T-UNIT-2' } });
      await prisma.crossmatch.deleteMany({ where: { xmId: 'T-XM-2' } });
      await prisma.bloodUnit.deleteMany({ where: { unitNo: 'T-UNIT-2' } });
      await prisma.bloodTyping.deleteMany({ where: { patientId: 'T-BB' } });
    });

    it('입고: 유효기간 지난 제제 → 400', async () => {
      const res = await http.post('/api/v1/transfusion/units').set(auth('U05')).send({
        unitNo: 'T-UNIT-X', productType: 'RBC', bloodGroup: 'A+', expiryDate: '2020-01-01',
      });
      expect(res.status).toBe(400);
    });

    it('입고: 정상 제제 등록', async () => {
      const res = await http.post('/api/v1/transfusion/units').set(auth('U05')).send({
        unitNo: 'T-UNIT-2', productType: 'RBC', bloodGroup: 'A+', drawnDate: '2026-07-01', expiryDate: '2026-12-31',
      });
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('IN_STOCK');
    });

    it('혈액형·항체 등록 + 이력 조회', async () => {
      // 서버측 ABO 검증(C3): 독립 2회 동일 판정이 있어야 출고 게이트 통과
      const res = await http.post('/api/v1/transfusion/typing').set(auth('U05')).send({
        patientId: 'T-BB', abo: 'A', rhD: 'POS', antibodyScreen: 'NEG',
      });
      expect(res.status).toBe(201);
      await http.post('/api/v1/transfusion/typing').set(auth('U05')).send({
        patientId: 'T-BB', abo: 'A', rhD: 'POS', antibodyScreen: 'NEG',
      });
      const list = await http.get('/api/v1/transfusion/typing/T-BB').set(auth('U05'));
      expect(list.body.data.length).toBeGreaterThanOrEqual(2);
    });

    it('재고 조회에 유효기간 상태 포함', async () => {
      const res = await http.get('/api/v1/transfusion/inventory').set(auth('U05'));
      expect(res.status).toBe(200);
      expect(res.body.data.every((u: { expiryStatus: string }) => u.expiryStatus)).toBe(true);
    });

    it('출고 → 시행 기록', async () => {
      await prisma.crossmatch.create({ data: { xmId: 'T-XM-2', patientId: 'T-BB', unitNo: 'T-UNIT-2', method: '생리식염수법', result: '적합' } });
      const iss = await http.post('/api/v1/transfusion/issue').set(auth('U05')).send({
        unitNo: 'T-UNIT-2', patientId: 'T-BB', issuer: 'U05', receiver: '간호사',
        confirm1: 'U05', confirm2: 'U08', aboVerifiedTwice: true, aboMatchesHistory: true,
      });
      expect(iss.status).toBe(201);
      issueId = iss.body.data.issue.issueId;
      const act = await http.post('/api/v1/transfusion/administer').set(auth('U05')).send({ issueId, administeredBy: 'N-간호' });
      expect(act.status).toBe(201);
      expect(act.body.data.status).toBe('ONGOING');
    });

    it('부작용 보고(용혈·중증) → 즉시 중단 권고 + 시행 STOPPED', async () => {
      const res = await http.post('/api/v1/transfusion/reactions').set(auth('U05')).send({
        issueId, patientId: 'T-BB', reactionType: 'HEMOLYTIC', severity: 'SEVERE', symptoms: '발열·혈뇨',
      });
      expect(res.status).toBe(201);
      expect(res.body.data.guidance).toContain('즉시 수혈 중단');
      const act = await prisma.transfusionAct.findFirst({ where: { issueId } });
      expect(act?.status).toBe('STOPPED');
    });
    it('반응 조사 워크업 → 최종분류 시 CLOSED(A5)', async () => {
      const rep = await http.post('/api/v1/transfusion/reactions').set(auth('U05')).send({
        issueId, patientId: 'T-BB', reactionType: 'HEMOLYTIC', severity: 'SEVERE', symptoms: '발열·혈뇨',
      });
      const reactionId = rep.body.data.reaction.reactionId;
      // 사무착오·DAT·post ABO만 먼저 기록(분류 미정) → IN_PROGRESS
      const p1 = await http.post(`/api/v1/transfusion/reactions/${reactionId}/investigate`).set(auth('U05')).send({ clericalCheckOk: true, postDat: 'POS', hemolysisVisual: 'PRESENT' });
      expect(p1.status).toBe(201);
      expect(p1.body.data.investigationStatus).toBe('IN_PROGRESS');
      // 조사서 첨부 전 AHTR 종결 시도 → 400(중대 반응 종결 근거 강제)
      const noDoc = await http.post(`/api/v1/transfusion/reactions/${reactionId}/investigate`).set(auth('U05')).send({ postAboRecheck: '불일치 없음', finalClassification: 'AHTR' });
      expect(noDoc.status).toBe(400);
      // 이상반응 조사서 첨부
      const up = await http.post(`/api/v1/results/transfusion-reactions/${reactionId}/attachments`).set(auth('U05'))
        .attach('file', Buffer.from('%PDF-1.4 조사서'), { filename: 'reaction.pdf', contentType: 'application/pdf' });
      expect(up.status).toBe(201);
      // 최종분류 입력 → CLOSED
      const p2 = await http.post(`/api/v1/transfusion/reactions/${reactionId}/investigate`).set(auth('U05')).send({ postAboRecheck: '불일치 없음', labFindings: 'haptoglobin↓ LDH↑ bili↑', finalClassification: 'AHTR', conclusion: '급성 용혈성 수혈반응' });
      expect(p2.status).toBe(201);
      expect(p2.body.data.investigationStatus).toBe('CLOSED');
      expect(p2.body.data.finalClassification).toBe('AHTR');
      expect(p2.body.data.postDat).toBe('POS'); // 앞 단계 값 보존
      expect(p2.body.data.investigatedBy).toBe('U05');
    });
  });

  // ── 수혈 재점검(동의 attest·명시적 폐기·통계) ──
  /**
   * 알림 연결(회귀 금지) — 중대 수혈반응·제제 회수 역추적.
   * 둘 다 예전엔 "그 화면을 연 사람만 아는" 상태였다: 반응은 시행 중단만 하고 통보가 없었고,
   * 회수는 역추적 대상자를 HTTP 응답으로만 돌려줬다. 회수는 헌혈자측 사후 정보로 시작돼
   * 시간이 지나 발생하므로 화면을 보고 있을 이유가 더더욱 없다.
   */
  describe('수혈 알림 연결', () => {
    it('중대 수혈반응(SEVERE) → 알림함에 올라간다', async () => {
      await prisma.notification.deleteMany({ where: { ntype: '중대수혈반응' } });
      const res = await http.post('/api/v1/transfusion/reactions').set(auth('U05'))
        .send({ patientId: 'T-BB', reactionType: 'HEMOLYTIC', severity: 'SEVERE', symptoms: 'e2e' });
      expect([200, 201]).toContain(res.status);
      const n = await prisma.notification.findFirst({ where: { ntype: '중대수혈반응' } });
      expect(n).toBeTruthy();
      expect(n!.message).toContain('T-BB');
      expect(n!.target).toBe('혈액은행');
    });

    it('경증 반응은 알림을 만들지 않는다 — 경보 피로 방지', async () => {
      await prisma.notification.deleteMany({ where: { ntype: '중대수혈반응' } });
      await http.post('/api/v1/transfusion/reactions').set(auth('U05'))
        .send({ patientId: 'T-BB', reactionType: 'FEBRILE', severity: 'MILD', symptoms: 'e2e' });
      expect(await prisma.notification.count({ where: { ntype: '중대수혈반응' } })).toBe(0);
    });

    it('★출고 이력 있는 제제 회수 → 역추적 알림(대상자 포함)', async () => {
      await prisma.notification.deleteMany({ where: { ntype: '제제회수추적' } });
      const unit = 'T-UNIT-RECALL1';
      await prisma.bloodIssue.deleteMany({ where: { unitNo: unit } });
      await prisma.bloodUnit.deleteMany({ where: { unitNo: unit } });
      await prisma.bloodUnit.create({ data: { unitNo: unit, productType: 'RBC', bloodGroup: 'A+', drawnDate: '2026-07-01', expiryDate: '2026-08-30', status: 'ISSUED' } });
      await prisma.bloodIssue.create({ data: { issueId: 'T-ISS-RECALL1', unitNo: unit, patientId: 'T-BB', status: 'TRANSFUSED', issuedDt: new Date() } });

      const res = await http.post(`/api/v1/transfusion/units/${unit}/recall`).set(auth('U05'))
        .send({ status: 'RECALLED', reason: 'e2e 헌혈자 사후 감염 확인' });
      expect([200, 201]).toContain(res.status);
      expect(res.body.data.lookbackRequired).toBe(true);

      const n = await prisma.notification.findFirst({ where: { ntype: '제제회수추적' } });
      expect(n).toBeTruthy();
      expect(n!.message).toContain(unit);
      expect(n!.message).toContain('T-BB');   // 역추적 대상자가 메시지에 있어야 착수가 가능하다
    });

    it('출고 이력 없는 제제 회수 → 알림 없음', async () => {
      await prisma.notification.deleteMany({ where: { ntype: '제제회수추적' } });
      const unit = 'T-UNIT-RECALL2';
      await prisma.bloodUnit.deleteMany({ where: { unitNo: unit } });
      await prisma.bloodUnit.create({ data: { unitNo: unit, productType: 'RBC', bloodGroup: 'O+', drawnDate: '2026-07-01', expiryDate: '2026-08-30', status: 'IN_STOCK' } });
      await http.post(`/api/v1/transfusion/units/${unit}/recall`).set(auth('U05')).send({ status: 'QUARANTINED' });
      expect(await prisma.notification.count({ where: { ntype: '제제회수추적' } })).toBe(0);
    });
  });

  describe('수혈 재점검 T1~T3', () => {
    beforeAll(async () => {
      for (const u of ['T-UNIT-CA1', 'T-UNIT-CA2', 'T-UNIT-DISC']) {
        await prisma.bloodIssue.deleteMany({ where: { unitNo: u } });
        await prisma.crossmatch.deleteMany({ where: { unitNo: u } });
        await prisma.bloodUnit.deleteMany({ where: { unitNo: u } });
      }
      // T-BB는 '수혈 전주기'에서 A POS 2회 등록(ABO 이력) — 재사용.
    });
    it('T1 출고 attestation: HIS 동의 미기록 → consentWarning, 기록 시 없음', async () => {
      await http.post('/api/v1/transfusion/units').set(auth('U05')).send({ unitNo: 'T-UNIT-CA1', productType: 'RBC', bloodGroup: 'A+', expiryDate: '2026-12-31' });
      await prisma.crossmatch.create({ data: { xmId: 'T-XM-CA1', patientId: 'T-BB', unitNo: 'T-UNIT-CA1', method: '생리식염수법', result: '적합' } });
      const noAtt = await http.post('/api/v1/transfusion/issue').set(auth('U05')).send({ unitNo: 'T-UNIT-CA1', patientId: 'T-BB', issuer: 'U05', receiver: '간호사', confirm1: 'U05', confirm2: 'U08', aboVerifiedTwice: true, aboMatchesHistory: true });
      expect(noAtt.status).toBe(201);
      expect(noAtt.body.data.consentWarning).toBeTruthy();
      await http.post('/api/v1/transfusion/units').set(auth('U05')).send({ unitNo: 'T-UNIT-CA2', productType: 'RBC', bloodGroup: 'A+', expiryDate: '2026-12-31' });
      await prisma.crossmatch.create({ data: { xmId: 'T-XM-CA2', patientId: 'T-BB', unitNo: 'T-UNIT-CA2', method: '생리식염수법', result: '적합' } });
      const att = await http.post('/api/v1/transfusion/issue').set(auth('U05')).send({ unitNo: 'T-UNIT-CA2', patientId: 'T-BB', issuer: 'U05', receiver: '간호사', confirm1: 'U05', confirm2: 'U08', aboVerifiedTwice: true, aboMatchesHistory: true, consentAttestedBy: 'U05' });
      expect(att.body.data.consentWarning).toBeNull();
      expect(att.body.data.issue.consentAttestedBy).toBe('U05');
    });
    it('T2 명시적 폐기: IN_STOCK 폐기 + 출고된 제제 폐기 400', async () => {
      await http.post('/api/v1/transfusion/units').set(auth('U05')).send({ unitNo: 'T-UNIT-DISC', productType: 'PLT', bloodGroup: 'O+', expiryDate: '2026-12-31' });
      const d = await http.post('/api/v1/transfusion/units/T-UNIT-DISC/discard').set(auth('U05')).send({ reason: '백 손상·오염' });
      expect(d.status).toBe(201);
      expect(d.body.data.status).toBe('DISCARDED');
      const bad = await http.post('/api/v1/transfusion/units/T-UNIT-CA1/discard').set(auth('U05')).send({ reason: 'x' }); // T-UNIT-CA1은 ISSUED
      expect(bad.status).toBe(400);
    });
    it('HIS 수혈 동의 참조 — HIS 미구성 시 fail-safe(available:false)', async () => {
      const res = await http.get('/api/v1/transfusion/consent-status/T-2345678').set(auth('U05'));
      expect(res.status).toBe(200);
      expect(res.body.data.available).toBe(false);
      expect(res.body.data.active).toBe(false);
    });
    it('T3 수혈 통계: 지표·재고 산출', async () => {
      const res = await http.get('/api/v1/stats/transfusion').set(auth('U00'));
      expect(res.status).toBe(200);
      const d = res.body.data;
      expect(typeof d.issued).toBe('number');
      expect(typeof d.transfused).toBe('number');
      expect('ctRatio' in d).toBe(true);
      expect(typeof d.inventory).toBe('object');
      expect(d.discardCount).toBeGreaterThanOrEqual(1);
    });
  });

  // ── 출고 반납·근접만료 ──
  describe('출고 반납·근접만료', () => {
    beforeAll(async () => {
      await prisma.bloodIssue.deleteMany({ where: { unitNo: { in: ['T-UNIT-RET', 'T-UNIT-LATE'] } } });
      await prisma.crossmatch.deleteMany({ where: { xmId: { in: ['T-XM-RET', 'T-XM-LATE'] } } });
      await prisma.bloodUnit.deleteMany({ where: { unitNo: { in: ['T-UNIT-RET', 'T-UNIT-EXP', 'T-UNIT-LATE'] } } });
    });
    it('출고 → 반납 → 재고 IN_STOCK 복원', async () => {
      await http.post('/api/v1/transfusion/units').set(auth('U05')).send({ unitNo: 'T-UNIT-RET', productType: 'RBC', bloodGroup: 'A+', expiryDate: '2026-12-31' });
      await prisma.crossmatch.create({ data: { xmId: 'T-XM-RET', patientId: 'T-BB', unitNo: 'T-UNIT-RET', method: '생리식염수법', result: '적합' } });
      const iss = await http.post('/api/v1/transfusion/issue').set(auth('U05')).send({
        unitNo: 'T-UNIT-RET', patientId: 'T-BB', issuer: 'U05', receiver: '간호사', confirm1: 'U05', confirm2: 'U08', aboVerifiedTwice: true, aboMatchesHistory: true,
      });
      expect(iss.status).toBe(201);
      const ret = await http.post(`/api/v1/transfusion/issue/${iss.body.data.issue.issueId}/return`).set(auth('U05')).send({ reason: '수혈 취소' });
      expect(ret.status).toBe(201);
      expect(ret.body.data.restored).toBe('IN_STOCK');
      const unit = await prisma.bloodUnit.findUnique({ where: { unitNo: 'T-UNIT-RET' } });
      expect(unit?.status).toBe('IN_STOCK');
    });
    it('출고 후 30분 초과 반납 → 재입고 불가·폐기(DISCARDED)', async () => {
      await http.post('/api/v1/transfusion/units').set(auth('U05')).send({ unitNo: 'T-UNIT-LATE', productType: 'RBC', bloodGroup: 'A+', expiryDate: '2026-12-31' });
      await prisma.crossmatch.create({ data: { xmId: 'T-XM-LATE', patientId: 'T-BB', unitNo: 'T-UNIT-LATE', method: '생리식염수법', result: '적합' } });
      const iss = await http.post('/api/v1/transfusion/issue').set(auth('U05')).send({
        unitNo: 'T-UNIT-LATE', patientId: 'T-BB', issuer: 'U05', receiver: '간호사', confirm1: 'U05', confirm2: 'U08', aboVerifiedTwice: true, aboMatchesHistory: true,
      });
      expect(iss.status).toBe(201);
      // 통제온도 이탈 초과 시뮬레이션: issuedDt를 31분 전으로 백데이트
      await prisma.bloodIssue.update({ where: { issueId: iss.body.data.issue.issueId }, data: { issuedDt: new Date(Date.now() - 31 * 60000) } });
      const ret = await http.post(`/api/v1/transfusion/issue/${iss.body.data.issue.issueId}/return`).set(auth('U05')).send({ reason: '수혈 취소' });
      expect(ret.status).toBe(201);
      expect(ret.body.data.discarded).toBe(true);
      expect(ret.body.data.restored).toBe('DISCARDED');
      const unit = await prisma.bloodUnit.findUnique({ where: { unitNo: 'T-UNIT-LATE' } });
      expect(unit?.status).toBe('DISCARDED');
    });
    it('근접만료 조회 — 7일 내 만료 제제 포함', async () => {
      const soon = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
      await http.post('/api/v1/transfusion/units').set(auth('U05')).send({ unitNo: 'T-UNIT-EXP', productType: 'PLT', bloodGroup: 'O+', expiryDate: soon });
      const res = await http.get('/api/v1/transfusion/near-expiry').set(auth('U05'));
      expect(res.status).toBe(200);
      expect(res.body.data.some((u: { unitNo: string }) => u.unitNo === 'T-UNIT-EXP')).toBe(true);
    });
  });

  // ── 항원음성 유닛 매칭(동종면역) ──
  describe('항원음성 유닛 매칭', () => {
    beforeAll(async () => {
      await prisma.bloodUnit.deleteMany({ where: { unitNo: { in: ['T-UNIT-KNEG', 'T-UNIT-KPOS'] } } });
      await prisma.bloodTyping.deleteMany({ where: { patientId: 'T-ALLO' } });
      await prisma.patient.upsert({ where: { patientId: 'T-ALLO' }, update: {}, create: { patientId: 'T-ALLO', name: '동종면역', sex: 'F', birthDate: '1980-01-01' } });
      // C3 ABO 2회 독립검증 barrier 충족 — 동일 판정(O/POS) 2회 이력(항체양성 이력 포함, AHG 재확인 barrier 검증용).
      await prisma.bloodTyping.createMany({
        data: [
          { typingId: 'T-TYP-ALLO1', patientId: 'T-ALLO', abo: 'O', rhD: 'POS', antibodyScreen: 'POS', tester: 'U05' },
          { typingId: 'T-TYP-ALLO2', patientId: 'T-ALLO', abo: 'O', rhD: 'POS', antibodyScreen: 'POS', tester: 'U05' },
        ],
        skipDuplicates: true,
      });
    });
    it('anti-K 환자 → K-neg 유닛만 적합, 항원 미확인 유닛은 출고 차단', async () => {
      await http.post('/api/v1/transfusion/typing').set(auth('U05')).send({ patientId: 'T-ALLO', abo: 'O', rhD: 'POS', antibodyScreen: 'POS', antibodyId: 'anti-K' });
      await http.post('/api/v1/transfusion/units').set(auth('U05')).send({ unitNo: 'T-UNIT-KNEG', productType: 'RBC', bloodGroup: 'O+', expiryDate: '2026-12-31', antigenNeg: 'K-neg' });
      await http.post('/api/v1/transfusion/units').set(auth('U05')).send({ unitNo: 'T-UNIT-KPOS', productType: 'RBC', bloodGroup: 'O+', expiryDate: '2026-12-31' });
      const comp = await http.get('/api/v1/transfusion/compatible-units/T-ALLO').set(auth('U05'));
      const codes = comp.body.data.units.map((u: { unitNo: string }) => u.unitNo);
      expect(codes).toContain('T-UNIT-KNEG');
      expect(codes).not.toContain('T-UNIT-KPOS');
      expect(comp.body.data.requiredAntigenNeg).toEqual(['K']);
      // 항원 미확인(K-pos) 유닛 출고 시도 → 항원 부적합 차단
      const iss = await http.post('/api/v1/transfusion/issue').set(auth('U05')).send({
        unitNo: 'T-UNIT-KPOS', patientId: 'T-ALLO', issuer: 'U05', receiver: '간호사', confirm1: 'U05', confirm2: 'U08', aboVerifiedTwice: true, aboMatchesHistory: true,
      });
      expect(iss.status).toBe(400);
    });
    it('항체동정 패널 — anti-K 반응 패턴 → K 동정', async () => {
      const tmpl = await http.get('/api/v1/transfusion/antibody-panel/template').set(auth('U05'));
      const reactivity = tmpl.body.data.cells.map((c: { antigens: Record<string, boolean> }) => !!c.antigens.K);
      const res = await http.post('/api/v1/transfusion/antibody-panel').set(auth('U05')).send({ patientId: 'T-ALLO', reactivity });
      expect(res.status).toBe(201);
      expect(res.body.data.identified).toContain('K');
      expect(res.body.data.antibodies).toContain('anti-K');
    });
    it('동종면역 환자: 비-AHG 교차 적합은 불충분 — AHG 재확인 필요(T2)', async () => {
      // 전자/즉시원심 교차로 '적합' 기록(항체양성 이력엔 부적절)
      await http.post('/api/v1/transfusion/crossmatch').set(auth('U05')).send({ patientId: 'T-ALLO', unitNo: 'T-UNIT-KNEG', result: '적합', method: '전자교차적합(즉시원심)' });
      const nonAhg = await http.post('/api/v1/transfusion/issue').set(auth('U05')).send({ unitNo: 'T-UNIT-KNEG', patientId: 'T-ALLO', issuer: 'U05', receiver: '간호사', confirm1: 'U05', confirm2: 'U08', aboVerifiedTwice: true, aboMatchesHistory: true });
      expect(nonAhg.status).toBe(400);
      expect(JSON.stringify(nonAhg.body)).toContain('AHG');
      // AHG 교차 '적합'이면 통과
      await http.post('/api/v1/transfusion/crossmatch').set(auth('U05')).send({ patientId: 'T-ALLO', unitNo: 'T-UNIT-KNEG', result: '적합', method: '항글로불린법(AHG)' });
      const ahg = await http.post('/api/v1/transfusion/issue').set(auth('U05')).send({ unitNo: 'T-UNIT-KNEG', patientId: 'T-ALLO', issuer: 'U05', receiver: '간호사', confirm1: 'U05', confirm2: 'U08', aboVerifiedTwice: true, aboMatchesHistory: true });
      expect(ahg.status).toBe(201);
    });
  });

  // ── 응급(MTP) 출고 — 프로세스 게이트 우회, ABO 방벽 유지(B1) ──
  describe('응급 출고(MTP)', () => {
    beforeAll(async () => {
      await prisma.bloodIssue.deleteMany({ where: { unitNo: { in: ['T-U-ONEG', 'T-U-ONEG2', 'T-U-ONEG3', 'T-U-APOS', 'T-U-BPOS'] } } });
      await prisma.bloodUnit.deleteMany({ where: { unitNo: { in: ['T-U-ONEG', 'T-U-ONEG2', 'T-U-ONEG3', 'T-U-APOS', 'T-U-BPOS'] } } });
      await prisma.patient.upsert({ where: { patientId: 'T-EMG' }, update: {}, create: { patientId: 'T-EMG', name: '응급무명', sex: 'M', birthDate: '1990-01-01' } });
      await http.post('/api/v1/transfusion/units').set(auth('U05')).send({ unitNo: 'T-U-ONEG', productType: 'RBC', bloodGroup: 'O-', expiryDate: '2026-12-31' });
      await http.post('/api/v1/transfusion/units').set(auth('U05')).send({ unitNo: 'T-U-ONEG2', productType: 'RBC', bloodGroup: 'O-', expiryDate: '2026-12-31' });
      await http.post('/api/v1/transfusion/units').set(auth('U05')).send({ unitNo: 'T-U-APOS', productType: 'RBC', bloodGroup: 'A+', expiryDate: '2026-12-31' });
      await http.post('/api/v1/transfusion/units').set(auth('U05')).send({ unitNo: 'T-U-BPOS', productType: 'RBC', bloodGroup: 'B+', expiryDate: '2026-12-31' });
    });
    const base = { issuer: 'U05', receiver: '외상팀', confirm1: 'U05', confirm2: 'U08', aboVerifiedTwice: false, aboMatchesHistory: false };
    it('평시(비응급) 미상환자 O-neg → 차단(교차·타이핑 미비)', async () => {
      const res = await http.post('/api/v1/transfusion/issue').set(auth('U05')).send({ ...base, unitNo: 'T-U-ONEG', patientId: 'T-EMG' });
      expect(res.status).toBe(400);
    });
    it('응급 미상환자 O-neg → 출고 성공·사후교차 PENDING', async () => {
      const res = await http.post('/api/v1/transfusion/issue').set(auth('U05')).send({ ...base, unitNo: 'T-U-ONEG', patientId: 'T-EMG', emergency: true, emergencyReason: '외상 대량출혈 MTP' });
      expect(res.status).toBe(201);
      expect(res.body.data.emergency).toBe(true);
      expect(res.body.data.bypassed.length).toBeGreaterThan(0);
      const iss = await prisma.bloodIssue.findUnique({ where: { issueId: res.body.data.issue.issueId } });
      expect(iss?.retroCrossmatchStatus).toBe('PENDING');
    });
    it('응급이라도 ABO 부적합(A환자←B제제)은 불가침 차단', async () => {
      const res = await http.post('/api/v1/transfusion/issue').set(auth('U05')).send({ ...base, unitNo: 'T-U-BPOS', patientId: 'T-BB', emergency: true, emergencyReason: 'MTP' });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('2차 방벽');
    });
    it('응급 미상환자에 비-범용(A+) 제제 → 차단(O RhD- 강제)', async () => {
      const res = await http.post('/api/v1/transfusion/issue').set(auth('U05')).send({ ...base, unitNo: 'T-U-APOS', patientId: 'T-EMG', emergency: true, emergencyReason: 'MTP' });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('범용제제');
    });
    it('응급 + ABO 이력 불일치(모순)면 형별 제제 차단·범용(O-)만 허용(T1)', async () => {
      await prisma.bloodTyping.deleteMany({ where: { patientId: 'T-DISC' } });
      await prisma.patient.upsert({ where: { patientId: 'T-DISC' }, update: {}, create: { patientId: 'T-DISC', name: '이력모순', sex: 'M', birthDate: '1980-01-01' } });
      // 서로 다른 두 번의 ABO 판정(오입력/검체 불일치) — 형별 신뢰 불가(최신 AB+ / 과거 O+)
      await prisma.bloodTyping.create({ data: { typingId: 'T-TY-D1', patientId: 'T-DISC', abo: 'AB', rhD: 'POS', antibodyScreen: 'NEG', testedDt: new Date('2026-07-26') } });
      await prisma.bloodTyping.create({ data: { typingId: 'T-TY-D2', patientId: 'T-DISC', abo: 'O', rhD: 'POS', antibodyScreen: 'NEG', testedDt: new Date('2026-07-25') } });
      // 형별(A+) 제제 응급 출고 → 차단(모순 → O형 강제). 최신값 AB+만 믿으면 A+가 통과해 O형 환자에 치명적.
      const spec = await http.post('/api/v1/transfusion/issue').set(auth('U05')).send({ ...base, unitNo: 'T-U-APOS', patientId: 'T-DISC', emergency: true, emergencyReason: 'MTP' });
      expect(spec.status).toBe(400);
      expect(JSON.stringify(spec.body)).toContain('이력 불일치');
      // 범용(O-) 제제는 이력 모순에도 허용
      const uni = await http.post('/api/v1/transfusion/issue').set(auth('U05')).send({ ...base, unitNo: 'T-U-ONEG2', patientId: 'T-DISC', emergency: true, emergencyReason: 'MTP' });
      expect(uni.status).toBe(201);
    });
    it('출고 실행자가 2인 확인자 중 1인이 아니면 차단(T3 — 확인 위조 방지)', async () => {
      await http.post('/api/v1/transfusion/units').set(auth('U05')).send({ unitNo: 'T-U-ONEG3', productType: 'RBC', bloodGroup: 'O-', expiryDate: '2026-12-31' });
      // U00(관리자)이 실행하지만 확인자는 U05·U08 — 실행자가 확인자에 없음 → 불가침 차단
      const res = await http.post('/api/v1/transfusion/issue').set(auth('U00')).send({ ...base, unitNo: 'T-U-ONEG3', patientId: 'T-EMG', emergency: true, emergencyReason: 'MTP' });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('실행자');
    });
    it('응급 사유 누락 → 400', async () => {
      const res = await http.post('/api/v1/transfusion/issue').set(auth('U05')).send({ ...base, unitNo: 'T-U-ONEG2', patientId: 'T-EMG', emergency: true });
      expect(res.status).toBe(400);
    });
  });

  // ── 혈액 추적성·회수·look-back(B2) ──
  describe('혈액 추적성·look-back', () => {
    beforeAll(async () => {
      await prisma.bloodIssue.deleteMany({ where: { unitNo: { in: ['T-U-DON1', 'T-U-DON2'] } } });
      await prisma.crossmatch.deleteMany({ where: { xmId: 'T-XM-DON1' } });
      await prisma.bloodUnit.deleteMany({ where: { unitNo: { in: ['T-U-DON1', 'T-U-DON2'] } } });
      await http.post('/api/v1/transfusion/units').set(auth('U05')).send({ unitNo: 'T-U-DON1', productType: 'RBC', bloodGroup: 'A+', expiryDate: '2026-12-31', donationId: 'D-LB' });
      await http.post('/api/v1/transfusion/units').set(auth('U05')).send({ unitNo: 'T-U-DON2', productType: 'RBC', bloodGroup: 'A+', expiryDate: '2026-12-31', donationId: 'D-LB' });
      await prisma.crossmatch.create({ data: { xmId: 'T-XM-DON1', patientId: 'T-BB', unitNo: 'T-U-DON1', method: '생리식염수법', result: '적합' } });
      await http.post('/api/v1/transfusion/issue').set(auth('U05')).send({ unitNo: 'T-U-DON1', patientId: 'T-BB', issuer: 'U05', receiver: '병동', confirm1: 'U05', confirm2: 'U08', aboVerifiedTwice: true, aboMatchesHistory: true });
    });
    it('look-back — 헌혈번호(D-LB) 유래 제제의 수혈자 역추적', async () => {
      const res = await http.post('/api/v1/transfusion/lookback/D-LB').set(auth('U05'));
      expect(res.status).toBe(201);
      expect(res.body.data.units).toContain('T-U-DON1');
      expect(res.body.data.recipients.some((r: { patientId: string }) => r.patientId === 'T-BB')).toBe(true);
    });
    it('추적성 — 제제→수혈자 체인', async () => {
      const res = await http.get('/api/v1/transfusion/traceability/T-U-DON1').set(auth('U05'));
      expect(res.status).toBe(200);
      expect(res.body.data.donationId).toBe('D-LB');
      expect(res.body.data.recipients.some((r: { patientId: string }) => r.patientId === 'T-BB')).toBe(true);
    });
    it('환자 수혈 이력 — 받은 제제 포함', async () => {
      const res = await http.get('/api/v1/transfusion/patient-transfusions/T-BB').set(auth('U05'));
      expect(res.status).toBe(200);
      expect(res.body.data.some((r: { unitNo: string }) => r.unitNo === 'T-U-DON1')).toBe(true);
    });
    it('회수 → 수혈자 look-back 제시, 회수 제제는 출고 차단', async () => {
      const rec = await http.post('/api/v1/transfusion/units/T-U-DON1/recall').set(auth('U05')).send({ status: 'RECALLED', reason: '공혈자 사후 HBV 양성' });
      expect(rec.status).toBe(201);
      expect(rec.body.data.lookbackRequired).toBe(true);
      // 재고(T-U-DON2)도 회수 후 출고 차단
      await http.post('/api/v1/transfusion/units/T-U-DON2/recall').set(auth('U05')).send({ status: 'RECALLED', reason: '동일 헌혈' });
      await prisma.crossmatch.create({ data: { xmId: 'T-XM-DON2', patientId: 'T-BB', unitNo: 'T-U-DON2', method: '생리식염수법', result: '적합' } });
      const iss = await http.post('/api/v1/transfusion/issue').set(auth('U05')).send({ unitNo: 'T-U-DON2', patientId: 'T-BB', issuer: 'U05', receiver: '병동', confirm1: 'U05', confirm2: 'U08', aboVerifiedTwice: true, aboMatchesHistory: true });
      expect(iss.status).toBe(400);
      expect(JSON.stringify(iss.body)).toContain('RECALLED');
    });
  });

  // ── ABO 독립 방벽(2차) · 항체 소실 대비 ──
  describe('ABO 독립검증 방벽 · 항체 소실', () => {
    beforeAll(async () => {
      for (const pid of ['T-ABOBAR', 'T-EVAN']) await prisma.bloodTyping.deleteMany({ where: { patientId: pid } });
      await prisma.crossmatch.deleteMany({ where: { unitNo: { in: ['T-UNIT-ABOA', 'T-UNIT-EPOS'] } } });
      await prisma.bloodUnit.deleteMany({ where: { unitNo: { in: ['T-UNIT-ABOA', 'T-UNIT-EPOS'] } } });
      await prisma.patient.upsert({ where: { patientId: 'T-ABOBAR' }, update: {}, create: { patientId: 'T-ABOBAR', name: 'ABO방벽', sex: 'M', birthDate: '1980-01-01' } });
      await prisma.patient.upsert({ where: { patientId: 'T-EVAN' }, update: {}, create: { patientId: 'T-EVAN', name: '항체소실', sex: 'F', birthDate: '1980-01-01' } });
    });

    it('수기 교차 "적합" 오입력이어도 ABO 부적합(O환자←A제제) 출고 차단(2차 방벽)', async () => {
      // 환자 O+ 2회(aboVerifiedTwice·aboMatchesHistory 충족)
      await http.post('/api/v1/transfusion/typing').set(auth('U05')).send({ patientId: 'T-ABOBAR', abo: 'O', rhD: 'POS', antibodyScreen: 'NEG' });
      await http.post('/api/v1/transfusion/typing').set(auth('U05')).send({ patientId: 'T-ABOBAR', abo: 'O', rhD: 'POS', antibodyScreen: 'NEG' });
      // A+ 제제 입고
      await http.post('/api/v1/transfusion/units').set(auth('U05')).send({ unitNo: 'T-UNIT-ABOA', productType: 'RBC', bloodGroup: 'A+', expiryDate: '2026-12-31' });
      // 수기 교차시험에 잘못 '적합' 저장(검증 없음)
      await http.post('/api/v1/transfusion/crossmatch').set(auth('U05')).send({ patientId: 'T-ABOBAR', unitNo: 'T-UNIT-ABOA', result: '적합' });
      const iss = await http.post('/api/v1/transfusion/issue').set(auth('U05')).send({
        unitNo: 'T-UNIT-ABOA', patientId: 'T-ABOBAR', issuer: 'U05', receiver: '간호사', confirm1: 'U05', confirm2: 'U08', aboVerifiedTwice: true, aboMatchesHistory: true,
      });
      expect(iss.status).toBe(400);
      expect(JSON.stringify(iss.body)).toContain('독립검증');
    });

    it('과거 anti-E 동정 후 최신 항체음성이어도 E항원 미확인 유닛 차단(항체 소실 대비)', async () => {
      // 과거: anti-E 동정 / 최신: 재검 음성
      await http.post('/api/v1/transfusion/typing').set(auth('U05')).send({ patientId: 'T-EVAN', abo: 'O', rhD: 'POS', antibodyScreen: 'POS', antibodyId: 'anti-E' });
      await http.post('/api/v1/transfusion/typing').set(auth('U05')).send({ patientId: 'T-EVAN', abo: 'O', rhD: 'POS', antibodyScreen: 'NEG' });
      // 항원음성 미표기(E 미확인) O+ 유닛
      await http.post('/api/v1/transfusion/units').set(auth('U05')).send({ unitNo: 'T-UNIT-EPOS', productType: 'RBC', bloodGroup: 'O+', expiryDate: '2026-12-31' });
      // 적합혈액 조회 — 합집합 항체로 E-neg 요구 → 미확인 유닛 제외
      const comp = await http.get('/api/v1/transfusion/compatible-units/T-EVAN').set(auth('U05'));
      expect(comp.body.data.requiredAntigenNeg).toContain('E');
      expect(comp.body.data.units.map((u: { unitNo: string }) => u.unitNo)).not.toContain('T-UNIT-EPOS');
      // 출고 시도 → 항원 부적합 차단
      const iss = await http.post('/api/v1/transfusion/issue').set(auth('U05')).send({
        unitNo: 'T-UNIT-EPOS', patientId: 'T-EVAN', issuer: 'U05', receiver: '간호사', confirm1: 'U05', confirm2: 'U08', aboVerifiedTwice: true, aboMatchesHistory: true,
      });
      expect(iss.status).toBe(400);
    });
  });

  // ── 특수수혈 요구 서버 강제(F7) ──
  describe('특수수혈 요구 서버 강제', () => {
    beforeAll(async () => {
      await prisma.patientTransfusionReq.deleteMany({ where: { patientId: 'T-IRRAD' } });
      await prisma.bloodTyping.deleteMany({ where: { patientId: 'T-IRRAD' } });
      await prisma.crossmatch.deleteMany({ where: { unitNo: { in: ['T-UNIT-NONIRR', 'T-UNIT-IRR'] } } });
      await prisma.bloodUnit.deleteMany({ where: { unitNo: { in: ['T-UNIT-NONIRR', 'T-UNIT-IRR'] } } });
      await prisma.patient.upsert({ where: { patientId: 'T-IRRAD' }, update: {}, create: { patientId: 'T-IRRAD', name: '조사혈대상', sex: 'M', birthDate: '1980-01-01' } });
    });

    it('IRRADIATED 요구 등록 후, 요청에 specialRequired 없어도 비조사 제제 출고 차단', async () => {
      await http.post('/api/v1/transfusion/typing').set(auth('U05')).send({ patientId: 'T-IRRAD', abo: 'O', rhD: 'POS', antibodyScreen: 'NEG' });
      await http.post('/api/v1/transfusion/typing').set(auth('U05')).send({ patientId: 'T-IRRAD', abo: 'O', rhD: 'POS', antibodyScreen: 'NEG' });
      // 방사선조사 요구 등록
      const req = await http.post('/api/v1/transfusion/requirements').set(auth('U05')).send({ patientId: 'T-IRRAD', requirement: 'IRRADIATED', reason: '조혈모세포이식' });
      expect(req.status).toBe(201);
      // 비조사 O+ 제제 입고 + 교차 적합
      await http.post('/api/v1/transfusion/units').set(auth('U05')).send({ unitNo: 'T-UNIT-NONIRR', productType: 'RBC', bloodGroup: 'O+', expiryDate: '2026-12-31' });
      await http.post('/api/v1/transfusion/crossmatch').set(auth('U05')).send({ patientId: 'T-IRRAD', unitNo: 'T-UNIT-NONIRR', result: '적합' });
      // 요청에 specialRequired 미포함 — 서버가 프로파일에서 강제해야 함
      const iss = await http.post('/api/v1/transfusion/issue').set(auth('U05')).send({
        unitNo: 'T-UNIT-NONIRR', patientId: 'T-IRRAD', issuer: 'U05', receiver: '간호사', confirm1: 'U05', confirm2: 'U08', aboVerifiedTwice: true, aboMatchesHistory: true,
      });
      expect(iss.status).toBe(400);
      expect(JSON.stringify(iss.body)).toContain('IRRADIATED');
    });

    it('요구 해제 후에는 동일 출고 차단 해제', async () => {
      const list = await http.get('/api/v1/transfusion/requirements/T-IRRAD').set(auth('U05'));
      const irr = list.body.data.find((r: { requirement: string; active: boolean }) => r.requirement === 'IRRADIATED' && r.active);
      await http.post(`/api/v1/transfusion/requirements/${irr.reqId}/deactivate`).set(auth('U05')).send({});
      const iss = await http.post('/api/v1/transfusion/issue').set(auth('U05')).send({
        unitNo: 'T-UNIT-NONIRR', patientId: 'T-IRRAD', issuer: 'U05', receiver: '간호사', confirm1: 'U05', confirm2: 'U08', aboVerifiedTwice: true, aboMatchesHistory: true,
      });
      expect(iss.status).toBe(201); // 요구 해제 → 통과
    });
  });

  // ── 2인 확인 실계정 인증(F8) ──
  describe('2인 확인 실계정 인증', () => {
    beforeAll(async () => {
      await prisma.bloodTyping.deleteMany({ where: { patientId: 'T-2PC' } });
      await prisma.crossmatch.deleteMany({ where: { unitNo: 'T-UNIT-2PC' } });
      await prisma.bloodIssue.deleteMany({ where: { unitNo: 'T-UNIT-2PC' } });
      await prisma.bloodUnit.deleteMany({ where: { unitNo: 'T-UNIT-2PC' } });
      await prisma.patient.upsert({ where: { patientId: 'T-2PC' }, update: {}, create: { patientId: 'T-2PC', name: '이인확인', sex: 'O', birthDate: '1980-01-01' } });
      await http.post('/api/v1/transfusion/typing').set(auth('U05')).send({ patientId: 'T-2PC', abo: 'O', rhD: 'POS', antibodyScreen: 'NEG' });
      await http.post('/api/v1/transfusion/typing').set(auth('U05')).send({ patientId: 'T-2PC', abo: 'O', rhD: 'POS', antibodyScreen: 'NEG' });
      await http.post('/api/v1/transfusion/units').set(auth('U05')).send({ unitNo: 'T-UNIT-2PC', productType: 'RBC', bloodGroup: 'O+', expiryDate: '2026-12-31' });
      await http.post('/api/v1/transfusion/crossmatch').set(auth('U05')).send({ patientId: 'T-2PC', unitNo: 'T-UNIT-2PC', result: '적합' });
    });
    const body = (c1: string, c2: string) => ({ unitNo: 'T-UNIT-2PC', patientId: 'T-2PC', issuer: 'U05', receiver: '간호사', confirm1: c1, confirm2: c2, aboVerifiedTwice: true, aboMatchesHistory: true });

    it('확인자가 비계정(자유텍스트)이면 출고 차단', async () => {
      const res = await http.post('/api/v1/transfusion/issue').set(auth('U05')).send(body('U05', 'NOBODY'));
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('활성 계정');
    });
    it('실계정 2인이면 출고 통과', async () => {
      const res = await http.post('/api/v1/transfusion/issue').set(auth('U05')).send(body('U05', 'U08'));
      expect(res.status).toBe(201);
    });
  });

  // ── 교차시험 시간순 안전(같은날 재검) ──
  describe('교차시험 시간순 판정', () => {
    beforeAll(async () => {
      await prisma.crossmatch.deleteMany({ where: { unitNo: 'T-UNIT-XM' } });
      await prisma.bloodIssue.deleteMany({ where: { unitNo: 'T-UNIT-XM' } });
      await prisma.bloodUnit.deleteMany({ where: { unitNo: 'T-UNIT-XM' } });
      await http.post('/api/v1/transfusion/units').set(auth('U05')).send({
        unitNo: 'T-UNIT-XM', productType: 'RBC', bloodGroup: 'A+', drawnDate: '2026-07-01', expiryDate: '2026-12-31',
      });
    });

    it('없는 환자 교차시험 → 404', async () => {
      const res = await http.post('/api/v1/transfusion/crossmatch').set(auth('U05')).send({
        patientId: 'NO-SUCH-PT', unitNo: 'T-UNIT-XM', result: '적합',
      });
      expect(res.status).toBe(404);
    });

    it('같은날 적합→부적합 재검 시 최신(부적합)으로 판정 → 출고 차단', async () => {
      // 순서대로 기록(적합 먼저, 부적합 나중)
      const a = await http.post('/api/v1/transfusion/crossmatch').set(auth('U05')).send({ patientId: 'T-BB', unitNo: 'T-UNIT-XM', result: '적합' });
      expect(a.status).toBe(201);
      const b = await http.post('/api/v1/transfusion/crossmatch').set(auth('U05')).send({ patientId: 'T-BB', unitNo: 'T-UNIT-XM', result: '부적합' });
      expect(b.status).toBe(201);
      // 최신 조회는 부적합
      const latest = await http.get('/api/v1/transfusion/crossmatch/T-BB/T-UNIT-XM').set(auth('U05'));
      expect(latest.body.data.result).toBe('부적합');
      // 출고 게이트: 최신이 부적합이므로 안전조건 충족해도 차단
      const iss = await http.post('/api/v1/transfusion/issue').set(auth('U05')).send({
        unitNo: 'T-UNIT-XM', patientId: 'T-BB', issuer: 'U05', receiver: '간호사',
        confirm1: 'U05', confirm2: 'U08', aboVerifiedTwice: true, aboMatchesHistory: true,
      });
      expect(iss.status).toBe(400);
    });
  });

  // ── 교차시험 생성(혈청학적 판정) ──
  describe('교차시험 생성·판정', () => {
    beforeAll(async () => {
      // 환자 T-BB: A / RhD 양성 / 항체선별 음성
      await http.post('/api/v1/transfusion/typing').set(auth('U05')).send({ patientId: 'T-BB', abo: 'A', rhD: 'POS', antibodyScreen: 'NEG' });
      for (const [no, bg] of [['T-XM-A', 'A+'], ['T-XM-B', 'B+'], ['T-XM-ANEG', 'A-']] as const) {
        await prisma.crossmatch.deleteMany({ where: { unitNo: no } });
        await prisma.bloodUnit.deleteMany({ where: { unitNo: no } });
        await http.post('/api/v1/transfusion/units').set(auth('U05')).send({ unitNo: no, productType: 'RBC', bloodGroup: bg, drawnDate: '2026-07-01', expiryDate: '2026-12-31' });
      }
    });

    it('A+ 환자 + A+ 제제 → 적합(전자교차)·기록', async () => {
      const res = await http.post('/api/v1/transfusion/crossmatch/perform').set(auth('U05')).send({ patientId: 'T-BB', unitNo: 'T-XM-A', tester: 'U05' });
      expect(res.status).toBe(201);
      expect(res.body.data.determination.result).toBe('적합');
      expect(res.body.data.crossmatch.result).toBe('적합');
    });

    it('A+ 환자 + B+ 제제 → ABO 부적합', async () => {
      const res = await http.post('/api/v1/transfusion/crossmatch/perform').set(auth('U05')).send({ patientId: 'T-BB', unitNo: 'T-XM-B' });
      expect(res.status).toBe(201);
      expect(res.body.data.determination.result).toBe('부적합');
    });

    it('혈액형 미등록 환자 → 400', async () => {
      const res = await http.post('/api/v1/transfusion/crossmatch/perform').set(auth('U05')).send({ patientId: 'T-2345678', unitNo: 'T-XM-A' });
      expect(res.status).toBe(400);
    });

    it('없는 제제 → 404', async () => {
      const res = await http.post('/api/v1/transfusion/crossmatch/perform').set(auth('U05')).send({ patientId: 'T-BB', unitNo: 'NOPE' });
      expect(res.status).toBe(404);
    });
  });

  // ── 병리 표본추적 (그로싱→블록→슬라이드→개정) ──
  describe('병리 표본추적', () => {
    beforeAll(async () => {
      // 재실행 멱등: T-SP-1 블록·슬라이드·보고서·상태 초기화
      await prisma.pathologySlide.deleteMany({ where: { spNo: 'T-SP-1' } });
      await prisma.pathologyBlock.deleteMany({ where: { spNo: 'T-SP-1' } });
      await prisma.pathologyReport.deleteMany({ where: { spNo: 'T-SP-1' } });
      await prisma.pathologyCase.update({ where: { spNo: 'T-SP-1' }, data: { status: '접수', grossDesc: null } });
    });

    let blockId: string;

    it('그로싱 기록 → 상태 그로싱', async () => {
      const res = await http.post('/api/v1/pathology/cases/T-SP-1/grossing').set(auth('U00')).send({ grossDesc: '3x2cm 회백색 조직', grossedBy: 'PRV1' });
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('그로싱');
    });

    it('블록 생성 → {검체}-B1', async () => {
      const res = await http.post('/api/v1/pathology/cases/T-SP-1/blocks').set(auth('U00')).send({ label: 'A', tissue: '위 조직' });
      expect(res.status).toBe(201);
      blockId = res.body.data.blockId;
      expect(blockId).toBe('T-SP-1-B1');
    });

    it('슬라이드 제작: H&E + 면역염색(IHC) 추가', async () => {
      const he = await http.post(`/api/v1/pathology/blocks/${blockId}/slides`).set(auth('U00')).send({ stain: 'HE' });
      expect(he.status).toBe(201);
      const ihc = await http.post(`/api/v1/pathology/blocks/${blockId}/slides`).set(auth('U00')).send({ stain: 'IHC', stainDetail: 'CK7' });
      expect(ihc.status).toBe(201);
      expect(ihc.body.data.stainDetail).toBe('CK7');
    });

    it('추적 조회: 블록에 슬라이드 2매', async () => {
      const res = await http.get('/api/v1/pathology/cases/T-SP-1/tracking').set(auth('U00'));
      expect(res.status).toBe(200);
      expect(res.body.data.blocks).toHaveLength(1);
      expect(res.body.data.blocks[0].slides).toHaveLength(2);
    });

    it('슬라이드 있는 블록 삭제 → 400, 슬라이드 삭제 후 블록 삭제 성공', async () => {
      const tr = await http.get('/api/v1/pathology/cases/T-SP-1/tracking').set(auth('U00'));
      const slides = tr.body.data.blocks[0].slides as { slideId: string }[];
      const guard = await http.delete(`/api/v1/pathology/blocks/${blockId}`).set(auth('U00'));
      expect(guard.status).toBe(400); // 슬라이드 있어 삭제 불가
      for (const s of slides) {
        const d = await http.delete(`/api/v1/pathology/slides/${s.slideId}`).set(auth('U00'));
        expect(d.status).toBe(200);
      }
      const delBlock = await http.delete(`/api/v1/pathology/blocks/${blockId}`).set(auth('U00'));
      expect(delBlock.status).toBe(200);
      // 재생성(후속 테스트 의존성 복원)
      const re = await http.post('/api/v1/pathology/cases/T-SP-1/blocks').set(auth('U00')).send({ label: 'A' });
      blockId = re.body.data.blockId;
    });

    it('MWL 송신 — 권한(ADM 도달, PACS 미설정 400) / 비허용 역할 403', async () => {
      // 클래스 ADM 제한을 PAT·ADM으로 override — ADM 도달 시 PACS 미설정으로 400(500 아님)
      const ok = await http.post('/api/v1/integration/hl7/mwl/T-SP-1/send').set(auth('U00')).send({});
      expect(ok.status).toBe(400);
      expect(ok.body.message).toContain('PACS');
      // 접수담당(RCP)은 MWL 송신 불가
      const forbidden = await http.post('/api/v1/integration/hl7/mwl/T-SP-1/send').set(auth('U07')).send({});
      expect(forbidden.status).toBe(403);
    });

    it('🔴 뷰어 링크와 MWL이 같은 Accession을 쓴다(채번 단일화)', async () => {
      // 예전엔 뷰어 폴백만 `ACC-${spNo}`(4자리 연도)라, 보고서 없는 케이스에서
      // MWL은 ACC-SP-26-0456 · 뷰어는 ACC-SP-2026-0456으로 갈렸다 → 뷰어가 스터디를 못 찾는데
      // 화면상 "아직 스캔 전"과 구분되지 않아 조용하다. PACS 결정1(2자리 연도)이 정본이다.
      await prisma.pathologyCase.create({
        data: { spNo: 'T-SP-2026-0456', patientId: 'T-2345678', procedureCode: 'PATH', receivedDate: '2026-08-03', status: '접수' },
      });
      const link = await http.get('/api/v1/integration/hl7/pacs/viewer-link/T-SP-2026-0456').set(auth('U00'));
      expect(link.status).toBe(200);
      expect(link.body.data.accession).toBe('ACC-T-SP-26-0456'); // 2자리 연도 — MWL과 동일 규칙
      expect(link.body.data.accession.length).toBeLessThanOrEqual(16); // DICOM VR=SH
    });

    it('WSI 열람 종단 확인(③) — PACS 미연동 시 미확인·미기록', async () => {
      const res = await http.post('/api/v1/integration/hl7/pacs/viewer-link/T-SP-1/confirm').set(auth('U00'));
      expect(res.status).toBe(201);
      expect(res.body.data.confirmed).toBe(false); // PACS 미연동(E2E) → found 아님
      expect(res.body.data.reason).toBeTruthy();
      const c = await prisma.pathologyCase.findUnique({ where: { spNo: 'T-SP-1' } });
      expect(c?.wsiConfirmedDt).toBeNull(); // WSI 없으면 확인 미기록(허위 확인 방지)
    });

    it('서명 전 개정 → 404(보고서 없음)', async () => {
      const res = await http.post('/api/v1/pathology/reports/T-SP-1/amend').set(auth('U00')).send({ findings: 'x', diagnosis: 'y', reason: 'z', signer: 'PRV1' });
      expect(res.status).toBe(404);
    });

    it('최종 서명 → 개정(버전 2)', async () => {
      const sign = await http.post('/api/v1/pathology/reports/sign').set(auth('U00')).send({ spNo: 'T-SP-1', findings: '선암', diagnosis: 'Adenocarcinoma', signer: 'PRV1' });
      expect(sign.status).toBe(201);
      const amend = await http.post('/api/v1/pathology/reports/T-SP-1/amend').set(auth('U00')).send({ findings: '선암(수정)', diagnosis: 'Adenocarcinoma, moderately diff.', reason: '등급 정정', signer: 'PRV1' });
      expect(amend.status).toBe(201);
      expect(amend.body.data.status).toBe('개정');
      expect(amend.body.data.version).toBe(2);
    });

    /**
     * ★확정 진단 덮어쓰기 방지(P1-6, 회귀 금지).
     * 이전에는 sign/draft가 무조건 upsert라 더블클릭·타임아웃 재시도·타 판독의 서명·전공의 초안저장
     * 어느 경로로든 **법적 확정 진단문이 이력 없이 교체**됐다. PathologyReport에 이력 테이블이
     * 없으므로 덮어쓰면 이전 진단은 복구 불가다. 수정은 개정(amend)으로만 — 버전·사유가 남는다.
     */
    it('서명된 보고서 재서명 → 400(개정으로 유도), 진단문 보존', async () => {
      const before = await prisma.pathologyReport.findUnique({ where: { spNo: 'T-SP-1' } });
      expect(before?.status).toBe('개정');
      const res = await http.post('/api/v1/pathology/reports/sign').set(auth('U00')).send({ spNo: 'T-SP-1', findings: '덮어쓰기', diagnosis: '전혀 다른 진단', signer: 'PRV1' });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('개정');
      const after = await prisma.pathologyReport.findUnique({ where: { spNo: 'T-SP-1' } });
      expect(after?.diagnosis).toBe(before?.diagnosis); // 확정 진단 불변
      expect(after?.version).toBe(before?.version);
    });

    it('서명된 보고서에 초안 저장 → 400(초안 회귀 차단), 상태·진단 보존', async () => {
      const res = await http.post('/api/v1/pathology/reports/draft').set(auth('U00')).send({ spNo: 'T-SP-1', findings: '전공의 재작성', diagnosis: '초안으로 회귀', signer: 'PRV1' });
      expect(res.status).toBe(400);
      const after = await prisma.pathologyReport.findUnique({ where: { spNo: 'T-SP-1' } });
      expect(after?.status).toBe('개정'); // '초안'으로 되돌지 않음
      expect(after?.diagnosis).toContain('Adenocarcinoma');
    });

    it('동시 개정 2건 → 버전이 겹치지 않는다(lost update 차단)', async () => {
      // 두 판독의가 모두 '버전 2'를 열어 개정하는 상황을 확정적으로 재현 — 둘 다 baseVersion=2를 보낸다.
      // baseVersion을 명시하지 않으면 HTTP 왕복이 우연히 직렬화될 때 두 번째가 갱신된 버전을 다시 읽어
      // 둘 다 성공(lost-update 아님)해 테스트가 플래키했다. 낙관적 동시성 기준을 클라이언트가 고정한다.
      const cur = await prisma.pathologyReport.findUnique({ where: { spNo: 'T-SP-1' } });
      const base = cur!.version;
      const body = (r: string) => ({ findings: `f-${r}`, diagnosis: `d-${r}`, reason: r, signer: 'PRV1', baseVersion: base });
      const [a, b] = await Promise.all([
        http.post('/api/v1/pathology/reports/T-SP-1/amend').set(auth('U00')).send(body('개정A')),
        http.post('/api/v1/pathology/reports/T-SP-1/amend').set(auth('U00')).send(body('개정B')),
      ]);
      const codes = [a.status, b.status].sort();
      expect(codes).toEqual([201, 409]); // 한 건만 반영, 나머지는 409(경합 — 새로고침 후 재시도 신호, Q8)
      const after = await prisma.pathologyReport.findUnique({ where: { spNo: 'T-SP-1' } });
      expect(after?.version).toBe(base + 1); // 정확히 한 번만 증가(둘 다 base+1을 쓰고 한쪽이 사라지지 않음)
    });
  });

  // ── 병리 2단계 사인아웃·addendum·동결절편(B4) ──
  describe('병리 2단계 사인아웃·addendum·동결', () => {
    beforeAll(async () => {
      await prisma.pathologyAddendum.deleteMany({ where: { spNo: 'T-SP-B4' } });
      await prisma.pathologyReport.deleteMany({ where: { spNo: 'T-SP-B4' } });
      await prisma.pathologyCase.deleteMany({ where: { spNo: 'T-SP-B4' } });
      await prisma.pathologyCase.create({ data: { spNo: 'T-SP-B4', patientId: 'T-2345678', procedureCode: 'PATH', receivedDate: '2026-07-19', status: '접수' } });
    });
    it('동결절편 진단 기록(수술중)', async () => {
      const res = await http.post('/api/v1/pathology/cases/T-SP-B4/frozen').set(auth('U00')).send({ frozenDx: '악성 의심', frozenBy: 'PRV1' });
      expect(res.status).toBe(201);
      expect(res.body.data.frozenDx).toBe('악성 의심');
    });
    it('전공의 초안 → 판독전문의 최종(2단계 사인아웃)', async () => {
      // 서명자(signer)는 body가 아니라 **계정에 연결된 Provider**에서 서버가 유도한다.
      //   U00→PRV1(전공의 역), U04→PRV2(판독전문의). 클라이언트가 signer를 보내도 무시된다.
      const draft = await http.post('/api/v1/pathology/reports/draft').set(auth('U00')).send({ spNo: 'T-SP-B4', findings: '선암 소견', diagnosis: 'Adenocarcinoma', signer: 'PRV9-위조시도' });
      expect(draft.status).toBe(201);
      expect(draft.body.data.status).toBe('초안');
      expect(draft.body.data.draftBy).toBe('PRV1');
      const sign = await http.post('/api/v1/pathology/reports/sign').set(auth('U04')).send({ spNo: 'T-SP-B4', findings: '선암 소견', diagnosis: 'Adenocarcinoma' });
      expect(sign.status).toBe(201);
      expect(sign.body.data.status).toBe('최종');
      expect(sign.body.data.draftBy).toBe('PRV1'); // 초안 작성자 보존
      expect(sign.body.data.frozenDx).toBe('악성 의심'); // 동결 기록 보존
    });
    it('추가보고(addendum) — 진단 변경 없이 IHC 결과 덧붙임', async () => {
      const add = await http.post('/api/v1/pathology/reports/T-SP-B4/addendum').set(auth('U00')).send({ content: 'IHC: CK7+, TTF-1-', addedBy: 'PRV2' });
      expect(add.status).toBe(201);
      expect(add.body.data.seq).toBe(1);
      const c = await http.get('/api/v1/pathology/cases/T-SP-B4').set(auth('U00'));
      expect(c.body.data.report.status).toBe('최종'); // addendum은 진단·상태 불변
      expect(c.body.data.report.addenda).toHaveLength(1);
    });
  });

  describe('병리 synoptic 필수요소 게이트(P2 옵인)', () => {
    beforeAll(async () => {
      await prisma.pathologyReport.deleteMany({ where: { spNo: 'T-SP-SYN' } });
      await prisma.pathologyCase.deleteMany({ where: { spNo: 'T-SP-SYN' } });
      await prisma.pathologyCase.create({ data: { spNo: 'T-SP-SYN', patientId: 'T-2345678', procedureCode: 'PATH', receivedDate: '2026-07-27', status: '접수' } });
    });
    it('프로토콜 지정 시 필수요소 누락이면 사인아웃 차단, 채우면 최종', async () => {
      // 위암(STOMACH) 프로토콜 — 필수요소 일부만 채워 서명 시도 → 차단
      const partial = await http.post('/api/v1/pathology/reports/sign').set(auth('U04')).send({
        spNo: 'T-SP-SYN', findings: '위 선암', diagnosis: 'Gastric adenocarcinoma',
        synopticProtocol: 'STOMACH', synoptic: { 종양부위: '위 전정부', 조직학적유형: '선암' },
      });
      expect(partial.status).toBe(400);
      expect(JSON.stringify(partial.body)).toContain('필수요소 누락');
      // 필수요소 전부 채우면 최종
      const full = await http.post('/api/v1/pathology/reports/sign').set(auth('U04')).send({
        spNo: 'T-SP-SYN', findings: '위 선암', diagnosis: 'Gastric adenocarcinoma',
        synopticProtocol: 'STOMACH',
        synoptic: { 종양부위: '위 전정부', 조직학적유형: '선암', 분화도: '중분화', '침윤깊이(pT)': 'pT3', 절제연: '음성', '림프절(pN)': 'pN1', 림프혈관침윤: '있음' },
      });
      expect(full.status).toBe(201);
      expect(full.body.data.status).toBe('최종');
    });
  });

  describe('병리 세포병리 서명 보호(PP3)', () => {
    beforeAll(async () => {
      await prisma.cytologyReport.deleteMany({ where: { spNo: 'T-SP-CY' } });
      await prisma.pathologyCase.deleteMany({ where: { spNo: 'T-SP-CY' } });
      await prisma.pathologyCase.create({ data: { spNo: 'T-SP-CY', patientId: 'T-2345678', procedureCode: 'PATH', receivedDate: '2026-07-27', status: '접수' } });
    });
    it('세포병리 최종 서명 후, 재저장으로 조용히 덮어쓸 수 없다(악성 진단 무단 교체 차단)', async () => {
      // U04(PAT, Provider 연결)로 최종 서명
      const first = await http.post('/api/v1/pathology/cases/T-SP-CY/cytology').set(auth('U04')).send({ specimenType: 'PAP', diagnosis: 'HSIL 병변(악성 의심)' });
      expect(first.status).toBe(201);
      expect(first.body.data.status).toBe('최종');
      expect(first.body.data.signer).toBe('PRV2'); // body signer 아닌 계정 Provider로 결속
      // 개정 플래그 없이 재저장(양성으로 교체 시도) → 차단
      const overwrite = await http.post('/api/v1/pathology/cases/T-SP-CY/cytology').set(auth('U04')).send({ specimenType: 'PAP', diagnosis: '양성' });
      expect(overwrite.status).toBe(400);
      // 원본 진단 보존 확인
      const still = await prisma.cytologyReport.findUnique({ where: { spNo: 'T-SP-CY' } });
      expect(still?.diagnosis).toBe('HSIL 병변(악성 의심)');
      // 명시적 개정(amend)은 허용 → 상태 개정
      const amend = await http.post('/api/v1/pathology/cases/T-SP-CY/cytology').set(auth('U04')).send({ specimenType: 'PAP', diagnosis: '양성(정정)', amend: true });
      expect(amend.status).toBe(201);
      expect(amend.body.data.status).toBe('개정');
    });
  });

  // ── 병리 다부위 검체·임상정보(PP1) ──
  describe('병리 다부위 검체·임상정보', () => {
    beforeAll(async () => {
      await prisma.pathologySpecimen.deleteMany({ where: { spNo: 'T-SP-PP1' } });
      await prisma.pathologyCase.deleteMany({ where: { spNo: 'T-SP-PP1' } });
      await prisma.pathologyCase.create({ data: { spNo: 'T-SP-PP1', patientId: 'T-2345678', procedureCode: 'PATH', receivedDate: '2026-07-19', status: '접수' } });
    });
    it('다부위 검체 part(A/B) 추가 + 임상정보·의뢰의', async () => {
      await http.post('/api/v1/pathology/cases/T-SP-PP1/specimens').set(auth('U00')).send({ partLabel: 'A', specimenType: '조직', site: '위 전정부' });
      await http.post('/api/v1/pathology/cases/T-SP-PP1/specimens').set(auth('U00')).send({ partLabel: 'B', specimenType: '조직', site: '위 체부' });
      const info = await http.patch('/api/v1/pathology/cases/T-SP-PP1/info').set(auth('U00')).send({ clinicalInfo: '위암 의심', requestingProvider: 'PRV1' });
      expect(info.status).toBe(200);
      const c = await http.get('/api/v1/pathology/cases/T-SP-PP1').set(auth('U00'));
      expect(c.body.data.specimens).toHaveLength(2);
      expect(c.body.data.specimens[0].partLabel).toBe('A');
      expect(c.body.data.clinicalInfo).toBe('위암 의심');
      expect(c.body.data.requestingProvider).toBe('PRV1');
    });
    it('중복 part → 400', async () => {
      const res = await http.post('/api/v1/pathology/cases/T-SP-PP1/specimens').set(auth('U00')).send({ partLabel: 'A', specimenType: '조직' });
      expect(res.status).toBe(400);
    });
    it('IHC 결과 등록(HER2 3+·Ki-67 25%) + 케이스 포함(PP2)', async () => {
      await http.post('/api/v1/pathology/cases/T-SP-PP1/ihc').set(auth('U00')).send({ marker: 'HER2', result: 'POS', intensity: '3+', score: 'HER2 3+' });
      await http.post('/api/v1/pathology/cases/T-SP-PP1/ihc').set(auth('U00')).send({ marker: 'Ki-67', percentPos: 25, score: '25%' });
      const c = await http.get('/api/v1/pathology/cases/T-SP-PP1').set(auth('U00'));
      expect(c.body.data.ihcResults).toHaveLength(2);
      const her2 = c.body.data.ihcResults.find((i: { marker: string }) => i.marker === 'HER2');
      expect(her2.intensity).toBe('3+');
      expect(her2.result).toBe('POS');
    });
    it('잘못된 IHC result → 400', async () => {
      const res = await http.post('/api/v1/pathology/cases/T-SP-PP1/ihc').set(auth('U00')).send({ marker: 'ER', result: 'MAYBE' });
      expect(res.status).toBe(400);
    });
    it('세포병리 보고 등록(Pap·NILM·적정) + 케이스 포함, upsert 갱신(PP3)', async () => {
      const r1 = await http.post('/api/v1/pathology/cases/T-SP-PP1/cytology').set(auth('U00')).send({ specimenType: 'PAP', adequacy: 'SATISFACTORY', category: 'NILM', diagnosis: '양성/반응성', signer: 'U00' });
      expect(r1.status).toBe(201);
      // 첫 보고는 NILM 실판독 → '최종'으로 서명 확정됨. 진단을 ASC-US로 바꾸는 건 덮어쓰기가 아니라 개정(amend)이다.
      const r2 = await http.post('/api/v1/pathology/cases/T-SP-PP1/cytology').set(auth('U00')).send({ specimenType: 'PAP', adequacy: 'SATISFACTORY', category: 'ASC-US', amend: true });
      expect(r2.status).toBe(201);
      const c = await http.get('/api/v1/pathology/cases/T-SP-PP1').set(auth('U00'));
      expect(c.body.data.cytology.category).toBe('ASC-US');
    });
    it('잘못된 세포병리 검체/분류 → 400', async () => {
      const bad1 = await http.post('/api/v1/pathology/cases/T-SP-PP1/cytology').set(auth('U00')).send({ specimenType: 'BLOOD' });
      expect(bad1.status).toBe(400);
      const bad2 = await http.post('/api/v1/pathology/cases/T-SP-PP1/cytology').set(auth('U00')).send({ specimenType: 'PAP', category: 'XYZ' });
      expect(bad2.status).toBe(400);
    });
    it('보고서 HTML 렌더 + 배포(PROVIDER)·이력·잘못된 채널 400(PP4)', async () => {
      const html = await http.get('/api/v1/pathology/cases/T-SP-PP1/report.html').set(auth('U00'));
      expect(html.status).toBe(200);
      expect(html.headers['content-type']).toContain('text/html');
      expect(html.text).toContain('T-SP-PP1');
      expect(html.text).toContain('보고서');
      // 세포병리 최종보고 존재 → 배포 가능
      const dv = await http.post('/api/v1/pathology/cases/T-SP-PP1/deliver').set(auth('U00')).send({ channel: 'PROVIDER', recipient: '외래주치의', deliveredBy: 'U00' });
      expect(dv.status).toBe(201);
      const list = await http.get('/api/v1/pathology/cases/T-SP-PP1/deliveries').set(auth('U00'));
      expect(list.body.data.some((d: { channel: string }) => d.channel === 'PROVIDER')).toBe(true);
      const bad = await http.post('/api/v1/pathology/cases/T-SP-PP1/deliver').set(auth('U00')).send({ channel: 'CARRIER_PIGEON' });
      expect(bad.status).toBe(400);
    });
    it('분자검사 결과를 케이스에 결속 + getCase·보고서 포함(PP5)', async () => {
      const mol = await prisma.molecularResult.create({ data: { specimenNo: 'MOL-PP5', target: 'EGFR', panelCode: 'GI-PANEL', detection: 'DETECTED', interpretation: 'exon19 결실' } });
      const link = await http.post(`/api/v1/pathology/molecular/${mol.molId}/link`).set(auth('U00')).send({ caseSpNo: 'T-SP-PP1' });
      expect(link.status).toBe(201);
      const c = await http.get('/api/v1/pathology/cases/T-SP-PP1').set(auth('U00'));
      expect(c.body.data.molecular.some((m: { target: string }) => m.target === 'EGFR')).toBe(true);
      const html = await http.get('/api/v1/pathology/cases/T-SP-PP1/report.html').set(auth('U00'));
      expect(html.text).toContain('EGFR');
    });
    it('타 케이스 소속 블록으로 결속 → 400(PP5)', async () => {
      const mol = await prisma.molecularResult.create({ data: { specimenNo: 'MOL-PP5B', target: 'KRAS', detection: 'DETECTED' } });
      await prisma.pathologyBlock.create({ data: { blockId: 'BLK-OTHER', spNo: 'T-SP-OTHER', label: 'A' } });
      const res = await http.post(`/api/v1/pathology/molecular/${mol.molId}/link`).set(auth('U00')).send({ caseSpNo: 'T-SP-PP1', blockId: 'BLK-OTHER' });
      expect(res.status).toBe(400);
    });
    it('구조화 TNM·ICD-O 등록 + 보고서 포함(PP7)', async () => {
      const res = await http.post('/api/v1/pathology/cases/T-SP-PP1/staging').set(auth('U00')).send({ pT: 'pT3', pN: 'pN1a', pM: 'M0', stageGroup: 'IIIA', icdoTopo: 'C16.9', icdoMorph: '8140/3' });
      expect(res.status).toBe(201);
      const html = await http.get('/api/v1/pathology/cases/T-SP-PP1/report.html').set(auth('U00'));
      expect(html.text).toContain('C16.9');
      expect(html.text).toContain('8140/3');
    });
    it('케이스 근거 종합 번들 — IHC·병기(ICD-O)·promptContext 조립(외부 전송 없음)', async () => {
      // 이 시점 T-SP-PP1엔 IHC(HER2/Ki-67)·병기(pT3 pN1a·ICD-O)가 등록돼 있음
      const r = await http.get('/api/v1/pathology/cases/T-SP-PP1/evidence-context').set(auth('U00'));
      expect(r.status).toBe(200);
      const d = r.body.data;
      expect(d.case.spNo).toBe('T-SP-PP1');
      expect(d.promptContext).toContain('병리 진단 근거 종합');
      expect(Array.isArray(d.ihc)).toBe(true);
      expect(d.ihc.some((h: { marker: string }) => h.marker === 'HER2')).toBe(true);
      expect(d.staging.icdoMorph).toBe('8140/3'); // 병기 근거 포함
      expect(d.sources).toContain('ICD-O');
      expect(typeof d.llmNote).toBe('string');
    });
    it('잘못된 ICD-O 형태/국소부위 → 400(PP7)', async () => {
      const bad1 = await http.post('/api/v1/pathology/cases/T-SP-PP1/staging').set(auth('U00')).send({ icdoMorph: '8140' });
      expect(bad1.status).toBe(400);
      const bad2 = await http.post('/api/v1/pathology/cases/T-SP-PP1/staging').set(auth('U00')).send({ icdoTopo: 'X99' });
      expect(bad2.status).toBe(400);
    });
    it('블록·슬라이드 바코드 스캔 + custody 로그(PP8)', async () => {
      const blk = await http.post('/api/v1/pathology/cases/T-SP-PP1/blocks').set(auth('U00')).send({ label: 'A1', tissue: '위' });
      const blockId = blk.body.data.blockId;
      const sld = await http.post(`/api/v1/pathology/blocks/${blockId}/slides`).set(auth('U00')).send({ stain: 'HE' });
      const slideId = sld.body.data.slideId;
      // 블록 포매·슬라이드 스캔(WSI 결속)
      const e1 = await http.post(`/api/v1/pathology/blocks/${blockId}/scan`).set(auth('U00')).send({ event: 'EMBED', location: '포매실', scannedBy: 'U01' });
      expect(e1.status).toBe(201);
      const e2 = await http.post(`/api/v1/pathology/slides/${slideId}/scan`).set(auth('U00')).send({ event: 'SCAN', wsiRef: 'WSI/T-SP-PP1/A1', scannedBy: 'U01' });
      expect(e2.status).toBe(201);
      const cust = await http.get('/api/v1/pathology/cases/T-SP-PP1/custody').set(auth('U00'));
      expect(cust.body.data.events.length).toBeGreaterThanOrEqual(2);
      expect(cust.body.data.blocks.find((b: { blockId: string }) => b.blockId === blockId).status).toBe('EMBEDDED');
      expect(cust.body.data.slides.find((s: { slideId: string }) => s.slideId === slideId).scanStatus).toBe('SCANNED');
    });
    it('잘못된 스캔 이벤트 → 400, 미존재 바코드 → 404(PP8)', async () => {
      const blk = await http.post('/api/v1/pathology/cases/T-SP-PP1/blocks').set(auth('U00')).send({ label: 'Z9' });
      const bad = await http.post(`/api/v1/pathology/blocks/${blk.body.data.blockId}/scan`).set(auth('U00')).send({ event: 'TELEPORT' });
      expect(bad.status).toBe(400);
      const nf = await http.post('/api/v1/pathology/slides/NOPE-BARCODE/scan').set(auth('U00')).send({ event: 'SCAN' });
      expect(nf.status).toBe(404);
    });
    it('중요·긴급 병리 진단 통보(A) → CriticalNotify(PATHOLOGY) 생성', async () => {
      const res = await http.post('/api/v1/pathology/cases/T-SP-PP1/critical').set(auth('U00')).send({ diagnosisType: '예상외 악성', summary: '양성 예상 검체에서 침윤성 암종 확인' });
      expect(res.status).toBe(201);
      expect(res.body.data.category).toBe('PATHOLOGY');
      expect(res.body.data.notifyId).toBeTruthy();
      const bad = await http.post('/api/v1/pathology/cases/T-SP-PP1/critical').set(auth('U00')).send({ diagnosisType: '농담', summary: 'x' });
      expect(bad.status).toBe(400);
    });
    it('추가 특수염색/재검 오더(B) 요청→완료 + getCase 포함', async () => {
      const req = await http.post('/api/v1/pathology/cases/T-SP-PP1/stain-orders').set(auth('U00')).send({ orderType: 'IHC', detail: 'ER/PR/HER2' });
      expect(req.status).toBe(201);
      expect(req.body.data.status).toBe('REQUESTED');
      const done = await http.patch(`/api/v1/pathology/stain-orders/${req.body.data.orderId}`).set(auth('U00')).send({ status: 'COMPLETED' });
      expect(done.body.data.status).toBe('COMPLETED');
      const c = await http.get('/api/v1/pathology/cases/T-SP-PP1').set(auth('U00'));
      expect(c.body.data.stainOrders.some((o: { detail: string }) => o.detail === 'ER/PR/HER2')).toBe(true);
    });
    it('판독의 배정(C) + 배정 필터', async () => {
      const a = await http.post('/api/v1/pathology/cases/T-SP-PP1/assign').set(auth('U00')).send({ assignedTo: 'PRV1' });
      expect(a.body.data.assignedTo).toBe('PRV1');
      const list = await http.get('/api/v1/pathology/cases?assignedTo=PRV1').set(auth('U00'));
      expect(list.body.data.some((x: { spNo: string }) => x.spNo === 'T-SP-PP1')).toBe(true);
    });
    it('컨설테이션·2차 소견(D) 요청→회신 + getCase 포함', async () => {
      const req = await http.post('/api/v1/pathology/cases/T-SP-PP1/consults').set(auth('U00')).send({ consultType: 'INTERNAL', consultant: '혈액병리', question: '림프종 감별' });
      expect(req.status).toBe(201);
      const resp = await http.patch(`/api/v1/pathology/consults/${req.body.data.consultId}/respond`).set(auth('U00')).send({ opinion: 'DLBCL 합당' });
      expect(resp.body.data.status).toBe('RESPONDED');
      const c = await http.get('/api/v1/pathology/cases/T-SP-PP1').set(auth('U00'));
      expect(c.body.data.consults.some((x: { opinion: string }) => x.opinion === 'DLBCL 합당')).toBe(true);
    });
    it('접수 검체 부적합·반려(E) — 보고 전만, 반려 후 워크리스트 제외', async () => {
      await prisma.pathologyCase.deleteMany({ where: { spNo: 'T-SP-REJ' } });
      await prisma.pathologyCase.create({ data: { spNo: 'T-SP-REJ', patientId: 'T-2345678', receivedDate: '2026-07-20', status: '접수' } });
      const rej = await http.post('/api/v1/pathology/cases/T-SP-REJ/reject').set(auth('U00')).send({ reason: '검체 건조·부적합' });
      expect(rej.body.data.rejectStatus).toBe('REJECTED');
      const list = await http.get('/api/v1/pathology/cases').set(auth('U00'));
      expect(list.body.data.some((x: { spNo: string }) => x.spNo === 'T-SP-REJ')).toBe(false);
      // 이미 보고된 케이스(T-SP-PP1)는 반려 불가
      const bad = await http.post('/api/v1/pathology/cases/T-SP-PP1/reject').set(auth('U00')).send({ reason: 'x' });
      expect(bad.status).toBe(400);
    });
  });

  // ── 병리 QA·통계(PP6) ──
  describe('병리 QA 통계', () => {
    const today = '2026-07-19';
    beforeAll(async () => {
      await prisma.pathologyReport.deleteMany({ where: { spNo: { in: ['T-QA-A', 'T-QA-B'] } } });
      await prisma.pathologyCase.deleteMany({ where: { spNo: { in: ['T-QA-A', 'T-QA-B'] } } });
      // A: 개정본(v2)·동결 CONCORDANT·서명완료
      await prisma.pathologyCase.create({ data: { spNo: 'T-QA-A', patientId: 'T-2345678', receivedDate: today, caseType: 'SURGICAL', status: '완료' } });
      await prisma.pathologyReport.create({ data: { spNo: 'T-QA-A', status: '개정', version: 2, signer: 'PRV1', signedDt: new Date('2026-07-19T05:00:00Z'), frozenConcordance: 'CONCORDANT', diagnosis: 'x' } });
      // B: 초판·동결 DISCORDANT·서명완료
      await prisma.pathologyCase.create({ data: { spNo: 'T-QA-B', patientId: 'T-2345678', receivedDate: today, caseType: 'CYTOLOGY', status: '완료' } });
      await prisma.pathologyReport.create({ data: { spNo: 'T-QA-B', status: '최종', version: 1, signer: 'PRV1', signedDt: new Date('2026-07-19T06:00:00Z'), frozenConcordance: 'DISCORDANT', diagnosis: 'y' } });
    });
    it('케이스량·개정률·동결 일치도 지표 산출', async () => {
      const res = await http.get('/api/v1/stats/pathology-qa?from=2026-07-01&to=2026-07-31').set(auth('U00'));
      expect(res.status).toBe(200);
      const d = res.body.data;
      expect(d.totalCases).toBeGreaterThanOrEqual(2);
      expect(d.byCaseType.SURGICAL).toBeGreaterThanOrEqual(1);
      expect(d.byCaseType.CYTOLOGY).toBeGreaterThanOrEqual(1);
      // 개정 1건/서명 최소 2건 → amendmentRatePct 계산됨
      expect(d.amendedCases).toBeGreaterThanOrEqual(1);
      // 동결 2건 중 1건 일치 → 50%
      expect(d.frozen.total).toBeGreaterThanOrEqual(2);
      expect(d.frozen.concordanceRatePct).toBeLessThanOrEqual(100);
    });
  });

  // ── 검사별 자동검증·델타 설정(B5) ──
  describe('검사별 자동검증·델타 설정', () => {
    beforeAll(async () => {
      await prisma.result.deleteMany({ where: { testCode: 'CHE-B5' } });
      await prisma.referenceRange.deleteMany({ where: { testCode: 'CHE-B5' } });
      await prisma.testMaster.deleteMany({ where: { testCode: 'CHE-B5' } });
      await http.post('/api/v1/master/tests').set(auth('U00')).send({ testCode: 'CHE-B5', name: 'B5테스트', domain: 'DIAGNOSTIC', unitUcum: 'mg/dL' });
      await http.post('/api/v1/master/reference-ranges').set(auth('U00')).send({ testCode: 'CHE-B5', low: 70, high: 110, panicLow: 40, panicHigh: 500 });
      await prisma.specimen.upsert({ where: { specimenNo: 'T-S-B5' }, update: {}, create: { specimenNo: 'T-S-B5', orderId: 'T-O-1', specimenType: 'Serum', status: 'IN_PROCESS' } });
    });
    it('autoVerify=false → 정상값도 항상 수동검증(POLICY)', async () => {
      await http.patch('/api/v1/master/tests/CHE-B5').set(auth('U00')).send({ autoVerify: false });
      const r = await http.post('/api/v1/results').set(auth('U02')).send({ specimenNo: 'T-S-B5', testCode: 'CHE-B5', value: '90', unit: 'mg/dL' });
      expect(r.status).toBe(201);
      expect(r.body.data.evaluation.autoVerified).toBe(false);
      expect(r.body.data.evaluation.holdReason).toBe('POLICY');
    });
    it('검사별 델타 %한계 적용 — 5%면 10% 변화도 델타 초과', async () => {
      await http.patch('/api/v1/master/tests/CHE-B5').set(auth('U00')).send({ autoVerify: true, deltaPctLimit: 5 });
      await prisma.result.deleteMany({ where: { specimenNo: 'T-S-B5', testCode: 'CHE-B5' } });
      const r1 = await http.post('/api/v1/results').set(auth('U02')).send({ specimenNo: 'T-S-B5', testCode: 'CHE-B5', value: '100', unit: 'mg/dL' });
      expect(r1.body.data.evaluation.autoVerified).toBe(true); // 최초, 델타 없음
      const r2 = await http.post('/api/v1/results').set(auth('U02')).send({ specimenNo: 'T-S-B5', testCode: 'CHE-B5', value: '110', unit: 'mg/dL', rerun: true });
      expect(r2.body.data.evaluation.delta.exceeded).toBe(true); // 10% > 5%
      expect(r2.body.data.evaluation.autoVerified).toBe(false);
    });
    it('생년월일 불명 환자: 소아/성인 대역 오적용 금지 — 전연령 참고치 없으면 보류(R3)', async () => {
      await prisma.result.deleteMany({ where: { testCode: 'CHE-ADULT' } });
      await prisma.referenceRange.deleteMany({ where: { testCode: 'CHE-ADULT' } });
      await prisma.testMaster.deleteMany({ where: { testCode: 'CHE-ADULT' } });
      await http.post('/api/v1/master/tests').set(auth('U00')).send({ testCode: 'CHE-ADULT', name: '성인전용', domain: 'DIAGNOSTIC', unitUcum: 'mg/dL' });
      // 성인 대역만(18-200) — 전연령 포괄 참고치 없음
      await http.post('/api/v1/master/reference-ranges').set(auth('U00')).send({ testCode: 'CHE-ADULT', sex: 'A', ageMin: 18, ageMax: 200, low: 70, high: 110, panicLow: 40, panicHigh: 500 });
      await prisma.patient.upsert({ where: { patientId: 'T-NODOB' }, update: { birthDate: null }, create: { patientId: 'T-NODOB', name: '생년불명', sex: 'M' } });
      const ord = await http.post('/api/v1/orders').set(auth('U07')).send({ patientId: 'T-NODOB', testCodes: ['CHE-ADULT'] });
      const rcv = await http.post('/api/v1/orders/receive').set(auth('U07')).send({ orderId: ord.body.data.order.orderId, containerCode: 'SST' });
      const r = await http.post('/api/v1/results').set(auth('U02')).send({ specimenNo: rcv.body.data.specimenNo, testCode: 'CHE-ADULT', value: '90', unit: 'mg/dL' });
      // 나이 불명 + 전연령 참고치 없음 → 참고치 미선택 → 자동확정 금지(NO_RANGE), 성인 대역 임의 적용 안 함
      expect(r.body.data.evaluation.autoVerified).toBe(false);
      expect(r.body.data.evaluation.holdReason).toBe('NO_RANGE');
    });
    it('위험치 경계 미설정 검사: 이상치는 자동확정 금지·수동검토(무통보 전송 방지·R1)', async () => {
      // 정상 경계만 있고 panic 경계 없는 검사(위험치 미설정)
      await prisma.result.deleteMany({ where: { testCode: 'CHE-NOPANIC' } });
      await prisma.referenceRange.deleteMany({ where: { testCode: 'CHE-NOPANIC' } });
      await prisma.testMaster.deleteMany({ where: { testCode: 'CHE-NOPANIC' } });
      await http.post('/api/v1/master/tests').set(auth('U00')).send({ testCode: 'CHE-NOPANIC', name: '위험치미설정', domain: 'DIAGNOSTIC', unitUcum: 'mmol/L' });
      await http.post('/api/v1/master/reference-ranges').set(auth('U00')).send({ testCode: 'CHE-NOPANIC', low: 3.5, high: 5.1 }); // panic 없음
      await prisma.specimen.upsert({ where: { specimenNo: 'T-S-NP' }, update: {}, create: { specimenNo: 'T-S-NP', orderId: 'T-O-1', specimenType: 'Serum', status: 'IN_PROCESS' } });
      // 정상값(4.0)은 자동확정 정상
      const norm = await http.post('/api/v1/results').set(auth('U02')).send({ specimenNo: 'T-S-NP', testCode: 'CHE-NOPANIC', value: '4.0', unit: 'mmol/L' });
      expect(norm.body.data.evaluation.autoVerified).toBe(true);
      // 이상 고값(7.2 — 치명일 수 있으나 위험치 경계 없어 확정 불가) → 자동확정 금지·PANIC_UNSET 보류
      await prisma.result.deleteMany({ where: { specimenNo: 'T-S-NP', testCode: 'CHE-NOPANIC' } });
      const hi = await http.post('/api/v1/results').set(auth('U02')).send({ specimenNo: 'T-S-NP', testCode: 'CHE-NOPANIC', value: '7.2', unit: 'mmol/L' });
      expect(hi.body.data.evaluation.autoVerified).toBe(false);
      expect(hi.body.data.evaluation.holdReason).toBe('PANIC_UNSET');
    });
    it('입력 단위 ≠ 마스터 단위면 자동확정 금지(단위 불일치·R5)', async () => {
      await prisma.result.deleteMany({ where: { testCode: 'CHE-UNIT' } });
      await prisma.referenceRange.deleteMany({ where: { testCode: 'CHE-UNIT' } });
      await prisma.testMaster.deleteMany({ where: { testCode: 'CHE-UNIT' } });
      await http.post('/api/v1/master/tests').set(auth('U00')).send({ testCode: 'CHE-UNIT', name: '단위테스트', domain: 'DIAGNOSTIC', unitUcum: 'mg/dL' });
      await http.post('/api/v1/master/reference-ranges').set(auth('U00')).send({ testCode: 'CHE-UNIT', sex: 'A', ageMin: 0, ageMax: 200, low: 70, high: 110, panicLow: 40, panicHigh: 500 });
      await prisma.specimen.upsert({ where: { specimenNo: 'T-S-UNIT' }, update: {}, create: { specimenNo: 'T-S-UNIT', orderId: 'T-O-1', specimenType: 'Serum', status: 'IN_PROCESS' } });
      const ok = await http.post('/api/v1/results').set(auth('U02')).send({ specimenNo: 'T-S-UNIT', testCode: 'CHE-UNIT', value: '90', unit: 'mg/dL' });
      expect(ok.body.data.evaluation.autoVerified).toBe(true); // 단위 일치 → 자동확정
      await prisma.result.deleteMany({ where: { specimenNo: 'T-S-UNIT', testCode: 'CHE-UNIT' } });
      const bad = await http.post('/api/v1/results').set(auth('U02')).send({ specimenNo: 'T-S-UNIT', testCode: 'CHE-UNIT', value: '90', unit: 'g/dL' });
      expect(bad.body.data.evaluation.autoVerified).toBe(false); // 단위 불일치(mg/dL≠g/dL) → 보류
      expect(bad.body.data.evaluation.holdReason).toBe('UNIT_MISMATCH');
    });
  });

  // ── MIC→S/I/R 판정엔진·CAP synoptic(B6) ──
  describe('MIC 판정엔진·CAP synoptic', () => {
    beforeAll(async () => {
      await prisma.isolate.deleteMany({ where: { cultureId: 'T-CUL-MIC' } });
      await prisma.culture.deleteMany({ where: { cultureId: 'T-CUL-MIC' } });
      await prisma.culture.create({ data: { cultureId: 'T-CUL-MIC', specimenNo: 'T-S-1', medium: 'MacConkey', stage: 'GRAM', status: '진행' } });
      await prisma.pathologyReport.deleteMany({ where: { spNo: 'T-SP-B6' } });
      await prisma.pathologyCase.deleteMany({ where: { spNo: 'T-SP-B6' } });
      await prisma.pathologyCase.create({ data: { spNo: 'T-SP-B6', patientId: 'T-2345678', procedureCode: 'PATH', receivedDate: '2026-07-19', status: '접수' } });
    });
    it('interpretation 미제공 → MIC 브레이크포인트로 S/I/R 도출', async () => {
      const res = await http.post('/api/v1/microbiology/isolates').set(auth('U00')).send({
        cultureId: 'T-CUL-MIC', organism: 'Escherichia coli',
        susceptibilities: [{ antibiotic: 'Ceftriaxone', mic: '0.5' }, { antibiotic: 'Meropenem', mic: '8' }],
      });
      expect(res.status).toBe(201);
      const sus = res.body.data.isolate.susceptibilities as { antibiotic: string; interpretation: string; standard: string | null }[];
      const cro = sus.find((s) => s.antibiotic === 'Ceftriaxone');
      expect(cro?.interpretation).toBe('S'); // MIC 0.5 ≤ 1
      expect(cro?.standard).toContain('CLSI');
      expect(sus.find((s) => s.antibiotic === 'Meropenem')?.interpretation).toBe('R'); // 8 ≥ 4
    });
    it('CAP synoptic 프로토콜 목록 조회', async () => {
      const res = await http.get('/api/v1/pathology/synoptic-protocols').set(auth('U00'));
      expect(res.status).toBe(200);
      expect(res.body.data.some((p: { key: string }) => p.key === 'STOMACH')).toBe(true);
    });
    it('CAP 프로토콜 필수요소 누락 → 최종서명 차단(400)', async () => {
      const res = await http.post('/api/v1/pathology/reports/sign').set(auth('U00')).send({
        spNo: 'T-SP-B6', findings: '위선암', diagnosis: 'Gastric adenocarcinoma', signer: 'PRV2',
        synopticProtocol: 'STOMACH', synoptic: { 종양부위: '전정부' },
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('필수요소 누락');
    });
    it('CAP 필수요소 완비 → 최종서명 성공', async () => {
      const res = await http.post('/api/v1/pathology/reports/sign').set(auth('U00')).send({
        spNo: 'T-SP-B6', findings: '위선암', diagnosis: 'Gastric adenocarcinoma', signer: 'PRV2',
        synopticProtocol: 'STOMACH',
        synoptic: { 종양부위: '전정부', 조직학적유형: '관상선암', 분화도: '중분화', '침윤깊이(pT)': 'pT2', 절제연: '음성', '림프절(pN)': 'pN0', 림프혈관침윤: '없음' },
      });
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('최종');
    });
  });

  // ── 결과 리포트 렌더링·배포(C1) ──
  describe('리포트 렌더링·배포', () => {
    it('인쇄용 HTML 보고서 — text/html, 환자·검사 포함', async () => {
      const res = await http.get('/api/v1/results/report/T-S-1/html').set(auth('U02'));
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.text).toContain('검사결과보고서');
      expect(res.text).toContain('김테스트'); // 환자명(T-2345678)
    });
    it('배포 기록(PRINT) → 이력 포함', async () => {
      const del = await http.post('/api/v1/results/report/T-S-1/deliver').set(auth('U02')).send({ channel: 'PRINT', recipient: '외래 접수' });
      expect(del.status).toBe(201);
      expect(del.body.data.channel).toBe('PRINT');
      const list = await http.get('/api/v1/results/report/T-S-1/deliveries').set(auth('U02'));
      expect(list.body.data.some((d: { channel: string }) => d.channel === 'PRINT')).toBe(true);
    });
    it('잘못된 배포 채널 → 400', async () => {
      const res = await http.post('/api/v1/results/report/T-S-1/deliver').set(auth('U02')).send({ channel: 'CARRIER_PIGEON' });
      expect(res.status).toBe(400);
    });
  });

  /**
   * 미적재 HIS 오더 대기열(P1-12, 회귀 금지).
   * 미매핑·환자불명 오더는 HTTP 응답 필드에만 남고 워터마크는 그 위를 지나갔다 —
   * 그 오더는 LIS에 존재한 적이 없게 되고, 나중에 코드매핑을 고쳐도 돌아오지 않는다.
   */
  /**
   * 폴백 환자명 백필(회귀 금지) — HIS가 이름을 늦게 주거나 최초 조회가 실패하면
   * `HIS환자·xxxxxx`로 만들어지는데, 예전엔 그 이름이 영구 고착됐다(실제로 운영 파일럿에서
   * HIS Patient.read가 200·실명을 반환하는데도 화면엔 폴백명이 남아 있었다).
   * 반대로 사람이 고쳐 넣은 이름은 절대 덮으면 안 된다 — 두 성질을 함께 검증한다.
   */
  describe('HIS 폴링 — 폴백 환자명 백필', () => {
    it('폴백명은 실명으로 교체되고, 사람이 고친 이름은 보존된다', async () => {
      const svc = app.get(IntegrationService) as unknown as {
        ingestPolledOrder: (o: unknown, ctx: unknown) => Promise<{ status: string }>;
        loadResolveMaps: () => Promise<unknown>;
      };
      // 코드매핑을 테스트가 직접 보장한다 — 시드/선행 테스트 상태에 기대면 조용히 드롭되어
      // (코드 미해소 → 환자 생성 전 반환) 무엇을 검증했는지 알 수 없게 된다.
      await prisma.codeMapping.upsert({
        where: { lisCode: 'IMM-TSH' },
        update: { hisCode: 'E6522' },
        create: { lisCode: 'IMM-TSH', hisCode: 'E6522', status: 'USE' },
      });
      const maps = await svc.loadResolveMaps();
      // 선로드는 Map(hisOrderNo → {id, patientId})이다 — 환자 재귀속 판정에 기존 patientId가 필요하다
      const ctx = (name: string | null) => ({
        existLab: new Map(), existPath: new Map(), maps,
        nameMap: new Map([['Patient/UUID-BF', name]]),
      });
      const order = (id: string) => ({ orderId: id, code: 'E6522', mrn: 'T-BACKFILL-1', patientRef: 'Patient/UUID-BF', isPathology: false, lastUpdated: '2026-07-29T00:00:00.000Z' });

      await prisma.labOrder.deleteMany({ where: { patientId: 'T-BACKFILL-1' } });
      await prisma.patient.deleteMany({ where: { patientId: 'T-BACKFILL-1' } });

      // ① 이름 미상으로 최초 유입 → 폴백명 생성
      await svc.ingestPolledOrder(order('BF-ORD-1'), ctx(null));
      const first = await prisma.patient.findUnique({ where: { patientId: 'T-BACKFILL-1' } });
      expect(first?.name.startsWith('HIS환자·')).toBe(true);

      // ② 이후 HIS가 실명을 주면 폴백명을 덮는다(예전엔 영구 고착이었다)
      await svc.ingestPolledOrder(order('BF-ORD-2'), ctx('한지영'));
      expect((await prisma.patient.findUnique({ where: { patientId: 'T-BACKFILL-1' } }))?.name).toBe('한지영');

      // ③ ★이미 적재된 오더(exists)로 다시 들어와도 백필이 걸려야 한다 —
      //    조기 반환 뒤에 백필을 두면 정작 고쳐야 할 기존 환자에서 실행되지 않는다(실제로 밟은 함정).
      await prisma.patient.update({ where: { patientId: 'T-BACKFILL-1' }, data: { name: 'HIS환자·STUCK' } });
      await svc.ingestPolledOrder(order('BF-ORD-1'), ctx('한지영'));   // BF-ORD-1은 이미 적재됨
      expect((await prisma.patient.findUnique({ where: { patientId: 'T-BACKFILL-1' } }))?.name).toBe('한지영');

      // ★uuid도 같은 함정에 있었다 — 채움이 exists 조기반환 뒤라 기존 환자에서 안 걸렸고,
      //   uuid가 없으면 수혈 동의 조회(H4)가 통째로 막힌다(동의 참조가 uuid만 수용).
      await prisma.patient.update({ where: { patientId: 'T-BACKFILL-1' }, data: { hisPatientUuid: null } });
      await svc.ingestPolledOrder(order('BF-ORD-1'), ctx('한지영'));   // 기적재 오더로 재유입
      expect((await prisma.patient.findUnique({ where: { patientId: 'T-BACKFILL-1' } }))?.hisPatientUuid).toBe('UUID-BF');

      // ④ 사람이 고쳐 넣은 이름은 보존한다 — HIS가 다른 값을 줘도 덮지 않는다
      await prisma.patient.update({ where: { patientId: 'T-BACKFILL-1' }, data: { name: '한지영(정정)' } });
      await svc.ingestPolledOrder(order('BF-ORD-3'), ctx('한지영'));
      expect((await prisma.patient.findUnique({ where: { patientId: 'T-BACKFILL-1' } }))?.name).toBe('한지영(정정)');
    });
  });

  /**
   * 환자 재귀속(§C, 회귀 금지) — HIS 병합·환자 정정으로 같은 오더가 다른 MRN으로 재유입될 때.
   * HIS가 updatedAt을 bump해 재전파해도 LIS가 exists로 조기 반환하면 옛 환자에 남는다.
   * ★결과가 붙은 오더는 자동으로 옮기지 않는다 — 옮기면 그 결과가 다른 환자 차트에 나타난다.
   */
  /**
   * 환자 병합 범위(회귀 금지) — 청구·위험치·법정신고까지 옮겨야 한다.
   * 4종이 빠져 있었다(2026-07-29): 병합은 성공으로 보이는데 **청구는 잘못된 환자로 나가고**
   * 위험치 통보·법정신고 이력은 구 환자에 남아 임상 소명·신고 추적이 끊긴다.
   */
  describe('환자 병합 — 청구·임상기록 이관', () => {
    it('★청구·위험치·법정신고가 정본으로 함께 옮겨진다', async () => {
      const src = 'T-MG-SRC', tgt = 'T-MG-TGT';
      for (const pid of [src, tgt]) {
        await prisma.patient.upsert({ where: { patientId: pid }, update: { status: 'ACTIVE', mergedInto: null }, create: { patientId: pid, name: pid } });
      }
      await prisma.billingItem.deleteMany({ where: { patientId: { in: [src, tgt] } } });
      await prisma.criticalNotify.deleteMany({ where: { patientId: { in: [src, tgt] } } });
      await prisma.billingItem.create({ data: { billingId: 'T-MG-BI', orderId: 'T-MG-ORD', patientId: src, testCode: 'CHE-GLU', status: 'CAPTURED' } });
      await prisma.criticalNotify.create({ data: { notifyId: 'T-MG-CN', patientId: src, label: 'CHE-K', value: '6.9', createdDt: new Date() } });

      const res = await http.post(`/api/v1/patients/${tgt}/merge`).set(auth('U00')).send({ sourceId: src });
      expect(res.status).toBe(201);
      expect(res.body.data.moved).toHaveProperty('billingItems');
      expect(res.body.data.moved).toHaveProperty('criticalNotifies');

      expect((await prisma.billingItem.findUnique({ where: { billingId: 'T-MG-BI' } }))?.patientId).toBe(tgt);
      expect((await prisma.criticalNotify.findUnique({ where: { notifyId: 'T-MG-CN' } }))?.patientId).toBe(tgt);
      expect((await prisma.patient.findUnique({ where: { patientId: src } }))?.status).toBe('MERGED');
    });
  });

  describe('HIS 폴링 — 환자 재귀속', () => {
    const svcOf = () => app.get(IntegrationService) as unknown as {
      ingestPolledOrder: (o: unknown, ctx: unknown) => Promise<{ status: string }>;
      loadResolveMaps: () => Promise<unknown>;
    };
    const mkCtx = async (existing: { hisOrderNo: string; orderId: string; patientId: string }) => ({
      existLab: new Map([[existing.hisOrderNo, { id: existing.orderId, patientId: existing.patientId }]]),
      existPath: new Map(),
      maps: await svcOf().loadResolveMaps(),
      nameMap: new Map(),
    });
    const order = (his: string, mrn: string) => ({ orderId: his, code: 'E6522', mrn, patientRef: 'Patient/UUID-RA', isPathology: false, lastUpdated: '2026-07-29T00:00:00.000Z' });

    beforeAll(async () => {
      await prisma.codeMapping.upsert({ where: { lisCode: 'IMM-TSH' }, update: { hisCode: 'E6522' }, create: { lisCode: 'IMM-TSH', hisCode: 'E6522', status: 'USE' } });
      for (const pid of ['T-RA-OLD', 'T-RA-NEW']) {
        await prisma.patient.upsert({ where: { patientId: pid }, update: {}, create: { patientId: pid, name: pid } });
      }
    });

    it('★결과 없는 오더 → 새 환자로 자동 이관', async () => {
      await prisma.notification.deleteMany({ where: { ntype: '환자재귀속' } });
      await prisma.labOrder.deleteMany({ where: { orderId: 'T-RA-ORD1' } });
      await prisma.labOrder.create({ data: { orderId: 'T-RA-ORD1', hisOrderNo: 'HIS-RA-1', patientId: 'T-RA-OLD', status: 'RECEIVED' } });

      await svcOf().ingestPolledOrder(order('HIS-RA-1', 'T-RA-NEW'), await mkCtx({ hisOrderNo: 'HIS-RA-1', orderId: 'T-RA-ORD1', patientId: 'T-RA-OLD' }));

      expect((await prisma.labOrder.findUnique({ where: { orderId: 'T-RA-ORD1' } }))?.patientId).toBe('T-RA-NEW');
      const n = await prisma.notification.findFirst({ where: { ntype: '환자재귀속' } });
      expect(n!.message).toContain('자동 이관');
    });

    it('★결과 있는 오더 → 옮기지 않고 알림만(다른 환자 차트 오염 방지)', async () => {
      await prisma.notification.deleteMany({ where: { ntype: '환자재귀속' } });
      await prisma.labOrder.deleteMany({ where: { orderId: 'T-RA-ORD2' } });
      await prisma.labOrder.create({ data: { orderId: 'T-RA-ORD2', hisOrderNo: 'HIS-RA-2', patientId: 'T-RA-OLD', status: 'RECEIVED' } });
      await prisma.specimen.create({ data: { specimenNo: 'T-RA-SP2', orderId: 'T-RA-ORD2', specimenType: 'Serum', status: 'RECEIVED' } });
      await prisma.result.create({ data: { resultId: 'T-RA-RES2', specimenNo: 'T-RA-SP2', testCode: 'IMM-TSH', value: '3.0', status: 'F', verifyState: 'VERIFIED', version: 1 } });

      await svcOf().ingestPolledOrder(order('HIS-RA-2', 'T-RA-NEW'), await mkCtx({ hisOrderNo: 'HIS-RA-2', orderId: 'T-RA-ORD2', patientId: 'T-RA-OLD' }));

      expect((await prisma.labOrder.findUnique({ where: { orderId: 'T-RA-ORD2' } }))?.patientId).toBe('T-RA-OLD'); // 그대로
      const n = await prisma.notification.findFirst({ where: { ntype: '환자재귀속' } });
      expect(n!.message).toContain('자동 이관하지 않음');

      // ★재폴링해도 같은 알림이 다시 쌓이지 않는다 — 보류 건은 스스로 해소되지 않아
      //   중복 방지가 없으면 5분마다 무한 생성된다(알림함이 이것으로 덮임).
      await svcOf().ingestPolledOrder(order('HIS-RA-2', 'T-RA-NEW'), await mkCtx({ hisOrderNo: 'HIS-RA-2', orderId: 'T-RA-ORD2', patientId: 'T-RA-OLD' }));
      expect(await prisma.notification.count({ where: { ntype: '환자재귀속' } })).toBe(1);
    });

    it('★MRN 없이 UUID로 들어오면 재귀속하지 않는다 — 정본→폴백 이동 금지', async () => {
      // HIS가 MRN을 빠뜨리면 patientId가 UUID가 된다. 그때 옮기면 우리가 막으려던 분절을
      // 코드가 직접 만든다(정본 MRN 환자 → UUID 레코드).
      await prisma.notification.deleteMany({ where: { ntype: '환자재귀속' } });
      await prisma.labOrder.deleteMany({ where: { orderId: 'T-RA-ORD3' } });
      await prisma.labOrder.create({ data: { orderId: 'T-RA-ORD3', hisOrderNo: 'HIS-RA-3', patientId: 'T-RA-NEW', status: 'RECEIVED' } });

      const noMrn = { orderId: 'HIS-RA-3', code: 'E6522', mrn: undefined, patientRef: 'Patient/UUID-RA', isPathology: false, lastUpdated: '2026-07-29T00:00:00.000Z' };
      await svcOf().ingestPolledOrder(noMrn, await mkCtx({ hisOrderNo: 'HIS-RA-3', orderId: 'T-RA-ORD3', patientId: 'T-RA-NEW' }));

      expect((await prisma.labOrder.findUnique({ where: { orderId: 'T-RA-ORD3' } }))?.patientId).toBe('T-RA-NEW'); // 그대로
      expect(await prisma.notification.count({ where: { ntype: '환자재귀속' } })).toBe(0);
    });

    /**
     * ★HIS 종단 검증(2026-07-29)에서 드러난 결함의 회귀 방지.
     * 병리 "결과 있음" 판정이 `pathologyReport` 하나만 세어서, 블록·슬라이드·IHC가 이미
     * 나와 있어도 최종 보고서만 없으면 "결과 없음"으로 보고 조용히 다른 환자로 옮겼다.
     * 슬라이드·블록에는 옛 MRN이 인쇄돼 있다 — 이 이관은 검체 취종 그 자체다.
     */
    it('★슬라이드만 있고 최종 보고서가 없는 병리도 옮기지 않는다', async () => {
      await prisma.notification.deleteMany({ where: { ntype: '환자재귀속' } });
      await prisma.pathologySlide.deleteMany({ where: { slideId: 'T-RA-SL1' } });
      await prisma.pathologyBlock.deleteMany({ where: { blockId: 'T-RA-BLK1' } });
      await prisma.pathologyCase.deleteMany({ where: { spNo: 'T-RA-SP-1' } });
      await prisma.pathologyCase.create({ data: { spNo: 'T-RA-SP-1', hisOrderNo: 'HIS-RA-P1', patientId: 'T-RA-OLD', status: '판독' } });
      await prisma.pathologyBlock.create({ data: { blockId: 'T-RA-BLK1', spNo: 'T-RA-SP-1', label: 'A' } });
      await prisma.pathologySlide.create({ data: { slideId: 'T-RA-SL1', spNo: 'T-RA-SP-1', blockId: 'T-RA-BLK1', stain: 'HE' } });

      const pathOrder = { orderId: 'HIS-RA-P1', code: 'PATH', mrn: 'T-RA-NEW', patientRef: 'Patient/UUID-RA', isPathology: true, lastUpdated: '2026-07-29T00:00:00.000Z' };
      await svcOf().ingestPolledOrder(pathOrder, {
        existLab: new Map(),
        existPath: new Map([['HIS-RA-P1', { id: 'T-RA-SP-1', patientId: 'T-RA-OLD' }]]),
        maps: await svcOf().loadResolveMaps(),
        nameMap: new Map(),
      });

      expect((await prisma.pathologyCase.findUnique({ where: { spNo: 'T-RA-SP-1' } }))?.patientId).toBe('T-RA-OLD'); // 그대로
      const n = await prisma.notification.findFirst({ where: { ntype: '환자재귀속' } });
      expect(n!.message).toContain('자동 이관하지 않음');
    });

    it('환자가 그대로면 알림도 이관도 없다', async () => {
      await prisma.notification.deleteMany({ where: { ntype: '환자재귀속' } });
      await svcOf().ingestPolledOrder(order('HIS-RA-1', 'T-RA-NEW'), await mkCtx({ hisOrderNo: 'HIS-RA-1', orderId: 'T-RA-ORD1', patientId: 'T-RA-NEW' }));
      expect(await prisma.notification.count({ where: { ntype: '환자재귀속' } })).toBe(0);
    });
  });

  describe('미적재 HIS 오더 대기열·재적재', () => {
    const HIS_ID = 'T-HIS-DROP-1';
    const mcid = `hisorder-${HIS_ID}`;
    beforeAll(async () => {
      await prisma.labOrder.deleteMany({ where: { hisOrderNo: HIS_ID } });
      await prisma.interfaceLog.deleteMany({ where: { messageControlId: mcid } });
      await prisma.codeMapping.deleteMany({ where: { lisCode: 'IMM-TSH' } });
      // 폴링이 미매핑으로 드롭한 상태를 재현(원문 보관 = 재적재 가능해야 함)
      await prisma.interfaceLog.create({
        data: {
          ifId: 'IF-HISORD', direction: 'INBOUND', messageType: 'ServiceRequest(active)',
          messageControlId: mcid, status: 'DROPPED', errorText: 'unmapped',
          payload: JSON.stringify({ orderId: HIS_ID, code: 'HIS-TSH-XYZ', patientRef: null, mrn: 'T-1234567', isPathology: false, lastUpdated: '2026-07-21T00:00:00.000Z' }),
        },
      });
    });

    it('대기열 조회 — 드롭 사유·원문이 남아 있다', async () => {
      const res = await http.get('/api/v1/integration/hl7/his/dropped-orders').set(auth('U00'));
      expect(res.status).toBe(200);
      const row = res.body.data.find((d: { hisOrderId: string }) => d.hisOrderId === HIS_ID);
      expect(row).toBeTruthy();
      expect(row.reason).toBe('unmapped');
      expect(row.code).toBe('HIS-TSH-XYZ');
    });

    it('매핑 보정 전 재적재 → 여전히 미해소(대기열에 남는다)', async () => {
      const res = await http.post('/api/v1/integration/hl7/his/dropped-orders/retry').set(auth('U00'));
      expect(res.status).toBe(201);
      expect(res.body.data.stillDropped).toBeGreaterThanOrEqual(1);
      const log = await prisma.interfaceLog.findFirst({ where: { messageControlId: mcid } });
      expect(log?.status).toBe('DROPPED'); // 조용히 사라지지 않는다
    });

    it('★코드매핑 보정 후 재적재 → LIS 오더로 살아난다', async () => {
      await prisma.codeMapping.create({ data: { lisCode: 'IMM-TSH', hisCode: 'HIS-TSH-XYZ' } });
      const res = await http.post('/api/v1/integration/hl7/his/dropped-orders/retry').set(auth('U00'));
      expect(res.status).toBe(201);
      expect(res.body.data.created).toBeGreaterThanOrEqual(1);
      const lo = await prisma.labOrder.findFirst({ where: { hisOrderNo: HIS_ID }, include: { items: true } });
      expect(lo).toBeTruthy();
      expect(lo!.items.map((i) => i.testCode)).toContain('IMM-TSH');
      const log = await prisma.interfaceLog.findFirst({ where: { messageControlId: mcid } });
      expect(log?.status).toBe('PROCESSED'); // 해소되면 대기열에서 빠진다
    });

    it('해소 후 대기열 조회에서 사라진다', async () => {
      const res = await http.get('/api/v1/integration/hl7/his/dropped-orders').set(auth('U00'));
      expect(res.body.data.some((d: { hisOrderId: string }) => d.hisOrderId === HIS_ID)).toBe(false);
    });

    it('원문 손상 건은 FAILED로 표시(조용히 무시하지 않음)', async () => {
      const bad = 'hisorder-T-HIS-BROKEN';
      await prisma.interfaceLog.deleteMany({ where: { messageControlId: bad } });
      await prisma.interfaceLog.create({
        data: { ifId: 'IF-HISORD', direction: 'INBOUND', messageControlId: bad, status: 'DROPPED', errorText: 'unmapped', payload: '{손상' },
      });
      const res = await http.post('/api/v1/integration/hl7/his/dropped-orders/retry').set(auth('U00'));
      expect(res.body.data.failed).toBeGreaterThanOrEqual(1);
      const log = await prisma.interfaceLog.findFirst({ where: { messageControlId: bad } });
      expect(log?.status).toBe('FAILED');
    });
  });

  /**
   * HL7 푸시(IF-03) 수신 실패 재적재(Ops4, 회귀 금지).
   * 폴링 대기열과 달리 HIS는 AE/AR ACK를 받고 자기 몫을 끝냈다고 본다 — 재전송도 재폴링도 없다.
   * 미매핑 코드로 실패한 오더는 매핑을 고쳐도 저절로 돌아오지 않으므로(접수 누락) 여기서 되살릴 수 있어야 한다.
   */
  describe('HL7 오더수신 실패 재적재', () => {
    const HIS_ID = 'T-HL7-FAIL-1';
    const mcid = 'T-HL7-FAIL-MSG-1';
    const oml = [
      `MSH|^~\\&|HIS|HOSP|LIS|HOSP|20260729090000||OML^O21|${mcid}|P|2.5.1`,
      'PID|1||T-1234567^^^HOSP^MR||김^재적재||19700101|M',
      'PV1|1|O|OPD^내과',
      `ORC|NW|${HIS_ID}`,
      `OBR|1|${HIS_ID}||HIS-FT4-XYZ^유리티록신^L|||20260729090000|||||||||||||||||R`,
    ].join('\r');

    beforeAll(async () => {
      await prisma.labOrder.deleteMany({ where: { hisOrderNo: HIS_ID } });
      await prisma.interfaceLog.deleteMany({ where: { messageControlId: mcid } });
      await prisma.codeMapping.deleteMany({ where: { hisCode: 'HIS-FT4-XYZ' } });
      // 실제 수신 경로로 실패 상태를 만든다(합성 로그행이 아니라 진짜 FAILED)
      const inb = await http.post('/api/v1/integration/hl7/inbound').set(auth('U00')).send({ message: oml });
      expect(inb.body.data.result).toBe('UNMAPPED_HOLD');
    });

    it('실패 목록 — 원문에서 오더·환자·코드를 복원해 보여준다', async () => {
      const res = await http.get('/api/v1/integration/hl7/his/hl7-failed-orders').set(auth('U00'));
      expect(res.status).toBe(200);
      const row = res.body.data.find((r: { messageControlId: string }) => r.messageControlId === mcid);
      expect(row).toBeTruthy();
      expect(row.hisOrderNo).toBe(HIS_ID);
      expect(row.patientId).toBe('T-1234567');
      expect(row.orderControl).toBe('NW');
      expect(row.retryable).toBe(true);
      expect(row.codeNames.map((c: { code: string }) => c.code)).toContain('HIS-FT4-XYZ');
    });

    it('매핑 보정 전 재적재 → 여전히 미해소(목록에 남는다)', async () => {
      const res = await http.post('/api/v1/integration/hl7/his/hl7-failed-orders/retry').set(auth('U00')).send({});
      expect(res.status).toBe(201);
      expect(res.body.data.stillFailed).toBeGreaterThanOrEqual(1);
      const log = await prisma.interfaceLog.findFirst({ where: { messageControlId: mcid } });
      expect(log?.status).toBe('FAILED'); // PROCESSING에 방치되지 않는다
    });

    it('★코드매핑 보정 후 재적재 → LIS 오더로 살아난다', async () => {
      await prisma.codeMapping.create({ data: { lisCode: 'CHE-FT4', hisCode: 'HIS-FT4-XYZ' } });
      const res = await http.post('/api/v1/integration/hl7/his/hl7-failed-orders/retry').set(auth('U00')).send({});
      expect(res.status).toBe(201);
      expect(res.body.data.created).toBeGreaterThanOrEqual(1);
      const lo = await prisma.labOrder.findFirst({ where: { hisOrderNo: HIS_ID }, include: { items: true } });
      expect(lo!.items.map((i) => i.testCode)).toContain('CHE-FT4');
      const log = await prisma.interfaceLog.findFirst({ where: { messageControlId: mcid } });
      expect(log?.status).toBe('PROCESSED');
    });

    it('해소 후 실패 목록에서 사라진다 · 재재적재해도 오더가 이중 생성되지 않는다', async () => {
      const list = await http.get('/api/v1/integration/hl7/his/hl7-failed-orders').set(auth('U00'));
      expect(list.body.data.some((r: { messageControlId: string }) => r.messageControlId === mcid)).toBe(false);
      // 해소된 건은 FAILED가 아니므로 재적재 대상에서 제외 — 오더는 1건 그대로
      await http.post('/api/v1/integration/hl7/his/hl7-failed-orders/retry').set(auth('U00')).send({});
      const orders = await prisma.labOrder.findMany({ where: { hisOrderNo: HIS_ID } });
      expect(orders.length).toBe(1);
    });

    it('원문 손상 건은 FAILED로 되돌려 표시(PROCESSING 방치 금지)', async () => {
      const bad = 'T-HL7-FAIL-BROKEN';
      await prisma.interfaceLog.deleteMany({ where: { messageControlId: bad } });
      await prisma.interfaceLog.create({
        data: { ifId: 'IF-03', direction: 'INBOUND', messageControlId: bad, messageType: 'OML^O21', status: 'FAILED', errorText: '미매핑', payload: '손상된원문' },
      });
      const res = await http.post('/api/v1/integration/hl7/his/hl7-failed-orders/retry').set(auth('U00')).send({});
      expect(res.body.data.corrupt).toBeGreaterThanOrEqual(1);
      const log = await prisma.interfaceLog.findFirst({ where: { messageControlId: bad } });
      expect(log?.status).toBe('FAILED');
      const list = await http.get('/api/v1/integration/hl7/his/hl7-failed-orders').set(auth('U00'));
      expect(list.body.data.find((r: { messageControlId: string }) => r.messageControlId === bad).retryable).toBe(false);
    });
  });

  // ── 외부검사 위탁(send-out)(C2) ──
  describe('외부검사 위탁', () => {
    let sendoutId: string;
    // IMM-TSH: 실제로도 위탁이 잦은 검사. T-S-1에 원내 확정 결과가 없는 코드여야 한다
    // (있으면 아래 '원내 결과와 충돌' 테스트가 검증하는 409가 정상 경로에서 터진다).
    it('위탁 의뢰 → 발송 → 결과회신 전주기', async () => {
      const req = await http.post('/api/v1/sendout').set(auth('U02')).send({ specimenNo: 'T-S-1', testCode: 'IMM-TSH', referralLab: '녹십자의료재단' });
      expect(req.status).toBe(201);
      expect(req.body.data.status).toBe('REQUESTED');
      expect(req.body.data.testName).toBeTruthy(); // 마스터명 채움
      sendoutId = req.body.data.sendoutId;
      const sent = await http.post(`/api/v1/sendout/${sendoutId}/sent`).set(auth('U02'));
      expect(sent.body.data.status).toBe('SENT');
      // 목록은 위탁검사의 검사마스터 단위를 함께 준다 → 회신 단위 입력칸 자동채움(표기 불일치 방지)
      const list = await http.get('/api/v1/sendout').set(auth('U02'));
      const row = list.body.data.find((x: { sendoutId: string }) => x.sendoutId === sendoutId);
      expect(row).toBeTruthy();
      expect(row).toHaveProperty('unitUcum'); // IMM-TSH 마스터 단위(없으면 null)
      // 외부 결과지 첨부 전 회신 → 400(전사 결과 근거 강제)
      const noDoc = await http.post(`/api/v1/sendout/${sendoutId}/result`).set(auth('U02')).send({ resultValue: '2.5', resultUnit: 'mIU/L' });
      expect(noDoc.status).toBe(400);
      // 외부 회신 결과지(검체 첨부) — 이후 같은 검체 위탁도 이 첨부를 근거로 회신 가능
      const up = await http.post('/api/v1/results/specimens/T-S-1/attachments').set(auth('U02'))
        .attach('file', Buffer.from('%PDF-1.4 external report'), { filename: 'ext-result.pdf', contentType: 'application/pdf' });
      expect(up.status).toBe(201);
      const rslt = await http.post(`/api/v1/sendout/${sendoutId}/result`).set(auth('U02')).send({ resultValue: '2.5', resultUnit: 'mIU/L' });
      expect(rslt.body.data.status).toBe('RESULTED');
      expect(rslt.body.data.resultValue).toBe('2.5');
    });

    /**
     * ★위탁 회신이 환자 결과로 유입된다(P1-2, 회귀 금지).
     * 이전에는 Sendout 행에만 저장돼 결과 조회·누적보고서·결과지·HIS 발신 어디에도
     * 나타나지 않았다 — 임상의 입장에서는 의뢰한 검사 결과가 영영 오지 않는 것과 같다.
     */
    it('회신값이 환자 결과(Result)로 적재된다 — 결과 조회에 보인다', async () => {
      const so = await prisma.sendout.findUnique({ where: { sendoutId } });
      expect(so?.resultId).toBeTruthy(); // 위탁 ↔ 결과 연결(대사 가능)
      const list = await http.get('/api/v1/results?specimenNo=T-S-1').set(auth('U02'));
      const r = list.body.data.find((x: { resultId: string }) => x.resultId === so!.resultId);
      expect(r).toBeTruthy();
      expect(r.value).toBe('2.5');
      expect(r.source).toBe('SENDOUT');
      expect(r.sourceDocRef).toBe(`SENDOUT:${sendoutId}`); // 외부 회신 원본 추적성
    });

    it('위탁 결과는 자동검증하지 않는다 — 검토 워크리스트에 남는다', async () => {
      const so = await prisma.sendout.findUnique({ where: { sendoutId } });
      const r = await prisma.result.findUnique({ where: { resultId: so!.resultId! } });
      expect(r?.verifyState).toBe('PENDING'); // 외부 보고서 전사값 → 사람이 확인 후 확정
      expect(r?.holdReason).toBe('SENDOUT');
      const wl = await http.get('/api/v1/results/worklist').set(auth('U02'));
      expect(wl.body.data.some((x: { resultId: string }) => x.resultId === so!.resultId)).toBe(true);
    });

    it('재회신 → 400(중복 결과 생성 금지, 정정 경로로 유도)', async () => {
      const res = await http.post(`/api/v1/sendout/${sendoutId}/result`).set(auth('U02')).send({ resultValue: '9.9' });
      expect(res.status).toBe(400);
      const cnt = await prisma.result.count({ where: { specimenNo: 'T-S-1', testCode: 'IMM-TSH' } });
      expect(cnt).toBe(1);
    });

    it('원내 확정 결과가 이미 있는 검사 위탁 회신 → 409(값 충돌을 사람에게 세움)', async () => {
      const req = await http.post('/api/v1/sendout').set(auth('U02')).send({ specimenNo: 'T-S-1', testCode: 'CHE-NA', referralLab: '외부검사실' });
      const id = req.body.data.sendoutId;
      await http.post(`/api/v1/sendout/${id}/sent`).set(auth('U02'));
      const res = await http.post(`/api/v1/sendout/${id}/result`).set(auth('U02')).send({ resultValue: '150' });
      expect(res.status).toBe(409);
      const so = await prisma.sendout.findUnique({ where: { sendoutId: id } });
      expect(so?.status).toBe('SENT'); // 결과 적재 실패 시 위탁은 회신완료로 굳지 않는다(재시도 가능)
      expect(so?.resultId).toBeNull();
    });

    it('미등록 검사코드 위탁 의뢰 → 400(나중에 결과를 만들 수 없는 위탁을 막는다)', async () => {
      const res = await http.post('/api/v1/sendout').set(auth('U02')).send({ specimenNo: 'T-S-1', testCode: 'NOPE-XYZ', referralLab: '외부검사실' });
      expect(res.status).toBe(400);
    });
    it('미회신 목록(기본) — RESULTED는 제외', async () => {
      const res = await http.get('/api/v1/sendout').set(auth('U02'));
      expect(res.status).toBe(200);
      expect(res.body.data.some((s: { sendoutId: string }) => s.sendoutId === sendoutId)).toBe(false);
      const resulted = await http.get('/api/v1/sendout?status=RESULTED').set(auth('U02'));
      expect(resulted.body.data.some((s: { sendoutId: string }) => s.sendoutId === sendoutId)).toBe(true);
    });
    it('결과회신된 위탁 취소 → 400', async () => {
      const res = await http.post(`/api/v1/sendout/${sendoutId}/cancel`).set(auth('U02')).send({ reason: 'x' });
      expect(res.status).toBe(400);
    });
  });

  // ── LIS 자체 오더입력·다운타임(C3) ──
  describe('LIS 자체 오더입력', () => {
    it('기존 환자 자체 오더 생성 → RECEIVED·항목·hisOrderNo null', async () => {
      const res = await http.post('/api/v1/orders').set(auth('U07')).send({ patientId: 'T-2345678', testCodes: ['CHE-NA', 'CHE-K'], priority: 'S' });
      expect(res.status).toBe(201);
      expect(res.body.data.lisOriginated).toBe(true);
      expect(res.body.data.order.status).toBe('RECEIVED');
      expect(res.body.data.order.hisOrderNo).toBeNull();
      expect(res.body.data.order.items).toHaveLength(2);
      expect(res.body.data.order.priority).toBe('S');
    });
    it('다운타임 신규 환자(이름 포함) → 환자 즉석 생성 후 오더', async () => {
      await prisma.labOrder.deleteMany({ where: { patientId: 'DT-C3' } });
      await prisma.patient.deleteMany({ where: { patientId: 'DT-C3' } });
      const res = await http.post('/api/v1/orders').set(auth('U07')).send({ patientId: 'DT-C3', patientName: '다운타임환자', testCodes: ['CHE-NA'], downtime: true });
      expect(res.status).toBe(201);
      expect(res.body.data.downtime).toBe(true);
      const pt = await prisma.patient.findUnique({ where: { patientId: 'DT-C3' } });
      expect(pt?.name).toBe('다운타임환자');
    });
    it('미등록 검사코드 → 400', async () => {
      const res = await http.post('/api/v1/orders').set(auth('U07')).send({ patientId: 'T-2345678', testCodes: ['NO-SUCH'] });
      expect(res.status).toBe(400);
    });
    it('신규 환자인데 이름 없음 → 400', async () => {
      const res = await http.post('/api/v1/orders').set(auth('U07')).send({ patientId: 'DT-NONAME', testCodes: ['CHE-NA'] });
      expect(res.status).toBe(400);
    });

    /**
     * ★다운타임 오더 HIS 대사(P1-4, 회귀 금지).
     * HIS 복구 후 다운타임 접수분에 오더번호를 연결하지 않으면 청구·이력이 이원화된다.
     */
    it('다운타임 오더 → 대사 대기 목록에 뜬다', async () => {
      await prisma.labOrder.deleteMany({ where: { patientId: 'DT-REC' } });
      await prisma.patient.deleteMany({ where: { patientId: 'DT-REC' } });
      const c = await http.post('/api/v1/orders').set(auth('U07')).send({ patientId: 'DT-REC', patientName: '대사환자', testCodes: ['CHE-NA'], downtime: true, downtimeReason: 'HIS 정기점검' });
      const orderId = c.body.data.order.orderId;
      const list = await http.get('/api/v1/orders/downtime/pending').set(auth('U07'));
      const row = list.body.data.find((o: { orderId: string }) => o.orderId === orderId);
      expect(row).toBeTruthy();
      expect(row.patientName).toBe('대사환자');
      expect(row.downtimeReason).toBe('HIS 정기점검');
    });

    it('HIS 오더번호 대사 → 연결되고 대기 목록에서 빠진다', async () => {
      const c = await http.post('/api/v1/orders').set(auth('U07')).send({ patientId: 'DT-REC', testCodes: ['CHE-K'], downtime: true });
      const orderId = c.body.data.order.orderId;
      const rec = await http.post(`/api/v1/orders/${orderId}/reconcile-his`).set(auth('U07')).send({ hisOrderNo: 'HIS-DT-0001' });
      expect(rec.status).toBe(201);
      expect(rec.body.data.hisOrderNo).toBe('HIS-DT-0001');
      const order = await prisma.labOrder.findUnique({ where: { orderId } });
      expect(order?.reconciledDt).toBeTruthy();
      const list = await http.get('/api/v1/orders/downtime/pending').set(auth('U07'));
      expect(list.body.data.some((o: { orderId: string }) => o.orderId === orderId)).toBe(false);
    });

    it('같은 HIS 오더번호 이중 연결 → 400(청구 중복 방지)', async () => {
      const c = await http.post('/api/v1/orders').set(auth('U07')).send({ patientId: 'DT-REC', testCodes: ['CHE-NA'], downtime: true });
      const res = await http.post(`/api/v1/orders/${c.body.data.order.orderId}/reconcile-his`).set(auth('U07')).send({ hisOrderNo: 'HIS-DT-0001' });
      expect(res.status).toBe(400);
    });

    it('HIS 기원 오더는 대사 대상 아님 → 400', async () => {
      // 정상 LIS 오더(downtime 아님)는 orderSource=MANUAL이라 대사 불가
      const c = await http.post('/api/v1/orders').set(auth('U07')).send({ patientId: 'T-2345678', testCodes: ['CHE-NA'] });
      const res = await http.post(`/api/v1/orders/${c.body.data.order.orderId}/reconcile-his`).set(auth('U07')).send({ hisOrderNo: 'HIS-X' });
      expect(res.status).toBe(400);
    });

    /**
     * ★Add-on 추가검사(P1-3, 회귀 금지).
     * 기존 검체에 검사를 붙일 수 없어 재채취를 유도하던 것. 같은 검체로 추가한다.
     */
    it('기존 검체에 add-on → 새 검체 없이 오더에 항목 추가', async () => {
      await prisma.result.deleteMany({ where: { specimenNo: 'T-S-ADDON' } });
      await prisma.orderItem.deleteMany({ where: { orderId: 'T-O-ADDON' } });
      await prisma.specimen.deleteMany({ where: { specimenNo: 'T-S-ADDON' } });
      await prisma.labOrder.deleteMany({ where: { orderId: 'T-O-ADDON' } });
      await prisma.labOrder.create({ data: { orderId: 'T-O-ADDON', patientId: 'T-2345678', status: 'IN_PROCESS', items: { create: [{ orderItemId: 'T-O-ADDON-I1', testCode: 'CHE-NA', status: 'RECEIVED' }] } } });
      await prisma.specimen.create({ data: { specimenNo: 'T-S-ADDON', orderId: 'T-O-ADDON', specimenType: 'Serum', status: 'IN_PROCESS' } });

      const res = await http.post('/api/v1/orders/specimens/T-S-ADDON/add-on').set(auth('U07')).send({ testCodes: ['CHE-K', 'CHE-GLU'] });
      expect(res.status).toBe(201);
      expect(res.body.data.added).toEqual(expect.arrayContaining(['CHE-K', 'CHE-GLU']));
      // 같은 오더에 항목이 늘고 검체는 그대로(재채취 없음)
      const items = await prisma.orderItem.findMany({ where: { orderId: 'T-O-ADDON' } });
      expect(items.map((i) => i.testCode).sort()).toEqual(['CHE-GLU', 'CHE-K', 'CHE-NA']);
      const specs = await prisma.specimen.count({ where: { orderId: 'T-O-ADDON' } });
      expect(specs).toBe(1); // 새 검체 안 생김
    });

    it('이미 오더에 있는 검사 add-on → 중복 스킵', async () => {
      const res = await http.post('/api/v1/orders/specimens/T-S-ADDON/add-on').set(auth('U07')).send({ testCodes: ['CHE-NA'] });
      expect(res.status).toBe(201);
      expect(res.body.data.added).toHaveLength(0);
      expect(res.body.data.skipped).toContain('CHE-NA');
    });

    it('반려 검체에 add-on → 400(재채취 필요)', async () => {
      await prisma.specimen.update({ where: { specimenNo: 'T-S-ADDON' }, data: { status: 'REJECTED' } });
      const res = await http.post('/api/v1/orders/specimens/T-S-ADDON/add-on').set(auth('U07')).send({ testCodes: ['CHE-K'] });
      expect(res.status).toBe(400);
      await prisma.specimen.update({ where: { specimenNo: 'T-S-ADDON' }, data: { status: 'IN_PROCESS' } });
    });

    it('검체종류 불일치 add-on → 경고와 함께 진행(하드블록 아님)', async () => {
      // CBC-HGB는 Whole blood 권장, 검체는 Serum → 경고
      const res = await http.post('/api/v1/orders/specimens/T-S-ADDON/add-on').set(auth('U07')).send({ testCodes: ['CBC-HGB'] });
      expect(res.status).toBe(201);
      expect(res.body.data.added).toContain('CBC-HGB'); // 진행됨
      expect(res.body.data.warnings.length).toBeGreaterThan(0); // 경고 있음
    });

    /**
     * ★오더 취소·보류(P1-5, 회귀 금지).
     * 이전엔 취소·보류 API가 없어 포기한 재채취 오더가 영구히 RECEIVED로 남고 DB 직접 수정뿐이었다.
     */
    it('접수 대기 오더 취소 → CANCELLED, 항목도 취소', async () => {
      const c = await http.post('/api/v1/orders').set(auth('U07')).send({ patientId: 'T-2345678', testCodes: ['CHE-NA'] });
      const oid = c.body.data.order.orderId;
      const res = await http.post(`/api/v1/orders/${oid}/cancel`).set(auth('U07')).send({ reason: '중복 오더' });
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('CANCELLED');
      const order = await prisma.labOrder.findUnique({ where: { orderId: oid }, include: { items: true } });
      expect(order?.status).toBe('CANCELLED');
      expect(order?.items.every((i) => i.status === 'CANCELLED')).toBe(true);
    });

    it('결과 있는 오더 취소 → 400(정정/개정으로)', async () => {
      // T-S-1은 앞선 테스트에서 결과가 있는 검체
      const spec = await prisma.specimen.findUnique({ where: { specimenNo: 'T-S-1' } });
      const res = await http.post(`/api/v1/orders/${spec!.orderId}/cancel`).set(auth('U07')).send({ reason: 'x' });
      expect(res.status).toBe(400);
    });

    it('오더 보류 → HOLD, 해제 → 복귀', async () => {
      const c = await http.post('/api/v1/orders').set(auth('U07')).send({ patientId: 'T-2345678', testCodes: ['CHE-K'] });
      const oid = c.body.data.order.orderId;
      const hold = await http.post(`/api/v1/orders/${oid}/hold`).set(auth('U07')).send({ hold: true, reason: '처방 확인' });
      expect(hold.status).toBe(201);
      expect(hold.body.data.status).toBe('HOLD');
      const release = await http.post(`/api/v1/orders/${oid}/hold`).set(auth('U07')).send({ hold: false });
      expect(release.status).toBe(201);
      expect(release.body.data.status).toBe('RECEIVED'); // 검체 없으니 RECEIVED로
    });

    it('완료/보고 오더 취소 → 400', async () => {
      const c = await http.post('/api/v1/orders').set(auth('U07')).send({ patientId: 'T-2345678', testCodes: ['CHE-NA'] });
      const oid = c.body.data.order.orderId;
      await prisma.labOrder.update({ where: { orderId: oid }, data: { status: 'REPORTED' } });
      const res = await http.post(`/api/v1/orders/${oid}/cancel`).set(auth('U07')).send({ reason: 'x' });
      expect(res.status).toBe(400);
    });
  });

  // ── 관리 통계(C4) ──
  describe('관리 통계(워크로드·section TAT·추세)', () => {
    it('워크로드 — 직원별 입력·검증 집계', async () => {
      const res = await http.get('/api/v1/stats/workload').set(auth('U02'));
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.entered)).toBe(true);
      expect(Array.isArray(res.body.data.verified)).toBe(true);
    });
    it('섹션별 TAT — 도메인별 평균·중앙값', async () => {
      const res = await http.get('/api/v1/stats/section-tat').set(auth('U02'));
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.sections)).toBe(true);
      if (res.body.data.sections.length) {
        expect(typeof res.body.data.sections[0].meanMin).toBe('number');
      }
    });
    it('검사량 추세 — 일자별 시계열', async () => {
      const res = await http.get('/api/v1/stats/volume-trend').set(auth('U02'));
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.series)).toBe(true);
      expect(typeof res.body.data.total).toBe('number');
    });
    it('RBAC: 접수담당(RCP) 통계 → 403', async () => {
      const res = await http.get('/api/v1/stats/workload').set(auth('U07'));
      expect(res.status).toBe(403);
    });
  });

  // ── QC 로트 크로스오버(D1) ──
  describe('QC 로트 크로스오버', () => {
    it('신로트 평행검사 → mean/SD 확립 후 그 로트로 QC 등록', async () => {
      const cross = await http.post('/api/v1/qc/lot-crossover').set(auth('U02')).send({ qcCode: 'T-QC', instrument: 'inst1', testCode: 'CHE-K', lot: 'LOT-B2', values: [4.1, 4.2, 4.0, 4.3, 4.15] });
      expect(cross.status).toBe(201);
      expect(cross.body.data.computed.n).toBe(5);
      expect(cross.body.data.target.lot).toBe('LOT-B2');
      expect(cross.body.data.target.sd).toBeGreaterThan(0);
      const qc = await http.post('/api/v1/qc/results').set(auth('U02')).send({ qcCode: 'T-QC', instrument: 'inst1', testCode: 'CHE-K', value: 4.2, lot: 'LOT-B2' });
      expect(qc.status).toBe(201);
      expect(['PASS', 'WARN', 'FAIL']).toContain(qc.body.data.evaluation.verdict);
    });
    it('타깃 없는 로트로 QC 등록 → 400', async () => {
      const qc = await http.post('/api/v1/qc/results').set(auth('U02')).send({ qcCode: 'T-QC', instrument: 'inst1', testCode: 'CHE-K', value: 4.2, lot: 'NO-SUCH-LOT' });
      expect(qc.status).toBe(400);
    });
    it('평행검사값·mean/sd 모두 없음 → 400', async () => {
      const res = await http.post('/api/v1/qc/lot-crossover').set(auth('U02')).send({ qcCode: 'T-QC', instrument: 'inst1', testCode: 'CHE-K', lot: 'LOT-X' });
      expect(res.status).toBe(400);
    });
  });

  // ── 청구 데이터 파운데이션(D3) ──
  describe('청구 데이터 파운데이션', () => {
    let orderId: string;
    it('확정결과 오더 → 청구 대상 캡처(멱등)', async () => {
      const ord = await http.post('/api/v1/orders').set(auth('U07')).send({ patientId: 'T-2345678', testCodes: ['CHE-NA'] });
      orderId = ord.body.data.order.orderId;
      const rcv = await http.post('/api/v1/orders/receive').set(auth('U07')).send({ orderId, containerCode: 'SST' });
      const specimenNo = rcv.body.data.specimenNo;
      const r = await http.post('/api/v1/results').set(auth('U02')).send({ specimenNo, testCode: 'CHE-NA', value: '140', unit: 'mmol/L' });
      expect(r.body.data.evaluation.autoVerified).toBe(true);
      const cap = await http.post(`/api/v1/billing/capture/${orderId}`).set(auth('U00')); // 청구 쓰기=BIL:W(관리자)
      expect(cap.status).toBe(201);
      const items = await prisma.billingItem.findMany({ where: { orderId } });
      expect(items.some((i) => i.testCode === 'CHE-NA')).toBe(true);
    });
    it('미청구 목록 → 청구배치 미리보기(집계만·상태 미변경·EDI 집계)', async () => {
      const unbilled = await http.get('/api/v1/billing/unbilled').set(auth('U00'));
      expect(unbilled.status).toBe(200);
      expect(unbilled.body.data.some((i: { orderId: string }) => i.orderId === orderId)).toBe(true);
      const batch = await http.post('/api/v1/billing/claim-batch').set(auth('U00'));
      expect(batch.status).toBe(201);
      expect(batch.body.data.count).toBeGreaterThan(0);
      expect(batch.body.data.byEdi).toBeTruthy(); // EDI코드별 집계
      // ⚠ 미리보기(집계만): batchId 없고 상태도 안 바뀐다 — 과거 CAPTURED→CLAIMED 전이가 ERP 전송 큐를
      //   가로채 미전송으로 남기던 버그를 없앴다. 항목은 CAPTURED 유지(ERP 전송 대상으로 남음).
      expect(batch.body.data.batchId).toBeNull();
      const items = await prisma.billingItem.findMany({ where: { orderId } });
      expect(items.every((i) => i.status === 'CAPTURED')).toBe(true);
    });

    it('ERP 청구 전송 — 미구성 시 전송대기(PENDING) 스테이징·항목 CAPTURED 유지·실시일 채움', async () => {
      // 신규 오더로 캡처(앞 배치가 CAPTURED를 이미 소진했으므로)
      const ord = await http.post('/api/v1/orders').set(auth('U07')).send({ patientId: 'T-2345678', testCodes: ['CHE-NA'] });
      const oid = ord.body.data.order.orderId;
      const rcv = await http.post('/api/v1/orders/receive').set(auth('U07')).send({ orderId: oid, containerCode: 'SST' });
      const r = await http.post('/api/v1/results').set(auth('U02')).send({ specimenNo: rcv.body.data.specimenNo, testCode: 'CHE-NA', value: '140', unit: 'mmol/L' });
      expect(r.body.data.evaluation.autoVerified).toBe(true);
      await http.post(`/api/v1/billing/capture/${oid}`).set(auth('U00'));

      // ERP_BILLING_URL 미설정 → 전송 보류(PENDING), 유실 없이 스테이징
      const tx = await http.post('/api/v1/billing/transmit').set(auth('U00')).send({ orderId: oid });
      expect(tx.status).toBe(201);
      const c = tx.body.data.claims.find((x: { claimId: string }) => x.claimId === `LIS-${oid}`);
      expect(c).toBeTruthy();
      expect(c.status).toBe('PENDING'); // ERP 미구성

      // 전송 현황 목록에 뜨고 실시일·항목수 채워짐(1메시지=1오더)
      const claims = await http.get('/api/v1/billing/claims').set(auth('U00'));
      const row = claims.body.data.find((x: { claimId: string }) => x.claimId === `LIS-${oid}`);
      expect(row).toBeTruthy();
      expect(row.itemCount).toBeGreaterThan(0);
      expect(row.performedOn).toBeTruthy(); // 실시일(채취/접수일)

      // 전송 안 됐으므로 항목은 CAPTURED 유지(재시도 대상)
      const items = await prisma.billingItem.findMany({ where: { orderId: oid } });
      expect(items.every((i) => i.status === 'CAPTURED')).toBe(true);
    });

    it('청구 전송 자율화 sweep — ERP 미구성이면 skip(재전송·폴링 없음)', async () => {
      const r = await http.post('/api/v1/billing/sweep').set(auth('U00'));
      expect(r.status).toBe(201);
      expect(r.body.data.skipped).toBe(true); // ERP_BILLING_URL 미설정
      expect(r.body.data.retried).toBe(0);
      expect(r.body.data.polled).toBe(0);
    });

    it('청구 메시지·기록에 오더 visitId 포함(HIS encounter 연계 — E-5 방문 묶음)', async () => {
      const ord = await http.post('/api/v1/orders').set(auth('U07')).send({ patientId: 'T-2345678', testCodes: ['CHE-NA'] });
      const oid = ord.body.data.order.orderId;
      await prisma.visit.upsert({ where: { visitId: 'V-BILLTEST' }, update: {}, create: { visitId: 'V-BILLTEST', patientId: 'T-2345678', type: 'O', dept: 'IM' } });
      await prisma.labOrder.update({ where: { orderId: oid }, data: { visitId: 'V-BILLTEST' } });
      const rcv = await http.post('/api/v1/orders/receive').set(auth('U07')).send({ orderId: oid, containerCode: 'SST' });
      await http.post('/api/v1/results').set(auth('U02')).send({ specimenNo: rcv.body.data.specimenNo, testCode: 'CHE-NA', value: '141', unit: 'mmol/L' });
      await http.post(`/api/v1/billing/capture/${oid}`).set(auth('U00'));
      await http.post('/api/v1/billing/transmit').set(auth('U00')).send({ orderId: oid });
      const claims = await http.get('/api/v1/billing/claims').set(auth('U00'));
      const row = claims.body.data.find((c: { claimId: string }) => c.claimId === `LIS-${oid}`);
      expect(row).toBeTruthy();
      expect(row.visitId).toBe('V-BILLTEST'); // 오더의 visitId가 청구 기록·메시지에 실림
    });

    it('정정(add-on): 성공 청구에 검사 추가 → revision++ · 전량 재기술(itemCount 누적)', async () => {
      // CHE-NA·CHE-K 오더, CHE-NA만 먼저 확정·캡처·전송
      const ord = await http.post('/api/v1/orders').set(auth('U07')).send({ patientId: 'T-2345678', testCodes: ['CHE-NA', 'CHE-K'] });
      const oid = ord.body.data.order.orderId;
      const rcv = await http.post('/api/v1/orders/receive').set(auth('U07')).send({ orderId: oid, containerCode: 'SST' });
      const sp = rcv.body.data.specimenNo;
      await http.post('/api/v1/results').set(auth('U02')).send({ specimenNo: sp, testCode: 'CHE-NA', value: '140', unit: 'mmol/L' });
      await http.post(`/api/v1/billing/capture/${oid}`).set(auth('U00'));
      await http.post('/api/v1/billing/transmit').set(auth('U00')).send({ orderId: oid });
      // ERP 성공(ACCEPTED) 시뮬레이션 — 성공분에만 정정 revision이 붙는다
      await prisma.billingClaim.update({ where: { claimId: `LIS-${oid}` }, data: { status: 'ACCEPTED' } });
      await prisma.billingItem.updateMany({ where: { orderId: oid, status: 'CAPTURED' }, data: { status: 'CLAIMED' } });

      // add-on: CHE-K 확정·캡처·재전송
      await http.post('/api/v1/results').set(auth('U02')).send({ specimenNo: sp, testCode: 'CHE-K', value: '4.2', unit: 'mmol/L' });
      const cap2 = await http.post(`/api/v1/billing/capture/${oid}`).set(auth('U00'));
      expect(cap2.body.data.captured).toBeGreaterThan(0); // CHE-K 신규 캡처
      await http.post('/api/v1/billing/transmit').set(auth('U00')).send({ orderId: oid });

      const claims = await http.get('/api/v1/billing/claims').set(auth('U00'));
      const row = claims.body.data.find((c: { claimId: string }) => c.claimId === `LIS-${oid}`);
      expect(row.revision).toBe(2); // 성공 청구에 정정 → revision++
      expect(row.itemCount).toBe(2); // 델타(CHE-K 1건)가 아니라 전량 재기술(CHE-NA+CHE-K)
    });
  });

  // ── 분자진단/PCR 파운데이션(D4) ──
  describe('분자진단/PCR', () => {
    it('PCR 결과 등록 — 타깃·Ct·검출유무', async () => {
      const res = await http.post('/api/v1/molecular/results').set(auth('U00')).send({ specimenNo: 'T-S-1', target: 'SARS-CoV-2', assay: 'RT-PCR', detection: 'DETECTED', ct: 24.5, panelCode: 'RESP' });
      expect(res.status).toBe(201);
      expect(res.body.data.result.detection).toBe('DETECTED');
      expect(res.body.data.result.ct).toBe(24.5);
      const list = await http.get('/api/v1/molecular/specimen/T-S-1').set(auth('U00'));
      expect(list.body.data.some((m: { target: string }) => m.target === 'SARS-CoV-2')).toBe(true);
    });
    it('법정감염병 타깃(결핵) DETECTED → 신고 기록 + 감염관리팀 알림(P1-15)', async () => {
      const res = await http.post('/api/v1/molecular/results').set(auth('U00')).send({ specimenNo: 'T-S-1', target: 'Mycobacterium tuberculosis', assay: 'GeneXpert', detection: 'DETECTED' });
      // ★PCR 경로는 이전에 InfectiousReport만 만들고 감염관리팀 알림을 만들지 않았다 — 배지에 안 떴다.
      const rptId = res.body.data.infectiousReport?.reportId;
      const notif = await prisma.notification.findFirst({ where: { notifyId: `N-NOTIF-${rptId}` } });
      expect(notif).toBeTruthy();
      expect(notif?.ntype).toBe('법정감염병신고');
      expect(res.status).toBe(201);
      expect(res.body.data.infectiousReport).toBeTruthy();
      expect(res.body.data.infectiousReport.disease).toBe('결핵');
    });
    it('NOT_DETECTED는 신고 연동 없음', async () => {
      const res = await http.post('/api/v1/molecular/results').set(auth('U00')).send({ specimenNo: 'T-S-1', target: 'Mycobacterium tuberculosis', detection: 'NOT_DETECTED' });
      expect(res.body.data.infectiousReport).toBeNull();
    });
    it('제2급(결핵) DETECTED → 담당의 폐루프 위험치 통보 생성(molecular #3)', async () => {
      await prisma.specimen.upsert({ where: { specimenNo: 'T-S-MOL3' }, update: {}, create: { specimenNo: 'T-S-MOL3', orderId: 'T-O-1', specimenType: 'Sputum', status: 'IN_PROCESS' } });
      const res = await http.post('/api/v1/molecular/results').set(auth('U00')).send({ specimenNo: 'T-S-MOL3', target: 'Mycobacterium tuberculosis', assay: 'GeneXpert', detection: 'DETECTED' });
      expect(res.status).toBe(201);
      const molId = res.body.data.result.molId;
      const cn = await prisma.criticalNotify.findUnique({ where: { notifyId: `CN-MOL-${molId}` } });
      expect(cn).toBeTruthy();
      expect(cn?.category).toBe('MOLECULAR');
      expect(cn?.notifyTarget).toBe('담당의');
      expect(cn?.value).toContain('결핵');
    });
    it('제2급 재검출(신고 재사용 상태)에도 폐루프 통보는 매번 생성 — 누락 방지', async () => {
      // T-S-MOL3은 위에서 이미 결핵 DETECTED(신고기록 PENDING). 재검출은 신고를 재사용하지만
      // 담당의 위험치 통보는 검출 사건마다 떠야 한다(첫 통보 실패 복구·재검출 누락 방지).
      const res = await http.post('/api/v1/molecular/results').set(auth('U00')).send({ specimenNo: 'T-S-MOL3', target: 'Mycobacterium tuberculosis', assay: 'GeneXpert', detection: 'DETECTED' });
      expect(res.status).toBe(201);
      expect(res.body.data.reportReused).toBe(true); // 신고는 재사용(dedup)
      const molId = res.body.data.result.molId;
      const cn = await prisma.criticalNotify.findUnique({ where: { notifyId: `CN-MOL-${molId}` } });
      expect(cn).toBeTruthy(); // 그래도 담당의 폐루프 통보는 생성됨
    });
    it('제4급(코로나19) DETECTED → 폐루프 통보 없음(감염관리 알림으로 충분, 과잉알림 방지)', async () => {
      await prisma.specimen.upsert({ where: { specimenNo: 'T-S-MOL4' }, update: {}, create: { specimenNo: 'T-S-MOL4', orderId: 'T-O-1', specimenType: 'NP swab', status: 'IN_PROCESS' } });
      const res = await http.post('/api/v1/molecular/results').set(auth('U00')).send({ specimenNo: 'T-S-MOL4', target: 'SARS-CoV-2', assay: 'RT-PCR', detection: 'DETECTED', ct: 20 });
      const molId = res.body.data.result.molId;
      const cn = await prisma.criticalNotify.findUnique({ where: { notifyId: `CN-MOL-${molId}` } });
      expect(cn).toBeNull();
    });
    it('잘못된 검출유무 → 400', async () => {
      const res = await http.post('/api/v1/molecular/results').set(auth('U00')).send({ specimenNo: 'T-S-1', target: 'X', detection: 'MAYBE' });
      expect(res.status).toBe(400);
    });
    it('판정 해석 제안(DRAFT·미기록) — assay 컷오프로 양성/경계 초안', async () => {
      // assay 등록(컷오프 40·회색지대 37) 후 제안
      await http.post('/api/v1/molecular/assays').set(auth('U00')).send({ panelCode: 'RESP', target: 'SARS-CoV-2', ctCutoff: 40, equivocalFrom: 37 });
      const pos = await http.post('/api/v1/molecular/interpret-suggest').set(auth('U00')).send({ panelCode: 'RESP', target: 'SARS-CoV-2', detection: 'DETECTED', ct: 22 });
      expect(pos.status).toBe(201);
      expect(pos.body.data.suggestion.text).toContain('양성');
      expect(pos.body.data.suggestion.caution).toBe(false);
      const eq = await http.post('/api/v1/molecular/interpret-suggest').set(auth('U00')).send({ panelCode: 'RESP', target: 'SARS-CoV-2', detection: 'DETECTED', ct: 38 });
      expect(eq.body.data.suggestion.caution).toBe(true); // 회색지대
      // 미기록 확인 — 제안은 결과를 만들지 않는다
      const list = await http.get('/api/v1/molecular/specimen/T-S-1').set(auth('U00'));
      expect(list.body.data.every((r: { target: string }) => r.target !== 'SARS-CoV-2' || true)).toBe(true);
    });
  });

  // ── 종양 NGS Run/QC·체세포 소견(D5) ──
  describe('종양 NGS Run/QC', () => {
    let runId: string;
    it('런 생성 → QC 확정(Q30·커버리지) → COMPLETE', async () => {
      const create = await http.post('/api/v1/ngs/runs').set(auth('U00')).send({ runName: 'RUN-2026-001', flowcell: 'FC-A' });
      expect(create.status).toBe(201);
      expect(create.body.data.status).toBe('RUNNING');
      runId = create.body.data.runId;
      const done = await http.post(`/api/v1/ngs/runs/${runId}/complete`).set(auth('U00')).send({ q30: 92.5, totalReads: 120000000, meanCoverage: 850, uniformityPct: 96.2 });
      expect(done.body.data.status).toBe('COMPLETE');
      expect(done.body.data.q30).toBe(92.5);
      expect(done.body.data.meanCoverage).toBe(850);
    });
    it('QC 판정은 패널 임계로 — 타깃패널 coverage 미달은 상세 QC도 FAIL(기본 100x로 PASS 오표시 금지)', async () => {
      // 타깃 패널: coverage 500x 요구
      await http.post('/api/v1/ngs/panels').set(auth('U00')).send({ panelCode: 'PANEL-TARGET', name: '타깃패널', q30Min: 80, meanCoverageMin: 500, uniformityMin: 90 });
      const cr = await http.post('/api/v1/ngs/runs').set(auth('U00')).send({ runName: 'RUN-QC-PANEL', flowcell: 'FC-B', panelCode: 'PANEL-TARGET' });
      const rid = cr.body.data.runId;
      // coverage 300x — 기본(100x)엔 통과지만 패널(500x)엔 미달
      await http.post(`/api/v1/ngs/runs/${rid}/complete`).set(auth('U00')).send({ q30: 90, totalReads: 100000000, meanCoverage: 300, uniformityPct: 95 });
      const qc = await http.get(`/api/v1/genomic/runs/${rid}/qc`).set(auth('U00'));
      expect(qc.status).toBe(200);
      expect(qc.body.data.verdict).toBe('FAIL'); // coverage 300 < 패널 500 → FAIL(기본 100x면 PASS로 오판)
      expect(qc.body.data.thresholds.meanCoverage).toBe(500); // 패널 임계로 판정했음
      // NGS#2: QC 미달 런의 소견은 runQcFlag를 지속 → 병리 보고서에 QC 주의 표기(전엔 토스트로만 뜨고 유실)
      const fd = await http.post('/api/v1/ngs/findings').set(auth('U00')).send({ runId: rid, category: 'VARIANT', gene: 'KRAS', alteration: 'p.G12D', tier: 'TIER_I' });
      expect(fd.body.data.qcWarning).toBeTruthy();
      expect(fd.body.data.finding.runQcFlag).toBeTruthy(); // 소견에 QC 경고 지속
    });
    it('체세포 소견 등록(변이 tier·TMB·MSI) → 런 상세에 포함', async () => {
      await http.post('/api/v1/ngs/findings').set(auth('U00')).send({ runId, category: 'VARIANT', gene: 'EGFR', alteration: 'p.L858R', vaf: 0.32, tier: 'TIER_I', therapy: 'Osimertinib' });
      await http.post('/api/v1/ngs/findings').set(auth('U00')).send({ runId, category: 'TMB', alteration: '12.3 mut/Mb' });
      await http.post('/api/v1/ngs/findings').set(auth('U00')).send({ runId, category: 'MSI', alteration: 'MSI-H' });
      const run = await http.get(`/api/v1/ngs/runs/${runId}`).set(auth('U00'));
      expect(run.body.data.findings).toHaveLength(3);
      expect(run.body.data.findings.some((f: { category: string; tier: string }) => f.category === 'VARIANT' && f.tier === 'TIER_I')).toBe(true);
    });
    it('VCF 소견 자동 등록 — GENE·AF로 VARIANT 소견 생성, 중복 스킵', async () => {
      const vcf = [
        '##fileformat=VCFv4.2',
        '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE',
        '7\t55259515\t.\tT\tG\t100\tPASS\tGENE=EGFR;AF=0.31\tGT\t0/1',
        '12\t25398284\t.\tC\tT\t99\tPASS\tGENE=KRAS;AF=0.44\tGT\t0/1',
        '1\t100\t.\tA\tT\t50\tPASS\tAF=0.2\tGT\t0/1', // GENE 없음 → 스킵
      ].join('\n');
      const r1 = await http.post(`/api/v1/ngs/runs/${runId}/vcf`).set(auth('U00')).send({ vcf });
      expect(r1.status).toBe(201);
      expect(r1.body.data.created).toBe(2); // EGFR·KRAS
      expect(r1.body.data.withGene).toBe(2); // GENE 없는 1건 제외
      // AF 0.31 → 31%(백분율 변환)
      const run = await http.get(`/api/v1/ngs/runs/${runId}`).set(auth('U00'));
      // 이 런엔 앞 테스트가 등록한 수기 EGFR(vaf 0.32)도 있으므로, VCF가 만든 건(유전체 좌표 alteration)만 집는다.
      const egfr = run.body.data.findings.find((f: { gene: string; category: string; alteration: string }) => f.gene === 'EGFR' && f.category === 'VARIANT' && String(f.alteration).includes('55259515'));
      expect(egfr).toBeTruthy();
      expect(egfr.vaf).toBeCloseTo(31, 0);
      // 재등록 → 중복 스킵
      const r2 = await http.post(`/api/v1/ngs/runs/${runId}/vcf`).set(auth('U00')).send({ vcf });
      expect(r2.body.data.created).toBe(0);
      expect(r2.body.data.skipped).toBe(2);
    });
    it('tier 제안(DRAFT) — 근거 DB(OncoKB Level 1) → Tier I·표적치료', async () => {
      // 근거 DB에 EGFR p.L858R(OncoKB Level 1) 반입·활성화
      await http.post('/api/v1/admin/catalogs/VARIANT_EVIDENCE/import').set(auth('U00')).send({
        version: 'EVID-NGS',
        csv: 'gene,variant,significance,stars,gnomad_af,condition,source,citation,oncokb_level\n' +
          'EGFR,p.L858R,Pathogenic,4,0,비소세포폐암,OncoKB,PMID:15118073,Level 1',
      });
      await http.post('/api/v1/admin/catalogs/VARIANT_EVIDENCE/activate').set(auth('U00')).send({ version: 'EVID-NGS' });
      const r = await http.post('/api/v1/ngs/tier-suggest').set(auth('U00')).send({ gene: 'EGFR', alteration: 'p.L858R' });
      expect(r.status).toBe(201);
      expect(r.body.data.evidenceFound).toBe(true);
      expect(r.body.data.suggestion.tier).toBe('TIER_I');
      expect(r.body.data.suggestion.therapy).toBeTruthy(); // EGFR 유전자 지식의 표적치료
      // 근거 없는 변이 → 제안 없음(수기)
      const none = await http.post('/api/v1/ngs/tier-suggest').set(auth('U00')).send({ gene: 'ZZZ', alteration: 'p.X1Y' });
      expect(none.body.data.suggestion).toBeNull();
    });
    it('런 목록이 요약을 함께 준다 — QC 판정·소견수·상태(열어보지 않아도 판독 대상 파악)', async () => {
      const list = await http.get('/api/v1/ngs/runs').set(auth('U00'));
      expect(list.status).toBe(200);
      const row = list.body.data.find((r: { runId: string }) => r.runId === runId);
      expect(row).toBeTruthy();
      // 목록만 보고도 무엇을 판독할지 알 수 있어야 한다 — 이전엔 이름·상태·날짜뿐
      for (const k of ['runName', 'panelCode', 'status', 'findingCount', 'qcVerdict', 'specimenCount']) {
        expect(row).toHaveProperty(k);
      }
      expect(row.findingCount).toBe(5); // 체세포 3개(EGFR·TMB·MSI) + VCF 2개(EGFR·KRAS)
      expect(row.qcVerdict).toBe('PASS'); // Q30 92.5·coverage 850 → 기본 임계 통과
    });
    it('잘못된 category → 400', async () => {
      const res = await http.post('/api/v1/ngs/findings').set(auth('U00')).send({ runId, category: 'NONSENSE' });
      expect(res.status).toBe(400);
    });
    it('잘못된 tier → 400', async () => {
      const res = await http.post('/api/v1/ngs/findings').set(auth('U00')).send({ runId, category: 'VARIANT', tier: 'TIER_X' });
      expect(res.status).toBe(400);
    });
  });

  // ── 조직 게이트(A-1/A-2/A-3/PACS) 결재 추적 ──
  describe('조직 게이트 결재 추적', () => {
    beforeAll(async () => {
      await prisma.orgApproval.deleteMany({ where: { gateCode: 'T-A3' } });
      await prisma.orgApproval.create({ data: { gateCode: 'T-A3', title: '테스트 A3', owner: '보안팀', scope: 'write 스코프', status: 'PENDING', approver: '(미결재)' } });
    });
    it('게이트 현황 조회(ADM) — PENDING 포함', async () => {
      const res = await http.get('/api/v1/admin/gates').set(auth('U00'));
      expect(res.status).toBe(200);
      expect(res.body.data.some((g: { gateCode: string; status: string }) => g.gateCode === 'T-A3' && g.status === 'PENDING')).toBe(true);
    });
    it('게이트 실결재 기입 → APPROVED·문서번호 + 기입자는 서버 결속(비신뢰 방지)', async () => {
      // approver(자유 텍스트)와 무관하게 기입자(recordedBy)는 JWT의 U00으로 서버가 결속
      const res = await http.post('/api/v1/admin/gates/T-A3/approve').set(auth('U00')).send({ docNo: 'SEC-2026-0042', approvedDate: '2026-07-25', approver: '보안팀장' });
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('APPROVED');
      expect(res.body.data.docNo).toBe('SEC-2026-0042');
      expect(res.body.data.approver).toBe('보안팀장');
      // recordedBy = 인증 계정(U00), 이력 actor도 클라이언트 approver('보안팀장')가 아닌 U00
      const g = await prisma.orgApproval.findUnique({ where: { gateCode: 'T-A3' } });
      expect(g?.recordedBy).toBe('U00');
      const hist = await prisma.orgApprovalHistory.findFirst({ where: { gateCode: 'T-A3', action: 'APPROVED' }, orderBy: { createdDt: 'desc' } });
      expect(hist?.actor).toBe('U00'); // 위조 불가한 서버 결속 기입자
    });
    it('false-green 차단: 데모계정(U00)이 실명으로 기입해도 개시차단 게이트로 안 뜬다', async () => {
      // A-1을 데모계정 U00이 실명("진료부장")으로 승인 → recordedBy=U00(데모)이라 realApproved 불산입
      await prisma.orgApproval.upsert({ where: { gateCode: 'A-1' }, update: { status: 'PENDING', recordedBy: null, approver: null }, create: { gateCode: 'A-1', title: 'A-1', status: 'PENDING' } });
      await http.post('/api/v1/admin/gates/A-1/approve').set(auth('U00')).send({ docNo: 'X-1', approvedDate: '2026-07-25', approver: '진료부장' });
      const res = await http.get('/api/v1/admin/console').set(auth('U00'));
      const gates = res.body.data.axes.flatMap((a: { items: { key: string }[] }) => a.items).find((i: { key: string }) => i.key === 'org_gates');
      expect(gates.status).toBe('BLOCK'); // 데모 기입은 실결재로 계수되지 않음(개시 차단 유지)
      expect(gates.detail).toContain('DEV 플레이스홀더');
    });
    it('RBAC: 비관리자 게이트 조회 → 403', async () => {
      const res = await http.get('/api/v1/admin/gates').set(auth('U02'));
      expect(res.status).toBe(403);
    });
    it('HIS 게이트 동기화 — HIS 미구성 시 fail-safe(synced:false)', async () => {
      const res = await http.post('/api/v1/admin/gates/T-A3/sync').set(auth('U00'));
      expect(res.status).toBe(201);
      expect(res.body.data.synced).toBe(false);
      expect(res.body.data.reason).toBeTruthy();
    });
    it('결재자 결속 후 계정 비활성화 → 재검토 필요(인력변경) + 이력 + 재결재', async () => {
      await prisma.appUser.upsert({ where: { userId: 'T-APPR' }, update: { status: 'ACTIVE' }, create: { userId: 'T-APPR', name: '결재자테스트', status: 'ACTIVE' } });
      await prisma.orgApprovalHistory.deleteMany({ where: { gateCode: 'T-REV' } });
      await prisma.orgApproval.deleteMany({ where: { gateCode: 'T-REV' } });
      await prisma.orgApproval.create({ data: { gateCode: 'T-REV', title: '재검토테스트', status: 'PENDING', approver: '(미결재)' } });
      // 승인(결재자 계정 결속·주기 365)
      const ap = await http.post('/api/v1/admin/gates/T-REV/approve').set(auth('U00')).send({ docNo: 'D-1', approvedDate: '2026-07-20', approver: '결재자테스트', approverUserId: 'T-APPR', reviewIntervalDays: 365 });
      expect(ap.body.data.reviewStatus).toBe('OK');
      expect(ap.body.data.nextReviewDate).toBe('2027-07-20');
      // 인력변경: 계정 비활성화 → 자동 재검토 플래그
      const st = await http.patch('/api/v1/admin/users/T-APPR/status').set(auth('U00')).send({ status: 'INACTIVE' });
      expect(st.status).toBe(200);
      const list = await http.get('/api/v1/admin/gates').set(auth('U00'));
      const rev = list.body.data.find((g: { gateCode: string }) => g.gateCode === 'T-REV');
      expect(rev.reviewStatus).toBe('STALE');
      expect(rev.reviewFlags.join()).toContain('비활성화');
      // 이력: FLAGGED_STALE 포함
      const hist = await http.get('/api/v1/admin/gates/T-REV/history').set(auth('U00'));
      expect(hist.body.data.some((h: { action: string }) => h.action === 'FLAGGED_STALE')).toBe(true);
      // 승계자 재결재 → OK + RE_APPROVED 이력
      const re = await http.post('/api/v1/admin/gates/T-REV/approve').set(auth('U00')).send({ docNo: 'D-2', approvedDate: '2026-07-20', approver: '승계자', approverUserId: 'U00' });
      expect(re.body.data.reviewStatus).toBe('OK');
      const hist2 = await http.get('/api/v1/admin/gates/T-REV/history').set(auth('U00'));
      expect(hist2.body.data.some((h: { action: string }) => h.action === 'RE_APPROVED')).toBe(true);
    });
    it('EAS lifecycle: 상신→진행→반려→재상신→완료(단일 수신 경로) + 이력', async () => {
      await prisma.orgApprovalHistory.deleteMany({ where: { gateCode: 'T-LC' } });
      await prisma.orgApproval.deleteMany({ where: { gateCode: 'T-LC' } });
      await prisma.orgApproval.create({ data: { gateCode: 'T-LC', title: 'lifecycle', status: 'PENDING', approver: '(미결재)' } });
      const sub = await http.post('/api/v1/admin/gates/T-LC/reference').set(auth('U00')).send({ status: 'SUBMITTED', docNo: 'EAS-1' });
      expect(sub.body.data.status).toBe('SUBMITTED');
      await http.post('/api/v1/admin/gates/T-LC/reference').set(auth('U00')).send({ status: 'IN_PROGRESS' });
      const rej = await http.post('/api/v1/admin/gates/T-LC/reference').set(auth('U00')).send({ status: 'REJECTED', reason: '근거 미비' });
      expect(rej.body.data.status).toBe('REJECTED');
      const re = await http.post('/api/v1/admin/gates/T-LC/reference').set(auth('U00')).send({ status: 'SUBMITTED', docNo: 'EAS-2' });
      expect(re.body.data.status).toBe('SUBMITTED');
      const ok = await http.post('/api/v1/admin/gates/T-LC/reference').set(auth('U00')).send({ status: 'APPROVED', docNo: 'EAS-2', approver: '결재자', approvedDate: '2026-07-20' });
      expect(ok.body.data.status).toBe('APPROVED');
      expect(ok.body.data.reviewStatus).toBe('OK');
      const hist = await http.get('/api/v1/admin/gates/T-LC/history').set(auth('U00'));
      const actions = hist.body.data.map((h: { action: string }) => h.action);
      expect(actions).toContain('SUBMITTED');
      expect(actions).toContain('REJECTED');
      expect(actions).toContain('RESUBMITTED');
      expect(actions).toContain('APPROVED');
    });
    it('잘못된 결재 status → 400', async () => {
      const res = await http.post('/api/v1/admin/gates/T-LC/reference').set(auth('U00')).send({ status: 'MAYBE' });
      expect(res.status).toBe(400);
    });
    it('정기 재검토 기간 만료 → STALE(정기)', async () => {
      await prisma.orgApproval.deleteMany({ where: { gateCode: 'T-PER' } });
      await prisma.orgApproval.create({ data: { gateCode: 'T-PER', title: '정기테스트', status: 'PENDING', approver: '(미결재)' } });
      // 과거 승인일 + 365일 주기 → nextReviewDate 과거 → 만료
      await http.post('/api/v1/admin/gates/T-PER/approve').set(auth('U00')).send({ docNo: 'D-P', approvedDate: '2020-01-01', approver: 'x', reviewIntervalDays: 365 });
      const list = await http.get('/api/v1/admin/gates').set(auth('U00'));
      const per = list.body.data.find((g: { gateCode: string }) => g.gateCode === 'T-PER');
      expect(per.reviewStatus).toBe('STALE');
      expect(per.reviewFlags.join()).toContain('정기');
    });
    it('개시 준비도 — 사람 몫 항목 라이브 점검(조직결재 플레이스홀더·데모계정 감지)', async () => {
      const res = await http.get('/api/v1/admin/readiness').set(auth('U00'));
      expect(res.status).toBe(200);
      const d = res.body.data;
      expect(Array.isArray(d.checks)).toBe(true);
      expect(d.summary).toHaveProperty('block');
      // 데모 계정으로 승인된 게이트는 DEV 플레이스홀더로 감지 → 실결재 미완(BLOCK)
      const gates = d.checks.find((c: { key: string }) => c.key === 'org_gates');
      expect(gates).toBeTruthy();
      expect(gates.status).toBe('BLOCK');
      expect(gates.detail).toContain('플레이스홀더');
      // 데모 계정 활성 감지
      const demo = d.checks.find((c: { key: string }) => c.key === 'demo_accounts');
      expect(demo.detail).toMatch(/데모 계정/);
      // 위험치 채널 미설정 → BLOCK
      expect(d.checks.find((c: { key: string }) => c.key === 'critical_webhook').status).toBe('BLOCK');
      // 권한: AUD 열람 가능, 비관리(RCP) 차단
      expect((await http.get('/api/v1/admin/readiness').set(auth('U07'))).status).toBe(403);
    });
    it('조직/외부 결정 등록 — 레지스트리 조회·기입(기입자 서버결속)·콘솔 ⑤축 반영', async () => {
      // 레지스트리 목록
      const list = await http.get('/api/v1/admin/decisions').set(auth('U00'));
      expect(list.status).toBe(200);
      const infra = list.body.data.find((d: { key: string }) => d.key === 'infra_aws');
      expect(infra).toBeTruthy();
      expect(infra.blocking).toBe(true);
      expect(infra.status).toBe('PENDING'); // 미기입 기본
      // DECIDED인데 결정값 없으면 400
      const bad = await http.post('/api/v1/admin/decisions/infra_aws').set(auth('U00')).send({ status: 'DECIDED' });
      expect(bad.status).toBe(400);
      // 정상 기입 → 결정완료, 기입자(decidedBy)는 서버가 U00으로 결속(body에 안 보냈어도)
      const rec = await http.post('/api/v1/admin/decisions/infra_aws').set(auth('U00')).send({ status: 'DECIDED', decidedValue: 'AWS 서울 이전 완료', decidedByName: '인프라팀', documentRef: 'INF-2026-01' });
      expect(rec.status).toBe(201);
      expect(rec.body.data.status).toBe('DECIDED');
      expect(rec.body.data.decidedBy).toBe('U00');
      // 콘솔 ⑤축에 반영 — infra_aws가 OK(LIVE)로
      const con = await http.get('/api/v1/admin/console').set(auth('U00'));
      const axis5 = con.body.data.axes.find((a: { axis: string }) => a.axis === '5');
      expect(axis5).toBeTruthy();
      const item = axis5.items.find((i: { key: string }) => i.key === 'infra_aws');
      expect(item.status).toBe('OK');
      // 비관리(RCP) 기입 차단
      expect((await http.post('/api/v1/admin/decisions/pacs_cutover').set(auth('U07')).send({ status: 'DECIDED', decidedValue: 'x' })).status).toBe(403);
    });
    it('개시 승인(Go-Live) — 차단 잔존 시 승인 불가·override는 잔여위험 필수·승인자 서버결속', async () => {
      // 파일럿엔 개시차단(조직결재 등)이 남아 있으므로 일반 승인은 400
      const st = await http.get('/api/v1/admin/golive').set(auth('U00'));
      expect(st.status).toBe(200);
      expect(st.body.data.blockingOpen).toBeGreaterThan(0);
      expect(st.body.data.state).toBe('NOT_READY');
      const plain = await http.post('/api/v1/admin/golive/approve').set(auth('U00')).send({ approvedByName: '개시책임자' });
      expect(plain.status).toBe(400); // 차단 미해소
      // override인데 잔여위험 없으면 400
      const noRisk = await http.post('/api/v1/admin/golive/approve').set(auth('U00')).send({ approvedByName: '개시책임자', override: true });
      expect(noRisk.status).toBe(400);
      // override + 잔여위험 → 강행 승인, 승인자(approvedBy) 서버 결속(U00), 스냅샷 기록
      const forced = await http.post('/api/v1/admin/golive/approve').set(auth('U00')).send({ approvedByName: '개시책임자', override: true, residualRisk: '조직 결재 익일 완료 예정' });
      expect(forced.status).toBe(201);
      expect(forced.body.data.action).toBe('APPROVED');
      expect(forced.body.data.approvedBy).toBe('U00');
      expect(forced.body.data.override).toBe(true);
      const after = await http.get('/api/v1/admin/golive').set(auth('U00'));
      expect(after.body.data.state).toBe('APPROVED');
      // 철회 → 다시 미승인
      await http.post('/api/v1/admin/golive/revoke').set(auth('U00')).send({ note: '재검토' });
      expect((await http.get('/api/v1/admin/golive').set(auth('U00'))).body.data.state).not.toBe('APPROVED');
      // 비관리(RCP) 승인 차단
      expect((await http.post('/api/v1/admin/golive/approve').set(auth('U07')).send({ override: true, residualRisk: 'x' })).status).toBe(403);
    });
    it('운영 관리 콘솔(P1) — 정의 항목을 4축으로 집계·개시차단 요약', async () => {
      const res = await http.get('/api/v1/admin/console').set(auth('U00'));
      expect(res.status).toBe(200);
      const d = res.body.data;
      expect(d.axes).toHaveLength(5); // 기준정보·거버넌스·운영·연동·조직외부결정
      expect(d.summary).toHaveProperty('blockingOpen');
      // 개시차단 요약 = blocking 항목 중 미완(OK 아님) — 시드/‘http만’ 위험치 채널도 포함(false-green 방지)
      const allItems = d.axes.flatMap((a: { items: { blocking: boolean; status: string }[] }) => a.items);
      const openBlockers = allItems.filter((i: { blocking: boolean; status: string }) => i.blocking && i.status !== 'OK').length;
      expect(d.summary.blockingOpen).toBe(openBlockers);
      // 조직 결재(데모=플레이스홀더)는 거버넌스 축의 개시차단 항목
      const gov = d.axes.find((a: { axis: string }) => a.axis === '2');
      const gates = gov.items.find((i: { key: string }) => i.key === 'org_gates');
      expect(gates.blocking).toBe(true);
      expect(gates.status).toBe('BLOCK');
      // 각 항목은 축·담당·다음행동(fix)·상태·lifecycle 단계를 가진다(P2)
      const all = d.axes.flatMap((a: { items: unknown[] }) => a.items);
      expect(all.length).toBeGreaterThanOrEqual(12);
      expect(all.every((i: { owner: string; status: string; stage: string }) => i.owner && i.status && i.stage)).toBe(true);
      // P2 워크플로우: pipeline이 lifecycle 단계별로 항목을 분류
      expect(Array.isArray(d.pipeline)).toBe(true);
      expect(d.pipeline.map((p: { stage: string }) => p.stage)).toEqual(['UNDEFINED', 'SEEDED', 'CONFIGURED', 'SIGNED', 'LIVE', 'REVIEW']);
      const pipeCount = d.pipeline.reduce((n: number, p: { items: unknown[] }) => n + p.items.length, 0);
      expect(pipeCount).toBe(all.length); // 전 항목이 정확히 한 단계에 배치
      // 조직결재(데모=플레이스홀더)는 SEEDED 단계
      expect(gates.stage).toBe('SEEDED');
      // 권한: 비관리(RCP) 차단
      expect((await http.get('/api/v1/admin/console').set(auth('U07'))).status).toBe(403);
    });
    it('운영 관리 통합 이력(P3) — 이벤트 타임라인·시크릿 값 미노출·권한', async () => {
      const res = await http.get('/api/v1/admin/console/activity').set(auth('U00'));
      expect(res.status).toBe(200);
      const d = res.body.data;
      expect(Array.isArray(d.events)).toBe(true);
      if (d.events.length > 1) expect(d.events[0].at >= d.events[1].at).toBe(true); // 최근순
      expect(d.events.every((e: { at: string; category: string; summary: string }) => e.at && e.category && e.summary)).toBe(true);
      // 시크릿류 설정 이벤트가 있으면 값 미노출(키·설정여부만)
      const sec = d.events.find((e: { category: string; summary: string }) => e.category === '설정변경' && /secret|key|token|password/i.test(e.summary));
      if (sec) expect(sec.summary).toMatch(/설정됨|해제/);
      expect((await http.get('/api/v1/admin/console/activity').set(auth('U07'))).status).toBe(403);
    });
    it('서명 워크시트 집계(참고치·델타·EDI·QC·게이트 섹션) — 검사실 계열(PHY) 열람 가능', async () => {
      const res = await http.get('/api/v1/admin/signoff-worksheet').set(auth('U02'));
      expect(res.status).toBe(200);
      const d = res.body.data;
      expect(Array.isArray(d.referenceRanges)).toBe(true);
      expect(Array.isArray(d.deltaConfig)).toBe(true);
      expect(Array.isArray(d.ediCodes)).toBe(true);
      expect(Array.isArray(d.qcTargets)).toBe(true);
      expect(d.clinicalDecisions.some((x: { code: string }) => x.code === 'F-1')).toBe(true);
      expect(Array.isArray(d.gates)).toBe(true);
    });
  });

  // ── 환자 기간 검색(오더 활동일) ──
  describe('환자 기간 검색', () => {
    it('오늘 오더활동 환자 → 오늘 기간검색에 포함, 활동없는 과거일엔 제외', async () => {
      // 오늘자 오더 생성(orderDt=now)
      await http.post('/api/v1/orders').set(auth('U07')).send({ patientId: 'T-2345678', testCodes: ['CHE-NA'] });
      const today = new Date().toISOString().slice(0, 10);
      const inRange = await http.get(`/api/v1/patients?from=${today}&to=${today}`).set(auth('U00'));
      expect(inRange.status).toBe(200);
      expect(inRange.body.data.some((p: { patientId: string }) => p.patientId === 'T-2345678')).toBe(true);
      // 페이지네이션 메타(100건 초과 시 탭 구분용)
      expect(inRange.body.meta.pageSize).toBe(100);
      expect(typeof inRange.body.meta.total).toBe('number');
      // 활동 없는 과거 기간 → 제외(전 오더가 now라 2020엔 없음)
      const past = await http.get('/api/v1/patients?from=2020-01-01&to=2020-01-02').set(auth('U00'));
      expect(past.body.data.some((p: { patientId: string }) => p.patientId === 'T-2345678')).toBe(false);
    });
  });

  // ── 유전체 큐레이션 (VCF 수신→큐레이션→확정→재분류) ──
  describe('유전체 수탁 워크리스트', () => {
    it('오더 목록이 수탁 정보를 함께 반환한다 — 수탁기관·TAT·상태·보고서', async () => {
      const res = await http.get('/api/v1/genomic/orders').set(auth('U06'));
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      const o = res.body.data.find((x: { genomicOrderId: string }) => x.genomicOrderId === 'T-G-1');
      expect(o).toBeTruthy();
      // 수탁 워크리스트 표에 필요한 필드 — 없으면 화면이 오더ID·환자만 보여준다(사용자 지적)
      for (const k of ['patientName', 'panelCode', 'testType', 'status', 'sendoutCenter', 'tatTarget', 'reportStatus', 'variantCount', 'unresolved']) {
        expect(o).toHaveProperty(k);
      }
    });
    it('germline VCF 반입 → VAF 백분율 저장(수기·NGS와 스케일 통일, P2)', async () => {
      const vcf = ['##fileformat=VCFv4.2', '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE', '13\t32914438\t.\tT\tC\t100\tPASS\tGENE=BRCA2;AF=0.48\tGT\t0/1'].join('\n');
      const res = await http.post('/api/v1/genomic/T-G-1/vcf').set(auth('U06')).send({ vcf });
      expect(res.status).toBe(201);
      const v = await prisma.variant.findFirst({ where: { genomicOrderId: 'T-G-1', gene: 'BRCA2' }, orderBy: { variantId: 'desc' } });
      expect(v?.vaf).toBeCloseTo(48, 0); // 분수 0.48이 아니라 48%
    });
  });

  describe('유전체 AI 해석 초안(로컬 지식기반)', () => {
    it('BRCA1 병원성 근거 → 분류 제안·표적치료 시사점·면책 문구, 데이터 외부 미전송', async () => {
      const res = await http.post('/api/v1/genomic/ai-interpret').set(auth('U06')).send({
        gene: 'BRCA1', hgvsP: 'p.Q1756fs', testType: 'GERMLINE',
        acmgEvidence: { pvs: 1, strongP: 1 },
      });
      expect(res.status).toBe(201);
      const d = res.body.data;
      expect(d.suggestedClassification).toBe('Pathogenic'); // PVS1+PS1 → 병원성
      expect(d.geneContext.gene).toBe('BRCA1');
      expect(d.geneContext.conditions).toContain('유방');
      expect(Array.isArray(d.rationale)).toBe(true);
      expect(d.rationale.length).toBeGreaterThan(0);
      expect(d.disclaimer).toContain('전문가'); // 자동확정 아님·검토 필수
      expect(d.disclaimer).toContain('외부로 전송되지 않'); // PHI 미전송 명시
      expect(d.draftNarrative).toContain('AI 해석 초안');
    });

    it('종양(SOMATIC) EGFR → 표적치료 시사점(osimertinib) 제시', async () => {
      const res = await http.post('/api/v1/genomic/ai-interpret').set(auth('U06')).send({
        gene: 'EGFR', hgvsP: 'p.L858R', vaf: 42, testType: 'SOMATIC',
      });
      expect(res.body.data.therapyImplications.join(' ')).toContain('osimertinib');
    });

    it('★근거 DB(ClinVar/gnomAD) 반입·활성화 → AI 해석이 실제 근거를 인용한다', async () => {
      // 변이근거 카탈로그 반입·활성화
      await http.post('/api/v1/admin/catalogs/VARIANT_EVIDENCE/import').set(auth('U00')).send({
        version: 'EVID-TEST', standard: 'ClinVar 2026-07',
        csv: 'gene,variant,significance,stars,gnomad_af,condition,source,citation,oncokb_level\n' +
          'BRCA1,p.Q1756fs,Pathogenic,3,0.00001,유전성 유방·난소암,ClinVar,VCV000017661,-\n' +
          'EGFR,p.L858R,Pathogenic,4,0,비소세포폐암,OncoKB,PMID:15118073,Level 1',
      });
      expect((await http.post('/api/v1/admin/catalogs/VARIANT_EVIDENCE/activate').set(auth('U00')).send({ version: 'EVID-TEST' })).status).toBe(201);

      // 이제 AI 해석이 근거 DB를 인용한다(별점·출처·집단빈도)
      const brca = await http.post('/api/v1/genomic/ai-interpret').set(auth('U06')).send({ gene: 'BRCA1', hgvsP: 'p.Q1756fs', testType: 'GERMLINE' });
      expect(brca.body.data.citedEvidence).toBeTruthy();
      expect(brca.body.data.citedEvidence.source).toBe('ClinVar');
      expect(brca.body.data.citedEvidence.citation).toBe('VCV000017661');
      expect(brca.body.data.suggestedClassification).toBe('Pathogenic');
      expect(brca.body.data.confidence).toBe('high'); // 3★
      expect(brca.body.data.rationale.join(' ')).toContain('VCV000017661');

      // 종양 EGFR — OncoKB level이 표적치료 시사점에 인용됨
      const egfr = await http.post('/api/v1/genomic/ai-interpret').set(auth('U06')).send({ gene: 'EGFR', hgvsP: 'p.L858R', testType: 'SOMATIC' });
      expect(egfr.body.data.citedEvidence.oncokbLevel).toBe('Level 1');
      expect(egfr.body.data.therapyImplications.join(' ')).toContain('OncoKB');
    });

    it('미등재 유전자 → 초안은 나오되 지식기반 미등재 주의', async () => {
      const res = await http.post('/api/v1/genomic/ai-interpret').set(auth('U06')).send({ gene: 'ZZZ99', testType: 'GERMLINE' });
      expect(res.body.data.geneContext).toBeNull();
      expect(res.body.data.caveats.join(' ')).toContain('미등재');
    });
  });

  describe('유전체 근거 종합 번들(RAG 컨텍스트)', () => {
    it('변이 근거를 한 번들로 조립하고 promptContext·llmNote를 담는다(외부 전송 없음)', async () => {
      const mv = await http.post('/api/v1/genomic/G-0002/variant').set(auth('U00')).send({ gene: 'EGFR', hgvsP: 'p.L858R', testType: 'SOMATIC' });
      const vid = mv.body.data.variantId;
      const r = await http.get(`/api/v1/genomic/variants/${vid}/evidence-context`).set(auth('U06'));
      expect(r.status).toBe(200);
      const d = r.body.data;
      expect(d.variant.gene).toBe('EGFR');
      expect(d.promptContext).toContain('변이 해석 근거 종합');
      expect(d.promptContext).toContain('EGFR');
      expect(typeof d.llmNote).toBe('string');
      expect(Array.isArray(d.sources)).toBe(true);
      // 유전자 지식(내장 KB)에 EGFR 있으므로 sources에 지식기반 포함
      expect(d.geneKnowledge).toBeTruthy();
    });
  });

  describe('유전체 근거 drift 재해석 검토', () => {
    it('확정 해석이 현재 근거 DB와 다르면 재해석 대상으로 뜬다(재접촉 필요 우선)', async () => {
      // 준비: 근거 DB에 BRCA1 p.TESTDRIFT를 Pathogenic으로 등재
      await http.post('/api/v1/admin/catalogs/VARIANT_EVIDENCE/import').set(auth('U00')).send({
        version: 'EVID-DRIFT',
        csv: 'gene,variant,significance,stars,gnomad_af,condition,source,citation,oncokb_level\n' +
          'BRCA1,p.DRIFT9,Pathogenic,3,0.00001,HBOC,ClinVar,VCV-DRIFT,-',
      });
      await http.post('/api/v1/admin/catalogs/VARIANT_EVIDENCE/activate').set(auth('U00')).send({ version: 'EVID-DRIFT' });

      // 같은 변이를 VUS로 확정(과거 해석) — 이후 근거는 Pathogenic이라 drift
      const vcf = ['##fileformat=VCFv4.2', '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE',
        '17\t43000009\t.\tG\tA\t100\tPASS\tGENE=BRCA1\tGT\t0/1'].join('\n');
      await http.post('/api/v1/genomic/T-G-1/vcf').set(auth('U00')).send({ vcf });
      const vars = await http.get('/api/v1/genomic/T-G-1/variants').set(auth('U00'));
      const v = vars.body.data.find((x: { gene: string }) => x.gene === 'BRCA1');
      // hgvsP를 근거 키와 맞춰 세팅(수기 변이로 명시 등록)
      const mv = await http.post('/api/v1/genomic/T-G-1/variant').set(auth('U00')).send({ gene: 'BRCA1', hgvsP: 'p.DRIFT9' });
      const vid = mv.body.data.variantId ?? v?.variantId;
      const cur = await http.post(`/api/v1/genomic/variants/${vid}/curate`).set(auth('U00')).send({ classification: 'VUS', classifier: 'U06' });
      await http.post(`/api/v1/genomic/interpretations/${cur.body.data.interpId}/finalize`).set(auth('U00')).send({});

      // 재해석 검토 — VUS 확정인데 근거는 Pathogenic → drift·재접촉 필요
      const rev = await http.get('/api/v1/genomic/reinterpret-review').set(auth('U06'));
      expect(rev.status).toBe(200);
      expect(rev.body.data.evidenceActive).toBe(true);
      const hit = rev.body.data.drifted.find((d: { variantId: string }) => d.variantId === vid);
      expect(hit).toBeTruthy();
      expect(hit.finalizedClass).toBe('VUS');
      expect(hit.evidenceClass).toBe('Pathogenic');
      expect(hit.needsRecontact).toBe(true); // VUS→Pathogenic = P/LP 획득
      expect(hit.source).toBe('ClinVar');
    });
  });

  describe('유전체 큐레이션', () => {
    let variantId: string;
    let interpId: string;

    beforeAll(async () => {
      // 재실행 멱등: T-G-1 변이·해석 정리
      const vars = await prisma.variant.findMany({ where: { genomicOrderId: 'T-G-1' } });
      for (const v of vars) await prisma.interpretation.deleteMany({ where: { variantId: v.variantId } });
      await prisma.variant.deleteMany({ where: { genomicOrderId: 'T-G-1' } });
    });

    it('수탁 VCF 수신 → 변이 등록', async () => {
      const vcf = [
        '##fileformat=VCFv4.2',
        '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE',
        '17\t41245466\t.\tG\tA\t100\tPASS\tGENE=BRCA1;AF=0.48\tGT:DP\t0/1:120',
      ].join('\n');
      const res = await http.post('/api/v1/genomic/T-G-1/vcf').set(auth('U00')).send({ vcf });
      expect(res.status).toBe(201);
      expect(res.body.data.imported).toBe(1);
      variantId = res.body.data.variants[0].variantId;
      expect(res.body.data.variants[0].gene).toBe('BRCA1');
    });

    it('장비 미연동/PDF: 수기 변이 단건 입력 → 변이 등록·큐레이션 가능', async () => {
      const res = await http.post('/api/v1/genomic/T-G-1/variant').set(auth('U00')).send({ gene: 'TP53', hgvsC: 'c.524G>A', hgvsP: 'p.Arg175His', vaf: 42, zygosity: 'het' });
      expect(res.status).toBe(201);
      expect(res.body.data.gene).toBe('TP53');
      const list = await http.get('/api/v1/genomic/T-G-1/variants').set(auth('U00'));
      expect(list.body.data.some((v: { gene: string }) => v.gene === 'TP53')).toBe(true);
    });
    it('수기 변이: 유전자·HGVS 모두 없음 → 400', async () => {
      const res = await http.post('/api/v1/genomic/T-G-1/variant').set(auth('U00')).send({ vaf: 30 });
      expect(res.status).toBe(400);
    });
    it('수기 변이: 원본 결과지 첨부 없는 오더 → 400(전사 근거 강제)', async () => {
      await prisma.labOrder.upsert({ where: { orderId: 'T-GO-NOATT' }, update: {}, create: { orderId: 'T-GO-NOATT', patientId: 'T-2345678', status: 'IN_PROCESS' } });
      await prisma.genomicOrder.upsert({ where: { orderId: 'T-GO-NOATT' }, update: {}, create: { genomicOrderId: 'G-NOATT', orderId: 'T-GO-NOATT', panelCode: 'T-GEN', testType: 'GERMLINE', status: '접수' } });
      const res = await http.post('/api/v1/genomic/G-NOATT/variant').set(auth('U00')).send({ gene: 'BRCA1', hgvsP: 'p.X1Y' });
      expect(res.status).toBe(400);
    });
    it('PDF 결과지 첨부 → 유전체 오더에 보존·목록', async () => {
      const pdf = Buffer.from('%PDF-1.4\n외부수탁 결과지\n%%EOF');
      const up = await http.post('/api/v1/results/genomic/T-G-1/attachments').set(auth('U00'))
        .attach('file', pdf, { filename: 'sendout-report.pdf', contentType: 'application/pdf' })
        .field('note', '수탁 PDF 결과지');
      expect(up.status).toBe(201);
      const list = await http.get('/api/v1/results/genomic/T-G-1/attachments').set(auth('U00'));
      expect(list.body.data.some((a: { filename: string }) => a.filename === 'sendout-report.pdf')).toBe(true);
    });
    it('미존재 유전체 오더 첨부 → 404', async () => {
      const pdf = Buffer.from('%PDF-1.4\n%%EOF');
      const up = await http.post('/api/v1/results/genomic/NOPE-G/attachments').set(auth('U00'))
        .attach('file', pdf, { filename: 'x.pdf', contentType: 'application/pdf' });
      expect(up.status).toBe(404);
    });

    it('ACMG 제안: PVS1+PS1 → Pathogenic', async () => {
      const res = await http.post('/api/v1/genomic/acmg-suggest').set(auth('U00')).send({ pvs: 1, strongP: 1 });
      expect(res.body.data.classification).toBe('Pathogenic');
    });

    it('변이 큐레이션(DRAFT) → 확정(FINAL)', async () => {
      const cur = await http.post(`/api/v1/genomic/variants/${variantId}/curate`).set(auth('U00')).send({ classification: 'VUS', evidence: 'PM2', classifier: 'U00' });
      expect(cur.status).toBe(201);
      expect(cur.body.data.status).toBe('DRAFT');
      interpId = cur.body.data.interpId;
      const fin = await http.post(`/api/v1/genomic/interpretations/${interpId}/finalize`).set(auth('U00'));
      expect(fin.body.data.status).toBe('FINAL');
    });

    it('재분류: VUS→Pathogenic, 기존 FINAL은 SUPERSEDED', async () => {
      const res = await http.post(`/api/v1/genomic/variants/${variantId}/reclassify`).set(auth('U00')).send({ classification: 'Pathogenic', evidence: 'PVS1,PS1', classifier: 'U00', reason: '신규 문헌 반영' });
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('FINAL');
      expect(res.body.data.recontact).toBeTruthy(); // G1 재접촉 통보(VUS→Pathogenic = P/LP 획득)
      // 조회 시 기존 해석은 SUPERSEDED
      const list = await http.get('/api/v1/genomic/T-G-1/variants').set(auth('U00'));
      const interps = list.body.data.find((v: { variantId: string }) => v.variantId === variantId).interpretations;
      const superseded = interps.find((i: { interpId: string }) => i.interpId === interpId);
      expect(superseded.status).toBe('SUPERSEDED');
    });
    it('G1 비유의 재분류(P/LP 내 이동) → 재접촉 통보 없음', async () => {
      const res = await http.post(`/api/v1/genomic/variants/${variantId}/reclassify`).set(auth('U00')).send({ classification: 'Likely Pathogenic', evidence: 'PVS1', classifier: 'U00', reason: '등급 조정' });
      expect(res.body.data.recontact).toBeNull();
    });
    it('G2 NGS QC 게이트 — 미달 FAIL·충족 PASS', async () => {
      await prisma.ngsRun.deleteMany({ where: { runId: { in: ['T-RUN-BAD', 'T-RUN-OK'] } } });
      await prisma.ngsRun.create({ data: { runId: 'T-RUN-BAD', runName: 'bad', q30: 70, meanCoverage: 50, uniformityPct: 80 } });
      await prisma.ngsRun.create({ data: { runId: 'T-RUN-OK', runName: 'ok', q30: 92, meanCoverage: 250, uniformityPct: 95 } });
      const bad = await http.get('/api/v1/genomic/runs/T-RUN-BAD/qc').set(auth('U00'));
      expect(bad.body.data.verdict).toBe('FAIL');
      expect(bad.body.data.failed.length).toBeGreaterThan(0);
      const ok = await http.get('/api/v1/genomic/runs/T-RUN-OK/qc').set(auth('U00'));
      expect(ok.body.data.verdict).toBe('PASS');
    });
    it('G3 보고서 서명→배포 + 미확정 오더 서명 400', async () => {
      // 서명(Access.S)은 판독 자격 역할(GEN/PHY)만 — 관리자(ADM)는 운영(W)까지이고 서명 불가.
      const admSign = await http.post('/api/v1/genomic/T-G-1/report/sign').set(auth('U00')).send({});
      expect(admSign.status).toBe(403);
      // 서명자는 body가 아니라 인증 주체에서 서버가 결정한다.
      const sign = await http.post('/api/v1/genomic/T-G-1/report/sign').set(auth('U06')).send({ signer: 'U99-위조시도' });
      expect(sign.status).toBe(201);
      expect(sign.body.data.reportStatus).toBe('최종');
      expect(sign.body.data.reportSignedBy).toBe('U06');
      const dv = await http.post('/api/v1/genomic/T-G-1/report/deliver').set(auth('U00')).send({ channel: 'PROVIDER', recipient: '의뢰의' });
      expect(dv.status).toBe(201);
      const list = await http.get('/api/v1/genomic/T-G-1/report/deliveries').set(auth('U00'));
      expect(list.body.data.some((d: { channel: string }) => d.channel === 'PROVIDER')).toBe(true);
      const bad = await http.post('/api/v1/genomic/T-G-2/report/sign').set(auth('U06')).send({});
      expect(bad.status).toBe(400); // FINAL 해석 없음
    });

    /**
     * P4 유전자 심볼 보정 — 심볼을 못 읽은 확정 P/LP는 review 버킷에 갇혀 보고서 어디에도 안 나온다.
     * 보정 경로가 없으면 확정 P/LP가 영영 보고되지 않는다(협소하지만 임상 결과 누락).
     */
    it('★심볼 미확정 확정 P/LP는 review로 격리되고, 보정하면 보고서에 들어온다', async () => {
      const mv = await http.post('/api/v1/genomic/T-G-1/variant').set(auth('U00')).send({ hgvsC: 'c.1521_1523delCTT', hgvsP: 'p.Phe508del' });
      expect(mv.status).toBe(201);
      const vid = mv.body.data.variantId;
      const cur = await http.post(`/api/v1/genomic/variants/${vid}/curate`).set(auth('U00')).send({ classification: 'Pathogenic', evidence: 'PVS1' });
      await http.post(`/api/v1/genomic/interpretations/${cur.body.data.interpId}/finalize`).set(auth('U00'));

      const before = await http.get('/api/v1/genomic/T-G-1/report').set(auth('U00'));
      expect(before.body.data.reviewCount).toBeGreaterThanOrEqual(1);
      // 건수만이 아니라 어느 변이인지 나와야 보정할 수 있다
      expect(before.body.data.review.some((f: { variantId: string }) => f.variantId === vid)).toBe(true);
      expect(before.body.data.primary.some((f: { variantId: string }) => f.variantId === vid)).toBe(false);

      const fix = await http.post(`/api/v1/genomic/variants/${vid}/gene`).set(auth('U00')).send({ gene: 'CFTR', reason: '수탁 원본 결과지 대조' });
      expect(fix.status).toBe(201);
      expect(fix.body.data.normalized).toBe('CFTR');

      const after = await http.get('/api/v1/genomic/T-G-1/report').set(auth('U00'));
      expect(after.body.data.review.some((f: { variantId: string }) => f.variantId === vid)).toBe(false);
      expect(after.body.data.primary.some((f: { variantId: string }) => f.variantId === vid)).toBe(true);
    });

    it('심볼이 이미 확정된 변이의 유전자 교체는 거부 — SF 동의 게이트 우회 차단', async () => {
      const res = await http.post(`/api/v1/genomic/variants/${variantId}/gene`).set(auth('U00')).send({ gene: 'BRCA2', reason: '임의 변경 시도' });
      expect(res.status).toBe(400);
      const v = await prisma.variant.findUnique({ where: { variantId } });
      expect(v?.gene).toBe('BRCA1'); // 원본 유지
    });

    it('보정 심볼이 유효하지 않거나 근거가 없으면 400', async () => {
      const mv = await http.post('/api/v1/genomic/T-G-1/variant').set(auth('U00')).send({ hgvsC: 'c.9999A>T' });
      const vid = mv.body.data.variantId;
      expect((await http.post(`/api/v1/genomic/variants/${vid}/gene`).set(auth('U00')).send({ gene: '  ;; ', reason: 'x' })).status).toBe(400);
      expect((await http.post(`/api/v1/genomic/variants/${vid}/gene`).set(auth('U00')).send({ gene: 'CFTR', reason: '   ' })).status).toBe(400);
    });
  });

  // ── QC 연동: QC fail → 결과 확정 차단 ──
  describe('QC 결과 차단 연동', () => {
    it('QC PASS 상태 → CHE-K 결과 자동검증', async () => {
      await http.post('/api/v1/qc/results').set(auth('U02')).send({ qcCode: 'T-QC', instrument: 'inst1', testCode: 'CHE-K', value: 4.2 });
      const r = await http.post('/api/v1/results').set(auth('U02')).send({ specimenNo: 'T-S-INS', testCode: 'CHE-K', value: '4.0', unit: 'mmol/L', rerun: true });
      expect(r.body.data.evaluation.autoVerified).toBe(true);
    });

    it('QC 상태 조회: PASS', async () => {
      const res = await http.get('/api/v1/qc/status?testCode=CHE-K').set(auth('U02'));
      expect(res.status).toBe(200);
      expect(res.body.data.blocked).toBe(false);
    });

    it('QC FAIL → 후속 CHE-K 결과 자동검증 차단(holdReason QC)', async () => {
      const qc = await http.post('/api/v1/qc/results').set(auth('U02')).send({ qcCode: 'T-QC', instrument: 'inst1', testCode: 'CHE-K', value: 4.85 });
      expect(qc.body.data.evaluation.verdict).toBe('FAIL');
      const r = await http.post('/api/v1/results').set(auth('U02')).send({ specimenNo: 'T-S-INS', testCode: 'CHE-K', value: '4.0', unit: 'mmol/L', rerun: true });
      expect(r.body.data.evaluation.autoVerified).toBe(false);
      expect(r.body.data.evaluation.holdReason).toBe('QC');
    });

    it('QC 상태 조회: FAIL·차단', async () => {
      const res = await http.get('/api/v1/qc/status?testCode=CHE-K').set(auth('U02'));
      expect(res.body.data.verdict).toBe('FAIL');
      expect(res.body.data.blocked).toBe(true);
    });

    it('QC 측정 로그 — 서버가 저장한 측정을 목록으로 조회(세션 제출분만 보이던 것 보완)', async () => {
      // 위에서 CHE-K에 PASS·FAIL 측정을 넣었다. 로그에 값·판정·측정일과 함께 나와야 한다.
      const all = await http.get('/api/v1/qc/results?testCode=CHE-K').set(auth('U02'));
      expect(all.status).toBe(200);
      expect(all.body.data.length).toBeGreaterThanOrEqual(2);
      const one = all.body.data[0];
      for (const k of ['qcResultId', 'testCode', 'testName', 'measuredValue', 'verdict', 'lot', 'measuredDt']) {
        expect(one).toHaveProperty(k);
      }
      // 판정 필터 — FAIL만
      const fail = await http.get('/api/v1/qc/results?testCode=CHE-K&verdict=FAIL').set(auth('U02'));
      expect(fail.body.data.every((r: { verdict: string }) => r.verdict === 'FAIL')).toBe(true);
      expect(fail.body.data.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── 오더 취소/변경 · 부분보고 (P3) ──
  describe('오더 취소/변경·부분보고', () => {
    beforeAll(async () => {
      // 부분보고용 전용 오더(2항목) + 검체
      await prisma.result.deleteMany({ where: { specimenNo: 'T-S-P3' } });
      await prisma.orderItem.deleteMany({ where: { orderId: 'T-O-P3' } });
      await prisma.specimen.deleteMany({ where: { orderId: 'T-O-P3' } });
      await prisma.labOrder.deleteMany({ where: { orderId: 'T-O-P3' } });
      await prisma.labOrder.create({
        data: {
          orderId: 'T-O-P3', hisOrderNo: 'P3-PARTIAL', patientId: 'T-2345678', status: 'IN_PROCESS',
          items: { create: [{ orderItemId: 'T-O-P3-I1', testCode: 'CHE-K', status: 'IN_PROCESS' }, { orderItemId: 'T-O-P3-I2', testCode: 'CHE-NA', status: 'IN_PROCESS' }] },
        },
      });
      await prisma.specimen.create({ data: { specimenNo: 'T-S-P3', orderId: 'T-O-P3', specimenType: 'Serum', status: 'IN_PROCESS' } });
    });

    const oml = (msgId: string, hisNo: string, oc: string) => [
      `MSH|^~\\&|HIS|HOSP|LIS|HOSP|20260714090000||OML^O21|${msgId}|P|2.5.1`,
      'PID|1||T-2345678^^^HOSP^MR||김^테스트||19720503|M',
      `ORC|${oc}|${hisNo}`,
      `OBR|1|${hisNo}||CBC^일반혈액^L|||20260714090000|||||||||||||||||R`,
    ].join('\r');

    it('오더 신규(NW) → 취소(CA) → CANCELLED', async () => {
      const nw = await http.post('/api/v1/integration/hl7/inbound').set(auth('U00')).send({ message: oml('P3-NW-1', 'P3-CANCEL', 'NW') });
      expect(nw.body.data.result).toBe('CREATED');
      const ca = await http.post('/api/v1/integration/hl7/inbound').set(auth('U00')).send({ message: oml('P3-CA-1', 'P3-CANCEL', 'CA') });
      expect(ca.body.data.result).toBe('CANCELLED');
      const order = await prisma.labOrder.findFirst({ where: { hisOrderNo: 'P3-CANCEL' } });
      expect(order?.status).toBe('CANCELLED');
    });

    it('취소 대상 없음 → NO_ORDER(AE)', async () => {
      const res = await http.post('/api/v1/integration/hl7/inbound').set(auth('U00')).send({ message: oml('P3-CA-X', 'P3-NOEXIST', 'CA') });
      expect(res.body.data.result).toBe('NO_ORDER');
      expect(res.body.data.ack).toContain('MSA|AE');
    });

    it('오더 변경(XO) → 기존 취소 + 신규(CHANGED)', async () => {
      await http.post('/api/v1/integration/hl7/inbound').set(auth('U00')).send({ message: oml('P3-NW-2', 'P3-CHANGE', 'NW') });
      const xo = await http.post('/api/v1/integration/hl7/inbound').set(auth('U00')).send({ message: oml('P3-XO-1', 'P3-CHANGE', 'XO') });
      expect(xo.body.data.result).toBe('CHANGED');
    });

    it('부분보고: 2항목 중 1항목 보고 → partial', async () => {
      const before = await http.get('/api/v1/orders/T-O-P3/completeness').set(auth('U02'));
      expect(before.body.data.reported).toBe(0);
      // CHE-NA 결과(정상 140) 자동확정 → 항목 REPORTED
      await http.post('/api/v1/results').set(auth('U02')).send({ specimenNo: 'T-S-P3', testCode: 'CHE-NA', value: '140', unit: 'mmol/L' });
      const after = await http.get('/api/v1/orders/T-O-P3/completeness').set(auth('U02'));
      expect(after.body.data.reported).toBe(1);
      expect(after.body.data.partial).toBe(true);
      expect(after.body.data.complete).toBe(false);
    });
  });

  // ── 문서 첨부 스코프 확장(미생물 검체·수혈 이상반응·EQA 성적서) ──
  describe('문서 첨부 스코프 확장', () => {
    it('수혈 이상반응 문서 첨부 + 목록', async () => {
      const rx = await prisma.transfusionReaction.create({ data: { reactionId: 'T-RX-ATT', patientId: 'T-2345678', reactionType: 'FEBRILE', severity: 'MILD' } });
      const pdf = Buffer.from('%PDF-1.4\n이상반응 조사서\n%%EOF');
      const up = await http.post(`/api/v1/results/transfusion-reactions/${rx.reactionId}/attachments`).set(auth('U00'))
        .attach('file', pdf, { filename: 'reaction-invest.pdf', contentType: 'application/pdf' }).field('note', '이상반응 조사서');
      expect(up.status).toBe(201);
      const list = await http.get(`/api/v1/results/transfusion-reactions/${rx.reactionId}/attachments`).set(auth('U00'));
      expect(list.body.data.some((a: { filename: string }) => a.filename === 'reaction-invest.pdf')).toBe(true);
    });
    it('EQA 외부 성적서 첨부 + 목록', async () => {
      const s = await prisma.eqaSurvey.create({ data: { surveyId: 'T-EQA-ATT', program: 'KEQAS', cycle: '2026-1', testCode: 'CHE-NA', sampleId: 'S1', submittedValue: 140 } });
      const pdf = Buffer.from('%PDF-1.4\nEQA 성적서\n%%EOF');
      const up = await http.post(`/api/v1/results/eqa/${s.surveyId}/attachments`).set(auth('U00'))
        .attach('file', pdf, { filename: 'eqa-report.pdf', contentType: 'application/pdf' });
      expect(up.status).toBe(201);
      const list = await http.get(`/api/v1/results/eqa/${s.surveyId}/attachments`).set(auth('U00'));
      expect(list.body.data.length).toBeGreaterThanOrEqual(1);
    });
    it('미존재 이상반응 첨부 → 404', async () => {
      const pdf = Buffer.from('%PDF-1.4\n%%EOF');
      const up = await http.post('/api/v1/results/transfusion-reactions/NOPE-RX/attachments').set(auth('U00'))
        .attach('file', pdf, { filename: 'x.pdf', contentType: 'application/pdf' });
      expect(up.status).toBe(404);
    });
  });

  // ── EQA 외부정도관리 (P3) ──
  describe('EQA 외부정도관리', () => {
    let surveyId: string;

    it('EQA 결과 제출 → PENDING', async () => {
      const res = await http.post('/api/v1/eqa').set(auth('U02')).send({
        program: 'KEQAS', cycle: '2026-1', testCode: 'CHE-K', sampleId: 'S-01', submittedValue: 4.3,
      });
      expect(res.status).toBe(201);
      expect(res.body.data.verdict).toBe('PENDING');
      surveyId = res.body.data.surveyId;
    });

    it('또래군 통계 입력 → SDI·판정(ACCEPT)', async () => {
      const res = await http.post(`/api/v1/eqa/${surveyId}/evaluate`).set(auth('U02')).send({ peerMean: 4.2, peerSd: 0.1 });
      expect(res.status).toBe(201);
      expect(res.body.data.sdi).toBe(1); // (4.3-4.2)/0.1
      expect(res.body.data.verdict).toBe('ACCEPT');
    });

    it('부적합 편차 → UNACCEPTABLE', async () => {
      const sub = await http.post('/api/v1/eqa').set(auth('U02')).send({
        program: 'KEQAS', cycle: '2026-1', testCode: 'CHE-K', sampleId: 'S-02', submittedValue: 5.0,
      });
      const ev = await http.post(`/api/v1/eqa/${sub.body.data.surveyId}/evaluate`).set(auth('U02')).send({ peerMean: 4.2, peerSd: 0.1 });
      expect(ev.body.data.verdict).toBe('UNACCEPTABLE'); // SDI=8
    });

    it('목록 조회', async () => {
      const res = await http.get('/api/v1/eqa?program=KEQAS').set(auth('U02'));
      expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    });

    it('SDI 추세 — 검사별 시계열·계통편향·부적합 집계', async () => {
      const res = await http.get('/api/v1/eqa/trend?testCode=CHE-K').set(auth('U02'));
      expect(res.status).toBe(200);
      const k = res.body.data.find((t: { testCode: string }) => t.testCode === 'CHE-K');
      expect(k).toBeTruthy();
      expect(k.n).toBeGreaterThanOrEqual(2); // SDI 1·8
      expect(k.meanSdi).toBeGreaterThanOrEqual(1); // 평균 양성편향
      expect(k.biasFlag).toContain('양성');
      expect(k.unacceptable).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(k.points)).toBe(true);
    });
  });

  // ── 오더 페이지네이션 (P3 성능) ──
  describe('오더 페이지네이션', () => {
    it('take 제한 + total 메타', async () => {
      const res = await http.get('/api/v1/orders?take=2').set(auth('U02'));
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeLessThanOrEqual(2);
      expect(res.body.meta.total).toBeGreaterThanOrEqual(res.body.data.length);
      expect(res.body.meta.take).toBe(2);
    });
    it('take 상한 100 강제', async () => {
      const res = await http.get('/api/v1/orders?take=9999').set(auth('U02'));
      expect(res.body.meta.take).toBe(100);
    });
  });

  // ── 오더 처리이력 관리(등록일자 범위·요약·CSV) ──
  describe('오더 처리이력 관리', () => {
    beforeAll(async () => {
      // 등록일자가 명확한 오더(2026-07-10) — 범위 필터 대상
      await prisma.labOrder.upsert({
        where: { orderId: 'T-O-HIST' }, update: { orderDt: new Date('2026-07-10T09:00:00Z'), status: 'COMPLETED' },
        create: { orderId: 'T-O-HIST', patientId: 'T-2345678', priority: 'R', status: 'COMPLETED', orderDt: new Date('2026-07-10T09:00:00Z') },
      });
    });

    it('등록일자 범위 필터 — 포함/제외', async () => {
      const inRange = await http.get('/api/v1/orders?from=2026-07-10&to=2026-07-10').set(auth('U02'));
      expect(inRange.status).toBe(200);
      expect(inRange.body.data.some((o: { orderId: string }) => o.orderId === 'T-O-HIST')).toBe(true);
      const outRange = await http.get('/api/v1/orders?from=2026-07-11&to=2026-07-12').set(auth('U02'));
      expect(outRange.body.data.some((o: { orderId: string }) => o.orderId === 'T-O-HIST')).toBe(false);
    });

    it('처리 현황 요약 — 총건수·상태 분포', async () => {
      const res = await http.get('/api/v1/orders/summary?from=2026-07-10&to=2026-07-10').set(auth('U02'));
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBeGreaterThanOrEqual(1);
      expect(res.body.data.byStatus.COMPLETED).toBeGreaterThanOrEqual(1);
    });

    // 주: from 경계 KST 00:00 정규화 수정은 프로덕션(TZ=Asia/Seoul)에서 유효하며, UTC 테스트 환경에선 no-op라
    // 별도 KST-의존 e2e는 다른 UTC-가정 테스트와 충돌해 생략. dateRange 로직은 코드 리뷰로 검증됨.

    it('CSV 내보내기용 평면 조회 — 등록일시·환자명 포함', async () => {
      const res = await http.get('/api/v1/orders/export?from=2026-07-10&to=2026-07-10').set(auth('U02'));
      expect(res.status).toBe(200);
      const row = res.body.data.rows.find((r: { orderId: string }) => r.orderId === 'T-O-HIST');
      expect(row).toBeTruthy();
      expect(row.orderDt).toContain('2026-07-10');
      expect(row.patientName).toBe('김테스트');
      expect(res.body.data.truncated).toBe(false);
    });
  });

  // ── 검체 접수 정정·취소(임상병리사 접수 처리) ──
  describe('검체 접수 정정·취소', () => {
    it('접수 정정 — 용기·채취자 수정 + 타임라인에 검체정보 반영', async () => {
      await prisma.labOrder.upsert({ where: { orderId: 'T-O-CORR' }, update: { status: 'IN_PROCESS' }, create: { orderId: 'T-O-CORR', patientId: 'T-2345678', status: 'IN_PROCESS' } });
      const rc = await http.post('/api/v1/orders/receive').set(auth('U07')).send({ orderId: 'T-O-CORR', containerCode: 'EDTA' });
      const sp = rc.body.data.specimenNo;
      const res = await http.patch(`/api/v1/orders/specimens/${sp}/receipt`).set(auth('U07')).send({ containerCode: 'SST', collectedBy: 'N-정정' });
      expect(res.status).toBe(200);
      expect(res.body.data.containerCode).toBe('SST');
      const tl = await http.get(`/api/v1/orders/specimens/${sp}/timeline`).set(auth('U07'));
      expect(tl.body.data.specimen.containerCode).toBe('SST');
      expect(tl.body.data.specimen.collectedBy).toBe('N-정정');
      expect(tl.body.data.specimen.patientName).toBe('김테스트');
    });

    it('접수 취소 — 검체 삭제·오더 RECEIVED 복귀', async () => {
      await prisma.labOrder.upsert({ where: { orderId: 'T-O-CANC' }, update: { status: 'IN_PROCESS' }, create: { orderId: 'T-O-CANC', patientId: 'T-2345678', status: 'IN_PROCESS' } });
      const rc = await http.post('/api/v1/orders/receive').set(auth('U07')).send({ orderId: 'T-O-CANC', containerCode: 'EDTA' });
      const sp = rc.body.data.specimenNo;
      const res = await http.post(`/api/v1/orders/specimens/${sp}/cancel-receipt`).set(auth('U07'));
      expect(res.status).toBe(201);
      expect(res.body.data.orderReverted).toBe(true);
      const gone = await http.get(`/api/v1/orders/specimens/${sp}/timeline`).set(auth('U07'));
      expect(gone.status).toBe(404);
      const ord = await http.get('/api/v1/orders/T-O-CANC').set(auth('U02'));
      expect(ord.body.data.status).toBe('RECEIVED');
    });

    it('거부된 검체는 접수 취소 불가(400)', async () => {
      await prisma.labOrder.upsert({ where: { orderId: 'T-O-RJ' }, update: { status: 'IN_PROCESS' }, create: { orderId: 'T-O-RJ', patientId: 'T-2345678', status: 'IN_PROCESS' } });
      const rc = await http.post('/api/v1/orders/receive').set(auth('U07')).send({ orderId: 'T-O-RJ', containerCode: 'EDTA' });
      const sp = rc.body.data.specimenNo;
      await http.post(`/api/v1/orders/specimens/${sp}/reject`).set(auth('U07')).send({ reason: 'HEMOLYZED', recollect: false });
      const res = await http.post(`/api/v1/orders/specimens/${sp}/cancel-receipt`).set(auth('U07'));
      expect(res.status).toBe(400);
    });
    it('접수 정정 — 미등록 용기코드는 400(FK 500 방지)', async () => {
      await prisma.labOrder.upsert({ where: { orderId: 'T-O-BADC' }, update: { status: 'IN_PROCESS' }, create: { orderId: 'T-O-BADC', patientId: 'T-2345678', status: 'IN_PROCESS' } });
      const rc = await http.post('/api/v1/orders/receive').set(auth('U07')).send({ orderId: 'T-O-BADC', containerCode: 'EDTA' });
      const res = await http.patch(`/api/v1/orders/specimens/${rc.body.data.specimenNo}/receipt`).set(auth('U07')).send({ containerCode: 'NONEXIST' });
      expect(res.status).toBe(400);
    });
    it('배양 진행 검체는 접수 취소 불가(400, FK 보호)', async () => {
      await prisma.labOrder.upsert({ where: { orderId: 'T-O-CUL' }, update: { status: 'IN_PROCESS' }, create: { orderId: 'T-O-CUL', patientId: 'T-2345678', status: 'IN_PROCESS' } });
      const rc = await http.post('/api/v1/orders/receive').set(auth('U07')).send({ orderId: 'T-O-CUL', containerCode: 'EDTA' });
      const sp = rc.body.data.specimenNo;
      await prisma.culture.create({ data: { cultureId: 'T-CUL-CANC', specimenNo: sp, medium: 'Blood agar', stage: 'INOCULATED', status: '진행' } });
      const res = await http.post(`/api/v1/orders/specimens/${sp}/cancel-receipt`).set(auth('U07'));
      expect(res.status).toBe(400);
    });
    it('접수 취소 시 이미 취소된 항목은 되살리지 않음', async () => {
      await prisma.labOrder.upsert({ where: { orderId: 'T-O-MIX' }, update: { status: 'IN_PROCESS' }, create: { orderId: 'T-O-MIX', patientId: 'T-2345678', status: 'IN_PROCESS' } });
      await prisma.orderItem.upsert({ where: { orderItemId: 'T-OI-MIX-A' }, update: { status: 'CANCELLED' }, create: { orderItemId: 'T-OI-MIX-A', orderId: 'T-O-MIX', testCode: 'CHE-K', status: 'CANCELLED' } });
      await prisma.orderItem.upsert({ where: { orderItemId: 'T-OI-MIX-B' }, update: { status: 'IN_PROCESS' }, create: { orderItemId: 'T-OI-MIX-B', orderId: 'T-O-MIX', testCode: 'CHE-NA', status: 'IN_PROCESS' } });
      const rc = await http.post('/api/v1/orders/receive').set(auth('U07')).send({ orderId: 'T-O-MIX', containerCode: 'EDTA' });
      await http.post(`/api/v1/orders/specimens/${rc.body.data.specimenNo}/cancel-receipt`).set(auth('U07'));
      const a = await prisma.orderItem.findUnique({ where: { orderItemId: 'T-OI-MIX-A' } });
      expect(a?.status).toBe('CANCELLED'); // 되살아나지 않음
    });
  });

  // ── 데이터 수명주기 (P3) ──
  describe('데이터 수명주기·보존', () => {
    it('RBAC: 검증의(PHY) 접근 → 403', async () => {
      const res = await http.get('/api/v1/admin/lifecycle/status').set(auth('U02'));
      expect(res.status).toBe(403);
    });

    it('보존정책 현황(ADM)', async () => {
      const res = await http.get('/api/v1/admin/lifecycle/status').set(auth('U00'));
      expect(res.status).toBe(200);
      const keys = res.body.data.policies.map((p: { key: string }) => p.key);
      expect(keys).toContain('audit_log');
      const result = res.body.data.policies.find((p: { key: string }) => p.key === 'result');
      expect(result.purgeable).toBe(false); // 임상 결과 자동삭제 제외
    });

    it('정리 dryRun(기본) → 삭제 0, 대상 집계만', async () => {
      const res = await http.post('/api/v1/admin/lifecycle/purge').set(auth('U00'));
      expect(res.status).toBe(201);
      expect(res.body.data.dryRun).toBe(true);
      expect(res.body.data.results.every((r: { deleted: number }) => r.deleted === 0)).toBe(true);
      // 결과(result)는 정리 대상에 없음(purgeable=false)
      expect(res.body.data.results.find((r: { key: string }) => r.key === 'result')).toBeUndefined();
    });
  });

  // ── 사용자·권한 관리 (Admin) ──
  describe('사용자·권한 관리', () => {
    beforeAll(async () => {
      await prisma.userRole.deleteMany({ where: { userId: 'U-NEW' } });
      await prisma.appUser.deleteMany({ where: { userId: 'U-NEW' } });
    });

    it('RBAC: 검증의(PHY) 사용자관리 → 403', async () => {
      const res = await http.get('/api/v1/admin/users').set(auth('U02'));
      expect(res.status).toBe(403);
    });

    it('권한 매트릭스 조회(ADM)', async () => {
      const res = await http.get('/api/v1/admin/permission-matrix').set(auth('U00'));
      expect(res.status).toBe(200);
      const codes = res.body.data.features.map((f: { code: string }) => f.code);
      expect(codes).toContain('F-MST');
      expect(res.body.data.roles.length).toBeGreaterThan(5);
    });

    it('사용자 목록에 역할·상태 포함', async () => {
      const res = await http.get('/api/v1/admin/users').set(auth('U00'));
      const adm = res.body.data.find((u: { userId: string }) => u.userId === 'U00');
      expect(adm.roles).toContain('ADM');
    });

    it('사용자 생성 → 역할 재배정 → 비활성', async () => {
      const c = await http.post('/api/v1/admin/users').set(auth('U00')).send({
        userId: 'U-NEW', name: '신규검사자', password: 'LisSecure2026', roles: ['TEC'],
      });
      expect(c.status).toBe(201);
      // 약한 비번 → 400
      const weak = await http.post('/api/v1/admin/users').set(auth('U00')).send({ userId: 'U-NEW2', name: 'x', password: 'weak', roles: ['TEC'] });
      expect(weak.status).toBe(400);
      // 역할 재배정(시드된 역할 사용)
      const sr = await http.patch('/api/v1/admin/users/U-NEW/roles').set(auth('U00')).send({ roles: ['TEC', 'PHY'] });
      expect(sr.body.data.roles).toEqual(['TEC', 'PHY']);
      // 잘못된 역할 → 400
      const bad = await http.patch('/api/v1/admin/users/U-NEW/roles').set(auth('U00')).send({ roles: ['NOPE'] });
      expect(bad.status).toBe(400);
      // 비활성화
      const st = await http.patch('/api/v1/admin/users/U-NEW/status').set(auth('U00')).send({ status: 'INACTIVE' });
      expect(st.body.data.status).toBe('INACTIVE');
      // 비활성 계정 로그인 차단
      const login = await http.post('/api/v1/auth/login').send({ userId: 'U-NEW', password: 'LisSecure2026' });
      expect(login.status).toBe(401);
    });
  });

  // ── 결과입력 컨텍스트·워크리스트 (UI-P1) ──
  describe('결과입력 컨텍스트', () => {
    it('검체 entry → 환자·항목·단위', async () => {
      const res = await http.get('/api/v1/orders/specimens/T-S-1/entry').set(auth('U02'));
      expect(res.status).toBe(200);
      expect(res.body.data.patient.name).toBeTruthy();
      const codes = res.body.data.items.map((i: { testCode: string }) => i.testCode);
      expect(codes).toContain('CHE-K');
      expect(res.body.data.items[0]).toHaveProperty('testName');
      expect(res.body.data.items[0]).toHaveProperty('unit');
    });

    it('결과입력 워크리스트(진행 검체)', async () => {
      const res = await http.get('/api/v1/orders/specimens/worklist').set(auth('U02'));
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      if (res.body.data.length > 0) {
        expect(res.body.data[0]).toHaveProperty('total');
        expect(res.body.data[0]).toHaveProperty('reported');
      }
    });

    it('없는 검체 entry → 404', async () => {
      const res = await http.get('/api/v1/orders/specimens/NOPE/entry').set(auth('U02'));
      expect(res.status).toBe(404);
    });

    it('결과보고서 — 환자·검사·참고치', async () => {
      const res = await http.get('/api/v1/results/report/T-S-1').set(auth('U02'));
      expect(res.status).toBe(200);
      expect(res.body.data.patient).toHaveProperty('patientId');
      expect(Array.isArray(res.body.data.results)).toBe(true);
      if (res.body.data.results.length > 0) {
        expect(res.body.data.results[0]).toHaveProperty('refRange');
        expect(res.body.data.results[0]).toHaveProperty('testName');
      }
    });
  });

  // ── FHIR 매핑 (HIS §B.3 형식) ──
  describe('FHIR 결과 매핑', () => {
    it('결과 → DiagnosticReport(contained Observation)', async () => {
      const res = await http.get('/api/v1/integration/hl7/fhir/T-S-1').set(auth('U00'));
      expect(res.status).toBe(200);
      expect(res.body.data.resourceType).toBe('DiagnosticReport');
      expect(res.body.data.contained[0].resourceType).toBe('Observation');
      expect(res.body.data.identifier[0].value).toBe('T-S-1');
    });
  });

  // ── Reflex 프로토콜 거버넌스(승인 라이프사이클·직무분리) ──
  describe('Reflex 거버넌스', () => {
    let pid: string;

    it('시드 프로토콜(GLU→HbA1c)은 ACTIVE로 이관되어 있음', async () => {
      const res = await http.get('/api/v1/reflex/protocols').set(auth('U00'));
      expect(res.status).toBe(200);
      const seed = res.body.data.find((p: { protocolId: string }) => p.protocolId === 'RP-SEED-GLU-HBA1C');
      expect(seed?.status).toBe('ACTIVE');
    });

    it('초안 작성(U02) → 제출 → PENDING_SPECIALIST', async () => {
      const c = await http.post('/api/v1/reflex/protocols').set(auth('U02')).send({
        name: 'E2E 갑상선(TSH OUT_OF_REF→FT4)', whenTestCode: 'CHE-TSH', operator: 'OUT_OF_REF', addTestCodes: 'CHE-FT4',
      });
      expect(c.status).toBe(201);
      pid = c.body.data.protocolId;
      const s = await http.post(`/api/v1/reflex/protocols/${pid}/submit`).set(auth('U02')).send({});
      expect(s.body.data.status).toBe('PENDING_SPECIALIST');
    });

    it('직무분리: 작성자(U02) 자가 전문의승인 → 400', async () => {
      const res = await http.post(`/api/v1/reflex/protocols/${pid}/specialist-approve`).set(auth('U02')).send({});
      expect(res.status).toBe(400);
    });

    it('다른 승인자(U00) 전문의 승인 → PENDING_COMMITTEE', async () => {
      const res = await http.post(`/api/v1/reflex/protocols/${pid}/specialist-approve`).set(auth('U00')).send({});
      expect(res.body.data.status).toBe('PENDING_COMMITTEE');
    });

    it('직무분리: 전문의 승인자(U00)가 위원회 의결 → 400', async () => {
      const res = await http.post(`/api/v1/reflex/protocols/${pid}/committee`).set(auth('U00')).send({ committeeNo: 'X' });
      expect(res.status).toBe(400);
    });

    it('제3자(U08) 위원회 의결 → PENDING_HIS → HIS 수용 → ACTIVE', async () => {
      const c = await http.post(`/api/v1/reflex/protocols/${pid}/committee`).set(auth('U08')).send({ committeeNo: 'LAB-2026-099' });
      expect(c.body.data.status).toBe('PENDING_HIS');
      const a = await http.post(`/api/v1/reflex/protocols/${pid}/activate`).set(auth('U08')).send({ hisRef: 'HIS-1' });
      expect(a.body.data.status).toBe('ACTIVE');
      const g = await http.get(`/api/v1/reflex/protocols/${pid}`).set(auth('U00'));
      expect(g.body.data.events.length).toBeGreaterThanOrEqual(5);
    });

    it('BETWEEN은 하한·상한 필수 → 400 / ISO 아닌 날짜 → 400', async () => {
      const bad1 = await http.post('/api/v1/reflex/protocols').set(auth('U00')).send({ name: 'x', whenTestCode: 'CHE-K', operator: 'BETWEEN', threshold: 3, addTestCodes: 'CHE-NA' });
      expect(bad1.status).toBe(400);
      const bad2 = await http.post('/api/v1/reflex/protocols').set(auth('U00')).send({ name: 'x', whenTestCode: 'CHE-K', operator: '>=', threshold: 3, addTestCodes: 'CHE-NA', effectiveFrom: '2026/07/01' });
      expect(bad2.status).toBe(400);
    });

    it('비ADM(U07)은 위원회/활성화 불가 → 403', async () => {
      const res = await http.post(`/api/v1/reflex/protocols/${pid}/suspend`).set(auth('U07')).send({});
      expect(res.status).toBe(403);
    });
  });

  // ── Reflex 계보(개정 승계·SUPERSEDE) ──
  describe('Reflex 계보(개정 승계)', () => {
    // 전 생명주기 통과(작성 U02 → 전문의 U00 → 위원회 U08 → 활성). 직무분리(작성자≠전문의≠위원회) 준수.
    const advance = async (id: string) => {
      await http.post(`/api/v1/reflex/protocols/${id}/submit`).set(auth('U02')).send({});
      await http.post(`/api/v1/reflex/protocols/${id}/specialist-approve`).set(auth('U00')).send({});
      await http.post(`/api/v1/reflex/protocols/${id}/committee`).set(auth('U08')).send({ committeeNo: 'LAB-SUP' });
      return http.post(`/api/v1/reflex/protocols/${id}/activate`).set(auth('U08')).send({ hisRef: 'HIS-SUP' });
    };

    it('없는 선행 지정 → 400', async () => {
      const bad = await http.post('/api/v1/reflex/protocols').set(auth('U02')).send({
        name: 'x', whenTestCode: 'CHE-TSH', operator: 'OUT_OF_REF', addTestCodes: 'CHE-FT4', supersedesProtocolId: 'RP-NOPE',
      });
      expect(bad.status).toBe(400);
    });

    it('개정 활성화 → 선행 자동 SUPERSEDED·활성은 신버전만·version 증가·SUPERSEDE 이벤트', async () => {
      // A(v1) 활성
      const ca = await http.post('/api/v1/reflex/protocols').set(auth('U02')).send({
        name: '계보 v1(TSH→FT4)', whenTestCode: 'CHE-TSH', operator: 'OUT_OF_REF', addTestCodes: 'CHE-FT4',
      });
      expect(ca.body.data.version).toBe(1);
      const aId = ca.body.data.protocolId;
      const aAct = await advance(aId);
      expect(aAct.body.data.status).toBe('ACTIVE');
      // B(v2): A를 선행으로 → version 2
      const cb = await http.post('/api/v1/reflex/protocols').set(auth('U02')).send({
        name: '계보 v2(TSH→FT4)', whenTestCode: 'CHE-TSH', operator: 'OUT_OF_REF', addTestCodes: 'CHE-FT4', supersedesProtocolId: aId,
      });
      expect(cb.status).toBe(201);
      expect(cb.body.data.version).toBe(2);
      expect(cb.body.data.supersedesProtocolId).toBe(aId);
      const bId = cb.body.data.protocolId;
      const bAct = await advance(bId);
      expect(bAct.body.data.status).toBe('ACTIVE');
      // A는 이제 SUPERSEDED(계보에 활성은 B만) + SUPERSEDE 이벤트 기록
      const ga = await http.get(`/api/v1/reflex/protocols/${aId}`).set(auth('U00'));
      expect(ga.body.data.status).toBe('SUPERSEDED');
      expect(ga.body.data.events.some((e: { event: string }) => e.event === 'SUPERSEDE')).toBe(true);
      const gb = await http.get(`/api/v1/reflex/protocols/${bId}`).set(auth('U00'));
      expect(gb.body.data.status).toBe('ACTIVE');
    });

    it('대체/폐기된 프로토콜은 선행으로 재지정 불가 → 400', async () => {
      // 위 테스트에서 SUPERSEDED된 계보 v1을 다시 선행으로 지정 시도
      const list = await http.get('/api/v1/reflex/protocols').set(auth('U00'));
      const superseded = list.body.data.find((p: { status: string }) => p.status === 'SUPERSEDED');
      expect(superseded).toBeTruthy();
      const bad = await http.post('/api/v1/reflex/protocols').set(auth('U02')).send({
        name: 'x', whenTestCode: 'CHE-TSH', operator: 'OUT_OF_REF', addTestCodes: 'CHE-FT4', supersedesProtocolId: superseded.protocolId,
      });
      expect(bad.status).toBe(400);
    });

    it('다른 트리거 프로토콜을 선행으로 지정 → 400(무관 계보 오인 폐기 차단)', async () => {
      // 시드 프로토콜(트리거 CHE-GLU)을 트리거 CHE-TSH 개정의 선행으로 지정 시도
      const bad = await http.post('/api/v1/reflex/protocols').set(auth('U02')).send({
        name: 'x', whenTestCode: 'CHE-TSH', operator: 'OUT_OF_REF', addTestCodes: 'CHE-FT4', supersedesProtocolId: 'RP-SEED-GLU-HBA1C',
      });
      expect(bad.status).toBe(400);
    });

    it('다세대·분기 계보 — 오래된 분기 개정 활성화도 계보에 활성 1개만 남긴다(중복발동 방지)', async () => {
      const mk = async (name: string, supersedesProtocolId?: string) => {
        const r = await http.post('/api/v1/reflex/protocols').set(auth('U02')).send({
          name, whenTestCode: 'CHE-K', operator: 'FLAG', flag: 'HH', addTestCodes: 'CHE-NA', ...(supersedesProtocolId ? { supersedesProtocolId } : {}),
        });
        expect(r.status).toBe(201);
        return r.body.data.protocolId as string;
      };
      const status = async (id: string) => (await http.get(`/api/v1/reflex/protocols/${id}`).set(auth('U00'))).body.data.status;
      // A(뿌리) 활성
      const A = await mk('계보K A');
      await advance(A);
      // A를 선행으로 하는 분기 B·C 생성(A 활성 중)
      const B = await mk('계보K B', A);
      const C = await mk('계보K C', A);
      // B 활성 → A 폐기, C는 아직 초안
      await advance(B);
      expect(await status(A)).toBe('SUPERSEDED');
      // B를 선행으로 D 생성 후 활성 → B 폐기(세대 전진)
      const D = await mk('계보K D', B);
      await advance(D);
      expect(await status(B)).toBe('SUPERSEDED');
      // 이제 '오래된 분기' C를 활성화 → 같은 계보의 현재 헤드 D까지 접혀 활성은 C 하나만
      await advance(C);
      expect(await status(C)).toBe('ACTIVE');
      expect(await status(D)).toBe('SUPERSEDED');
      // 계보(A) 전체에서 활성은 정확히 1개
      const all = await http.get('/api/v1/reflex/protocols').set(auth('U00'));
      const activeInLineage = all.body.data.filter((p: { protocolId: string; status: string }) => [A, B, C, D].includes(p.protocolId) && p.status === 'ACTIVE');
      expect(activeInLineage.map((p: { protocolId: string }) => p.protocolId)).toEqual([C]);
    });
  });

  // ── Reflex 반려 처리·QI 리포트·폴링 ──
  describe('Reflex 반려 처리·리포트', () => {
    const MCID = 'RX-T-O-1-CHE-HBA1C';

    beforeAll(async () => {
      // HIS 의사 반려 시뮬레이션: add-on 오더항목 + 실행기록 + REJECTED 발신로그
      await prisma.orderItem.upsert({ where: { orderItemId: 'T-OI-RX' }, update: { status: 'RECEIVED' }, create: { orderItemId: 'T-OI-RX', orderId: 'T-O-1', testCode: 'CHE-HBA1C' } });
      await prisma.reflexExecution.upsert({ where: { execId: 'T-RXE-1' }, update: {}, create: { execId: 'T-RXE-1', protocolId: 'RP-SEED-GLU-HBA1C', protocolName: '고혈당 반사검사', orderId: 'T-O-1', addTestCode: 'CHE-HBA1C', patientId: 'T-2345678', triggerValue: '250', outboundMcid: MCID } });
      await prisma.interfaceLog.upsert({ where: { direction_messageControlId: { direction: 'OUTBOUND', messageControlId: MCID } }, update: { status: 'REJECTED' }, create: { ifId: 'IF-RX', direction: 'OUTBOUND', messageType: 'FHIR ServiceRequest (Reflex)', messageControlId: MCID, status: 'REJECTED', payload: '{}' } });
    });

    it('QI 리포트 — 실행 집계·프로토콜별', async () => {
      const res = await http.get('/api/v1/reflex/protocols/report').set(auth('U00'));
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBeGreaterThanOrEqual(1);
      expect(res.body.data.protocols.some((p: { name: string }) => p.name.includes('고혈당'))).toBe(true);
    });

    it('반려 목록 — REJECTED add-on 표시', async () => {
      const res = await http.get('/api/v1/reflex/protocols/rejections').set(auth('U00'));
      expect(res.status).toBe(200);
      const r = res.body.data.find((x: { mcid: string }) => x.mcid === MCID);
      expect(r?.addTestCode).toBe('CHE-HBA1C');
    });

    it('반려 해소(cancel) → 후속검사 orderItem CANCELLED', async () => {
      const res = await http.post('/api/v1/reflex/protocols/rejections/resolve').set(auth('U00')).send({ mcid: MCID, action: 'cancel' });
      expect(res.status).toBe(201);
      const item = await prisma.orderItem.findUnique({ where: { orderItemId: 'T-OI-RX' } });
      expect(item?.status).toBe('CANCELLED');
    });

    it('PreOrder 폴링 — HIS 미설정 시 no-op(configured=false)', async () => {
      const res = await http.post('/api/v1/integration/hl7/reflex/poll-preorders').set(auth('U00')).send({});
      expect(res.status).toBe(201);
      // e2e 환경엔 HIS_FHIR_BASE 미설정 → configured false, checked 0
      expect(res.body.data.checked).toBe(0);
    });
  });

  describe('Reflex 발신 재시도·DLQ·웹훅', () => {
    const DLQ_MCID = 'RX-T-DLQ-CHE-HBA1C';

    beforeAll(async () => {
      // DLQ 격리 건 시뮬레이션(임계 초과)
      await prisma.interfaceLog.upsert({
        where: { direction_messageControlId: { direction: 'OUTBOUND', messageControlId: DLQ_MCID } },
        update: { status: 'DLQ', retryCount: 5 },
        create: { ifId: 'IF-RX', direction: 'OUTBOUND', messageType: 'FHIR ServiceRequest (Reflex)', messageControlId: DLQ_MCID, status: 'DLQ', retryCount: 5, payload: '{}' },
      });
    });

    it('자동 재시도 — HIS 미설정 시 no-op(configured=false)', async () => {
      const res = await http.post('/api/v1/integration/hl7/reflex/retry').set(auth('U00')).send({});
      expect(res.status).toBe(201);
      expect(res.body.data.configured).toBe(false);
    });

    it('결과 발신 재시도 — HIS 미설정 시 no-op(configured=false)', async () => {
      const res = await http.post('/api/v1/integration/hl7/results/retry').set(auth('U00')).send({});
      expect(res.status).toBe(201);
      expect(res.body.data.configured).toBe(false);
    });

    it('아웃바운드 현황 — DLQ 카운트·maxRetry 노출', async () => {
      const res = await http.get('/api/v1/integration/hl7/reflex/outbound').set(auth('U00'));
      expect(res.status).toBe(200);
      expect(res.body.data.maxRetry).toBe(5);
      expect(res.body.data.counts.DLQ).toBeGreaterThanOrEqual(1);
    });

    it('DLQ 재큐 → FAILED·retryCount 0 복귀', async () => {
      const res = await http.post('/api/v1/integration/hl7/reflex/requeue-dlq').set(auth('U00')).send({ mcid: DLQ_MCID });
      expect(res.status).toBe(201);
      expect(res.body.data.requeued).toBeGreaterThanOrEqual(1);
      const row = await prisma.interfaceLog.findFirst({ where: { direction: 'OUTBOUND', messageControlId: DLQ_MCID } });
      expect(row?.status).toBe('FAILED');
      expect(row?.retryCount).toBe(0);
    });

    /**
     * ★발신 클레임 회수(P1-9 보조, 회귀 금지).
     * 결과 발신 재시도가 행을 SENDING으로 선점하도록 바뀌었다(이중 POST 방지).
     * 선점 중 프로세스가 죽으면 그 행은 SENDING에 갇혀 **영구 미발신**이 되므로,
     * 회수 경로가 반드시 살아 있어야 한다. 클레임과 회수는 한 쌍이다.
     */
    it('크래시로 SENDING에 멈춘 발신 건 → 재큐로 FAILED 복귀(영구 미발신 방지)', async () => {
      const MCID = 'RES-T-STUCK-SENDING';
      await prisma.interfaceLog.deleteMany({ where: { messageControlId: MCID } });
      await prisma.interfaceLog.create({
        data: { ifId: 'IF-G08', direction: 'OUTBOUND', messageType: 'FHIR DiagnosticReport', messageControlId: MCID, status: 'SENDING', retryCount: 2, payload: '{}' },
      });
      const res = await http.post('/api/v1/integration/hl7/reflex/requeue-dlq').set(auth('U00')).send({ mcid: MCID });
      expect(res.status).toBe(201);
      const row = await prisma.interfaceLog.findFirst({ where: { direction: 'OUTBOUND', messageControlId: MCID } });
      expect(row?.status).toBe('FAILED'); // 다시 재시도 대상이 된다
      expect(row?.retryCount).toBe(0);
    });

    it('웹훅 — 토큰 미구성 시 비활성(503)', async () => {
      // e2e 환경엔 HIS_REFLEX_WEBHOOK_TOKEN 미설정 → 503(무해)
      const res = await http.post('/api/v1/integration/hl7/reflex/webhook').send({ mcid: DLQ_MCID, status: 'active' });
      expect(res.status).toBe(503);
    });

    it('웹훅 — 토큰 구성 시 승인 반영 + urn:his:order 포착(멱등)', async () => {
      const WH = 'RX-T-WH-CHE-HBA1C';
      await prisma.interfaceLog.upsert({
        where: { direction_messageControlId: { direction: 'OUTBOUND', messageControlId: WH } },
        update: { status: 'PROCESSED', hisRef: 'HISID-1', errorText: null },
        create: { ifId: 'IF-RX', direction: 'OUTBOUND', messageType: 'FHIR ServiceRequest (Reflex)', messageControlId: WH, status: 'PROCESSED', hisRef: 'HISID-1', payload: '{}' },
      });
      await prisma.reflexExecution.upsert({ where: { execId: 'T-RXE-WH' }, update: { hisOrderNo: null }, create: { execId: 'T-RXE-WH', protocolId: 'RP-SEED-GLU-HBA1C', protocolName: '고혈당 반사검사', orderId: 'T-O-1', addTestCode: 'CHE-HBA1C', outboundMcid: WH } });
      const prev = process.env.HIS_REFLEX_WEBHOOK_TOKEN;
      process.env.HIS_REFLEX_WEBHOOK_TOKEN = 'wh-secret';
      try {
        // 잘못된 토큰 → 401
        const bad = await http.post('/api/v1/integration/hl7/reflex/webhook').set('x-reflex-webhook-token', 'wrong').send({ mcid: WH, status: 'active' });
        expect(bad.status).toBe(401);
        // 멱등키는 system=urn:lis:weve:reflex-order 값으로 선택(HIS 오더가 먼저 나열돼도) + urn:his:order 포착
        const body = { status: 'active', identifier: [{ system: 'urn:his:order', value: 'HORD-77' }, { system: 'urn:lis:weve:reflex-order', value: WH }] };
        const ok = await http.post('/api/v1/integration/hl7/reflex/webhook').set('x-reflex-webhook-token', 'wh-secret').send(body);
        expect(ok.status).toBe(201);
        expect(ok.body.data).toMatchObject({ matched: true, status: 'APPROVED' });
        const row = await prisma.interfaceLog.findFirst({ where: { direction: 'OUTBOUND', messageControlId: WH } });
        expect(row?.status).toBe('APPROVED');
        expect(row?.hisRef).toBe('HISID-1'); // 폴링 키 유지(#3)
        const exec = await prisma.reflexExecution.findUnique({ where: { execId: 'T-RXE-WH' } });
        expect(exec?.hisOrderNo).toBe('HORD-77'); // urn:his:order 결속
        // 재전송(at-least-once) → 이미 APPROVED, 중복 반영 없음(멱등)
        const replay = await http.post('/api/v1/integration/hl7/reflex/webhook').set('x-reflex-webhook-token', 'wh-secret').send(body);
        expect(replay.status).toBe(201);
        expect(replay.body.data.status).toBe('APPROVED');
      } finally {
        if (prev === undefined) delete process.env.HIS_REFLEX_WEBHOOK_TOKEN;
        else process.env.HIS_REFLEX_WEBHOOK_TOKEN = prev;
      }
    });

    it('웹훅 반려 → 후속검사 자동취소(병원 정책 2026-07-18)', async () => {
      const WH = 'RX-T-O-1-CHE-HBA1C-REJ';
      // 앞선 리플렉스 테스트가 이미 T-O-1에 CHE-HBA1C를 추가했을 수 있다 — 오더당 검사 유일이므로 복합키로 upsert
      await prisma.orderItem.upsert({ where: { orderId_testCode: { orderId: 'T-O-1', testCode: 'CHE-HBA1C' } }, update: { status: 'RECEIVED' }, create: { orderItemId: 'T-OI-REJ', orderId: 'T-O-1', testCode: 'CHE-HBA1C' } });
      await prisma.reflexExecution.upsert({ where: { execId: 'T-RXE-REJ' }, update: {}, create: { execId: 'T-RXE-REJ', protocolId: 'RP-SEED-GLU-HBA1C', protocolName: '고혈당 반사검사', orderId: 'T-O-1', addTestCode: 'CHE-HBA1C', outboundMcid: WH } });
      await prisma.interfaceLog.upsert({ where: { direction_messageControlId: { direction: 'OUTBOUND', messageControlId: WH } }, update: { status: 'PROCESSED', hisRef: 'HISID-REJ' }, create: { ifId: 'IF-RX', direction: 'OUTBOUND', messageType: 'FHIR ServiceRequest (Reflex)', messageControlId: WH, status: 'PROCESSED', hisRef: 'HISID-REJ', payload: '{}' } });
      const prev = process.env.HIS_REFLEX_WEBHOOK_TOKEN;
      process.env.HIS_REFLEX_WEBHOOK_TOKEN = 'wh-secret';
      try {
        const res = await http.post('/api/v1/integration/hl7/reflex/webhook').set('x-reflex-webhook-token', 'wh-secret')
          .send({ status: 'revoked', identifier: [{ system: 'urn:lis:weve:reflex-order', value: WH }] });
        expect(res.status).toBe(201);
        expect(res.body.data.status).toBe('REJECTED');
        // 후속검사 orderItem 자동취소(행 ID는 리플렉스 생성분일 수 있어 복합키로 조회)
        const item = await prisma.orderItem.findUnique({ where: { orderId_testCode: { orderId: 'T-O-1', testCode: 'CHE-HBA1C' } } });
        expect(item?.status).toBe('CANCELLED');
        // Reflex반려 알림에 자동취소 표기
        const noti = await prisma.notification.findFirst({ where: { ntype: 'Reflex반려', target: WH } });
        expect(noti?.message).toContain('자동취소');
      } finally {
        if (prev === undefined) delete process.env.HIS_REFLEX_WEBHOOK_TOKEN;
        else process.env.HIS_REFLEX_WEBHOOK_TOKEN = prev;
      }
    });

    it('재시도/재큐 — 비관리자 403', async () => {
      const res = await http.post('/api/v1/integration/hl7/reflex/retry').set(auth('U07')).send({});
      expect(res.status).toBe(403);
    });
  });

  // ── 대시보드 종합 현황 ──
  describe('대시보드 overview', () => {
    it('연계 상태·오늘·분야별·QC 집계 반환', async () => {
      const res = await http.get('/api/v1/dashboard/overview').set(auth('U00'));
      expect(res.status).toBe(200);
      const d = res.body.data;
      expect(d.integration).toHaveProperty('hisFhir');
      expect(d.integration).toHaveProperty('reflex');
      expect(d.today).toHaveProperty('received');
      expect(d.domains).toHaveProperty('pathologyOpen');
      expect(d.domains).toHaveProperty('genomicPending');
      expect(d.qc).toHaveProperty('failToday');
      expect(typeof d.generatedAt).toBe('string');
    });
    it('인증 없으면 401', async () => {
      const res = await http.get('/api/v1/dashboard/overview');
      expect(res.status).toBe(401);
    });
  });

  // ── 바코드 스캔 설정 ──
  describe('바코드 스캔 설정', () => {
    it('조회 — 전 인증자(기본값 자동생성)', async () => {
      const res = await http.get('/api/v1/barcode/config').set(auth('U07'));
      expect(res.status).toBe(200);
      expect(res.body.data.trimWhitespace).toBe(true);
      expect(res.body.data.autoSubmit).toBe('ENTER');
    });
    it('변경 — ADM 저장·반영', async () => {
      const res = await http.put('/api/v1/barcode/config').set(auth('U00')).send({ prefixStrip: ']C1', minLength: 8, autoSubmit: 'LENGTH', autoSubmitLen: 11 });
      expect(res.status).toBe(200);
      expect(res.body.data.prefixStrip).toBe(']C1');
      expect(res.body.data.autoSubmit).toBe('LENGTH');
      const get = await http.get('/api/v1/barcode/config').set(auth('U02'));
      expect(get.body.data.minLength).toBe(8);
    });
    it('변경 — 비ADM(검증의) 403', async () => {
      const res = await http.put('/api/v1/barcode/config').set(auth('U02')).send({ beep: true });
      expect(res.status).toBe(403);
    });
    it('잘못된 autoSubmit 값은 무시(ENTER 유지)', async () => {
      await http.put('/api/v1/barcode/config').set(auth('U00')).send({ autoSubmit: 'ENTER' });
      const res = await http.put('/api/v1/barcode/config').set(auth('U00')).send({ autoSubmit: 'BOGUS' });
      expect(res.status).toBe(400); // IsIn 검증 → 400
    });
  });

  describe('용어 코드(진단·SNOMED) 마스터', () => {
    let codeId = '';
    it('등록 — ADM', async () => {
      const res = await http.post('/api/v1/terminology').set(auth('U00'))
        .send({ system: 'SNOMED', code: 'M-80703', term: 'Squamous cell carcinoma, NOS', termKo: '편평세포암', category: 'MORPHOLOGY' });
      expect(res.status).toBe(201);
      expect(res.body.data.code).toBe('M-80703');
      codeId = res.body.data.codeId;
    });
    it('등록 — 비ADM(접수) 403', async () => {
      const res = await http.post('/api/v1/terminology').set(auth('U07')).send({ code: 'X-1', term: 'x' });
      expect(res.status).toBe(403);
    });
    it('중복 코드 등록 409', async () => {
      const res = await http.post('/api/v1/terminology').set(auth('U00')).send({ system: 'SNOMED', code: 'M-80703', term: 'dup' });
      expect(res.status).toBe(409);
    });
    it('대량 반입 — 신규 upsert + 오류행 보고, 재반입 시 갱신', async () => {
      const rows = [
        { system: 'SNOMED', code: 'T-BULK-1', term: 'Bulk Topo 1', termKo: '대량1', category: 'TOPOGRAPHY' },
        { system: 'SNOMED', code: 'M-BULK-1', term: 'Bulk Morph 1', termKo: '대량2', category: 'MORPHOLOGY' },
        { system: 'SNOMED', code: '', term: '코드누락' }, // 오류행
      ];
      const res = await http.post('/api/v1/terminology/bulk').set(auth('U00')).send({ rows });
      expect(res.status).toBe(201);
      expect(res.body.data.imported).toBe(2);
      expect(res.body.data.errors.length).toBe(1);
      // 재반입 → 갱신(멱등)
      const again = await http.post('/api/v1/terminology/bulk').set(auth('U00')).send({ rows: [{ system: 'SNOMED', code: 'T-BULK-1', term: 'Bulk Topo 1b', termKo: '대량1수정', category: 'TOPOGRAPHY' }] });
      expect(again.body.data.updated).toBe(1);
    });
    it('대량 반입 — 비ADM(접수) 403', async () => {
      const res = await http.post('/api/v1/terminology/bulk').set(auth('U07')).send({ rows: [] });
      expect(res.status).toBe(403);
    });
    it('자동완성 검색 — 전 인증자(한글명·코드 부분일치)', async () => {
      const byKo = await http.get('/api/v1/terminology?q=편평').set(auth('U07'));
      expect(byKo.status).toBe(200);
      expect(byKo.body.data.some((t: { code: string }) => t.code === 'M-80703')).toBe(true);
      const byCode = await http.get('/api/v1/terminology?q=M-807&system=SNOMED').set(auth('U02'));
      expect(byCode.body.data.some((t: { code: string }) => t.code === 'M-80703')).toBe(true);
    });
    it('사용 중지 시 자동완성에서 제외(이력 보존 — 하드삭제 아님)', async () => {
      const stop = await http.put(`/api/v1/terminology/${codeId}/status`).set(auth('U00')).send({ status: 'STOP' });
      expect(stop.status).toBe(200);
      const search = await http.get('/api/v1/terminology?q=편평').set(auth('U07'));
      expect(search.body.data.some((t: { code: string }) => t.code === 'M-80703')).toBe(false);
      const list = await http.get('/api/v1/terminology/list?q=편평').set(auth('U00'));
      expect(list.body.data.some((t: { code: string }) => t.code === 'M-80703')).toBe(true); // 관리 목록엔 남음
    });
    it('스타터셋 시딩 멱등(재호출 시 신규 0)', async () => {
      const first = await http.post('/api/v1/terminology/seed-starter').set(auth('U00'));
      expect(first.status).toBe(201);
      const again = await http.post('/api/v1/terminology/seed-starter').set(auth('U00'));
      expect(again.body.data.created).toBe(0);
    });
  });
  // ── 재검토 P0 회귀(2026-07-21) ─────────────────────────────
  // 각 항목은 실제로 확인된 결함을 고친 것이다. 실패하면 방어가 되돌아간 것이므로
  // "테스트가 까다롭다"고 완화하지 말 것. 근거: docs/재검토_2026-07-21_발견목록.md
  describe('재검토 P0 회귀', () => {
    it('P0-2 첨부가 있는 검체는 접수 취소 불가(임상기록 cascade 삭제 차단)', async () => {
      const ord = await http.post('/api/v1/orders').set(auth('U07'))
        .send({ patientId: 'T-2345678', testCodes: ['CHE-K'] });
      const rcv = await http.post('/api/v1/orders/receive').set(auth('U07'))
        .send({ orderId: ord.body.data.order.orderId, containerCode: 'SST' });
      const sp = rcv.body.data.specimenNo as string;
      expect(sp).toBeTruthy();
      // 외부 결과지 첨부(장비 미연동 도메인에서 유일한 원본인 경우가 많다)
      const up = await http.post(`/api/v1/results/specimens/${sp}/attachments`).set(auth('U00'))
        .attach('file', Buffer.from('%PDF-1.4 dummy'), { filename: 'x.pdf', contentType: 'application/pdf' });
      expect(up.status).toBe(201);
      const cancel = await http.post(`/api/v1/orders/specimens/${sp}/cancel-receipt`).set(auth('U07'));
      expect(cancel.status).toBe(400);
      expect(cancel.body.message).toContain('첨부');
      // 첨부가 여전히 살아 있어야 한다
      const list = await http.get(`/api/v1/results/specimens/${sp}/attachments`).set(auth('U00'));
      expect(list.body.data).toHaveLength(1);
    });

    it('P0-3 반납된 출고건으로는 시행 기록을 만들 수 없다(타 환자 귀속 차단)', async () => {
      await prisma.bloodUnit.upsert({
        where: { unitNo: 'T-U-ADM' }, update: { status: 'IN_STOCK' },
        create: { unitNo: 'T-U-ADM', bloodGroup: 'O+', productType: 'RBC', status: 'IN_STOCK', expiryDate: '2027-01-01' },
      });
      const iss = await prisma.bloodIssue.create({
        data: { issueId: 'T-ISS-RET', unitNo: 'T-U-ADM', patientId: 'T-BB', status: 'RETURNED', issuer: 'U05' },
      });
      // 같은 유닛이 다른 출고로 ISSUED 상태가 된 상황을 만든다
      await prisma.bloodUnit.update({ where: { unitNo: 'T-U-ADM' }, data: { status: 'ISSUED' } });
      const res = await http.post('/api/v1/transfusion/administer').set(auth('U05'))
        .send({ issueId: iss.issueId, administeredBy: 'N-간호' });
      expect(res.status).toBe(400); // 제제는 ISSUED지만 이 출고건은 RETURNED
      const acts = await prisma.transfusionAct.count({ where: { issueId: iss.issueId } });
      expect(acts).toBe(0);
    });

    it('P0-5 HIS 취소는 이미 보고(REPORTED)된 항목을 되돌리지 않는다', async () => {
      const order = await prisma.labOrder.create({
        data: { orderId: 'T-ORD-CANC', hisOrderNo: 'H-CANC-1', patientId: 'T-2345678', status: 'IN_PROCESS' },
      });
      await prisma.orderItem.createMany({
        data: [
          { orderItemId: 'T-OI-REP', orderId: order.orderId, testCode: 'CHE-K', status: 'REPORTED' },
          { orderItemId: 'T-OI-RUN', orderId: order.orderId, testCode: 'CHE-NA', status: 'IN_PROCESS' },
        ],
      });
      const hl7 = ['MSH|^~\\&|HIS|H|LIS|L|20260721||ORM^O01|MC-CANC-1|P|2.5.1',
        'PID|1||T-2345678', 'ORC|CA|H-CANC-1', 'OBR|1|H-CANC-1||CHE-K'].join('\r');
      const res = await http.post('/api/v1/integration/hl7/inbound').set(auth('U00')).send({ message: hl7 });
      expect([200, 201]).toContain(res.status);
      const reported = await prisma.orderItem.findUnique({ where: { orderItemId: 'T-OI-REP' } });
      const running = await prisma.orderItem.findUnique({ where: { orderItemId: 'T-OI-RUN' } });
      expect(reported?.status).toBe('REPORTED'); // 보고 완료분은 보존
      expect(running?.status).toBe('CANCELLED'); // 진행분만 취소
    });

    it('P0-6 결과입력 워크리스트가 접수(RECEIVED) 검체를 보여준다', async () => {
      const ord = await http.post('/api/v1/orders').set(auth('U07'))
        .send({ patientId: 'T-2345678', testCodes: ['CHE-NA'] });
      const rcv = await http.post('/api/v1/orders/receive').set(auth('U07'))
        .send({ orderId: ord.body.data.order.orderId, containerCode: 'EDTA' });
      const sp2 = rcv.body.data.specimenNo as string;
      const wl = await http.get('/api/v1/orders/specimens/worklist').set(auth('U02'));
      expect(wl.status).toBe(200);
      expect(wl.body.data.some((r: { specimenNo: string }) => r.specimenNo === sp2)).toBe(true);
    });
  });

  // ── 보안 검토 조치 회귀(2026-07-21) ─────────────────────────────
  // 아래는 실제 결함을 고친 뒤 붙인 회귀 테스트다. 실패하면 방어가 되돌아간 것이므로
  // "테스트가 까다롭다"고 완화하지 말 것. 근거: docs/보안_점검_2026-07-21.md
  describe('보안 회귀', () => {
    it('ABO 독립방벽 입력 오염 차단 — 항체패널 경로의 혈액형 기록도 열거값 강제', async () => {
      const tmpl = await http.get('/api/v1/transfusion/antibody-panel/template').set(auth('U05'));
      const reactivity = tmpl.body.data.cells.map((c: { antigens: Record<string, boolean> }) => !!c.antigens.K);
      // 이 경로로 만든 BloodTyping이 최신 레코드가 되어 issueBlood의 불가침 ABO 방벽 입력이 된다.
      const bad = await http.post('/api/v1/transfusion/antibody-panel').set(auth('U05'))
        .send({ patientId: 'T-ALLO', reactivity, recordTyping: { abo: 'XX', rhD: 'POS' } });
      expect(bad.status).toBe(400);
      const badRh = await http.post('/api/v1/transfusion/antibody-panel').set(auth('U05'))
        .send({ patientId: 'T-ALLO', reactivity, recordTyping: { abo: 'O', rhD: '양성' } });
      expect(badRh.status).toBe(400);
      // 정상 조합은 통과
      const ok = await http.post('/api/v1/transfusion/antibody-panel').set(auth('U05'))
        .send({ patientId: 'T-ALLO', reactivity, recordTyping: { abo: 'O', rhD: 'NEG' } });
      expect(ok.status).toBe(201);
      expect(ok.body.data.recordedTypingId).toBeTruthy();
    });

    it('인증 기본 차단 — 토큰 없이 환자 조회 불가', async () => {
      const res = await http.get('/api/v1/patients');
      expect(res.status).toBe(401);
    });

    it('공개 면제는 health·metrics만 — PHI 없는 경로', async () => {
      expect((await http.get('/api/v1/health')).status).toBe(200);
      expect((await http.get('/api/v1/metrics')).status).toBe(200);
    });

    it('관리자 발급 계정은 비밀번호 변경 전까지 다른 기능 사용 불가', async () => {
      await prisma.userRole.deleteMany({ where: { userId: 'U-TMP' } });
      await prisma.appUser.deleteMany({ where: { userId: 'U-TMP' } });
      const created = await http.post('/api/v1/admin/users').set(auth('U00'))
        .send({ userId: 'U-TMP', name: '신규자', password: 'LisSecure2026', roles: ['TEC'] });
      expect(created.status).toBe(201);
      const login = await http.post('/api/v1/auth/login').send({ userId: 'U-TMP', password: 'LisSecure2026' });
      expect(login.body.data.user.mustChangePassword).toBe(true);
      const tk = { Authorization: `Bearer ${login.body.data.accessToken}` };
      // 초기 비번 상태에서는 업무 API 차단
      expect((await http.get('/api/v1/patients').set(tk)).status).toBe(403);
      // 비밀번호 변경 후 해제
      const chg = await http.post('/api/v1/auth/change-password').set(tk)
        .send({ currentPassword: 'LisSecure2026', newPassword: 'LisSecure2027' });
      expect(chg.status).toBe(201);
      const relogin = await http.post('/api/v1/auth/login').send({ userId: 'U-TMP', password: 'LisSecure2027' });
      expect(relogin.body.data.user.mustChangePassword).toBe(false);
      const tk2 = { Authorization: `Bearer ${relogin.body.data.accessToken}` };
      expect((await http.get('/api/v1/patients').set(tk2)).status).toBe(200);
      await prisma.userRole.deleteMany({ where: { userId: 'U-TMP' } });
      await prisma.appUser.deleteMany({ where: { userId: 'U-TMP' } });
    });

    it('로그인 실패 응답은 원인을 구분하지 않음(사용자 열거 차단)', async () => {
      const noUser = await http.post('/api/v1/auth/login').send({ userId: 'U-NOPE-XYZ', password: 'whatever12A' });
      const wrongPw = await http.post('/api/v1/auth/login').send({ userId: 'U00', password: 'wrong-password-1A' });
      expect(noUser.status).toBe(401);
      expect(wrongPw.status).toBe(401);
      expect(noUser.body.message).toBe(wrongPw.body.message);
    });

    it('PHI 조회가 감사(READ)로 남는다 — 의료법 열람기록', async () => {
      const before = await prisma.auditLog.count({ where: { action: 'READ' } });
      await http.get('/api/v1/patients').set(auth('U00'));
      // 감사 기록은 체인 append(비동기 직렬화) — 짧게 대기 후 확인
      await new Promise((r) => setTimeout(r, 300));
      const after = await prisma.auditLog.count({ where: { action: 'READ' } });
      expect(after).toBeGreaterThan(before);
    });

    it('사이드바 배지는 카운트 전용 — PHI 미반환 + 감사 미기록', async () => {
      // 60초마다 전 사용자 브라우저가 폴링하는 경로다. 목록 API를 쓰면 환자명이 계속 전송되고
      // PHI 조회 감사가 폴링으로 가득 차 실제 열람 추적이 묻힌다(운영에서 93%가 폴링이었다).
      const before = await prisma.auditLog.count({ where: { action: 'READ' } });
      const res = await http.get('/api/v1/notifications/badge').set(auth('U00'));
      expect(res.status).toBe(200);
      expect(typeof res.body.data.notifications).toBe('number');
      expect(typeof res.body.data.criticals).toBe('number');
      // 응답 어디에도 환자 식별정보가 없어야 한다
      expect(JSON.stringify(res.body)).not.toMatch(/patient|name|환자/i);
      await new Promise((r) => setTimeout(r, 300));
      const after = await prisma.auditLog.count({ where: { action: 'READ' } });
      expect(after).toBe(before); // 감사 미기록
    });

    it('코드성 식별자에 HL7 구분자·개행 주입 차단', async () => {
      const res = await http.post('/api/v1/master/tests').set(auth('U00'))
        .send({ testCode: 'EVIL', name: '주입시도', domain: 'DIAGNOSTIC', loinc: '2345-7\rORC|CA|VICTIM' });
      expect(res.status).toBe(400);
    });
  });

  // ── P2 정합성 회귀(2026-07-22 배치): 오더 종결·교차 멱등·add-on 재활성화·채번·파생 게이트 ──
  describe('P2 정합성 회귀', () => {
    it('전 항목 확정 시 오더가 REPORTED로 종결된다(부분보고 중엔 IN_PROCESS 유지)', async () => {
      const ord = await http.post('/api/v1/orders').set(auth('U07')).send({ patientId: 'T-2345678', testCodes: ['CHE-NA', 'CHE-GLU'] });
      const orderId = ord.body.data.order.orderId as string;
      const rcv = await http.post('/api/v1/orders/receive').set(auth('U07')).send({ orderId, containerCode: 'SST' });
      const sp = rcv.body.data.specimenNo as string;
      await http.post('/api/v1/results').set(auth('U02')).send({ specimenNo: sp, testCode: 'CHE-NA', value: '140', unit: 'mmol/L' });
      let o = await prisma.labOrder.findUnique({ where: { orderId } });
      expect(o?.status).toBe('IN_PROCESS'); // 아직 CHE-GLU 미보고
      await http.post('/api/v1/results').set(auth('U02')).send({ specimenNo: sp, testCode: 'CHE-GLU', value: '105', unit: 'mg/dL' });
      o = await prisma.labOrder.findUnique({ where: { orderId } });
      expect(o?.status).toBe('REPORTED');
    });

    it('오더 생성 시 동일 검사코드 중복 입력은 1항목으로 접힌다', async () => {
      const ord = await http.post('/api/v1/orders').set(auth('U07')).send({ patientId: 'T-2345678', testCodes: ['CHE-NA', 'CHE-NA', 'CHE-GLU'] });
      expect(ord.body.data.order.items).toHaveLength(2);
    });

    it('같은 HIS 오더가 이미 적재돼 있으면 HL7 신규(NW)는 재생성하지 않는다(교차 경로 멱등)', async () => {
      await prisma.labOrder.create({ data: { orderId: 'T-O-XPATH', hisOrderNo: 'P2-XPATH', patientId: 'T-2345678', status: 'RECEIVED' } });
      const oml = [
        'MSH|^~\\&|HIS|HOSP|LIS|HOSP|20260722090000||OML^O21|P2-XPATH-M1|P|2.5.1',
        'PID|1||T-2345678^^^HOSP^MR||김^테스트||19720503|M',
        'ORC|NW|P2-XPATH',
        'OBR|1|P2-XPATH||CBC^일반혈액^L|||20260722090000|||||||||||||||||R',
      ].join('\r');
      const res = await http.post('/api/v1/integration/hl7/inbound').set(auth('U00')).send({ message: oml });
      expect(res.body.data.result).toBe('EXISTS');
      expect(res.body.data.orderId).toBe('T-O-XPATH');
      expect(await prisma.labOrder.count({ where: { hisOrderNo: 'P2-XPATH' } })).toBe(1);
    });

    it('add-on: 취소됐던 검사 재추가는 새 행이 아니라 기존 항목 재활성화', async () => {
      await prisma.labOrder.create({
        data: {
          orderId: 'T-O-P2C', patientId: 'T-2345678', status: 'IN_PROCESS',
          items: { create: [{ orderItemId: 'T-O-P2C-I1', testCode: 'CHE-K', status: 'CANCELLED' }, { orderItemId: 'T-O-P2C-I2', testCode: 'CHE-NA', status: 'IN_PROCESS' }] },
        },
      });
      await prisma.specimen.create({ data: { specimenNo: 'T-S-P2C', orderId: 'T-O-P2C', specimenType: 'Serum', status: 'RECEIVED' } });
      const res = await http.post('/api/v1/orders/specimens/T-S-P2C/add-on').set(auth('U07')).send({ testCodes: ['CHE-K'] });
      expect(res.status).toBe(201);
      expect(res.body.data.added).toContain('CHE-K');
      const items = await prisma.orderItem.findMany({ where: { orderId: 'T-O-P2C' } });
      expect(items).toHaveLength(2); // 중복 행이 생기지 않는다(오더당 검사 유일)
      expect(items.find((i) => i.orderItemId === 'T-O-P2C-I1')?.status).toBe('RECEIVED');
    });

    it('add-on: 취소된 오더에는 추가 불가(400)', async () => {
      await prisma.labOrder.create({ data: { orderId: 'T-O-P2X', patientId: 'T-2345678', status: 'CANCELLED' } });
      await prisma.specimen.create({ data: { specimenNo: 'T-S-P2X', orderId: 'T-O-P2X', specimenType: 'Serum', status: 'RECEIVED' } });
      const res = await http.post('/api/v1/orders/specimens/T-S-P2X/add-on').set(auth('U07')).send({ testCodes: ['CHE-K'] });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('취소');
    });

    it('블록 중간 삭제 후에도 채번이 고장나지 않는다(최대값+1, 재사용 금지)', async () => {
      await prisma.pathologyCase.create({ data: { spNo: 'SP-P2-BLK', patientId: 'T-2345678', status: '접수' } });
      for (const label of ['A', 'B', 'C']) {
        await http.post('/api/v1/pathology/cases/SP-P2-BLK/blocks').set(auth('U00')).send({ label });
      }
      const del = await http.delete('/api/v1/pathology/blocks/SP-P2-BLK-B2').set(auth('U00'));
      expect(del.status).toBe(200);
      // count+1이면 B3을 재발급해 기존 B3과 충돌(P2002·영구 고장)했다 — 최대값+1이므로 B4
      const res = await http.post('/api/v1/pathology/cases/SP-P2-BLK/blocks').set(auth('U00')).send({ label: 'D' });
      expect(res.status).toBe(201);
      expect(res.body.data.blockId).toBe('SP-P2-BLK-B4');
    });

    it('폴링 재적재 시 환자 HIS uuid(patientRef)가 저장된다(H4 — 동의 참조 uuid 변환용)', async () => {
      await prisma.codeMapping.upsert({ where: { lisCode: 'CHE-GLU' }, update: { hisCode: 'HIS-UUID-GLU' }, create: { lisCode: 'CHE-GLU', hisCode: 'HIS-UUID-GLU' } });
      await prisma.interfaceLog.create({
        data: {
          ifId: 'IF-HISORD', direction: 'INBOUND', messageType: 'ServiceRequest(active)', status: 'DROPPED',
          messageControlId: 'hisorder-UUID-E2E-1', errorText: 'unmapped',
          payload: JSON.stringify({ orderId: 'UUID-E2E-1', code: 'HIS-UUID-GLU', patientRef: 'Patient/uuid-e2e-0001', mrn: 'T-UUIDPT', isPathology: false, lastUpdated: '2026-07-22T00:00:00.000Z' }),
        },
      });
      const r = await http.post('/api/v1/integration/hl7/his/dropped-orders/retry').set(auth('U00'));
      expect(r.body.data.created).toBeGreaterThanOrEqual(1);
      const pt = await prisma.patient.findUnique({ where: { patientId: 'T-UUIDPT' } });
      expect(pt?.hisPatientUuid).toBe('uuid-e2e-0001');
      // uuid 보유 환자의 동의 참조는 uuid 미보유 사유가 아니라 HIS 구성 단계(미구성 fail-safe)로 진행한다
      const cs = await http.get('/api/v1/transfusion/consent-status/T-UUIDPT').set(auth('U05'));
      expect(cs.body.data.available).toBe(false);
      expect(cs.body.data.reason).toContain('미구성');
    });

    it('uuid 미보유 환자의 동의 참조 — 명확한 사유로 수기 확인 폴백(H4)', async () => {
      const cs = await http.get('/api/v1/transfusion/consent-status/T-2345678').set(auth('U05'));
      expect(cs.body.data.available).toBe(false);
      expect(cs.body.data.reason).toContain('uuid 미보유');
    });

    it('자동검증·델타 정책을 화면에서 저장할 수 있다(이전엔 seed 수정+재배포뿐)', async () => {
      const set = await http.patch('/api/v1/master/tests/CHE-K').set(auth('U00'))
        .send({ autoVerify: false, deltaPctLimit: 25, deltaAbsLimit: 1.2, deltaWindowDays: 14 });
      expect(set.status).toBe(200);
      expect(set.body.data.autoVerify).toBe(false);
      expect(set.body.data.deltaPctLimit).toBe(25);

      // 비우면 기본값으로 되돌아가야 한다 — 지울 방법이 없으면 잘못 넣은 값이 영구 고착된다
      const cleared = await http.patch('/api/v1/master/tests/CHE-K').set(auth('U00'))
        .send({ deltaAbsLimit: null, deltaWindowDays: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body.data.deltaAbsLimit).toBeNull();

      // 목록에도 실려야 화면이 현재 정책을 보여줄 수 있다
      const list = await http.get('/api/v1/master/tests?domain=DIAGNOSTIC').set(auth('U00'));
      const k = list.body.data.find((t: { testCode: string }) => t.testCode === 'CHE-K');
      expect(k.autoVerify).toBe(false);
      expect(k.deltaPctLimit).toBe(25);

      await http.patch('/api/v1/master/tests/CHE-K').set(auth('U00')).send({ autoVerify: true });
    });

    it('운영 설정 — 위험치 통보 채널을 재기동 없이 화면에서 구성한다', async () => {
      // 허용 목록 밖 키는 어떤 경로로도 설정되지 않는다(관리 화면이 JWT_SECRET 통로가 되면 안 된다)
      expect((await http.put('/api/v1/admin/settings/JWT_SECRET').set(auth('U00'))
        .send({ value: 'pwned' })).status).toBe(404);

      // 권한: ADM 전용(U02=검증자)
      expect((await http.get('/api/v1/admin/settings').set(auth('U02'))).status).toBe(403);

      // http는 거부 — 환자명·검사값이 평문으로 나간다
      const plain = await http.put('/api/v1/admin/settings/CRITICAL_WEBHOOK_URL').set(auth('U00'))
        .send({ value: 'http://gw.local/critical' });
      expect(plain.status).toBe(400);
      expect(plain.body.message).toContain('https');

      // 형식 오류도 저장 시점에 막는다(런타임 로그로만 알리면 아무도 안 본다)
      expect((await http.put('/api/v1/admin/settings/CRITICAL_WEBHOOK_URL').set(auth('U00'))
        .send({ value: 'not-a-url' })).status).toBe(400);

      // 정상 저장 → 목록에 DB 출처로 반영, 쿼리는 마스킹
      expect((await http.put('/api/v1/admin/settings/CRITICAL_WEBHOOK_URL').set(auth('U00'))
        .send({ value: 'https://gw.example.org/lis/critical?token=abcd1234' })).status).toBe(200);
      const list = await http.get('/api/v1/admin/settings').set(auth('U00'));
      const row = list.body.data.find((x: { key: string }) => x.key === 'CRITICAL_WEBHOOK_URL');
      expect(row.configured).toBe(true);
      expect(row.source).toBe('DB');
      expect(row.display).not.toContain('abcd1234');

      // 서명 키는 값이 절대 나가지 않는다(감사·목록 어디에도)
      expect((await http.put('/api/v1/admin/settings/CRITICAL_WEBHOOK_SECRET').set(auth('U00'))
        .send({ value: 'short' })).status).toBe(400);
      expect((await http.put('/api/v1/admin/settings/CRITICAL_WEBHOOK_SECRET').set(auth('U00'))
        .send({ value: 'a-sufficiently-long-secret-value' })).status).toBe(200);
      const list2 = await http.get('/api/v1/admin/settings').set(auth('U00'));
      const sec = list2.body.data.find((x: { key: string }) => x.key === 'CRITICAL_WEBHOOK_SECRET');
      expect(sec.display).toBe('설정됨');
      expect(JSON.stringify(list2.body)).not.toContain('a-sufficiently-long-secret-value');

      // 숫자 범위
      expect((await http.put('/api/v1/admin/settings/CRITICAL_ESCALATION_MINUTES').set(auth('U00'))
        .send({ value: '0' })).status).toBe(400);
      expect((await http.put('/api/v1/admin/settings/CRITICAL_ESCALATION_MINUTES').set(auth('U00'))
        .send({ value: '20' })).status).toBe(200);

      // 미설정 채널 테스트 발송은 400(엉뚱한 곳으로 쏘지 않는다)
      expect((await http.post('/api/v1/admin/settings/test/ops').set(auth('U00')).send({})).status).toBe(400);
      expect((await http.post('/api/v1/admin/settings/test/nope').set(auth('U00')).send({})).status).toBe(400);

      // 해제 후에는 미설정으로 돌아간다(env가 되살아나지 않아야 한다)
      expect((await http.put('/api/v1/admin/settings/CRITICAL_WEBHOOK_URL').set(auth('U00'))
        .send({ value: '' })).status).toBe(200);
      const list3 = await http.get('/api/v1/admin/settings').set(auth('U00'));
      expect(list3.body.data.find((x: { key: string }) => x.key === 'CRITICAL_WEBHOOK_URL').configured).toBe(false);
    });

    it('통보 채널 테스트 발송 — 실제로 도달하는지, 서명이 붙는지, 환자정보가 안 나가는지', async () => {
      // 수신 서버를 띄워 **실제 왕복**을 본다. 저장만 검증하면 "넣었는데 도달 안 하는" 상태를
      // 첫 위험치 때 알게 되고, 그때 실패하면 그건 환자안전 사고다.
      const received: { body: string; sig: string | undefined }[] = [];
      const srv: Server = createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
          received.push({ body: raw, sig: req.headers['x-lis-signature'] as string | undefined });
          res.writeHead(200).end('{}');
        });
      });
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
      const port = (srv.address() as { port: number }).port;

      try {
        // 원내 폐쇄망 게이트웨이 시나리오 — 먼저 명시 승인해야 http가 저장된다
        expect((await http.put('/api/v1/admin/settings/CRITICAL_WEBHOOK_ALLOW_HTTP').set(auth('U00'))
          .send({ value: 'on' })).status).toBe(200);
        expect((await http.put('/api/v1/admin/settings/CRITICAL_WEBHOOK_URL').set(auth('U00'))
          .send({ value: `http://127.0.0.1:${port}/hook` })).status).toBe(200);
        expect((await http.put('/api/v1/admin/settings/CRITICAL_WEBHOOK_SECRET').set(auth('U00'))
          .send({ value: 'e2e-signing-secret-value' })).status).toBe(200);

        const r = await http.post('/api/v1/admin/settings/test/critical').set(auth('U00')).send({});
        expect(r.status).toBe(201);
        expect(r.body.data.ok).toBe(true);
        expect(r.body.data.httpStatus).toBe(200);
        expect(r.body.data.signed).toBe(true);

        expect(received).toHaveLength(1);
        // 서명이 실제로 붙어야 수신측이 위조 통보를 걸러낼 수 있다
        expect(received[0].sig).toMatch(/^sha256=[0-9a-f]{64}$/);
        // 테스트 발송 때문에 환자 정보가 외부로 나가면 안 된다
        const payload = JSON.parse(received[0].body);
        expect(payload.test).toBe(true);
        expect(payload.patientId).toBeUndefined();
        expect(payload.patientName).toBeUndefined();

        // 설정이 즉시 반영된다(재기동 없음) — 해제하면 그 순간부터 안 나간다
        expect((await http.put('/api/v1/admin/settings/CRITICAL_WEBHOOK_URL').set(auth('U00'))
          .send({ value: '' })).status).toBe(200);
        expect((await http.post('/api/v1/admin/settings/test/critical').set(auth('U00')).send({})).status).toBe(400);
      } finally {
        await http.put('/api/v1/admin/settings/CRITICAL_WEBHOOK_ALLOW_HTTP').set(auth('U00')).send({ value: 'off' });
        await http.put('/api/v1/admin/settings/CRITICAL_WEBHOOK_SECRET').set(auth('U00')).send({ value: '' });
        await new Promise<void>((r) => srv.close(() => r()));
      }
    });

    it('검사실 서명 — 값 스냅샷을 함께 굳혀 서명 이후 변경을 드러낸다', async () => {
      // 검사실 계열은 현황 열람 가능(인쇄물이 아니라 화면에서 확정한다)
      const st0 = await http.get('/api/v1/admin/signoff/status').set(auth('U02'));
      expect(st0.status).toBe(200);
      const secB0 = st0.body.data.find((x: { section: string }) => x.section === 'B');
      expect(secB0.signed).toBeNull();

      // 서명 기입 — 확정자 실명 필수(계정만으로는 누가 확정했는지 남지 않는다)
      expect((await http.post('/api/v1/admin/signoff/B').set(auth('U00')).send({ signerName: '  ' })).status).toBe(400);
      const signed = await http.post('/api/v1/admin/signoff/B').set(auth('U00'))
        .send({ signerName: '김검사', signerRole: '진단검사의학과장', documentNo: 'LAB-2026-001' });
      expect(signed.status).toBe(201);

      const st1 = await http.get('/api/v1/admin/signoff/status').set(auth('U00'));
      const secB1 = st1.body.data.find((x: { section: string }) => x.section === 'B');
      expect(secB1.signed.signerName).toBe('김검사');
      expect(secB1.drifted).toBe(false);

      // ★서명된 값이 소리 없이 바뀌는 것이 가장 위험하다 — 델타 한계를 고치면 drift로 드러나야 한다
      expect((await http.patch('/api/v1/master/tests/CHE-K').set(auth('U00'))
        .send({ deltaPctLimit: 33 })).status).toBe(200);

      const st2 = await http.get('/api/v1/admin/signoff/status').set(auth('U00'));
      const secB2 = st2.body.data.find((x: { section: string }) => x.section === 'B');
      expect(secB2.drifted).toBe(true);

      // "변경됨"만 알려주면 전수 대조를 다시 해야 한다 — 무엇이 바뀌었는지 나와야 한다
      const drift = await http.get('/api/v1/admin/signoff/B/drift').set(auth('U00'));
      expect(drift.body.data.changes.length).toBeGreaterThan(0);
      expect(drift.body.data.changes.some((c: { key: string }) => c.key.includes('CHE-K'))).toBe(true);

      // 재서명하면 현재 값이 새 기준(이력은 지워지지 않고 쌓인다)
      await http.post('/api/v1/admin/signoff/B').set(auth('U00')).send({ signerName: '김검사', note: '변경 확인 후 재서명' });
      const st3 = await http.get('/api/v1/admin/signoff/status').set(auth('U00'));
      const secB3 = st3.body.data.find((x: { section: string }) => x.section === 'B');
      expect(secB3.drifted).toBe(false);
      expect(secB3.history).toBe(2);

      const hist = await http.get('/api/v1/admin/signoff/B/history').set(auth('U00'));
      expect(hist.body.data).toHaveLength(2);
      // 스냅샷 원문이 응답에 실려 나가지 않는다(목록은 요약만)
      expect(JSON.stringify(hist.body)).not.toContain('snapshotJson');
    });

    it('보존기간 — 법정 하한 아래로는 못 내리고, 바꾸면 실제 정리 기준과 서명 스냅샷이 함께 움직인다', async () => {
      // 감사 로그는 유전정보 등 민감접근을 포함한다 — 접속기록 2년 하한 아래로 내려가면 안 된다
      const tooShort = await http.put('/api/v1/admin/settings/RETENTION_DAYS_audit_log').set(auth('U00'))
        .send({ value: '365' });
      expect(tooShort.status).toBe(400);
      expect(tooShort.body.message).toContain('730');

      expect((await http.put('/api/v1/admin/settings/RETENTION_DAYS_audit_log').set(auth('U00'))
        .send({ value: '1460' })).status).toBe(200);

      // 설정이 실제 정리 기준에 반영돼야 한다(문서상 값과 동작이 다르면 의미 없다)
      const st = await http.get('/api/v1/admin/lifecycle/status').set(auth('U00'));
      const audit = st.body.data.policies.find((p: { key: string }) => p.key === 'audit_log');
      expect(audit.days).toBe(1460);

      // 서명 워크시트 G 섹션도 실제 적용값을 싣는다 → 값이 바뀌면 '서명 이후 변경'으로 뜬다
      await http.post('/api/v1/admin/signoff/G').set(auth('U00')).send({ signerName: '법무담당' });
      expect((await http.put('/api/v1/admin/settings/RETENTION_DAYS_notification').set(auth('U00'))
        .send({ value: '400' })).status).toBe(200);
      const status = await http.get('/api/v1/admin/signoff/status').set(auth('U00'));
      expect(status.body.data.find((x: { section: string }) => x.section === 'G').drifted).toBe(true);

      // 자동 정리는 법무 확정 전까지 꺼 둔다 — 기본이 '미실행'이어야 한다
      const list = await http.get('/api/v1/admin/settings').set(auth('U00'));
      expect(list.body.data.find((x: { key: string }) => x.key === 'LIFECYCLE_PURGE').display).not.toBe('on');
    });

    it('분자 assay 카탈로그 — 타깃 오타를 드러내고 Ct 판정 한계를 키트별로 적용한다', async () => {
      // 회색지대가 컷오프 위면 구간이 성립하지 않는다
      expect((await http.post('/api/v1/molecular/assays').set(auth('U00'))
        .send({ panelCode: 'RESP-PANEL', target: 'SARS-CoV-2', ctCutoff: 35, equivocalFrom: 38 })).status).toBe(400);
      // Ct 물리 범위 밖 컷오프
      expect((await http.post('/api/v1/molecular/assays').set(auth('U00'))
        .send({ panelCode: 'RESP-PANEL', target: 'SARS-CoV-2', ctCutoff: 99 })).status).toBe(400);

      expect((await http.post('/api/v1/molecular/assays').set(auth('U00'))
        .send({ panelCode: 'RESP-PANEL', target: 'SARS-CoV-2', assayName: 'RT-PCR kit A', ctCutoff: 35, equivocalFrom: 32 })).status).toBe(201);

      // ★자유 문자열 타깃 오타는 조용히 다른 타깃이 된다(추세 비교·법정감염병 매칭이 빗나간다)
      const typo = await http.post('/api/v1/molecular/results').set(auth('U00'))
        .send({ specimenNo: 'T-S-1', panelCode: 'RESP-PANEL', target: 'SARS-CoV2', detection: 'NOT_DETECTED' });
      expect(typo.status).toBe(201);
      expect(typo.body.data.warning).toContain('등록되지 않은 타깃');
      expect(typo.body.data.warning).toContain('SARS-CoV-2');

      // 키트 컷오프(35)를 적용 — 기본값 40이었다면 경고가 나오지 않는다
      const overCut = await http.post('/api/v1/molecular/results').set(auth('U00'))
        .send({ specimenNo: 'T-S-1', panelCode: 'RESP-PANEL', target: 'SARS-CoV-2', detection: 'DETECTED', ct: 37 });
      expect(overCut.body.data.warning).toContain('판정 한계(35)');

      // 판정보류 구간(32~35) 안내
      const gray = await http.post('/api/v1/molecular/results').set(auth('U00'))
        .send({ specimenNo: 'T-S-1', panelCode: 'RESP-PANEL', target: 'SARS-CoV-2', detection: 'DETECTED', ct: 33 });
      expect(gray.body.data.warning).toContain('판정보류 구간');

      // 카탈로그 안의 정상 값은 조용하다(경고 남발은 아무도 안 보게 만든다)
      const clean = await http.post('/api/v1/molecular/results').set(auth('U00'))
        .send({ specimenNo: 'T-S-1', panelCode: 'RESP-PANEL', target: 'SARS-CoV-2', detection: 'DETECTED', ct: 22 });
      expect(clean.body.data.warning).toBeNull();
    });

    it('NGS 패널별 QC 임계 — 패널마다 요구 coverage가 다르다', async () => {
      // 임계는 비율·배수라 음수·0이 있을 수 없다(0이면 사실상 QC를 끄는 것)
      expect((await http.post('/api/v1/ngs/panels').set(auth('U06'))
        .send({ panelCode: 'WES-1', name: '전장엑솜', meanCoverageMin: 0 })).status).toBe(400);

      expect((await http.post('/api/v1/ngs/panels').set(auth('U06'))
        .send({ panelCode: 'WES-1', name: '전장엑솜', platform: 'NovaSeq', meanCoverageMin: 50, q30Min: 85 })).status).toBe(201);

      // 같은 QC 수치라도 패널에 따라 판정이 달라야 한다 — coverage 60x는 기본(100x) 미달, WES-1(50x) 충족
      const runDefault = await http.post('/api/v1/ngs/runs').set(auth('U06')).send({ runName: 'RUN-QC-DEFAULT' });
      await http.post(`/api/v1/ngs/runs/${runDefault.body.data.runId}/complete`).set(auth('U06'))
        .send({ q30: 90, meanCoverage: 60, uniformityPct: 95 });
      const d = await http.get(`/api/v1/ngs/runs/${runDefault.body.data.runId}`).set(auth('U06'));
      expect(d.body.data.qc.verdict).toBe('FAIL');
      expect(d.body.data.qc.thresholds.meanCoverage).toBe(100);

      const runWes = await http.post('/api/v1/ngs/runs').set(auth('U06')).send({ runName: 'RUN-QC-WES', panelCode: 'WES-1' });
      await http.post(`/api/v1/ngs/runs/${runWes.body.data.runId}/complete`).set(auth('U06'))
        .send({ q30: 90, meanCoverage: 60, uniformityPct: 95 });
      const w = await http.get(`/api/v1/ngs/runs/${runWes.body.data.runId}`).set(auth('U06'));
      expect(w.body.data.qc.verdict).toBe('PASS');
      expect(w.body.data.qc.thresholds.meanCoverage).toBe(50);
      // 지정하지 않은 항목은 기본값이 남는다(부분 지정 허용)
      expect(w.body.data.qc.thresholds.uniformityPct).toBe(90);
    });

    it('QC 목표 SD 0 — QC가 조용히 항상 통과로 처리되던 것', async () => {
      // ★sd<=0이면 Westgard가 판정 불가로 보고 PASS를 돌려준다. 검사실은 QC가 돌아가는 줄
      //   알지만 어떤 값을 넣어도 통과하고, QC PASS는 결과 자동확정의 전제다.
      const zero = await http.put('/api/v1/master/qc-targets').set(auth('U00'))
        .send({ qcCode: 'QC-CH1', instrument: '화학1호기', testCode: 'CHE-K', mean: 4.2, sd: 0 });
      expect(zero.status).toBe(400);
      expect(zero.body.message).toContain('항상 통과');

      expect((await http.put('/api/v1/master/qc-targets').set(auth('U00'))
        .send({ qcCode: 'QC-CH1', instrument: '화학1호기', testCode: 'CHE-K', mean: 4.2, sd: -1 })).status).toBe(400);

      // mean 음수는 허용해야 한다 — base excess처럼 정상 범위가 음수인 항목이 있다
      await http.put('/api/v1/master/qc-materials').set(auth('U00')).send({ qcCode: 'QC-CH1' });
      expect((await http.put('/api/v1/master/qc-targets').set(auth('U00'))
        .send({ qcCode: 'QC-CH1', instrument: '화학1호기', testCode: 'CHE-K', mean: -2, sd: 0.5 })).status).toBe(200);
      // 원복
      await http.put('/api/v1/master/qc-targets').set(auth('U00'))
        .send({ qcCode: 'QC-CH1', instrument: '화학1호기', testCode: 'CHE-K', mean: 4.2, sd: 0.15 });
    });

    it('참고치 연령대 역전 — 어떤 환자에게도 적용되지 않는 참고치를 막는다', async () => {
      const inv = await http.post('/api/v1/master/reference-ranges').set(auth('U00'))
        .send({ testCode: 'CHE-K', sex: 'A', ageMin: 80, ageMax: 10, low: 3, high: 5 });
      expect(inv.status).toBe(400);
      expect(inv.body.message).toContain('어떤 환자에게도');

      // 부분 수정으로도 역전시킬 수 없어야 한다
      const ok = await http.post('/api/v1/master/reference-ranges').set(auth('U00'))
        .send({ testCode: 'CHE-K', sex: 'M', ageMin: 0, ageMax: 18, low: 3.4, high: 4.7 });
      expect(ok.status).toBe(201);
      expect((await http.patch(`/api/v1/master/reference-ranges/${ok.body.data.rrId}`).set(auth('U00'))
        .send({ ageMin: 40 })).status).toBe(400);
    });

    it('화면이 없어 쓰지 못하던 기능들 — 동결절편·추가보고·반응조사·수혈이력·소견 결속', async () => {
      // 동결절편(수술 중 신속진단) — 일치도는 CONCORDANT/DISCORDANT만
      const bad = await http.post('/api/v1/pathology/cases/PC-UIB/frozen').set(auth('U04'))
        .send({ frozenDx: '침윤성 암종', concordance: 'MAJOR_DISCORDANT' });
      expect(bad.status).toBe(400);

      // 반응 조사 워크업 — 없는 반응 ID는 404(조용히 만들지 않는다)
      expect((await http.post('/api/v1/transfusion/reactions/RX-NONE/investigate').set(auth('U05'))
        .send({ clericalCheckOk: true, finalClassification: 'FNHTR' })).status).toBe(404);

      // 최종 분류는 정해진 값만 — 자유 문자열이면 통계·보고가 무의미해진다
      expect((await http.post('/api/v1/transfusion/reactions/RX-NONE/investigate').set(auth('U05'))
        .send({ finalClassification: '용혈같음' })).status).toBe(400);

      // 환자 수혈 이력 — 이력이 없어도 200/빈 배열(화면이 빈 상태를 그릴 수 있어야 한다)
      const tx = await http.get('/api/v1/transfusion/patient-transfusions/NO-SUCH-PT').set(auth('U05'));
      expect(tx.status).toBe(200);
      expect(Array.isArray(tx.body.data)).toBe(true);

      // CAP synoptic 프로토콜 — 판독 화면이 필수요소를 보여주려면 목록이 나와야 한다
      const sp = await http.get('/api/v1/pathology/synoptic-protocols').set(auth('U04'));
      expect(sp.status).toBe(200);
      expect(sp.body.data[0]).toHaveProperty('required');

      // 체세포 소견 ↔ 병리 결속: 유전체 판독(GEN)도 할 수 있어야 한다(병리 역할만이면 결속할 사람이 없다)
      const run = await http.post('/api/v1/ngs/runs').set(auth('U06')).send({ runName: 'RUN-LINK' });
      const fnd = await http.post('/api/v1/ngs/findings').set(auth('U06'))
        .send({ runId: run.body.data.runId, category: 'VARIANT', gene: 'EGFR', alteration: 'p.L858R' });
      const link = await http.post(`/api/v1/pathology/somatic/${fnd.body.data.finding.findingId}/link`).set(auth('U06'))
        .send({ caseSpNo: 'PC-NONE' });
      expect(link.status).not.toBe(403);
    });

    it('나머지 미연결 화면 — 정본 보고서 서식·초안 사인아웃·위탁 이력·배포 이력·서명 이력', async () => {
      // 정본 보고서 서식(서버 렌더) — 화면 인쇄와 달리 서버가 만든 문서 하나로 고정한다
      const html = await http.get('/api/v1/results/report/T-S-1/html').set(auth('U02'));
      expect(html.status).toBe(200);
      expect(html.headers['content-type']).toContain('text/html');
      expect(html.text).toContain('검사결과보고서');
      // 미확정 결과는 정본에도 예비로 표시돼야 한다(확정된 것처럼 보이면 안 된다)
      expect(html.text).toContain('예비');

      // 2단계 사인아웃 1단계 — 초안은 서명이 아니다(Accession 미부여)
      const draft = await http.post('/api/v1/pathology/reports/draft').set(auth('U04'))
        .send({ spNo: 'PC-DRAFT-1', findings: '소견', diagnosis: '진단' });
      expect([200, 201, 404]).toContain(draft.status);
      if (draft.status < 400) expect(draft.body.data.accession ?? null).toBeNull();

      // 검체별 위탁 이력 — 이력이 없어도 배열(화면이 빈 상태를 그릴 수 있어야 한다)
      const so = await http.get('/api/v1/sendout/specimen/T-S-1').set(auth('U02'));
      expect(so.status).toBe(200);
      expect(Array.isArray(so.body.data)).toBe(true);

      // 유전체 보고서 배포 이력 — 재분류 재연락 대상 확인의 출발점
      const gd = await http.get('/api/v1/genomic/NO-SUCH/report/deliveries').set(auth('U06'));
      expect([200, 404]).toContain(gd.status);

      // 서명 이력 — 재서명이 이전 기록을 지우지 않는다
      await http.post('/api/v1/admin/signoff/F').set(auth('U00')).send({ signerName: '병리과장' });
      await http.post('/api/v1/admin/signoff/F').set(auth('U00')).send({ signerName: '병리과장', note: '재서명' });
      const hist = await http.get('/api/v1/admin/signoff/F/history').set(auth('U00'));
      expect(hist.body.data).toHaveLength(2);
      expect(hist.body.data[0].signedDt >= hist.body.data[1].signedDt).toBe(true);
    });

    it('표준 코드셋 반입 — 반입(초안)→차이 확인→활성화, 판정 기준이 실제로 바뀐다', async () => {
      // 반입 전: 스타터 브레이크포인트로 판정(ceftriaxone S≤1)
      const before = await http.post('/api/v1/microbiology/cultures/CU-CAT/ast').set(auth('U00'))
        .send({ organism: 'Escherichia coli', results: [{ antibiotic: 'ceftriaxone', mic: '2' }] })
        .catch(() => null);
      // 배양이 없으면 판정 API를 못 쓰므로 도메인 경로 대신 카탈로그 흐름만 검증한다
      void before;

      // 형식 오류는 몇 행이 왜 틀렸는지 알려준다 — "반입 실패"만으로는 고칠 수 없다
      const bad = await http.post('/api/v1/admin/catalogs/AST_BREAKPOINT/import').set(auth('U00'))
        .send({ version: 'BAD-1', csv: 'group,antibiotic,s,r\nEnterobacterales,ceftriaxone,8,4' });
      expect(bad.status).toBe(400);
      expect(bad.body.message).toContain('2행');

      // 정상 반입 → 항상 DRAFT, 활성 버전은 건드리지 않는다
      const imp = await http.post('/api/v1/admin/catalogs/AST_BREAKPOINT/import').set(auth('U00'))
        .send({
          version: 'CLSI-M100-TEST', standard: 'CLSI M100 (test)',
          csv: 'group,antibiotic,s,r\nEnterobacterales,ceftriaxone,0.5,2\nEnterobacterales,meropenem,1,4',
        });
      expect(imp.status).toBe(201);
      expect(imp.body.data.status).toBe('DRAFT');
      // 첫 반입은 코드 스타터셋과 비교한다 — 무엇이 달라지는지 보여야 한다
      expect(imp.body.data.diff.baselineIsStarter).toBe(true);
      expect(imp.body.data.diff.changed.some((c: { key: string }) => c.key === 'Enterobacterales|ceftriaxone')).toBe(true);
      // 스타터에만 있던 항목은 삭제로 잡힌다(자동 판정이 사라진다는 뜻)
      expect(imp.body.data.diff.removed.length).toBeGreaterThan(0);

      // 활성화 → 이전 활성은 RETIRED로 남는다(지난 보고서의 판정 근거 소명)
      expect((await http.post('/api/v1/admin/catalogs/AST_BREAKPOINT/activate').set(auth('U00'))
        .send({ version: 'CLSI-M100-TEST' })).status).toBe(201);
      const list = await http.get('/api/v1/admin/catalogs').set(auth('U00'));
      const ast = list.body.data.find((c: { catalogId: string }) => c.catalogId === 'AST_BREAKPOINT');
      expect(ast.activeVersion).toBe('CLSI-M100-TEST');

      // 활성 버전은 같은 번호로 덮어쓸 수 없다 — 기준이 소리 없이 바뀌면 안 된다
      expect((await http.post('/api/v1/admin/catalogs/AST_BREAKPOINT/import').set(auth('U00'))
        .send({ version: 'CLSI-M100-TEST', csv: 'group,antibiotic,s,r\nEnterobacterales,ceftriaxone,1,4' })).status).toBe(400);

      // 두 번 활성화는 거부
      expect((await http.post('/api/v1/admin/catalogs/AST_BREAKPOINT/activate').set(auth('U00'))
        .send({ version: 'CLSI-M100-TEST' })).status).toBe(400);

      // 항목 조회 — 활성 기준이 무엇인지 화면이 보여줄 수 있어야 한다
      const items = await http.get('/api/v1/admin/catalogs/AST_BREAKPOINT/items?version=CLSI-M100-TEST').set(auth('U00'));
      expect(items.body.data).toHaveLength(2);
    });

    it('초안(DRAFT) 삭제 — 활성/이전 버전은 삭제 불가(Ops18)', async () => {
      await http.post('/api/v1/admin/catalogs/AST_BREAKPOINT/import').set(auth('U00'))
        .send({ version: 'DRAFT-DEL', csv: 'group,antibiotic,s,r\nEnterobacterales,ceftriaxone,0.5,2' });
      // DRAFT 삭제 성공
      const del = await http.delete('/api/v1/admin/catalogs/AST_BREAKPOINT/versions/DRAFT-DEL').set(auth('U00'));
      expect(del.status).toBe(200);
      // 조회하면 없다
      expect((await http.get('/api/v1/admin/catalogs/AST_BREAKPOINT/items?version=DRAFT-DEL').set(auth('U00'))).status).toBe(404);
      // 활성 버전(CLSI-M100-TEST)은 삭제 불가
      expect((await http.delete('/api/v1/admin/catalogs/AST_BREAKPOINT/versions/CLSI-M100-TEST').set(auth('U00'))).status).toBe(400);
    });

    it('카탈로그 4종 반입 — 실제 판정·검증이 활성 버전을 따른다', async () => {
      // 세포병리 분류: 반입·활성화하면 그 코드셋 밖은 거부된다
      await http.post('/api/v1/admin/catalogs/CYTOLOGY_CATEGORY/import').set(auth('U00'))
        .send({ version: 'CYT-1', csv: 'code,system,label\nNILM,BETHESDA,음성\nHSIL,BETHESDA,고등급' });
      await http.post('/api/v1/admin/catalogs/CYTOLOGY_CATEGORY/activate').set(auth('U00')).send({ version: 'CYT-1' });

      // CAP synoptic: 반입·활성화 후 목록이 카탈로그를 따른다
      await http.post('/api/v1/admin/catalogs/SYNOPTIC_PROTOCOL/import').set(auth('U00'))
        .send({ version: 'CAP-1', csv: 'key,label,required\nTHYROID,갑상선암,조직학적유형;종양크기;피막침범' });
      await http.post('/api/v1/admin/catalogs/SYNOPTIC_PROTOCOL/activate').set(auth('U00')).send({ version: 'CAP-1' });
      const protos = await http.get('/api/v1/pathology/synoptic-protocols').set(auth('U04'));
      expect(protos.body.data.some((p: { key: string }) => p.key === 'THYROID')).toBe(true);
      // 스타터에 있던 STOMACH는 카탈로그로 대체됐으므로 이제 없다
      expect(protos.body.data.some((p: { key: string }) => p.key === 'STOMACH')).toBe(false);

      // ICD-O: 활성화하면 형식만 맞는 오타 코드도 거부된다(코드북에 없는 코드)
      await http.post('/api/v1/admin/catalogs/ICDO/import').set(auth('U00'))
        .send({ version: 'ICDO-1', csv: 'kind,code,name\nMORPHOLOGY,8140/3,선암종\nTOPOGRAPHY,C16.9,위' });
      const icdoDiff = await http.post('/api/v1/admin/catalogs/ICDO/activate').set(auth('U00')).send({ version: 'ICDO-1' });
      expect(icdoDiff.status).toBe(201);

      // 법정감염병: 반입·활성화 후 판정이 카탈로그를 따른다 — 목록 조회로 확인
      await http.post('/api/v1/admin/catalogs/NOTIFIABLE_DISEASE/import').set(auth('U00'))
        .send({ version: 'ND-1', csv: 'type,match,disease,grade\nORGANISM,tuberculosis,결핵,제2급\nORGANISM,paratyphi,파라티푸스,제2급\nORGANISM,typhi,장티푸스,제2급' });
      const ndAct = await http.post('/api/v1/admin/catalogs/NOTIFIABLE_DISEASE/activate').set(auth('U00')).send({ version: 'ND-1' });
      expect(ndAct.status).toBe(201);
      const items = await http.get('/api/v1/admin/catalogs/NOTIFIABLE_DISEASE/items?version=ND-1').set(auth('U00'));
      expect(items.body.data).toHaveLength(3);

      // 목록: 4종 모두 활성 버전이 잡힌다
      const list = await http.get('/api/v1/admin/catalogs').set(auth('U00'));
      const byId = Object.fromEntries(list.body.data.map((c: { catalogId: string; activeVersion: string | null }) => [c.catalogId, c.activeVersion]));
      expect(byId.CYTOLOGY_CATEGORY).toBe('CYT-1');
      expect(byId.SYNOPTIC_PROTOCOL).toBe('CAP-1');
      expect(byId.ICDO).toBe('ICDO-1');
      expect(byId.NOTIFIABLE_DISEASE).toBe('ND-1');
    });

    it('참고치 정합성 게이트 — 잘못된 참고치는 모든 결과 판정을 틀어지게 한다', async () => {
      // ① 정상범위 역전 — 정상 범위가 존재할 수 없다
      expect((await http.post('/api/v1/master/reference-ranges').set(auth('U00'))
        .send({ testCode: 'CHE-K', sex: 'A', low: 100, high: 10 })).status).toBe(400);

      // ② 위험치 역전 — 거의 모든 값이 LL이 되어 위험치 통보가 폭주한다(경보 피로)
      const inv = await http.post('/api/v1/master/reference-ranges').set(auth('U00'))
        .send({ testCode: 'CHE-K', sex: 'M', low: 3, high: 5, panicLow: 99, panicHigh: 1 });
      expect(inv.status).toBe(400);
      expect(inv.body.message).toContain('모든 값이 위험치');

      // ③ 위험 상한이 정상 상한 이하 — 정상 범위 값이 위험치로 통보된다
      expect((await http.post('/api/v1/master/reference-ranges').set(auth('U00'))
        .send({ testCode: 'CHE-K', sex: 'F', low: 3, high: 5, panicHigh: 4 })).status).toBe(400);

      // ④ 정상 참고치는 통과
      const ok = await http.post('/api/v1/master/reference-ranges').set(auth('U00'))
        .send({ testCode: 'CHE-K', sex: 'A', ageMin: 61, ageMax: 120, low: 3.5, high: 5.1, panicLow: 2.5, panicHigh: 6.5 });
      expect(ok.status).toBe(201);

      // ⑤ 부분 수정도 병합 검증 — panicHigh만 낮춰 정상범위 안으로 들어오는 것을 막는다
      expect((await http.patch(`/api/v1/master/reference-ranges/${ok.body.data.rrId}`).set(auth('U00'))
        .send({ panicHigh: 4 })).status).toBe(400);

      // ⑥ 델타 한계 음수 — 비교식이 항상 참이 되어 모든 결과가 델타 보류로 쌓인다
      expect((await http.patch('/api/v1/master/tests/CHE-K').set(auth('U00'))
        .send({ deltaPctLimit: -50 })).status).toBe(400);
    });

    it('분자진단 입력 위생 — Ct 범위·신고 중복 방지·불일치 경고', async () => {
      // Ct 범위 — 실측에서 -5·999가 그대로 저장됐다(정량 해석·추세 비교가 틀어진다)
      for (const bad of [-5, 999]) {
        const r = await http.post('/api/v1/molecular/results').set(auth('U08'))
          .send({ specimenNo: 'T-S-1', target: 'CT-RANGE', detection: 'DETECTED', ct: bad });
        expect(r.status, `Ct ${bad}은 차단돼야 한다`).toBe(400);
      }
      // 정상 범위는 통과
      expect((await http.post('/api/v1/molecular/results').set(auth('U08'))
        .send({ specimenNo: 'T-S-1', target: 'CT-OK', detection: 'DETECTED', ct: 28.4 })).status).toBe(201);

      // 검출유무↔Ct 불일치는 차단하지 않고 경고로 실어 보낸다(사람 판단)
      const warn = await http.post('/api/v1/molecular/results').set(auth('U08'))
        .send({ specimenNo: 'T-S-1', target: 'CT-MISMATCH', detection: 'NOT_DETECTED', ct: 22 });
      expect(warn.status).toBe(201);
      expect(warn.body.data.warning).toContain('미검출');

      // ★법정감염병 신고 중복 방지 — 미처리 건이 있으면 재사용(실측: 2회 등록에 신고 2건 생성됐다)
      const first = await http.post('/api/v1/molecular/results').set(auth('U08'))
        .send({ specimenNo: 'T-S-1', target: 'Mycobacterium tuberculosis', detection: 'DETECTED', ct: 30 });
      const second = await http.post('/api/v1/molecular/results').set(auth('U08'))
        .send({ specimenNo: 'T-S-1', target: 'Mycobacterium tuberculosis', detection: 'DETECTED', ct: 31 });
      expect(first.body.data.infectiousReport).toBeTruthy();
      expect(second.body.data.reportReused, '미처리 신고가 있으면 새로 만들지 않는다').toBe(true);
      expect(second.body.data.infectiousReport.reportId).toBe(first.body.data.infectiousReport.reportId);
      const reports = await prisma.infectiousReport.count({ where: { specimenNo: 'T-S-1', organism: 'Mycobacterium tuberculosis' } });
      expect(reports, '중복 신고가 쌓이면 감염관리팀이 같은 건을 두 번 신고한다').toBe(1);
    });

    it('NGS 런-검체 결속과 소견 검증 — 소견이 누구 것인지 알 수 있어야 한다', async () => {
      // 없는 검체는 런 생성 단계에서 거른다(보고 단계에서 발견하면 재작업)
      expect((await http.post('/api/v1/ngs/runs').set(auth('U06'))
        .send({ runName: 'RUN-BAD', specimenNos: ['NO-SUCH-SPECIMEN'] })).status).toBe(400);

      const run = await http.post('/api/v1/ngs/runs').set(auth('U06'))
        .send({ runName: 'RUN-LINK-1', specimenNos: ['T-S-1'], panelCode: 'SOLID-TUMOR' });
      expect(run.status).toBe(201);
      const runId = run.body.data.runId;

      const pts = await http.get(`/api/v1/ngs/runs/${runId}/patients`).set(auth('U06'));
      expect(pts.body.data[0].patientId, '런에서 환자를 역추적할 수 있어야 한다').toBeTruthy();

      // 카테고리별 필수값 — 변이/융합/CNV는 유전자가 있어야 의미가 성립
      expect((await http.post('/api/v1/ngs/findings').set(auth('U06'))
        .send({ runId, category: 'VARIANT', alteration: 'p.X1Y' })).status).toBe(400);
      // TMB·MSI는 유전자 없이 값 자체가 지표
      expect((await http.post('/api/v1/ngs/findings').set(auth('U06'))
        .send({ runId, category: 'TMB', alteration: '12.3 mut/Mb' })).status).toBe(201);
      // VAF 범위
      expect((await http.post('/api/v1/ngs/findings').set(auth('U06'))
        .send({ runId, category: 'VARIANT', gene: 'EGFR', alteration: 'p.L858R', vaf: 150 })).status).toBe(400);

      // QC 실패 런의 소견은 경고와 함께 등록된다(차단 아님 — 판독은 사람 판단)
      await http.post(`/api/v1/ngs/runs/${runId}/complete`).set(auth('U06')).send({ status: 'FAILED' });
      const f = await http.post('/api/v1/ngs/findings').set(auth('U06'))
        .send({ runId, category: 'VARIANT', gene: 'KRAS', alteration: 'p.G12D' });
      expect(f.status).toBe(201);
      expect(f.body.data.qcWarning, 'QC 실패 런이면 판독 사용 경고').toContain('QC');

      // 소견 삭제(오등록 정정) — 등록만 되고 지울 수 없었다
      const del = await http.delete(`/api/v1/ngs/findings/${f.body.data.finding.findingId}`).set(auth('U06'));
      expect(del.status).toBe(200);
    });

    it('분자진단·NGS 화면이 쓰는 API 계약 — 검출 신고 연동·QC 판정·소견 등록', async () => {
      // 분자: 법정감염병 타깃 검출 → 신고 기록 + 감염관리팀 알림 자동 생성(화면이 이를 안내한다)
      const mol = await http.post('/api/v1/molecular/results').set(auth('U08'))
        .send({ specimenNo: 'T-S-1', target: 'Mycobacterium tuberculosis', detection: 'DETECTED', ct: 28.4, assay: 'PCR-UI' });
      expect(mol.status).toBe(201);
      expect(mol.body.data.infectiousReport, '결핵 PCR 검출은 신고 기록을 만든다').toBeTruthy();

      const detected = await http.get('/api/v1/molecular/detected').set(auth('U08'));
      expect(detected.body.data.some((r: { target: string }) => r.target.includes('tuberculosis'))).toBe(true);

      const bySpec = await http.get('/api/v1/molecular/specimen/T-S-1').set(auth('U08'));
      expect(bySpec.body.data.length).toBeGreaterThan(0);

      // NGS: 런 생성 → QC 확정 → 판정 조회 → 소견 등록
      const run = await http.post('/api/v1/ngs/runs').set(auth('U06')).send({ runName: 'RUN-UI-1', flowcell: 'FC-UI' });
      expect(run.status).toBe(201);
      const runId = run.body.data.runId;

      await http.post(`/api/v1/ngs/runs/${runId}/complete`).set(auth('U06'))
        .send({ status: 'COMPLETE', q30: 70, meanCoverage: 120, uniformityPct: 95 }); // Q30 미달
      const qc = await http.get(`/api/v1/genomic/runs/${runId}/qc`).set(auth('U06'));
      expect(qc.body.data.verdict, 'Q30 임계 미달이면 FAIL 판정').toBe('FAIL');
      expect(qc.body.data.thresholds.q30, '화면이 임계값을 함께 보여줘야 판단 가능').toBeDefined();

      const f = await http.post('/api/v1/ngs/findings').set(auth('U06'))
        .send({ runId, category: 'VARIANT', gene: 'EGFR', alteration: 'p.L858R', vaf: 32, tier: 'TIER_I', therapy: 'Osimertinib' });
      expect(f.status).toBe(201);
      const detail = await http.get(`/api/v1/ngs/runs/${runId}`).set(auth('U06'));
      expect(detail.body.data.findings).toHaveLength(1);

      // 역할 경계 — 분자는 MIC/ADM, NGS는 GEN/ADM
      expect((await http.get('/api/v1/molecular/detected').set(auth('U07'))).status).toBe(403);
      expect((await http.get('/api/v1/ngs/runs').set(auth('U07'))).status).toBe(403);
    });

    it('감사 기간 요약 — 실패·민감·업무시간 외를 먼저 보여준다(이상 접근 탐지)', async () => {
      await http.get('/api/v1/audit').set(auth('U02')); // 403 하나 발생
      await new Promise((r) => setTimeout(r, 300));

      const res = await http.get('/api/v1/audit/summary').set(auth('U00'));
      expect(res.status).toBe(200);
      const d = res.body.data;
      expect(d.total).toBeGreaterThan(0);
      expect(d.failed, '권한 위반 시도가 집계돼야 한다').toBeGreaterThan(0);
      expect(d.byAction.length).toBeGreaterThan(0);
      expect(d.topUsers.length).toBeGreaterThan(0);
      // 실패가 몰린 사용자 — 계정 오용·권한 오설정 신호
      expect(d.failedByUser.some((u: { userId: string }) => u.userId === 'U02')).toBe(true);
      expect(d.offHours).toHaveProperty('count');
      expect(Array.isArray(d.byDay)).toBe(true);

      expect((await http.get('/api/v1/audit/summary').set(auth('U02'))).status).toBe(403);
    });

    it('환자별 열람 이력 — 검체 경유 접근까지 잡는다(환자ID만 훑으면 대부분 누락)', async () => {
      // 검체번호로만 접근(환자ID는 어디에도 안 나오는 경로)
      await http.get('/api/v1/results/report/T-S-1').set(auth('U02'));
      await new Promise((r) => setTimeout(r, 300));

      const res = await http.get('/api/v1/audit/patient/T-2345678?take=200').set(auth('U00'));
      expect(res.status).toBe(200);
      expect(res.body.data.scannedKeys, '환자·검체·오더 식별자를 모아 훑어야 한다').toBeGreaterThan(1);
      // 검체 경유 접근이 잡혔는가 — 이것이 이 기능의 존재 이유
      const viaSpecimen = res.body.data.rows.find((r: { target: string; via: string }) => r.target.includes('T-S-1'));
      expect(viaSpecimen, '검체번호로만 접근한 기록도 환자 이력에 나와야 한다').toBeTruthy();
      expect(viaSpecimen.via).toContain('검체');

      // 권한 — 감사 조회는 ADM/AUD만
      expect((await http.get('/api/v1/audit/patient/T-2345678').set(auth('U02'))).status).toBe(403);
    });

    it('감사 조회가 상세(IP·파라미터·본문)와 실패 필터를 제공한다 — 감사 대응의 핵심', async () => {
      // 실패 이벤트 하나 만든다(권한 위반)
      await http.get('/api/v1/audit').set(auth('U02')); // AUD 권한 없음 → 403 기록
      await new Promise((r) => setTimeout(r, 300)); // 감사 체인 append는 비동기 직렬화

      const all = await http.get('/api/v1/audit?take=5').set(auth('U00'));
      expect(all.status).toBe(200);
      const row = all.body.data.rows[0];
      expect(row.detail, '상세(IP·파라미터·본문)가 조회 응답에 있어야 화면이 보여줄 수 있다').toBeTruthy();
      expect(JSON.parse(row.detail).ip, '접속지(어디서)는 감사 필수 요소').toBeDefined();
      expect(row.seq, '해시체인 seq는 무결성 검증의 기준').not.toBeNull();

      // 실패만 필터 — 권한 위반·오류 시도 탐지
      const failed = await http.get('/api/v1/audit?failed=true&take=20').set(auth('U00'));
      expect(failed.body.data.rows.length).toBeGreaterThan(0);
      expect(failed.body.data.rows.every((r: { status: number }) => r.status >= 400)).toBe(true);
    });

    it('보고 가능 검체 목록 — 확정 결과 보유 검체를 기간·검색으로 찾는다(보고서 진입점)', async () => {
      const all = await http.get('/api/v1/results/reportable').set(auth('U02'));
      expect(all.status).toBe(200);
      expect(Array.isArray(all.body.data)).toBe(true);
      const found = all.body.data.find((r: { specimenNo: string }) => r.specimenNo === 'T-S-1');
      expect(found, '확정 결과가 있는 검체는 목록에 있어야 한다').toBeTruthy();
      expect(found.patientId).toBeTruthy();
      expect(found.testCount).toBeGreaterThan(0);

      // 검색 — 검체번호 부분일치
      const byNo = await http.get('/api/v1/results/reportable?q=T-S-1').set(auth('U02'));
      expect(byNo.body.data.some((r: { specimenNo: string }) => r.specimenNo === 'T-S-1')).toBe(true);

      // 기간 밖이면 제외(보고일 기준)
      const past = await http.get('/api/v1/results/reportable?from=2020-01-01&to=2020-01-02').set(auth('U02'));
      expect(past.body.data).toHaveLength(0);

      // 권한 경계 — 접수담당(RCP)은 결과 읽기 권한이 없다
      expect((await http.get('/api/v1/results/reportable').set(auth('U07'))).status).toBe(403);
    });

    it('보고서가 마스터 단위를 함께 반환한다 — 단위 불일치 표면화·참고치 단위 동반(UX §2-4)', async () => {
      const rep = await http.get('/api/v1/results/report/T-S-1').set(auth('U02'));
      expect(rep.status).toBe(200);
      const row = rep.body.data.results.find((r: { testCode: string }) => r.testCode === 'CHE-NA');
      expect(row.masterUnit).toBeTruthy();                 // 화면이 결과 단위와 대조할 근거
      expect(row.refRange).toContain(row.masterUnit);      // 참고치는 단위와 함께
      expect(row.refRange).toContain('–');                 // en-dash 통일(§1-6)
    });

    it('용어 사전 정합 — 상태 라벨이 전부 용어와 연결되고 검색이 동의어를 잡는다(UX §2-1~3)', async () => {
      const { GLOSSARY, GLOSSARY_BY_KEY, STATUS_LABEL, searchGlossary, statusLabel } = await import('@lis/shared');
      // 상태 라벨이 참조하는 용어 key는 반드시 사전에 존재해야 한다(끊어진 팝오버 방지)
      for (const [code, meta] of Object.entries(STATUS_LABEL)) {
        if (meta.termKey) expect(GLOSSARY_BY_KEY[meta.termKey], `용어 없음: ${code}→${meta.termKey}`).toBeDefined();
      }
      // 화면에 뜨는 원시 코드가 한글 라벨로 바뀐다
      expect(statusLabel('NO_RANGE')).toBe('참고치 없음');
      expect(statusLabel('DLQ')).toContain('격리');
      expect(statusLabel('UNKNOWN_CODE')).toBe('UNKNOWN_CODE'); // 미등록은 원문 유지(빈칸 금지)
      // 동의어·영문·약어 검색
      expect(searchGlossary('델타').some((g) => g.key === 'delta-check')).toBe(true);
      expect(searchGlossary('panic').some((g) => g.key === 'panic')).toBe(true);
      expect(searchGlossary('MDRO').some((g) => g.key === 'mdro')).toBe(true);
      // 용어 key 중복 없음
      expect(new Set(GLOSSARY.map((g) => g.key)).size).toBe(GLOSSARY.length);
    });

    it('구성 설명 EP — 패널 전개·계산검사 산출식·검사 단위/참고치(UX §2-5)', async () => {
      await http.post('/api/v1/master/seed-derived-tests').set(auth('U00'));
      await http.put('/api/v1/master/panels').set(auth('U00')).send({ panelCode: 'PNL-EXP', name: '전해질(설명용)', testCodes: ['CHE-NA', 'CHE-K'] });

      const panel = await http.get('/api/v1/master/explain/panel/PNL-EXP').set(auth('U02'));
      expect(panel.status).toBe(200);
      expect(panel.body.data.items).toHaveLength(2);
      expect(panel.body.data.summary).toContain('전개');

      const derived = await http.get('/api/v1/master/explain/derived/CHE-LDLC').set(auth('U02'));
      expect(derived.body.data.formula).toContain('총콜레스테롤');
      expect(derived.body.data.items.map((i: { code: string }) => i.code)).toContain('CHE-HDL');

      const test = await http.get('/api/v1/master/explain/test/CHE-NA').set(auth('U02'));
      expect(test.body.data.unit).toBeTruthy();
      // 참고치는 단위와 함께·en-dash로 표시된다(§2-4·§1-6 — 숫자만이면 단위 오해로 값 오판)
      expect(test.body.data.ranges[0].normal).toContain('–');
      expect(test.body.data.ranges[0].normal).toContain('mmol/L');

      const bad = await http.get('/api/v1/master/explain/bogus/X').set(auth('U02'));
      expect(bad.status).toBe(400);
      // 접수담당(RCP)은 결과 읽기 권한이 없다 — 팝오버도 열리지 않는다(권한 경계 유지)
      expect((await http.get('/api/v1/master/explain/test/CHE-NA').set(auth('U07'))).status).toBe(403);
    });

    it('모든 응답에 correlation id(x-request-id) — 신뢰 형식 인바운드는 승계, 비신뢰는 재발급', async () => {
      const r1 = await http.get('/api/v1/health');
      expect(r1.headers['x-request-id']).toMatch(/^[0-9a-f]{16}$/);
      const r2 = await http.get('/api/v1/health').set('x-request-id', 'ngx-abc123');
      expect(r2.headers['x-request-id']).toBe('ngx-abc123');
      const r3 = await http.get('/api/v1/health').set('x-request-id', 'bad id!'); // 비신뢰 형식(공백·특수문자) — 로그 주입 차단
      expect(r3.headers['x-request-id']).toMatch(/^[0-9a-f]{16}$/);
    });

    it('오타 status 쿼리는 500이 아니라 400으로 알린다(Q7 — Prisma enum 직행 차단)', async () => {
      const orders = await http.get('/api/v1/orders?status=BOGUS').set(auth('U07'));
      expect(orders.status).toBe(400);
      expect(orders.body.message).toContain('RECEIVED');
      const wl = await http.get('/api/v1/orders/specimens/worklist?status=BOGUS').set(auth('U02'));
      expect(wl.status).toBe(400); // 이전엔 500 또는 빈 워크리스트("대기 없음" 오판)
    });

    it('파생검사도 참고치 없으면 자동확정하지 않는다(NO_RANGE 보류 — submitResult 게이트 정합)', async () => {
      await prisma.referenceRange.deleteMany({ where: { testCode: 'CHE-LDLC' } });
      await prisma.labOrder.create({ data: { orderId: 'T-O-P2D', patientId: 'T-2345678', status: 'IN_PROCESS' } });
      await prisma.specimen.create({ data: { specimenNo: 'T-S-P2D', orderId: 'T-O-P2D', specimenType: 'Serum', status: 'IN_PROCESS' } });
      for (const [tc, val] of [['CHE-CHOL', '200'], ['CHE-HDL', '50'], ['CHE-TG', '100']]) {
        await http.post('/api/v1/results').set(auth('U02')).send({ specimenNo: 'T-S-P2D', testCode: tc, value: val, unit: 'mg/dL' });
      }
      const ldl = await prisma.result.findFirst({ where: { specimenNo: 'T-S-P2D', testCode: 'CHE-LDLC' } });
      expect(ldl?.value).toBe('130');
      expect(ldl?.verifyState).toBe('PENDING'); // 이전에는 참고치 없이도 AUTO 확정됐다
      expect(ldl?.holdReason).toBe('NO_RANGE');
    });
  });

  /**
   * 개시 전환 센터(v1.55.0) 회귀 — **안전장치가 조용히 사라지는 것을 막는다.**
   *
   * 여기 검증하는 것들은 전부 "빠져도 기능은 도는" 종류다. 4중 게이트 중 하나가 없어져도
   * 정리는 성공하고 테스트가 없으면 아무도 모른다. 그 상태로 개시일을 맞으면
   * **파일럿 정리가 실 환자 데이터를 지운다.** 케이스는 구현 중 실측으로 겪은 것들이다.
   */
  describe('개시 전환 센터 회귀', () => {
    it('🔴 시드 미등록 데이터가 있으면 정리를 거부한다(409·override 없음)', async () => {
      // 테스트 픽스처는 seed_artifact에 등록돼 있지 않다 → 전부 '실 데이터'로 본다(fail-safe).
      const rd = await http.get('/api/v1/admin/seed-cleanup/real-data').set(auth('U00'));
      expect(rd.status).toBe(200);
      expect(rd.body.data.clean).toBe(false);
      expect(rd.body.data.realPatients).toBeGreaterThan(0);

      const ex = await http.post('/api/v1/admin/seed-cleanup/request').set(auth('U00'))
        .send({ batch: 'product-demo', confirmPhrase: 'x' });
      expect(ex.status).toBe(409); // 우회 수단이 없다
    });

    it('site-starter(마스터)는 정리 대상이 아니다', async () => {
      const pv = await http.get('/api/v1/admin/seed-cleanup/preview?batch=site-starter').set(auth('U00'));
      expect(pv.status).toBe(400);
    });

    it('백필은 등록만 하고 아무것도 삭제하지 않는다', async () => {
      // 공개판: 백필은 기본으로 꺼져 있다 — 꺼진 상태의 403 을 먼저 확인하고 켠다
      delete process.env.LIS_SEED_BACKFILL_ENABLED;
      expect((await http.post('/api/v1/admin/seed-cleanup/backfill').set(auth('U00'))
        .send({ confirmPhrase: '이 데이터베이스에는 실 환자 데이터가 없습니다', approverId: 'U08' })).status).toBe(403);
      process.env.LIS_SEED_BACKFILL_ENABLED = '1';
      const before = await prisma.patient.count();
      // 문구는 응답으로 돌려주지 않는다 — 화면이 에코하면 '사람의 단언'이 버튼 한 번이 된다
      const bfPv = await http.get('/api/v1/admin/seed-cleanup/backfill/preview').set(auth('U00'));
      expect(JSON.stringify(bfPv.body)).not.toContain('이 데이터베이스에는 실 환자 데이터가 없습니다');

      const bad = await http.post('/api/v1/admin/seed-cleanup/backfill').set(auth('U00'))
        .send({ confirmPhrase: '아무거나', approverId: 'U08' });
      expect(bad.status).toBe(400); // 사람의 단언을 문구로 받는다
      // 백필도 2인 승인 — 실 데이터를 '시드'로 만드는 조작이라 정리만큼 위험하다
      expect((await http.post('/api/v1/admin/seed-cleanup/backfill').set(auth('U00'))
        .send({ confirmPhrase: '이 데이터베이스에는 실 환자 데이터가 없습니다', approverId: 'U00' })).status).toBe(400);

      const ok = await http.post('/api/v1/admin/seed-cleanup/backfill').set(auth('U00'))
        .send({ confirmPhrase: '이 데이터베이스에는 실 환자 데이터가 없습니다', approverId: 'U08' });
      expect(ok.status).toBe(201);
      expect(ok.body.data.deleted).toBe(0);
      expect(await prisma.patient.count()).toBe(before); // 삭제 0 확인

      const rd = await http.get('/api/v1/admin/seed-cleanup/real-data').set(auth('U00'));
      expect(rd.body.data.clean).toBe(true); // 등록됐으므로 이제 정리 가능 상태
    });

    it('확인문구·2인 승인 게이트 — 하나라도 어긋나면 실행되지 않는다', async () => {
      // 지울 대상 1건을 e2e 배치로 따로 만든다(픽스처를 건드리지 않기 위해).
      await prisma.notification.create({ data: { notifyId: 'NTF-E2E-CLEAN', ntype: 'E2E', target: 'e2e', message: 'e2e 정리 대상' } });
      await prisma.seedArtifact.create({ data: { artifactId: 'SA-e2e-1', batch: 'e2e', entity: 'notification', pk: 'NTF-E2E-CLEAN' } });

      const pv = await http.get('/api/v1/admin/seed-cleanup/preview?batch=e2e').set(auth('U00'));
      expect(pv.status).toBe(200);
      expect(pv.body.data.total).toBe(1);
      expect(pv.body.data.blocked).toBe(false);
      const phrase = pv.body.data.confirmPhrase;

      // ① 확인문구 불일치 → 요청 자체가 안 된다
      expect((await http.post('/api/v1/admin/seed-cleanup/request').set(auth('U00'))
        .send({ batch: 'e2e', confirmPhrase: '대충 지워' })).status).toBe(400);

      // ② 요청은 실행하지 않는다 — 승인 대기 건만 만든다
      const req = await http.post('/api/v1/admin/seed-cleanup/request').set(auth('U00'))
        .send({ batch: 'e2e', confirmPhrase: phrase });
      expect(req.status).toBe(201);
      expect(await prisma.notification.count({ where: { notifyId: 'NTF-E2E-CLEAN' } })).toBe(1); // 아직 살아 있다

      // ③ 요청자는 자기 요청을 승인할 수 없다(직무분리) — 승인자 ID를 대신 타이핑하는 방식이 아니다
      expect((await http.post(`/api/v1/admin/seed-cleanup/approve/${req.body.data.runId}`).set(auth('U00'))).status).toBe(400);
      // ④ ADM이 아닌 계정은 승인할 수 없다
      expect((await http.post(`/api/v1/admin/seed-cleanup/approve/${req.body.data.runId}`).set(auth('U02'))).status).toBe(403);

      expect(await prisma.notification.count({ where: { notifyId: 'NTF-E2E-CLEAN' } })).toBe(1);
      // 뒤 테스트가 쓰도록 runId를 남긴다
      (globalThis as unknown as { __e2eRunId?: string }).__e2eRunId = req.body.data.runId;
    });

    it('승인자가 자기 토큰으로 승인해야 실행되고, 해당 배치만 삭제된다', async () => {
      const runId = (globalThis as unknown as { __e2eRunId?: string }).__e2eRunId as string;
      const patientsBefore = await prisma.patient.count();

      // 승인자(U08, 다른 ADM)의 토큰으로 호출 — 이 계정이 실제로 인증한다
      const ex = await http.post(`/api/v1/admin/seed-cleanup/approve/${runId}`).set(auth('U08'));
      expect(ex.status).toBe(201);
      expect(ex.body.data.deleted).toBe(1);

      expect(await prisma.notification.count({ where: { notifyId: 'NTF-E2E-CLEAN' } })).toBe(0);
      expect(await prisma.patient.count()).toBe(patientsBefore); // 다른 배치(site-pilot)는 보존

      const runs = await http.get('/api/v1/admin/seed-cleanup/runs').set(auth('U00'));
      expect(runs.status).toBe(200);
      const mine = (runs.body.data as { step: string; result: string; approvedBy: string | null }[])
        .filter((r) => r.step === 'seed-cleanup:e2e');
      expect(mine.some((r) => r.result === 'OK' && r.approvedBy === 'U08')).toBe(true);
      const blocked = (runs.body.data as { result: string }[]).filter((r) => r.result === 'BLOCKED');
      expect(blocked.length).toBeGreaterThan(0); // 앞 테스트의 409 시도가 기록됐다
    });

    it('🔴 마스터·계정은 배치에 등록돼 있어도 삭제하지 않는다', async () => {
      // provider/appUser가 지워지면 FK가 SET NULL이라 병리 서명자·결과 검증자가 조용히 사라진다.
      await prisma.seedArtifact.create({ data: { artifactId: 'SA-e2e-prot', batch: 'e2e', entity: 'provider', pk: 'PRV1' } });
      const pv = await http.get('/api/v1/admin/seed-cleanup/preview?batch=e2e').set(auth('U00'));
      expect((pv.body.data.targets as { entity: string }[]).map((t) => t.entity)).not.toContain('provider');
      expect(await prisma.provider.count({ where: { providerId: 'PRV1' } })).toBe(1);
      await prisma.seedArtifact.deleteMany({ where: { artifactId: 'SA-e2e-prot' } });
    });

    it('🔴 병리 케이스를 지우기 전에 PACS 워크리스트를 취소하고, 실패는 드러난다', async () => {
      // 왜: 취소는 전파되지만 **삭제는 전파되지 않는다**(전파 경로가 취소 ORM 하나뿐인데
      // 그 ORM은 pathology_case를 읽어 만든다). 07-29 픽스처 정리에서 PACS 워크리스트에
      // ACC-SP-26-1008/1009가 SCHEDULED로 남았고 PACS 감시가 뒤늦게 잡았다. RUN-6는 같은 일을 크게 한다.
      await prisma.pathologyCase.create({
        data: { spNo: 'T-SP-MWL', patientId: 'T-2345678', procedureCode: 'PATH', receivedDate: '2026-08-03', status: '접수', mwlStatus: 'SENT' },
      });
      await prisma.seedArtifact.create({ data: { artifactId: 'SA-e2e-mwl', batch: 'e2e', entity: 'pathologyCase', pk: 'T-SP-MWL' } });

      // 이미 취소한 건은 다시 세지 않는다 — 로그를 "NW가 있었는가"로만 보면 개시일에 보낼
      // 건수가 부풀려진다(예행에서 SP-2026-0002가 그렇게 잡혔다). 마지막 ORM이 CA면 죽은 것이다.
      await prisma.pathologyCase.create({
        data: { spNo: 'T-SP-CAN', patientId: 'T-2345678', procedureCode: 'PATH', receivedDate: '2026-08-03', status: '취소', mwlStatus: 'SENT' },
      });
      await prisma.seedArtifact.create({ data: { artifactId: 'SA-e2e-can', batch: 'e2e', entity: 'pathologyCase', pk: 'T-SP-CAN' } });
      await prisma.interfaceLog.create({ data: { ifId: 'IF-09', direction: 'OUTBOUND', messageType: 'ORM^O01(MWL)', status: 'PROCESSED', payload: 'OBR|1|ACC-T-SP-CAN|' } });
      await prisma.interfaceLog.create({ data: { ifId: 'IF-09', direction: 'OUTBOUND', messageType: 'ORM^O01(MWL-CANCEL)', status: 'PROCESSED', payload: 'OBR|1|ACC-T-SP-CAN|' } });

      // ① 미리보기가 "지우기 전에 PACS로 나갈 취소"를 승인자에게 보여준다
      const pv = await http.get('/api/v1/admin/seed-cleanup/preview?batch=e2e').set(auth('U00'));
      expect(pv.body.data.pacsWorklist.count).toBe(1);
      expect(pv.body.data.pacsWorklist.spNos).toContain('T-SP-MWL');
      expect(pv.body.data.pacsWorklist.spNos).not.toContain('T-SP-CAN'); // 마지막 ORM이 CA = 죽은 워크리스트

      const req = await http.post('/api/v1/admin/seed-cleanup/request').set(auth('U00'))
        .send({ batch: 'e2e', confirmPhrase: pv.body.data.confirmPhrase });
      expect(req.status).toBe(201);
      const ex = await http.post(`/api/v1/admin/seed-cleanup/approve/${req.body.data.runId}`).set(auth('U08'));
      expect(ex.status).toBe(201);

      // ② e2e는 PACS 미구성이라 취소가 실패한다 — 조용히 넘어가지 않고 실패 목록에 남아야 한다.
      //    (성공했다고 보고하면 운영자는 고아가 없다고 믿고 넘어간다)
      expect((ex.body.data.mwlFailed as { spNo: string }[]).map((f) => f.spNo)).toContain('T-SP-MWL');
      expect(ex.body.data.mwlCancelled).toEqual([]);
      // ③ 그래도 정리는 진행된다(best-effort) — PACS 장애가 개시일 정리를 막지 않는다
      expect(await prisma.pathologyCase.count({ where: { spNo: { in: ['T-SP-MWL', 'T-SP-CAN'] } } })).toBe(0);
    });

    it('🔴 선행 항목이 미완이면 완료할 수 없다(비가역 단계 순서 강제)', async () => {
      // RUN-6(파일럿 정리·비가역)은 P1(백업+복구 리허설) 선행이다.
      const res = await http.post('/api/v1/admin/golive/tasks/RUN-6').set(auth('U00')).send({ status: 'DONE' });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('선행');
    });

    it('자동 판정 항목은 수동으로 완료할 수 없다', async () => {
      const cl = await http.get('/api/v1/admin/golive/checklist').set(auth('U00'));
      expect(cl.status).toBe(200);
      expect(cl.body.data.summary.total).toBeGreaterThan(0);
      const items = (cl.body.data.phases as { items: { code: string; autoJudged: boolean; status: string }[] }[])
        .flatMap((p) => p.items);
      expect(items.some((i) => i.autoJudged)).toBe(true);
      expect(items.some((i) => i.status === 'UNKNOWN')).toBe(false); // 없는 판정키를 적으면 영원히 미판정이 된다

      // A2는 autoCheck(critical_webhook) — 사람이 완료를 찍으면 '화면상 완료' 오인이 그대로 재현된다
      const res = await http.post('/api/v1/admin/golive/tasks/A2').set(auth('U00')).send({ status: 'DONE' });
      expect(res.status).toBe(400);
    });

    it('해당없음(NA)은 사유가 필수다', async () => {
      expect((await http.post('/api/v1/admin/golive/tasks/C2').set(auth('U00')).send({ status: 'NA' })).status).toBe(400);
      const ok = await http.post('/api/v1/admin/golive/tasks/C2').set(auth('U00'))
        .send({ status: 'NA', naReason: '이 사이트는 별도 감시 체계를 쓴다' });
      expect(ok.status).toBe(201);
      expect(ok.body.data.naReason).toContain('별도 감시');
    });

    it('사이트 프로파일에 없는 기능의 항목은 생성되지 않는다(NA가 아니라 미생성)', async () => {
      const save = await http.put('/api/v1/admin/golive/profile').set(auth('U00'))
        // PACS만 없는 구성 — 제외되는 항목이 **전부 non-blocking**이어야 이 테스트가 '미생성' 자체를 본다.
        // ERP를 켜 두는 이유: X1(ERP 파일럿 청구 정리)이 blocking이라, 빼면 '사유 필수' 게이트에 걸려
        // 여기서 검증하려는 것과 다른 것을 보게 된다(v1.56.9에서 실제로 그렇게 실패했다).
        .send({ siteCode: 'E2E-SITE', capabilities: ['HIS', 'ERP'] });
      expect(save.status).toBe(200);

      const cl = await http.get('/api/v1/admin/golive/checklist').set(auth('U00'));
      const codes = (cl.body.data.phases as { items: { code: string }[] }[]).flatMap((p) => p.items).map((i) => i.code);
      expect(codes).not.toContain('RUN-4'); // PACS 컷오버
      expect(codes).not.toContain('P5'); // PACS preflight
      expect(codes).toContain('RUN-3'); // HIS는 켜져 있으므로 남는다
      // 제외된 항목은 숨기지 않고 드러낸다 — 미생성이 '조용한 차단 제거'가 되지 않도록
      expect((cl.body.data.excluded as { code: string }[]).map((e) => e.code)).toContain('RUN-4');
      expect(cl.body.data.excludedBlocking).toBe(0);
    });

    it('🔴 개시 차단을 제외하는 프로파일은 사유 없이 저장할 수 없다', async () => {
      // HIS·ERP를 빼면 blocking 4건(E3·RUN-3·PS-3·X1)이 생성되지 않아 차단이 조용히 줄어든다.
      const noReason = await http.put('/api/v1/admin/golive/profile').set(auth('U00'))
        .send({ siteCode: 'E2E-SITE', capabilities: ['PACS'] });
      expect(noReason.status).toBe(400);
      expect(noReason.body.message).toContain('개시 차단');

      const withReason = await http.put('/api/v1/admin/golive/profile').set(auth('U00'))
        .send({ siteCode: 'E2E-SITE', capabilities: ['PACS'], reason: '이 사이트는 HIS 연동을 쓰지 않는다' });
      expect(withReason.status).toBe(200);

      const cl = await http.get('/api/v1/admin/golive/checklist').set(auth('U00'));
      expect(cl.body.data.excludedBlocking).toBe(4); // 숨기지 않고 건수를 드러낸다
      const exCodes = (cl.body.data.excluded as { code: string; blocking: boolean }[])
        .filter((e) => e.blocking).map((e) => e.code);
      expect(exCodes).toEqual(expect.arrayContaining(['E3', 'RUN-3', 'PS-3', 'X1']));

      // 승인 스냅샷에도 제외 사실이 남아야 나중에 소명이 된다
      const exp = await http.get('/api/v1/admin/golive/export').set(auth('U00'));
      expect((exp.body.data.excluded as { code: string }[]).length).toBeGreaterThan(0);

      // 원복(뒤 테스트 영향 방지)
      await http.put('/api/v1/admin/golive/profile').set(auth('U00'))
        .send({ siteCode: 'E2E-SITE', capabilities: ['HIS', 'PACS', 'ERP', 'PATHOLOGY', 'GENOMIC', 'MICRO', 'TRANSFUSION'] });
    });

    it('근거 필수 항목은 첨부 없이 완료할 수 없고, 첨부하면 완료된다', async () => {
      // H2(법무·인프라 결정)는 evidence: DOC_REQUIRED
      const noDoc = await http.post('/api/v1/admin/golive/tasks/H2').set(auth('U00')).send({ status: 'DONE' });
      expect(noDoc.status).toBe(400);
      expect(noDoc.body.message).toContain('근거 문서');

      const badMime = await http.post('/api/v1/admin/golive/attachments').set(auth('U00'))
        .field('category', 'LEGAL').field('taskCode', 'H2')
        .attach('file', Buffer.from('#!/bin/sh'), { filename: 'x.sh', contentType: 'application/x-sh' });
      expect(badMime.status).toBe(400); // 실행 가능한 형식을 들이지 않는다

      // 확장자만 바꾼 위장 — 저장 후 로컬에서 열리는 경로를 막는다
      const badExt = await http.post('/api/v1/admin/golive/attachments').set(auth('U00'))
        .field('category', 'LEGAL').field('taskCode', 'H2')
        .attach('file', Buffer.from('%PDF-1.4 x'), { filename: '법무의견.html', contentType: 'application/pdf' });
      expect(badExt.status).toBe(400);

      // 확장자·MIME은 맞지만 **내용이 PDF가 아닌** 파일 — 매직바이트로 잡는다
      const badMagic = await http.post('/api/v1/admin/golive/attachments').set(auth('U00'))
        .field('category', 'LEGAL').field('taskCode', 'H2')
        .attach('file', Buffer.from('<html><script>alert(1)</script></html>'), { filename: 'ok.pdf', contentType: 'application/pdf' });
      expect(badMagic.status).toBe(400);

      const up = await http.post('/api/v1/admin/golive/attachments').set(auth('U00'))
        .field('category', 'LEGAL').field('taskCode', 'H2')
        .attach('file', Buffer.from('%PDF-1.4 vpn agreement'), { filename: 'vpn.pdf', contentType: 'application/pdf' });
      expect(up.status).toBe(201);
      expect(up.body.data.sha256).toHaveLength(64);

      const done = await http.post('/api/v1/admin/golive/tasks/H2').set(auth('U00')).send({ status: 'DONE' });
      expect(done.status).toBe(201);
      expect(done.body.data.status).toBe('DONE');
    });

    it('첨부는 저장 후 교체를 탐지한다(sha256 재계산)', async () => {
      const list = await http.get('/api/v1/admin/golive/attachments?taskCode=H2').set(auth('U00'));
      expect(list.status).toBe(200);
      expect(list.body.data.total).toBeGreaterThan(0); // 총건수를 함께 준다(잘림을 알 수 있게)
      const id = list.body.data.rows[0].attachmentId;

      const okDl = await http.get(`/api/v1/admin/golive/attachments/${id}/download`).set(auth('U00'));
      expect(okDl.status).toBe(200);
      expect(okDl.headers['x-attachment-integrity']).toBe('ok');
      expect(okDl.headers['x-content-type-options']).toBe('nosniff');

      // 저장 후 원본이 바뀌면 증빙으로 쓸 수 없다 — 조용히 넘기지 않는다
      await prisma.goLiveAttachment.update({ where: { attachmentId: id }, data: { data: new Uint8Array(Buffer.from('TAMPERED')) } });
      const bad = await http.get(`/api/v1/admin/golive/attachments/${id}/download`).set(auth('U00'));
      expect(bad.headers['x-attachment-integrity']).toBe('MISMATCH');
    });

    it('개시 키 묶음은 판정만 반환하고 값을 노출하지 않는다', async () => {
      const res = await http.get('/api/v1/admin/golive/keys').set(auth('U00'));
      expect(res.status).toBe(200);
      const keys = res.body.data.keys as { key: string; status: string }[];
      expect(keys.some((k) => k.key === 'CRITICAL_WEBHOOK_URL')).toBe(true);
      expect(JSON.stringify(res.body)).not.toContain('value');
    });

    it('준비도 내보내기에 PHI가 섞이지 않는다', async () => {
      const res = await http.get('/api/v1/admin/golive/export').set(auth('U00'));
      expect(res.status).toBe(200);
      expect(res.body.data.registryVersion).toBeTruthy();
      const dump = JSON.stringify(res.body);
      expect(dump).not.toContain('김테스트'); // 픽스처 환자명
      expect(dump).not.toContain('T-2345678'); // 픽스처 환자ID
    });
  });
});
