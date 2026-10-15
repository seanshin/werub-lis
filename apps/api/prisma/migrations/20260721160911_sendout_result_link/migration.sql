-- 외부위탁 회신 → 환자 결과 연결(P1-2). 기존 행은 NULL(미연계 회신으로 남는다).
ALTER TABLE "sendout" ADD COLUMN "result_id" TEXT;
