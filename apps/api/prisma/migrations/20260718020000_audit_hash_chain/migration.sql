-- 감사 tamper-evident 해시체인(개시 전 백로그: 감사 무결성). 추가 컬럼(nullable) — 기존 행 영향 0.
-- 신규 감사 레코드부터 seq(단조)·prevHash·hash 채워 체인 형성. NULL seq(레거시/파일럿)는 verify 대상 외.
-- Postgres UNIQUE 인덱스는 다중 NULL 허용 → 기존 행과 충돌 없음.

ALTER TABLE "audit_log" ADD COLUMN "seq" INTEGER;
ALTER TABLE "audit_log" ADD COLUMN "prev_hash" TEXT;
ALTER TABLE "audit_log" ADD COLUMN "hash" TEXT;

CREATE UNIQUE INDEX "audit_log_seq_key" ON "audit_log"("seq");
