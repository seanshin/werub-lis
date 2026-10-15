-- B6 MIC→S/I/R 판정기준·검사법 + 병리 CAP synoptic 프로토콜. 추가 컬럼, 기존 행 영향 0.
ALTER TABLE "susceptibility" ADD COLUMN "method" TEXT;
ALTER TABLE "susceptibility" ADD COLUMN "standard" TEXT;
ALTER TABLE "pathology_report" ADD COLUMN "synoptic_protocol" TEXT;
