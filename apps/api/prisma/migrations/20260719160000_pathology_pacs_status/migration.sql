-- PACS 연동 재검토 보완 — 병리 케이스에 MWL 송신 상태·WSI 열람 확인 추적. 추가 컬럼, 기존 행 영향 0.
ALTER TABLE "pathology_case" ADD COLUMN "mwl_status" TEXT;
ALTER TABLE "pathology_case" ADD COLUMN "mwl_sent_dt" TIMESTAMP(3);
ALTER TABLE "pathology_case" ADD COLUMN "wsi_confirmed_dt" TIMESTAMP(3);
ALTER TABLE "pathology_case" ADD COLUMN "wsi_confirmed_by" TEXT;
