-- A3 결과 코멘트/해석 코멘트(CAP 요건) — 검증자 기술 주석·임상 해석문. 추가 컬럼(nullable), 기존 행 영향 0.
ALTER TABLE "result" ADD COLUMN "comment" TEXT;
ALTER TABLE "result" ADD COLUMN "interpretation" TEXT;
