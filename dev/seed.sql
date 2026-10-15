-- ============================================================
-- LIS 개발지원 시드 데이터
-- 시나리오: 화면정의서(03)·프로토타입과 동일 샘플 재사용
--   홍길동 Hb 6.5 위험치 / 김철수 K 6.8 위험치 / Klebsiella 배양
--   위 조직검사 병리 / 정민호 수혈 / 박지은 BRCA 유전체
-- 기준시각: 2026-07-12
-- ============================================================
PRAGMA foreign_keys = ON;

-- ---------- 마스터: 의료진/용기 ----------
INSERT INTO provider VALUES
 ('D001','김의사','내과','처방의'),
 ('D002','박의사','유방외과','처방의'),
 ('D010','정판독','병리과','판독의'),
 ('D011','유전판독','진단검사의학과','유전체판독의');

INSERT INTO container VALUES
 ('SST','혈청분리관','응고촉진제','금색'),
 ('EDTA','EDTA관','EDTA','보라색'),
 ('URINE','요검사컵',NULL,'투명'),
 ('SPUTUM','객담용기',NULL,'투명'),
 ('TISSUE','조직용기','포르말린','흰색');

-- ---------- 마스터: 검사항목 ----------
INSERT INTO test_master VALUES
 ('CBC-HGB','혈색소','718-7','진단검사','g/dL','Whole blood','USE'),
 ('CBC-WBC','백혈구수','6690-2','진단검사','10*3/uL','Whole blood','USE'),
 ('CBC-PLT','혈소판수','777-3','진단검사','10*3/uL','Whole blood','USE'),
 ('CHE-GLU','공복혈당','1558-6','진단검사','mg/dL','Serum','USE'),
 ('CHE-K','칼륨','2823-3','진단검사','mmol/L','Serum','USE'),
 ('CHE-NA','나트륨','2951-2','진단검사','mmol/L','Serum','USE'),
 ('UA-PROT','요단백','2888-6','진단검사',NULL,'Urine','USE'),
 ('MIC-CUL','일반세균배양','600-7','미생물',NULL,'각종','USE'),
 ('MIC-AST','항생제감수성','29576-6','미생물',NULL,'배양체','USE'),
 ('PAT-SURG','외과병리(조직검사)','33746-0','병리',NULL,'조직','USE'),
 ('BB-ABO','ABO 혈액형','883-9','수혈',NULL,'Whole blood','USE'),
 ('BB-XM','교차시험','883-9','수혈',NULL,'Whole blood','USE'),
 ('GEN-HRD','유전성유방암패널',NULL,'유전체',NULL,'Blood','USE');

-- ---------- 마스터: 패널/구성 ----------
INSERT INTO panel VALUES ('CBC','일반혈액검사'),('CHEM','임상화학패널');
INSERT INTO panel_item VALUES
 ('CBC','CBC-HGB'),('CBC','CBC-WBC'),('CBC','CBC-PLT'),
 ('CHEM','CHE-GLU'),('CHEM','CHE-K'),('CHEM','CHE-NA');

-- ---------- 마스터: 참고치(성별/연령) ----------
INSERT INTO reference_range VALUES
 ('RR01','CBC-HGB','M',18,200,13.0,17.0,7.0,20.0),
 ('RR02','CBC-HGB','F',18,200,12.0,16.0,7.0,20.0),
 ('RR03','CBC-WBC','A',0,200,4.0,10.0,1.0,30.0),
 ('RR04','CBC-PLT','A',0,200,150,400,20,1000),
 ('RR05','CHE-GLU','A',18,200,70,100,40,500),
 ('RR06','CHE-K','A',0,200,3.5,5.1,2.5,6.5),
 ('RR07','CHE-NA','A',0,200,135,145,120,160);

-- ---------- 마스터: 코드매핑 ----------
INSERT INTO code_mapping VALUES
 ('CBC-HGB','CBC','718-7',NULL,'USE'),
 ('CBC-WBC','CBC','6690-2',NULL,'USE'),
 ('CHE-K','K','2823-3',NULL,'USE'),
 ('CHE-GLU','GLU','1558-6',NULL,'USE'),
 ('MIC-CUL','CULT','600-7',NULL,'USE'),
 ('PAT-SURG','SP','33746-0',NULL,'USE'),
 ('GEN-HRD','HEREDNGS',NULL,NULL,'USE');

-- ---------- 마스터: 역할/사용자 ----------
INSERT INTO role VALUES
 ('RCP','접수담당'),('TEC','검사자'),('PHY','검증의'),
 ('PAT','병리판독의'),('BB','수혈담당'),('MIC','미생물검사자'),
 ('GEN','유전체판독의'),('GC','유전상담사'),('ADM','관리자'),('AUD','감사자');

