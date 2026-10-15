-- 연동 상태(커서·워터마크) KV — 증분 폴링 _lastUpdated 워터마크. 신규 테이블(additive).
CREATE TABLE "integration_state" (
  "key"        TEXT NOT NULL,
  "value"      TEXT,
  "updated_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "integration_state_pkey" PRIMARY KEY ("key")
);
