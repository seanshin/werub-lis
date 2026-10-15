-- PP1 병리 다부위 검체 + 케이스 임상정보·의뢰의·caseType. 추가 컬럼·신규 테이블.
ALTER TABLE "pathology_case" ADD COLUMN "case_type" TEXT NOT NULL DEFAULT 'SURGICAL';
ALTER TABLE "pathology_case" ADD COLUMN "clinical_info" TEXT;
ALTER TABLE "pathology_case" ADD COLUMN "requesting_provider" TEXT;

CREATE TABLE "pathology_specimen" (
  "specimen_id" TEXT NOT NULL,
  "sp_no" TEXT NOT NULL,
  "part_label" TEXT NOT NULL,
  "specimen_type" TEXT,
  "site" TEXT,
  "description" TEXT,
  "created_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pathology_specimen_pkey" PRIMARY KEY ("specimen_id")
);
CREATE UNIQUE INDEX "pathology_specimen_sp_no_part_label_key" ON "pathology_specimen"("sp_no", "part_label");
CREATE INDEX "pathology_specimen_sp_no_idx" ON "pathology_specimen"("sp_no");
