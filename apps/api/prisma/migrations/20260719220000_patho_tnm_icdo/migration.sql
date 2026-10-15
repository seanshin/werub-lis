-- PP7 구조화 병기(AJCC TNM)·종양분류(ICD-O-3) — PathologyReport에 nullable 컬럼 추가.
ALTER TABLE "pathology_report" ADD COLUMN "p_t" TEXT;
ALTER TABLE "pathology_report" ADD COLUMN "p_n" TEXT;
ALTER TABLE "pathology_report" ADD COLUMN "p_m" TEXT;
ALTER TABLE "pathology_report" ADD COLUMN "stage_group" TEXT;
ALTER TABLE "pathology_report" ADD COLUMN "icdo_topo" TEXT;
ALTER TABLE "pathology_report" ADD COLUMN "icdo_morph" TEXT;
