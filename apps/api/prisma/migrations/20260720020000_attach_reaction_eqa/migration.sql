-- 문서 첨부 스코프 확장 — 수혈 이상반응(reaction)·EQA 서베이(외부 성적서). 미생물은 기존 specimenNo 재사용.
ALTER TABLE "result_attachment" ADD COLUMN "reaction_id" TEXT;
ALTER TABLE "result_attachment" ADD COLUMN "eqa_id" TEXT;
CREATE INDEX "result_attachment_reaction_id_idx" ON "result_attachment"("reaction_id");
CREATE INDEX "result_attachment_eqa_id_idx" ON "result_attachment"("eqa_id");
ALTER TABLE "result_attachment" ADD CONSTRAINT "result_attachment_reaction_id_fkey"
  FOREIGN KEY ("reaction_id") REFERENCES "transfusion_reaction"("reaction_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "result_attachment" ADD CONSTRAINT "result_attachment_eqa_id_fkey"
  FOREIGN KEY ("eqa_id") REFERENCES "eqa_survey"("survey_id") ON DELETE CASCADE ON UPDATE CASCADE;
