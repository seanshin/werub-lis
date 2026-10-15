-- 개시 승인에 체크리스트 스냅샷 — "무엇을 확인하고 승인했는가"를 나중에 재구성한다.
-- blocking_snapshot과 분리한다: 그쪽은 APPROVED_STALE 판정이 `{key}[]`로 파싱하므로
-- 형식이 섞이면 승인 무효 판정이 조용히 깨진다.
-- 근거: docs/개시전환센터_기획서.md §3.7·§6.4

ALTER TABLE "golive_approval" ADD COLUMN "checklist_snapshot" TEXT;
ALTER TABLE "golive_approval" ADD COLUMN "registry_version" TEXT;
