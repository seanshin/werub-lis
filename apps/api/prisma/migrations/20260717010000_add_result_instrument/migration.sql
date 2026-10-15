-- 결과 산출 장비(QC 차단 장비 귀속). nullable additive(수기 입력은 null).
ALTER TABLE "result" ADD COLUMN "instrument" TEXT;
