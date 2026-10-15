-- ============================================================
-- LIS 개발지원 스키마 (DDL)
-- 근거: 06_상세설계_데이터모델.md
-- 대상: SQLite 3 (검증용). PostgreSQL 이식 시 주석 참조.
--   * TEXT PK 사용(가독). PG에서는 VARCHAR/UUID 권장.
--   * TIMESTAMP는 SQLite에서 TEXT affinity. 'YYYY-MM-DD HH:MM:SS' 저장.
--   * 참조무결성 확인은 PRAGMA foreign_keys=ON 필요.
-- ============================================================
PRAGMA foreign_keys = ON;

-- ---------- 마스터 ----------
CREATE TABLE provider (            -- 의료진
  provider_id  TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  dept         TEXT,
  role_type    TEXT               -- 처방의/판독의 등
);

CREATE TABLE container (           -- 검체 용기
  container_code TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  additive       TEXT,
  color          TEXT
);

CREATE TABLE test_master (         -- 검사항목
  test_code      TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  loinc          TEXT,
  domain         TEXT NOT NULL,    -- 진단검사/미생물/병리/수혈/유전체
  unit_ucum      TEXT,
  specimen_type  TEXT,
  status         TEXT DEFAULT 'USE'
);

CREATE TABLE panel (               -- 패널
  panel_code TEXT PRIMARY KEY,
  name       TEXT NOT NULL
);

CREATE TABLE panel_item (          -- 패널 구성(1:N 전개)
  panel_code TEXT NOT NULL REFERENCES panel(panel_code),
  test_code  TEXT NOT NULL REFERENCES test_master(test_code),
  PRIMARY KEY (panel_code, test_code)
);

CREATE TABLE reference_range (     -- 참고치(성별/연령/검체별)
  rr_id       TEXT PRIMARY KEY,
  test_code   TEXT NOT NULL REFERENCES test_master(test_code),
  sex         TEXT DEFAULT 'A',   -- A(전체)/M/F
  age_min     INTEGER DEFAULT 0,
  age_max     INTEGER DEFAULT 200,
  low         REAL,
  high        REAL,
  panic_low   REAL,
  panic_high  REAL
);

CREATE TABLE code_mapping (        -- HIS↔LIS↔LOINC↔EDI
  lis_code  TEXT PRIMARY KEY REFERENCES test_master(test_code),
  his_code  TEXT,
  loinc     TEXT,
  edi_code  TEXT,
  status    TEXT DEFAULT 'USE'
);

CREATE TABLE role (                -- 역할
  role_code TEXT PRIMARY KEY,
  name      TEXT NOT NULL
);

CREATE TABLE app_user (            -- 사용자
  user_id TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  dept    TEXT,
  status  TEXT DEFAULT 'ACTIVE'
);

CREATE TABLE user_role (
  user_id   TEXT NOT NULL REFERENCES app_user(user_id),
  role_code TEXT NOT NULL REFERENCES role(role_code),
  PRIMARY KEY (user_id, role_code)
);

-- ---------- 환자/오더/검체 ----------
CREATE TABLE patient (
  patient_id TEXT PRIMARY KEY,     -- = HIS 등록번호
  name       TEXT NOT NULL,
  sex        TEXT,                 -- M/F/O/U
  birth_date TEXT,
  status     TEXT DEFAULT 'ACTIVE'
);

CREATE TABLE visit (
  visit_id   TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patient(patient_id),
  type       TEXT,                 -- I/O/E
  dept       TEXT,
  ward       TEXT,
  attending  TEXT REFERENCES provider(provider_id)
);

CREATE TABLE lab_order (
  order_id           TEXT PRIMARY KEY,
  his_order_no       TEXT,
  patient_id         TEXT NOT NULL REFERENCES patient(patient_id),
  visit_id           TEXT REFERENCES visit(visit_id),
  ordering_provider  TEXT REFERENCES provider(provider_id),
  order_dt           TEXT,
  priority           TEXT DEFAULT 'R',   -- S(STAT)/R(Routine)
  status             TEXT DEFAULT 'RECEIVED'
);

CREATE TABLE order_item (
  order_item_id TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES lab_order(order_id),
  test_code     TEXT NOT NULL REFERENCES test_master(test_code),
  status        TEXT DEFAULT 'RECEIVED',
  sendout_flag  INTEGER DEFAULT 0
);

CREATE TABLE specimen (
  specimen_no    TEXT PRIMARY KEY,   -- 바코드
  order_id       TEXT NOT NULL REFERENCES lab_order(order_id),
  container_code TEXT REFERENCES container(container_code),
  specimen_type  TEXT,
  collected_dt   TEXT,
  received_dt    TEXT,
  status         TEXT DEFAULT 'RECEIVED'
);

CREATE TABLE aliquot (
  aliquot_no        TEXT PRIMARY KEY,
  specimen_no       TEXT NOT NULL REFERENCES specimen(specimen_no),
  container_code    TEXT REFERENCES container(container_code),
  target_instrument TEXT
);

CREATE TABLE result (
  result_id    TEXT PRIMARY KEY,
  specimen_no  TEXT NOT NULL REFERENCES specimen(specimen_no),
  test_code    TEXT NOT NULL REFERENCES test_master(test_code),
  value        TEXT,
  unit         TEXT,
  flag         TEXT,                -- N/H/L/HH/LL
  status       TEXT DEFAULT 'F',    -- P/F/C
  version      INTEGER DEFAULT 1,
  verifier     TEXT REFERENCES app_user(user_id),
  reported_dt  TEXT
);

