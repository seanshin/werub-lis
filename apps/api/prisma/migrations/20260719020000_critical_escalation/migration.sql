-- A4 위험치 에스컬레이션 사다리 + read-back 문서화. 추가 컬럼, 기존 행은 created_dt=now() 소급.
ALTER TABLE "critical_notify" ADD COLUMN "created_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "critical_notify" ADD COLUMN "escalation_level" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "critical_notify" ADD COLUMN "escalated_dt" TIMESTAMP(3);
ALTER TABLE "critical_notify" ADD COLUMN "readback_by" TEXT;
ALTER TABLE "critical_notify" ADD COLUMN "readback_note" TEXT;
