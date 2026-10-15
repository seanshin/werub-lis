-- 전환 실행 이력 — 비가역 작업을 실행 단위로 전/후 스냅샷과 함께 남긴다.
-- 감사 체인에도 남지만 거기는 전 조치가 섞인 append-only 로그라 "무엇이 지워졌나"를 되짚기 어렵다.
-- 차단된 시도(BLOCKED)도 기록한다 — 실 데이터가 있는데 정리를 시도했다는 사실 자체가 신호다.
-- 근거: docs/개시전환센터_기획서.md §3.4

CREATE TABLE "cutover_run" (
  "run_id"       TEXT NOT NULL,
  "step"         TEXT NOT NULL,
  "mode"         TEXT NOT NULL,
  "result"       TEXT NOT NULL,
  "requested_by" TEXT,
  "approved_by"  TEXT,
  "before_json"  TEXT,
  "after_json"   TEXT,
  "message"      TEXT,
  "started_dt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_dt"  TIMESTAMP(3),
  CONSTRAINT "cutover_run_pkey" PRIMARY KEY ("run_id")
);

CREATE INDEX "cutover_run_step_idx" ON "cutover_run"("step");
CREATE INDEX "cutover_run_started_dt_idx" ON "cutover_run"("started_dt");
