-- B4 병리 2단계 사인아웃·동결절편·addendum. PathologyReport 컬럼 추가 + PathologyAddendum 신규.
ALTER TABLE "pathology_report" ADD COLUMN "draft_by" TEXT;
ALTER TABLE "pathology_report" ADD COLUMN "draft_dt" TIMESTAMP(3);
ALTER TABLE "pathology_report" ADD COLUMN "frozen_dx" TEXT;
ALTER TABLE "pathology_report" ADD COLUMN "frozen_by" TEXT;
ALTER TABLE "pathology_report" ADD COLUMN "frozen_dt" TIMESTAMP(3);
ALTER TABLE "pathology_report" ADD COLUMN "frozen_concordance" TEXT;

CREATE TABLE "pathology_addendum" (
  "addendum_id" TEXT NOT NULL,
  "sp_no" TEXT NOT NULL,
  "seq" INTEGER NOT NULL,
  "content" TEXT NOT NULL,
  "added_by" TEXT,
  "added_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pathology_addendum_pkey" PRIMARY KEY ("addendum_id")
);
CREATE INDEX "pathology_addendum_sp_no_idx" ON "pathology_addendum"("sp_no");