INSERT INTO app_user VALUES
 ('U01','이검사','진단검사의학과','ACTIVE'),
 ('U02','최검증','진단검사의학과','ACTIVE'),
 ('U03','한미생','진단검사의학과','ACTIVE'),
 ('U04','정판독','병리과','ACTIVE'),
 ('U05','서수혈','진단검사의학과','ACTIVE'),
 ('U06','유전판독','진단검사의학과','ACTIVE');

INSERT INTO user_role VALUES
 ('U01','TEC'),('U02','PHY'),('U03','MIC'),
 ('U04','PAT'),('U05','BB'),('U06','GEN');

-- ---------- 환자/내원 ----------
INSERT INTO patient VALUES
 ('1234567','홍길동','M','1980-01-01','ACTIVE'),
 ('2345678','김철수','M','1972-05-03','ACTIVE'),
 ('3456789','이영희','F','1990-11-20','ACTIVE'),
 ('4567890','박지은','F','1979-07-15','ACTIVE'),
 ('5678901','정민호','M','1965-03-09','ACTIVE');

INSERT INTO visit VALUES
 ('V001','1234567','O','내과',NULL,'D001'),
 ('V002','2345678','E','응급실',NULL,'D001'),
 ('V003','3456789','O','내과',NULL,'D001'),
 ('V004','4567890','O','유방외과',NULL,'D002'),
 ('V005','5678901','I','외과','5W','D001');

-- ---------- 오더/항목/검체/분주 ----------
-- 홍길동: CBC (Whole blood)
INSERT INTO lab_order VALUES ('O-0001','H..00123','1234567','V001','D001','2026-07-12 09:15','R','COMPLETED');
INSERT INTO order_item VALUES
 ('OI-0001','O-0001','CBC-HGB','COMPLETED',0),
 ('OI-0002','O-0001','CBC-WBC','COMPLETED',0),
 ('OI-0003','O-0001','CBC-PLT','COMPLETED',0);
INSERT INTO specimen VALUES ('S-0088','O-0001','EDTA','Whole blood','2026-07-12 09:10','2026-07-12 09:15','COMPLETED');

-- 김철수(응급): 임상화학 (Serum) + 분주
INSERT INTO lab_order VALUES ('O-0002','H..00201','2345678','V002','D001','2026-07-12 09:20','S','COMPLETED');
INSERT INTO order_item VALUES
 ('OI-0004','O-0002','CHE-GLU','COMPLETED',0),
 ('OI-0005','O-0002','CHE-K','COMPLETED',0),
 ('OI-0006','O-0002','CHE-NA','COMPLETED',0);
INSERT INTO specimen VALUES ('S-0090','O-0002','SST','Serum','2026-07-12 09:18','2026-07-12 09:22','COMPLETED');
INSERT INTO aliquot VALUES ('S-0090-1','S-0090','SST','화학1호기');

-- 김철수: 객담 배양 오더
INSERT INTO lab_order VALUES ('O-0003','H..00202','2345678','V002','D001','2026-07-12 09:25','R','IN_PROCESS');
INSERT INTO order_item VALUES ('OI-0007','O-0003','MIC-CUL','IN_PROCESS',0);
INSERT INTO specimen VALUES ('S-0201','O-0003','SPUTUM','객담','2026-07-12 09:24','2026-07-12 09:30','IN_PROCESS');

-- 홍길동: 위 조직검사 병리 오더
INSERT INTO lab_order VALUES ('O-0004','H..00301','1234567','V001','D001','2026-07-11 14:00','R','IN_PROCESS');
INSERT INTO order_item VALUES ('OI-0008','O-0004','PAT-SURG','IN_PROCESS',0);
INSERT INTO specimen VALUES ('S-0456','O-0004','TISSUE','위 조직','2026-07-11 13:40','2026-07-11 14:00','IN_PROCESS');

-- 박지은: 유전체(유전성유방암) 오더 - 수탁
INSERT INTO lab_order VALUES ('O-0005','H..00401','4567890','V004','D002','2026-07-15 10:00','R','IN_PROCESS');
INSERT INTO order_item VALUES ('OI-0009','O-0005','GEN-HRD','IN_PROCESS',1);
INSERT INTO specimen VALUES ('S-0501','O-0005','EDTA','Blood','2026-07-15 09:50','2026-07-15 10:00','IN_PROCESS');

