-- T1 수혈 동의 attestation — 출고 담당자가 HIS 동의서 확인했음을 기록(동의 정본은 HIS/EMR).
ALTER TABLE "blood_issue" ADD COLUMN "consent_attested_by" TEXT;

-- T2 명시적 혈액 폐기(만료·손상·오염 등) — 폐기 사유·담당·시각 추적.
ALTER TABLE "blood_unit" ADD COLUMN "discard_reason" TEXT;
ALTER TABLE "blood_unit" ADD COLUMN "discarded_by" TEXT;
ALTER TABLE "blood_unit" ADD COLUMN "discarded_dt" TIMESTAMP(3);
