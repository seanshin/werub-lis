-- PP2 IHC/특수염색 결과 점수화. 신규 테이블.
CREATE TABLE "ihc_result" (
  "ihc_id" TEXT NOT NULL,
  "sp_no" TEXT NOT NULL,
  "slide_id" TEXT,
  "marker" TEXT NOT NULL,
  "result" TEXT,
  "intensity" TEXT,
  "percent_pos" DOUBLE PRECISION,
  "score" TEXT,
  "interpretation" TEXT,
  "reported_by" TEXT,
  "reported_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ihc_result_pkey" PRIMARY KEY ("ihc_id")
);
CREATE INDEX "ihc_result_sp_no_idx" ON "ihc_result"("sp_no");
