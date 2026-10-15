-- 조직 게이트 EAS 결재 lifecycle(상신/진행/반려) + 결재 참조 출처(수기/자동피드).
-- status는 기존 String이라 값 집합만 확장(스키마 변경 없음). source 컬럼만 추가.
ALTER TABLE "org_approval" ADD COLUMN "source" TEXT;
