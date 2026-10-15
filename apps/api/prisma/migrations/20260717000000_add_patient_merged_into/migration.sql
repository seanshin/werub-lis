-- 환자 병합 정본 포인터(구 MRN 조회 리다이렉트·인바운드 재라우팅). nullable additive.
ALTER TABLE "patient" ADD COLUMN "merged_into" TEXT;
