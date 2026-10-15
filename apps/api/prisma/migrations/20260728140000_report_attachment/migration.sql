-- 법정감염병 신고 첨부 — 보건소 신고 서류 스캔/사진을 InfectiousReport에 첨부(완료 근거).
-- additive/nullable + FK(cascade). 기존 행 무영향.
ALTER TABLE "result_attachment" ADD COLUMN "report_id" TEXT;
CREATE INDEX "result_attachment_report_id_idx" ON "result_attachment"("report_id");
ALTER TABLE "result_attachment" ADD CONSTRAINT "result_attachment_report_id_fkey"
  FOREIGN KEY ("report_id") REFERENCES "infectious_report"("report_id") ON DELETE CASCADE ON UPDATE CASCADE;
