-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Domain" AS ENUM ('DIAGNOSTIC', 'MICROBIOLOGY', 'PATHOLOGY', 'TRANSFUSION', 'GENOMIC');

-- CreateEnum
CREATE TYPE "Sex" AS ENUM ('M', 'F', 'O', 'U');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('S', 'R');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('RECEIVED', 'IN_PROCESS', 'COMPLETED', 'REPORTED', 'CANCELLED', 'HOLD');

-- CreateEnum
CREATE TYPE "SpecimenStatus" AS ENUM ('COLLECTED', 'RECEIVED', 'IN_PROCESS', 'COMPLETED', 'REJECTED', 'STORED', 'DISPOSED');

-- CreateEnum
CREATE TYPE "ResultStatus" AS ENUM ('P', 'F', 'C');

-- CreateEnum
CREATE TYPE "ResultFlag" AS ENUM ('N', 'H', 'L', 'HH', 'LL');

-- CreateEnum
CREATE TYPE "VerifyState" AS ENUM ('PENDING', 'AUTO', 'VERIFIED');

-- CreateEnum
CREATE TYPE "GenomicTestType" AS ENUM ('SOMATIC', 'GERMLINE', 'INFECTION', 'PGX');

-- CreateTable
CREATE TABLE "provider" (
    "provider_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dept" TEXT,
    "role_type" TEXT,

    CONSTRAINT "provider_pkey" PRIMARY KEY ("provider_id")
);

-- CreateTable
CREATE TABLE "container" (
    "container_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "additive" TEXT,
    "color" TEXT,

    CONSTRAINT "container_pkey" PRIMARY KEY ("container_code")
);

-- CreateTable
CREATE TABLE "test_master" (
    "test_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "loinc" TEXT,
    "domain" "Domain" NOT NULL,
    "unit_ucum" TEXT,
    "specimen_type" TEXT,
    "status" TEXT NOT NULL DEFAULT 'USE',

    CONSTRAINT "test_master_pkey" PRIMARY KEY ("test_code")
);

-- CreateTable
CREATE TABLE "panel" (
    "panel_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "panel_pkey" PRIMARY KEY ("panel_code")
);

-- CreateTable
CREATE TABLE "panel_item" (
    "panel_code" TEXT NOT NULL,
    "test_code" TEXT NOT NULL,

    CONSTRAINT "panel_item_pkey" PRIMARY KEY ("panel_code","test_code")
);

-- CreateTable
CREATE TABLE "reference_range" (
    "rr_id" TEXT NOT NULL,
    "test_code" TEXT NOT NULL,
    "sex" TEXT NOT NULL DEFAULT 'A',
    "age_min" INTEGER NOT NULL DEFAULT 0,
    "age_max" INTEGER NOT NULL DEFAULT 200,
    "low" DOUBLE PRECISION,
    "high" DOUBLE PRECISION,
    "panic_low" DOUBLE PRECISION,
    "panic_high" DOUBLE PRECISION,

    CONSTRAINT "reference_range_pkey" PRIMARY KEY ("rr_id")
);

-- CreateTable
CREATE TABLE "code_mapping" (
    "lis_code" TEXT NOT NULL,
    "his_code" TEXT,
    "loinc" TEXT,
    "edi_code" TEXT,
    "status" TEXT NOT NULL DEFAULT 'USE',

    CONSTRAINT "code_mapping_pkey" PRIMARY KEY ("lis_code")
);

-- CreateTable
CREATE TABLE "terminology_code" (
    "code_id" TEXT NOT NULL,
    "system" TEXT NOT NULL DEFAULT 'SNOMED',
    "code" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "term_ko" TEXT,
    "category" TEXT,
    "status" TEXT NOT NULL DEFAULT 'USE',
    "created_by" TEXT,
    "created_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "terminology_code_pkey" PRIMARY KEY ("code_id")
);

-- CreateTable
CREATE TABLE "role" (
    "role_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "role_pkey" PRIMARY KEY ("role_code")
);

