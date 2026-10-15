-- 종양 NGS 소견에 생성 시점 런 QC 경고 스냅샷 — 병리 보고서에 QC-FAIL 런 소견 주의 표기용
ALTER TABLE "somatic_finding" ADD COLUMN "run_qc_flag" TEXT;
