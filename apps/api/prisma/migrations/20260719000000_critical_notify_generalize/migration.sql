-- 위험치 통보 폐루프를 소스 무관하게 일반화(A1) — 미생물 혈액배양 양성 등 비-Result 위험치 지원.
-- result_id를 nullable로, 비정규화 표시필드·소스 구분 컬럼 추가. 기존 행 영향 0(기존은 CHEM 경로 유지).

ALTER TABLE "critical_notify" ALTER COLUMN "result_id" DROP NOT NULL;
ALTER TABLE "critical_notify" ADD COLUMN "category" TEXT;
ALTER TABLE "critical_notify" ADD COLUMN "source_ref" TEXT;
ALTER TABLE "critical_notify" ADD COLUMN "specimen_no" TEXT;
ALTER TABLE "critical_notify" ADD COLUMN "patient_id" TEXT;
ALTER TABLE "critical_notify" ADD COLUMN "patient_name" TEXT;
ALTER TABLE "critical_notify" ADD COLUMN "label" TEXT;
ALTER TABLE "critical_notify" ADD COLUMN "value" TEXT;
