-- 시드 산출물 등록부 — "이 행은 시드가 만든 것"을 기록해 선택 삭제를 가능하게 한다.
-- 현행 pilot-cleanup.sql은 테이블 전량 DELETE라 실 데이터가 섞이면 구분할 수 없다.
-- 근거: docs/개시전환센터_기획서.md §3.5

CREATE TABLE "seed_artifact" (
  "artifact_id" TEXT NOT NULL,
  "batch"       TEXT NOT NULL,
  "entity"      TEXT NOT NULL,
  "pk"          TEXT NOT NULL,
  "created_dt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "seed_artifact_pkey" PRIMARY KEY ("artifact_id")
);

-- 같은 행을 같은 배치로 두 번 등록하지 않는다(시드는 멱등 실행이 정상).
CREATE UNIQUE INDEX "seed_artifact_entity_pk_batch_key" ON "seed_artifact"("entity", "pk", "batch");
CREATE INDEX "seed_artifact_batch_idx" ON "seed_artifact"("batch");
CREATE INDEX "seed_artifact_entity_idx" ON "seed_artifact"("entity");
