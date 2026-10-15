-- Reflex 계보 키(lineageId) — 개정본이 뿌리의 계보를 승계. 활성화 시 같은 계보의 다른 활성본을 세대·분기
-- 무관하게 전량 SUPERSEDED로 접어 "계보당 활성 1개" 불변식을 보장(단일 레벨 매칭의 분기 누락 결함 수정).
-- additive/nullable — 기존 행은 각자 자기 자신을 뿌리로 백필(현재 개정 계보 데이터 없음).
ALTER TABLE "reflex_protocol" ADD COLUMN "lineage_id" TEXT;
UPDATE "reflex_protocol" SET "lineage_id" = "protocol_id" WHERE "lineage_id" IS NULL;
CREATE INDEX "reflex_protocol_lineage_id_idx" ON "reflex_protocol"("lineage_id");
