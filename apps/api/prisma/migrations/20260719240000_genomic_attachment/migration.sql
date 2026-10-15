-- 유전체 오더 첨부 스코프 — 수탁 PDF 결과지 등 문서 로딩(자동 인터페이스 부재 시 문서 경로).
ALTER TABLE "result_attachment" ADD COLUMN "genomic_order_id" TEXT;
CREATE INDEX "result_attachment_genomic_order_id_idx" ON "result_attachment"("genomic_order_id");
ALTER TABLE "result_attachment" ADD CONSTRAINT "result_attachment_genomic_order_id_fkey"
  FOREIGN KEY ("genomic_order_id") REFERENCES "genomic_order"("genomic_order_id") ON DELETE CASCADE ON UPDATE CASCADE;
