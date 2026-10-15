-- 개시 승인(Go-Live) — 조직 최종 GO/NO-GO 결정 이력
CREATE TABLE "golive_approval" (
    "approval_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "approved_by_name" TEXT,
    "approved_by" TEXT,
    "approved_date" TEXT,
    "override" BOOLEAN NOT NULL DEFAULT false,
    "residual_risk" TEXT,
    "blocking_snapshot" TEXT,
    "note" TEXT,
    "created_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "golive_approval_pkey" PRIMARY KEY ("approval_id")
);
CREATE INDEX "golive_approval_created_dt_idx" ON "golive_approval"("created_dt");
