-- 환자별 특수수혈 요구(방사선조사·CMV음성 등) — 출고 게이트 서버측 강제 근거. 신규 테이블(additive).
CREATE TABLE "patient_transfusion_req" (
  "req_id"      TEXT NOT NULL,
  "patient_id"  TEXT NOT NULL,
  "requirement" TEXT NOT NULL,
  "reason"      TEXT,
  "active"      BOOLEAN NOT NULL DEFAULT true,
  "created_by"  TEXT,
  "created_dt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "patient_transfusion_req_pkey" PRIMARY KEY ("req_id")
);
CREATE INDEX "patient_transfusion_req_patient_id_active_idx" ON "patient_transfusion_req" ("patient_id", "active");
