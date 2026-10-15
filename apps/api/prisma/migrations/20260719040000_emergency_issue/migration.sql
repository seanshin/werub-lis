-- B1 응급(MTP) 출고 — 프로세스 게이트 사후처리 필드. 추가 컬럼, 기존 행 영향 0.
ALTER TABLE "blood_issue" ADD COLUMN "emergency" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "blood_issue" ADD COLUMN "emergency_reason" TEXT;
ALTER TABLE "blood_issue" ADD COLUMN "bypassed_checks" TEXT;
ALTER TABLE "blood_issue" ADD COLUMN "retro_crossmatch_status" TEXT;
