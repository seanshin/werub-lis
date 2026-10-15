-- 분자 assay 카탈로그(패널·타깃·Ct 컷오프) + NGS 패널별 QC 임계
CREATE TABLE "molecular_assay" (
    "panel_code" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "assay_name" TEXT,
    "ct_cutoff" DOUBLE PRECISION,
    "equivocal_from" DOUBLE PRECISION,
    "note" TEXT,
    "updated_by" TEXT,
    "updated_dt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "molecular_assay_pkey" PRIMARY KEY ("panel_code","target")
);
CREATE INDEX "molecular_assay_target_idx" ON "molecular_assay"("target");

CREATE TABLE "ngs_panel" (
    "panel_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT,
    "q30_min" DOUBLE PRECISION,
    "mean_coverage_min" DOUBLE PRECISION,
    "uniformity_min" DOUBLE PRECISION,
    "note" TEXT,
    "updated_by" TEXT,
    "updated_dt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ngs_panel_pkey" PRIMARY KEY ("panel_code")
);
