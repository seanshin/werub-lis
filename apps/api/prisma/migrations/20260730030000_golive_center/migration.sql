-- 개시 전환 센터 — 사이트 프로파일 + 체크리스트 진행 상태.
-- 항목 '정의'는 코드 레지스트리(golive-registry.ts)에 두고 여기에는 상태만 둔다
-- (정의를 DB에 두면 업그레이드 때 두 벌이 어긋난다).
-- 근거: docs/개시전환센터_기획서.md §3.2·§6.2a

CREATE TABLE "site_profile" (
  "id"           INTEGER NOT NULL DEFAULT 1,
  "site_code"    TEXT NOT NULL,
  "site_name"    TEXT,
  "capabilities" TEXT NOT NULL,
  "installed_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_dt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "site_profile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "golive_task_record" (
  "code"         TEXT NOT NULL,
  "status"       TEXT NOT NULL DEFAULT 'OPEN',
  "owner"        TEXT,
  "note"         TEXT,
  "na_reason"    TEXT,
  "completed_by" TEXT,
  "completed_dt" TIMESTAMP(3),
  "updated_dt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "golive_task_record_pkey" PRIMARY KEY ("code")
);

CREATE INDEX "golive_task_record_status_idx" ON "golive_task_record"("status");
