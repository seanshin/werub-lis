-- 개시 근거 문서함 — 결재 공문·회신서·서명본 원본 보관.
-- org_approval.docNo(문자열)만으로는 결재가 실재했는지 소명할 수 없다.
-- 임상 첨부(result_attachment)와 테이블을 분리한다 — 보존정책·권한·수명주기가 다르다.
-- 근거: docs/개시전환센터_기획서.md §3.3

CREATE TABLE "golive_attachment" (
  "attachment_id" TEXT NOT NULL,
  "task_code"     TEXT,
  "gate_code"     TEXT,
  "signoff_sec"   TEXT,
  "decision_key"  TEXT,
  "category"      TEXT NOT NULL,
  "filename"      TEXT NOT NULL,
  "mime_type"     TEXT NOT NULL,
  "size_bytes"    INTEGER NOT NULL,
  "sha256"        TEXT NOT NULL,
  "data"          BYTEA NOT NULL,
  "note"          TEXT,
  "uploaded_by"   TEXT,
  "uploaded_dt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "golive_attachment_pkey" PRIMARY KEY ("attachment_id")
);

CREATE INDEX "golive_attachment_task_code_idx" ON "golive_attachment"("task_code");
CREATE INDEX "golive_attachment_gate_code_idx" ON "golive_attachment"("gate_code");
CREATE INDEX "golive_attachment_category_idx" ON "golive_attachment"("category");