-- ---------- 결과 (진단검사) ----------
INSERT INTO result VALUES
 ('R-0001','S-0088','CBC-HGB','6.5','g/dL','LL','F',1,'U02','2026-07-12 10:30'),   -- 위험치
 ('R-0002','S-0088','CBC-WBC','8.2','10*3/uL','N','F',1,'U01','2026-07-12 10:30'),
 ('R-0003','S-0088','CBC-PLT','210','10*3/uL','N','F',1,'U01','2026-07-12 10:30'),
 ('R-0004','S-0090','CHE-GLU','98','mg/dL','N','F',1,'U01','2026-07-12 10:45'),
 ('R-0005','S-0090','CHE-K','6.8','mmol/L','HH','F',1,'U02','2026-07-12 10:45'),   -- 위험치
 ('R-0006','S-0090','CHE-NA','140','mmol/L','N','F',1,'U01','2026-07-12 10:45');

-- ---------- 위험치 통보(폐루프) ----------
INSERT INTO critical_notify VALUES
 ('CN-01','R-0001','내과 김의사','유선','2026-07-12 10:40','2026-07-12 10:42','D001'),
 ('CN-02','R-0005','내과 김의사','유선',NULL,NULL,NULL);   -- 미확인(통보 대기)

-- ---------- 정도관리(QC) ----------
INSERT INTO qc_material VALUES ('QC-CH1','화학 QC Level1','LOT-A1','2026-12-31');
INSERT INTO qc_result VALUES
 ('QCR-01','QC-CH1','화학2호기','CHE-GLU',101.0,'2026-07-12 08:00','WARN'),  -- Westgard 1-3s
 ('QCR-02','QC-CH1','화학1호기','CHE-K',4.2,'2026-07-12 08:00','PASS');

-- ---------- 미생물 ----------
INSERT INTO culture VALUES ('CUL-01','S-0201','혈액한천','동정','IN_PROCESS');
INSERT INTO isolate VALUES ('ISO-01','CUL-01','Klebsiella pneumoniae','56415008');
INSERT INTO susceptibility VALUES
 ('SUS-01','ISO-01','Ampicillin','>32','R'),
 ('SUS-02','ISO-01','Ceftriaxone','2','S'),
 ('SUS-03','ISO-01','Meropenem','0.5','S');

-- ---------- 병리 ----------
INSERT INTO pathology_case VALUES ('SP-2026-0456','1234567','위 (내시경 생검)','2026-07-11','판독대기');
INSERT INTO pathology_report VALUES
 ('SP-2026-0456','위 점막의 만성 염증, 장상피화생 동반. 이형성/악성 소견 없음.',
  '만성 위염','233604007','예비','D010',NULL,'ACC-2026-0456');

-- ---------- 수혈 ----------
INSERT INTO blood_unit VALUES
 ('W1234567890123','RBC','A+','2026-07-01','2026-08-05','IN_STOCK'),
 ('W1234567890124','RBC','A+','2026-07-03','2026-08-07','IN_STOCK');
INSERT INTO crossmatch VALUES
 ('XM-01','5678901','W1234567890123','생리식염수법','적합','U05'),
 ('XM-02','5678901','W1234567890124','생리식염수법','적합','U05');
INSERT INTO blood_issue VALUES
 ('ISS-01','W1234567890123','5678901','U05','5W 간호사','U05','확인간호사','2026-07-12 11:00');

-- ---------- 유전체 (동의 → 수탁 → 변이 → 해석) ----------
INSERT INTO genomic_order VALUES
 ('G-0045','O-0005','GEN-HRD','생식세포','○○유전체수탁','2주','해석중');
INSERT INTO consent VALUES
 ('CONS-01','G-0045','생식세포검사',0,'2026-07-15',0);   -- 부수적소견 미동의, 동의완료
INSERT INTO variant VALUES
 ('VAR-01','G-0045','BRCA1','c.68_69delAG','p.Glu23fs',45.0,'Heterozygous'),
 ('VAR-02','G-0045','BRCA2','c.1234A>G','p.Ile412Val',48.0,'Heterozygous');
INSERT INTO interpretation VALUES
 ('INT-01','VAR-01','Pathogenic','PVS1,PM2','U06','2026-07-20','확정'),
 ('INT-02','VAR-02','VUS','PP3','U06','2026-07-20','검토중');

-- ---------- 시스템 알림 ----------
INSERT INTO notification VALUES
 ('N-01','QC위반','화학2호기','Glucose Westgard 1-3s 위반','2026-07-12 08:05',NULL),
 ('N-02','내성균알림','감염관리팀','Klebsiella pneumoniae 검출(S-0201)','2026-07-12 09:35',NULL);
