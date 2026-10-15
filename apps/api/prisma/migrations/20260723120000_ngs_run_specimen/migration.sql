-- NGS 런에 검체 연결 — 런에 올린 검체가 없으면 소견을 환자에 연결할 수 없다(누구의 런인지 불명).
-- 다검체 런(pooling)이 일반적이라 목록(쉼표구분) + 대표 검체를 함께 둔다. additive nullable.
ALTER TABLE "ngs_run" ADD COLUMN "specimen_nos" TEXT;
ALTER TABLE "ngs_run" ADD COLUMN "primary_specimen_no" TEXT;
ALTER TABLE "ngs_run" ADD COLUMN "panel_code" TEXT;
