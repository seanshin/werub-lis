-- Reflex 프로토콜 계보(개정) — 선행 프로토콜 포인터. 활성화 시 선행을 SUPERSEDED로 접는다.
-- additive/nullable — 기존 데이터 무영향(값 있는 컬럼 아님).
ALTER TABLE "reflex_protocol" ADD COLUMN "supersedes_protocol_id" TEXT;
