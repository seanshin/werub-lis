-- HIS 검사코드 카탈로그 미러(H1). CodeMapping(큐레이션 매핑)과 별개의 참조 테이블.
CREATE TABLE "his_lab_code" (
  "code" TEXT NOT NULL,
  "name_ko" TEXT,
  "loinc_code" TEXT,
  "category" TEXT,
  "panel_json" TEXT,
  "his_updated" TIMESTAMP(3),
  "synced_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "his_lab_code_pkey" PRIMARY KEY ("code")
);
CREATE INDEX "his_lab_code_name_ko_idx" ON "his_lab_code"("name_ko");
CREATE INDEX "his_lab_code_his_updated_idx" ON "his_lab_code"("his_updated");
