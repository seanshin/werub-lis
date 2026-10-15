-- PP3 세포병리(Cytology) 보고. 신규 테이블(케이스당 1:1).
CREATE TABLE "cytology_report" (
  "cyto_id" TEXT NOT NULL,
  "sp_no" TEXT NOT NULL,
  "specimen_type" TEXT NOT NULL,
  "adequacy" TEXT,
  "adequacy_note" TEXT,
  "category" TEXT,
  "diagnosis" TEXT,
  "signer" TEXT,
  "signed_dt" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT '최종',
  "reported_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cytology_report_pkey" PRIMARY KEY ("cyto_id")
);
CREATE UNIQUE INDEX "cytology_report_sp_no_key" ON "cytology_report"("sp_no");