CREATE TABLE critical_notify (     -- 위험치 통보(폐루프)
  notify_id     TEXT PRIMARY KEY,
  result_id     TEXT NOT NULL REFERENCES result(result_id),
  notify_target TEXT,
  notify_method TEXT,
  notified_dt   TEXT,
  ack_dt        TEXT,
  ack_by        TEXT
);

-- ---------- 정도관리(QC) ----------
CREATE TABLE qc_material (
  qc_code TEXT PRIMARY KEY,
  name    TEXT,
  lot     TEXT,
  expiry  TEXT
);

CREATE TABLE qc_result (
  qc_result_id   TEXT PRIMARY KEY,
  qc_code        TEXT NOT NULL REFERENCES qc_material(qc_code),
  instrument     TEXT,
  test_code      TEXT NOT NULL REFERENCES test_master(test_code),
  measured_value REAL,
  measured_dt    TEXT,
  verdict        TEXT               -- PASS/WARN/FAIL
);

-- ---------- 미생물 ----------
CREATE TABLE culture (
  culture_id  TEXT PRIMARY KEY,
  specimen_no TEXT NOT NULL REFERENCES specimen(specimen_no),
  medium      TEXT,
  stage       TEXT,                 -- 접종/배양/동정/감수성
  status      TEXT
);

CREATE TABLE isolate (
  isolate_id TEXT PRIMARY KEY,
  culture_id TEXT NOT NULL REFERENCES culture(culture_id),
  organism   TEXT,
  snomed     TEXT
);

CREATE TABLE susceptibility (
  sus_id         TEXT PRIMARY KEY,
  isolate_id     TEXT NOT NULL REFERENCES isolate(isolate_id),
  antibiotic     TEXT,
  mic            TEXT,
  interpretation TEXT               -- S/I/R
);

-- ---------- 병리 ----------
CREATE TABLE pathology_case (
  sp_no         TEXT PRIMARY KEY,
  patient_id    TEXT NOT NULL REFERENCES patient(patient_id),
  specimen_site TEXT,
  received_date TEXT,
  status        TEXT
);

CREATE TABLE pathology_report (
  sp_no        TEXT PRIMARY KEY REFERENCES pathology_case(sp_no),
  findings     TEXT,
  diagnosis    TEXT,
  snomed       TEXT,
  status       TEXT,                -- 예비/최종/개정
  signer       TEXT REFERENCES provider(provider_id),
  signed_dt    TEXT,
  accession_no TEXT                 -- PACS 연계키
);

-- ---------- 수혈 ----------
CREATE TABLE blood_unit (
  unit_no      TEXT PRIMARY KEY,    -- ISBT128
  product_type TEXT,
  blood_group  TEXT,
  drawn_date   TEXT,
  expiry_date  TEXT,
  status       TEXT DEFAULT 'IN_STOCK'
);

CREATE TABLE crossmatch (
  xm_id      TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patient(patient_id),
  unit_no    TEXT NOT NULL REFERENCES blood_unit(unit_no),
  method     TEXT,
  result     TEXT,                  -- 적합/부적합
  tester     TEXT REFERENCES app_user(user_id)
);

CREATE TABLE blood_issue (
  issue_id   TEXT PRIMARY KEY,
  unit_no    TEXT NOT NULL REFERENCES blood_unit(unit_no),
  patient_id TEXT NOT NULL REFERENCES patient(patient_id),
  issuer     TEXT,
  receiver   TEXT,
  confirm1   TEXT,
  confirm2   TEXT,
  issued_dt  TEXT
);

-- ---------- 유전체 ----------
CREATE TABLE genomic_order (
  genomic_order_id TEXT PRIMARY KEY,
  order_id         TEXT NOT NULL REFERENCES lab_order(order_id),
  panel_code       TEXT,
  test_type        TEXT,            -- 체세포/생식세포/감염/PGx
  sendout_center   TEXT,
  tat_target       TEXT,
  status           TEXT
);

CREATE TABLE consent (             -- 동의(발송 선행 게이트)
  consent_id                TEXT PRIMARY KEY,
  genomic_order_id          TEXT NOT NULL REFERENCES genomic_order(genomic_order_id),
  consent_type              TEXT,
  secondary_findings_optin  INTEGER DEFAULT 0,
  signed_date               TEXT,
  withdrawn                 INTEGER DEFAULT 0
);

CREATE TABLE variant (
  variant_id       TEXT PRIMARY KEY,
  genomic_order_id TEXT NOT NULL REFERENCES genomic_order(genomic_order_id),
  gene             TEXT,
  hgvs_c           TEXT,
  hgvs_p           TEXT,
  vaf              REAL,
  zygosity         TEXT
);

CREATE TABLE interpretation (
  interp_id        TEXT PRIMARY KEY,
  variant_id       TEXT NOT NULL REFERENCES variant(variant_id),
  classification   TEXT,            -- Pathogenic/VUS/... 또는 Tier/PGx
  evidence         TEXT,
  classifier       TEXT REFERENCES app_user(user_id),
  classified_date  TEXT,
  status           TEXT
);

-- ---------- 시스템 알림 ----------
CREATE TABLE notification (
  notify_id  TEXT PRIMARY KEY,
  ntype      TEXT,                  -- 미매핑/QC위반/연계오류 등
  target     TEXT,
  message    TEXT,
  created_dt TEXT,
  ack_dt     TEXT
);
