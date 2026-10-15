-- 다운타임 오더 식별·대사(P1-4). 기존 행은 전부 HIS 기원으로 간주.
ALTER TABLE "lab_order" ADD COLUMN "order_source" TEXT NOT NULL DEFAULT 'HIS';
ALTER TABLE "lab_order" ADD COLUMN "downtime_reason" TEXT;
ALTER TABLE "lab_order" ADD COLUMN "reconciled_dt" TIMESTAMP(3);
