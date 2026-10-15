-- D5 종양 NGS Run/QC + 체세포 소견 파운데이션. 신규 테이블.
CREATE TABLE "ngs_run" (
  "run_id" TEXT NOT NULL,
  "run_name" TEXT NOT NULL,
  "flowcell" TEXT,
  "status" TEXT NOT NULL DEFAULT 'RUNNING',
  "q30" DOUBLE PRECISION,
  "total_reads" DOUBLE PRECISION,
  "mean_coverage" DOUBLE PRECISION,
  "uniformity_pct" DOUBLE PRECISION,
  "started_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_dt" TIMESTAMP(3),
  "note" TEXT,
  CONSTRAINT "ngs_run_pkey" PRIMARY KEY ("run_id")
);

CREATE TABLE "somatic_finding" (
  "finding_id" TEXT NOT NULL,
  "run_id" TEXT,
  "genomic_order_id" TEXT,
  "category" TEXT NOT NULL,
  "gene" TEXT,
  "alteration" TEXT,
  "vaf" DOUBLE PRECISION,
  "tier" TEXT,
  "therapy" TEXT,
  "note" TEXT,
  "reported_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "somatic_finding_pkey" PRIMARY KEY ("finding_id")
);
CREATE INDEX "somatic_finding_run_id_idx" ON "somatic_finding"("run_id");
CREATE INDEX "somatic_finding_genomic_order_id_idx" ON "somatic_finding"("genomic_order_id");
