-- 조직 결재 기입자(recordedBy) — LIS에서 이 결재를 기입한 인증 계정.
--   서버가 JWT에서 결속(클라이언트 위조 불가). 데모/실 결재 판정·비신뢰(non-repudiation) 감사 정본.
ALTER TABLE "org_approval" ADD COLUMN "recorded_by" TEXT;