-- CreateTable
CREATE TABLE "app_user" (
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dept" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "password_hash" TEXT,
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "pwd_updated_dt" TIMESTAMP(3),

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "user_role" (
    "user_id" TEXT NOT NULL,
    "role_code" TEXT NOT NULL,

    CONSTRAINT "user_role_pkey" PRIMARY KEY ("user_id","role_code")
);

-- CreateTable
CREATE TABLE "patient" (
    "patient_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sex" "Sex",
    "birth_date" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "patient_pkey" PRIMARY KEY ("patient_id")
);

-- CreateTable
CREATE TABLE "visit" (
    "visit_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "type" TEXT,
    "dept" TEXT,
    "ward" TEXT,
    "attending" TEXT,

    CONSTRAINT "visit_pkey" PRIMARY KEY ("visit_id")
);

-- CreateTable
CREATE TABLE "lab_order" (
    "order_id" TEXT NOT NULL,
    "his_order_no" TEXT,
    "patient_id" TEXT NOT NULL,
    "visit_id" TEXT,
    "ordering_provider" TEXT,
    "order_dt" TIMESTAMP(3),
    "priority" "Priority" NOT NULL DEFAULT 'R',
    "status" "OrderStatus" NOT NULL DEFAULT 'RECEIVED',

    CONSTRAINT "lab_order_pkey" PRIMARY KEY ("order_id")
);

-- CreateTable
CREATE TABLE "order_item" (
    "order_item_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "test_code" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'RECEIVED',
    "sendout_flag" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "order_item_pkey" PRIMARY KEY ("order_item_id")
);

-- CreateTable
CREATE TABLE "specimen" (
    "specimen_no" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "container_code" TEXT,
    "specimen_type" TEXT,
    "collected_dt" TIMESTAMP(3),
    "collected_by" TEXT,
    "received_dt" TIMESTAMP(3),
    "reject_reason" TEXT,
    "rejected_dt" TIMESTAMP(3),
    "status" "SpecimenStatus" NOT NULL DEFAULT 'RECEIVED',

    CONSTRAINT "specimen_pkey" PRIMARY KEY ("specimen_no")
);

-- CreateTable
CREATE TABLE "result_attachment" (
    "attachment_id" TEXT NOT NULL,
    "specimen_no" TEXT,
    "sp_no" TEXT,
    "filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "note" TEXT,
    "uploaded_by" TEXT,
    "uploaded_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "result_attachment_pkey" PRIMARY KEY ("attachment_id")
);

-- CreateTable
CREATE TABLE "aliquot" (
    "aliquot_no" TEXT NOT NULL,
    "specimen_no" TEXT NOT NULL,
    "container_code" TEXT,
    "target_instrument" TEXT,

    CONSTRAINT "aliquot_pkey" PRIMARY KEY ("aliquot_no")
);

-- CreateTable
CREATE TABLE "result" (
    "result_id" TEXT NOT NULL,
    "specimen_no" TEXT NOT NULL,
    "test_code" TEXT NOT NULL,
    "value" TEXT,
    "unit" TEXT,
    "flag" "ResultFlag",
    "status" "ResultStatus" NOT NULL DEFAULT 'F',
    "verify_state" "VerifyState" NOT NULL DEFAULT 'PENDING',
    "hold_reason" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "entered_by" TEXT,
    "source_doc_ref" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "verifier" TEXT,
    "reported_dt" TIMESTAMP(3),
    "correction_reason" TEXT,
    "corrected_by" TEXT,
    "supersedes_id" TEXT,

    CONSTRAINT "result_pkey" PRIMARY KEY ("result_id")
);

-- CreateTable
CREATE TABLE "critical_notify" (
    "notify_id" TEXT NOT NULL,
    "result_id" TEXT NOT NULL,
    "notify_target" TEXT,
    "notify_method" TEXT,
    "notified_dt" TIMESTAMP(3),
    "dispatch_status" TEXT,
    "ack_dt" TIMESTAMP(3),
    "ack_by" TEXT,

    CONSTRAINT "critical_notify_pkey" PRIMARY KEY ("notify_id")
);

-- CreateTable
CREATE TABLE "qc_material" (
    "qc_code" TEXT NOT NULL,
    "name" TEXT,
    "lot" TEXT,
    "expiry" TEXT,

    CONSTRAINT "qc_material_pkey" PRIMARY KEY ("qc_code")
);

-- CreateTable
CREATE TABLE "qc_target" (
    "qc_target_id" TEXT NOT NULL,
    "qc_code" TEXT NOT NULL,
    "instrument" TEXT NOT NULL,
    "test_code" TEXT NOT NULL,
    "mean" DOUBLE PRECISION NOT NULL,
    "sd" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "qc_target_pkey" PRIMARY KEY ("qc_target_id")
);

-- CreateTable
CREATE TABLE "qc_result" (
    "qc_result_id" TEXT NOT NULL,
    "qc_code" TEXT NOT NULL,
    "instrument" TEXT,
    "test_code" TEXT NOT NULL,
    "measured_value" DOUBLE PRECISION,
    "measured_dt" TIMESTAMP(3),
    "verdict" TEXT,

    CONSTRAINT "qc_result_pkey" PRIMARY KEY ("qc_result_id")
);

-- CreateTable
CREATE TABLE "culture" (
    "culture_id" TEXT NOT NULL,
    "specimen_no" TEXT NOT NULL,
    "medium" TEXT,
    "stage" TEXT,
    "status" TEXT,
    "gram_stain" TEXT,
    "gram_dt" TIMESTAMP(3),
    "report_status" TEXT,

    CONSTRAINT "culture_pkey" PRIMARY KEY ("culture_id")
);

-- CreateTable
CREATE TABLE "culture_report" (
    "report_id" TEXT NOT NULL,
    "culture_id" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "reporter" TEXT,
    "reported_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "culture_report_pkey" PRIMARY KEY ("report_id")
);

-- CreateTable
CREATE TABLE "isolate" (
    "isolate_id" TEXT NOT NULL,
    "culture_id" TEXT NOT NULL,
    "organism" TEXT,
    "snomed" TEXT,

    CONSTRAINT "isolate_pkey" PRIMARY KEY ("isolate_id")
);

-- CreateTable
CREATE TABLE "susceptibility" (
    "sus_id" TEXT NOT NULL,
    "isolate_id" TEXT NOT NULL,
    "antibiotic" TEXT,
    "mic" TEXT,
    "interpretation" TEXT,

    CONSTRAINT "susceptibility_pkey" PRIMARY KEY ("sus_id")
);

-- CreateTable
CREATE TABLE "pathology_case" (
    "sp_no" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "his_order_no" TEXT,
    "procedure_code" TEXT,
    "specimen_site" TEXT,
    "received_date" TEXT,
    "status" TEXT,
    "gross_desc" TEXT,
    "grossed_by" TEXT,
    "grossed_dt" TIMESTAMP(3),

    CONSTRAINT "pathology_case_pkey" PRIMARY KEY ("sp_no")
);

-- CreateTable
CREATE TABLE "pathology_block" (
    "block_id" TEXT NOT NULL,
    "sp_no" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "tissue" TEXT,
    "created_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pathology_block_pkey" PRIMARY KEY ("block_id")
);

-- CreateTable
CREATE TABLE "pathology_slide" (
    "slide_id" TEXT NOT NULL,
    "sp_no" TEXT NOT NULL,
    "block_id" TEXT NOT NULL,
    "stain" TEXT NOT NULL,
    "stain_detail" TEXT,
    "created_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pathology_slide_pkey" PRIMARY KEY ("slide_id")
);

-- CreateTable
CREATE TABLE "pathology_report" (
    "sp_no" TEXT NOT NULL,
    "findings" TEXT,
    "diagnosis" TEXT,
    "snomed" TEXT,
    "status" TEXT,
    "signer" TEXT,
    "signed_dt" TIMESTAMP(3),
    "accession_no" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "amend_reason" TEXT,

    CONSTRAINT "pathology_report_pkey" PRIMARY KEY ("sp_no")
);

-- CreateTable
CREATE TABLE "blood_unit" (
    "unit_no" TEXT NOT NULL,
    "product_type" TEXT,
    "blood_group" TEXT,
    "drawn_date" TEXT,
    "expiry_date" TEXT,
    "status" TEXT NOT NULL DEFAULT 'IN_STOCK',
    "irradiated" BOOLEAN NOT NULL DEFAULT false,
    "cmv_neg" BOOLEAN NOT NULL DEFAULT false,
    "leukoreduced" BOOLEAN NOT NULL DEFAULT false,
    "washed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "blood_unit_pkey" PRIMARY KEY ("unit_no")
);

-- CreateTable
CREATE TABLE "blood_typing" (
    "typing_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "abo" TEXT NOT NULL,
    "rh_d" TEXT NOT NULL,
    "antibody_screen" TEXT NOT NULL,
    "antibody_id" TEXT,
    "tester" TEXT,
    "tested_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blood_typing_pkey" PRIMARY KEY ("typing_id")
);

-- CreateTable
CREATE TABLE "transfusion_act" (
    "act_id" TEXT NOT NULL,
    "issue_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "start_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "end_dt" TIMESTAMP(3),
    "administered_by" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ONGOING',
    "note" TEXT,

    CONSTRAINT "transfusion_act_pkey" PRIMARY KEY ("act_id")
);

-- CreateTable
CREATE TABLE "transfusion_reaction" (
    "reaction_id" TEXT NOT NULL,
    "issue_id" TEXT,
    "patient_id" TEXT NOT NULL,
    "reaction_type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "symptoms" TEXT,
    "action" TEXT,
    "reported_by" TEXT,
    "reported_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transfusion_reaction_pkey" PRIMARY KEY ("reaction_id")
);

-- CreateTable
CREATE TABLE "crossmatch" (
    "xm_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "unit_no" TEXT NOT NULL,
    "method" TEXT,
    "result" TEXT,
    "tester" TEXT,
    "tested_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crossmatch_pkey" PRIMARY KEY ("xm_id")
);

-- CreateTable
CREATE TABLE "blood_issue" (
    "issue_id" TEXT NOT NULL,
    "unit_no" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "issuer" TEXT,
    "receiver" TEXT,
    "confirm1" TEXT,
    "confirm2" TEXT,
    "issued_dt" TIMESTAMP(3),

    CONSTRAINT "blood_issue_pkey" PRIMARY KEY ("issue_id")
);

-- CreateTable
CREATE TABLE "genomic_order" (
    "genomic_order_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "panel_code" TEXT,
    "test_type" "GenomicTestType" NOT NULL,
    "sendout_center" TEXT,
    "tat_target" TEXT,
    "status" TEXT,

    CONSTRAINT "genomic_order_pkey" PRIMARY KEY ("genomic_order_id")
);

-- CreateTable
CREATE TABLE "consent" (
    "consent_id" TEXT NOT NULL,
    "genomic_order_id" TEXT NOT NULL,
    "consent_type" TEXT,
    "secondary_findings_optin" BOOLEAN NOT NULL DEFAULT false,
    "signed_date" TEXT,
    "withdrawn" BOOLEAN NOT NULL DEFAULT false,
    "withdrawn_date" TEXT,
    "withdrawn_reason" TEXT,
    "withdrawn_by" TEXT,

    CONSTRAINT "consent_pkey" PRIMARY KEY ("consent_id")
);

-- CreateTable
CREATE TABLE "variant" (
    "variant_id" TEXT NOT NULL,
    "genomic_order_id" TEXT NOT NULL,
    "chrom" TEXT,
    "pos" INTEGER,
    "ref_allele" TEXT,
    "alt_allele" TEXT,
    "gene" TEXT,
    "hgvs_c" TEXT,
    "hgvs_p" TEXT,
    "vaf" DOUBLE PRECISION,
    "zygosity" TEXT,

    CONSTRAINT "variant_pkey" PRIMARY KEY ("variant_id")
);

-- CreateTable
CREATE TABLE "interpretation" (
    "interp_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "classification" TEXT,
    "evidence" TEXT,
    "classifier" TEXT,
    "classified_date" TEXT,
    "status" TEXT,
    "reason" TEXT,

    CONSTRAINT "interpretation_pkey" PRIMARY KEY ("interp_id")
);

-- CreateTable
CREATE TABLE "instrument_mapping" (
    "id" TEXT NOT NULL,
    "instrument" TEXT NOT NULL,
    "raw_code" TEXT NOT NULL,
    "test_code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'USE',

    CONSTRAINT "instrument_mapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eqa_survey" (
    "survey_id" TEXT NOT NULL,
    "program" TEXT NOT NULL,
    "cycle" TEXT NOT NULL,
    "test_code" TEXT NOT NULL,
    "sample_id" TEXT NOT NULL,
    "submitted_value" DOUBLE PRECISION NOT NULL,
    "peer_mean" DOUBLE PRECISION,
    "peer_sd" DOUBLE PRECISION,
    "sdi" DOUBLE PRECISION,
    "verdict" TEXT,
    "submitted_by" TEXT,
    "submitted_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eqa_survey_pkey" PRIMARY KEY ("survey_id")
);

-- CreateTable
CREATE TABLE "barcode_config" (
    "id" TEXT NOT NULL DEFAULT 'SINGLETON',
    "trim_whitespace" BOOLEAN NOT NULL DEFAULT true,
    "prefix_strip" TEXT,
    "suffix_strip" TEXT,
    "strip_pattern" TEXT,
    "min_length" INTEGER,
    "max_length" INTEGER,
    "auto_submit" TEXT NOT NULL DEFAULT 'ENTER',
    "auto_submit_len" INTEGER,
    "idle_ms" INTEGER,
    "beep" BOOLEAN NOT NULL DEFAULT false,
    "updated_by" TEXT,
    "updated_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "barcode_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interface_log" (
    "log_id" TEXT NOT NULL,
    "if_id" TEXT,
    "direction" TEXT NOT NULL,
    "message_type" TEXT,
    "message_control_id" TEXT,
    "status" TEXT NOT NULL,
    "error_text" TEXT,
    "payload" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "his_ref" TEXT,
    "created_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interface_log_pkey" PRIMARY KEY ("log_id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "log_id" TEXT NOT NULL,
    "user_id" TEXT,
    "action" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "detail" TEXT,
    "status" INTEGER,
    "sensitive" BOOLEAN NOT NULL DEFAULT false,
    "created_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("log_id")
);

-- CreateTable
CREATE TABLE "notification" (
    "notify_id" TEXT NOT NULL,
    "ntype" TEXT,
    "target" TEXT,
    "message" TEXT,
    "created_dt" TIMESTAMP(3),
    "ack_dt" TIMESTAMP(3),

    CONSTRAINT "notification_pkey" PRIMARY KEY ("notify_id")
);

-- CreateTable
CREATE TABLE "reflex_protocol" (
    "protocol_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "when_test_code" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "threshold" DOUBLE PRECISION,
    "threshold_high" DOUBLE PRECISION,
    "flag" TEXT,
    "add_test_codes" TEXT NOT NULL,
    "priority" TEXT,
    "specialist_by" TEXT,
    "specialist_dt" TIMESTAMP(3),
    "committee_no" TEXT,
    "committee_dt" TIMESTAMP(3),
    "his_ref" TEXT,
    "effective_from" TEXT,
    "effective_to" TEXT,
    "created_by" TEXT,
    "created_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_dt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reflex_protocol_pkey" PRIMARY KEY ("protocol_id")
);

-- CreateTable
CREATE TABLE "reflex_protocol_event" (
    "event_id" TEXT NOT NULL,
    "protocol_id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "actor" TEXT,
    "note" TEXT,
    "created_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reflex_protocol_event_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "reflex_execution" (
    "exec_id" TEXT NOT NULL,
    "protocol_id" TEXT NOT NULL,
    "protocol_name" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "add_test_code" TEXT NOT NULL,
    "patient_id" TEXT,
    "trigger_value" TEXT,
    "outbound_mcid" TEXT,
    "his_order_no" TEXT,
    "executed_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reflex_execution_pkey" PRIMARY KEY ("exec_id")
);

-- CreateIndex
CREATE INDEX "terminology_code_status_idx" ON "terminology_code"("status");

-- CreateIndex
CREATE INDEX "terminology_code_category_idx" ON "terminology_code"("category");

-- CreateIndex
CREATE UNIQUE INDEX "terminology_code_system_code_key" ON "terminology_code"("system", "code");

-- CreateIndex
CREATE INDEX "lab_order_status_order_dt_idx" ON "lab_order"("status", "order_dt");

-- CreateIndex
CREATE INDEX "lab_order_his_order_no_idx" ON "lab_order"("his_order_no");

-- CreateIndex
CREATE INDEX "specimen_order_id_idx" ON "specimen"("order_id");

-- CreateIndex
CREATE INDEX "result_attachment_specimen_no_idx" ON "result_attachment"("specimen_no");

-- CreateIndex
CREATE INDEX "result_attachment_sp_no_idx" ON "result_attachment"("sp_no");

-- CreateIndex
CREATE INDEX "result_specimen_no_idx" ON "result"("specimen_no");

-- CreateIndex
CREATE INDEX "result_verify_state_idx" ON "result"("verify_state");

-- CreateIndex
CREATE UNIQUE INDEX "qc_target_qc_code_instrument_test_code_key" ON "qc_target"("qc_code", "instrument", "test_code");

-- CreateIndex
CREATE INDEX "qc_result_qc_code_instrument_test_code_measured_dt_idx" ON "qc_result"("qc_code", "instrument", "test_code", "measured_dt");

-- CreateIndex
CREATE INDEX "culture_report_culture_id_reported_dt_idx" ON "culture_report"("culture_id", "reported_dt");

-- CreateIndex
CREATE INDEX "pathology_case_his_order_no_idx" ON "pathology_case"("his_order_no");

-- CreateIndex
CREATE INDEX "pathology_block_sp_no_idx" ON "pathology_block"("sp_no");

-- CreateIndex
CREATE INDEX "pathology_slide_sp_no_idx" ON "pathology_slide"("sp_no");

-- CreateIndex
CREATE INDEX "pathology_slide_block_id_idx" ON "pathology_slide"("block_id");

-- CreateIndex
CREATE INDEX "blood_typing_patient_id_tested_dt_idx" ON "blood_typing"("patient_id", "tested_dt");

-- CreateIndex
CREATE INDEX "transfusion_act_issue_id_idx" ON "transfusion_act"("issue_id");

-- CreateIndex
CREATE INDEX "transfusion_reaction_patient_id_reported_dt_idx" ON "transfusion_reaction"("patient_id", "reported_dt");

-- CreateIndex
CREATE UNIQUE INDEX "genomic_order_order_id_key" ON "genomic_order"("order_id");

-- CreateIndex
CREATE INDEX "variant_genomic_order_id_idx" ON "variant"("genomic_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "instrument_mapping_instrument_raw_code_key" ON "instrument_mapping"("instrument", "raw_code");

-- CreateIndex
CREATE INDEX "eqa_survey_program_cycle_idx" ON "eqa_survey"("program", "cycle");

-- CreateIndex
CREATE UNIQUE INDEX "interface_log_direction_message_control_id_key" ON "interface_log"("direction", "message_control_id");

-- CreateIndex
CREATE INDEX "audit_log_user_id_created_dt_idx" ON "audit_log"("user_id", "created_dt");

-- CreateIndex
CREATE INDEX "reflex_protocol_status_idx" ON "reflex_protocol"("status");

-- CreateIndex
CREATE INDEX "reflex_protocol_when_test_code_idx" ON "reflex_protocol"("when_test_code");

-- CreateIndex
CREATE INDEX "reflex_protocol_event_protocol_id_idx" ON "reflex_protocol_event"("protocol_id");

-- CreateIndex
CREATE INDEX "reflex_execution_protocol_id_idx" ON "reflex_execution"("protocol_id");

-- CreateIndex
CREATE INDEX "reflex_execution_executed_dt_idx" ON "reflex_execution"("executed_dt");

-- AddForeignKey
ALTER TABLE "panel_item" ADD CONSTRAINT "panel_item_panel_code_fkey" FOREIGN KEY ("panel_code") REFERENCES "panel"("panel_code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "panel_item" ADD CONSTRAINT "panel_item_test_code_fkey" FOREIGN KEY ("test_code") REFERENCES "test_master"("test_code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference_range" ADD CONSTRAINT "reference_range_test_code_fkey" FOREIGN KEY ("test_code") REFERENCES "test_master"("test_code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_mapping" ADD CONSTRAINT "code_mapping_lis_code_fkey" FOREIGN KEY ("lis_code") REFERENCES "test_master"("test_code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_role_code_fkey" FOREIGN KEY ("role_code") REFERENCES "role"("role_code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visit" ADD CONSTRAINT "visit_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("patient_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visit" ADD CONSTRAINT "visit_attending_fkey" FOREIGN KEY ("attending") REFERENCES "provider"("provider_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_order" ADD CONSTRAINT "lab_order_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("patient_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_order" ADD CONSTRAINT "lab_order_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "visit"("visit_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_order" ADD CONSTRAINT "lab_order_ordering_provider_fkey" FOREIGN KEY ("ordering_provider") REFERENCES "provider"("provider_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "lab_order"("order_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_test_code_fkey" FOREIGN KEY ("test_code") REFERENCES "test_master"("test_code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specimen" ADD CONSTRAINT "specimen_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "lab_order"("order_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specimen" ADD CONSTRAINT "specimen_container_code_fkey" FOREIGN KEY ("container_code") REFERENCES "container"("container_code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_attachment" ADD CONSTRAINT "result_attachment_specimen_no_fkey" FOREIGN KEY ("specimen_no") REFERENCES "specimen"("specimen_no") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_attachment" ADD CONSTRAINT "result_attachment_sp_no_fkey" FOREIGN KEY ("sp_no") REFERENCES "pathology_case"("sp_no") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aliquot" ADD CONSTRAINT "aliquot_specimen_no_fkey" FOREIGN KEY ("specimen_no") REFERENCES "specimen"("specimen_no") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aliquot" ADD CONSTRAINT "aliquot_container_code_fkey" FOREIGN KEY ("container_code") REFERENCES "container"("container_code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result" ADD CONSTRAINT "result_specimen_no_fkey" FOREIGN KEY ("specimen_no") REFERENCES "specimen"("specimen_no") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result" ADD CONSTRAINT "result_test_code_fkey" FOREIGN KEY ("test_code") REFERENCES "test_master"("test_code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result" ADD CONSTRAINT "result_verifier_fkey" FOREIGN KEY ("verifier") REFERENCES "app_user"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "critical_notify" ADD CONSTRAINT "critical_notify_result_id_fkey" FOREIGN KEY ("result_id") REFERENCES "result"("result_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_target" ADD CONSTRAINT "qc_target_qc_code_fkey" FOREIGN KEY ("qc_code") REFERENCES "qc_material"("qc_code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_result" ADD CONSTRAINT "qc_result_qc_code_fkey" FOREIGN KEY ("qc_code") REFERENCES "qc_material"("qc_code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_result" ADD CONSTRAINT "qc_result_test_code_fkey" FOREIGN KEY ("test_code") REFERENCES "test_master"("test_code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "culture" ADD CONSTRAINT "culture_specimen_no_fkey" FOREIGN KEY ("specimen_no") REFERENCES "specimen"("specimen_no") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "culture_report" ADD CONSTRAINT "culture_report_culture_id_fkey" FOREIGN KEY ("culture_id") REFERENCES "culture"("culture_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "isolate" ADD CONSTRAINT "isolate_culture_id_fkey" FOREIGN KEY ("culture_id") REFERENCES "culture"("culture_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "susceptibility" ADD CONSTRAINT "susceptibility_isolate_id_fkey" FOREIGN KEY ("isolate_id") REFERENCES "isolate"("isolate_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pathology_case" ADD CONSTRAINT "pathology_case_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("patient_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pathology_report" ADD CONSTRAINT "pathology_report_sp_no_fkey" FOREIGN KEY ("sp_no") REFERENCES "pathology_case"("sp_no") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pathology_report" ADD CONSTRAINT "pathology_report_signer_fkey" FOREIGN KEY ("signer") REFERENCES "provider"("provider_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crossmatch" ADD CONSTRAINT "crossmatch_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("patient_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crossmatch" ADD CONSTRAINT "crossmatch_unit_no_fkey" FOREIGN KEY ("unit_no") REFERENCES "blood_unit"("unit_no") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crossmatch" ADD CONSTRAINT "crossmatch_tester_fkey" FOREIGN KEY ("tester") REFERENCES "app_user"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blood_issue" ADD CONSTRAINT "blood_issue_unit_no_fkey" FOREIGN KEY ("unit_no") REFERENCES "blood_unit"("unit_no") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blood_issue" ADD CONSTRAINT "blood_issue_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("patient_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "genomic_order" ADD CONSTRAINT "genomic_order_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "lab_order"("order_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent" ADD CONSTRAINT "consent_genomic_order_id_fkey" FOREIGN KEY ("genomic_order_id") REFERENCES "genomic_order"("genomic_order_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant" ADD CONSTRAINT "variant_genomic_order_id_fkey" FOREIGN KEY ("genomic_order_id") REFERENCES "genomic_order"("genomic_order_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interpretation" ADD CONSTRAINT "interpretation_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "variant"("variant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interpretation" ADD CONSTRAINT "interpretation_classifier_fkey" FOREIGN KEY ("classifier") REFERENCES "app_user"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reflex_protocol_event" ADD CONSTRAINT "reflex_protocol_event_protocol_id_fkey" FOREIGN KEY ("protocol_id") REFERENCES "reflex_protocol"("protocol_id") ON DELETE CASCADE ON UPDATE CASCADE;

