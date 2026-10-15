-- 법정감염병 신고번호(보건소 접수번호) 전용 필드 — 기존엔 비고에 섞여 있었다. additive/nullable.
ALTER TABLE "infectious_report" ADD COLUMN "report_no" TEXT;
