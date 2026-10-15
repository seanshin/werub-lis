-- B2 혈액 추적성·회수(hemovigilance) — 헌혈번호 그룹·회수/격리 상태. 추가 컬럼, 기존 행 영향 0.
ALTER TABLE "blood_unit" ADD COLUMN "donation_id" TEXT;
ALTER TABLE "blood_unit" ADD COLUMN "recall_status" TEXT;
ALTER TABLE "blood_unit" ADD COLUMN "recall_reason" TEXT;
ALTER TABLE "blood_unit" ADD COLUMN "recalled_dt" TIMESTAMP(3);
CREATE INDEX "blood_unit_donation_id_idx" ON "blood_unit"("donation_id");
