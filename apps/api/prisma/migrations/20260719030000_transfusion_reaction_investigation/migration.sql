-- A5 수혈 반응 조사 워크업 필드. 추가 컬럼(nullable), 기존 행 영향 0.
ALTER TABLE "transfusion_reaction" ADD COLUMN "investigation_status" TEXT DEFAULT 'OPEN';
ALTER TABLE "transfusion_reaction" ADD COLUMN "clerical_check_ok" BOOLEAN;
ALTER TABLE "transfusion_reaction" ADD COLUMN "post_dat" TEXT;
ALTER TABLE "transfusion_reaction" ADD COLUMN "post_abo_recheck" TEXT;
ALTER TABLE "transfusion_reaction" ADD COLUMN "hemolysis_visual" TEXT;
ALTER TABLE "transfusion_reaction" ADD COLUMN "lab_findings" TEXT;
ALTER TABLE "transfusion_reaction" ADD COLUMN "culprit_unit_no" TEXT;
ALTER TABLE "transfusion_reaction" ADD COLUMN "final_classification" TEXT;
ALTER TABLE "transfusion_reaction" ADD COLUMN "conclusion" TEXT;
ALTER TABLE "transfusion_reaction" ADD COLUMN "investigated_by" TEXT;
ALTER TABLE "transfusion_reaction" ADD COLUMN "investigated_dt" TIMESTAMP(3);
