-- HIS FHIR Patient uuid 저장(H4) — HIS 동의 참조 EP가 uuid만 수용(MRN은 500, 2026-07-22 실측).
-- 폴링 patientRef에서 채워 MRN→uuid 변환에 사용. additive nullable.
ALTER TABLE "patient" ADD COLUMN "his_patient_uuid" TEXT;
