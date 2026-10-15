-- M1 미생물 검체 부적합·반려(오염·부적절 채취·이송지연 등) — 접수 반려 사유 추적.
ALTER TABLE "culture" ADD COLUMN "reject_status" TEXT;
ALTER TABLE "culture" ADD COLUMN "reject_reason" TEXT;
ALTER TABLE "culture" ADD COLUMN "rejected_by" TEXT;
ALTER TABLE "culture" ADD COLUMN "rejected_dt" TIMESTAMP(3);
