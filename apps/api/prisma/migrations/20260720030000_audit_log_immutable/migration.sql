-- C3 감사로그 DB-레벨 불변성(append-only) — 해시체인(앱-레벨 탐지)에 더해 DB가 UPDATE를 원천 차단.
-- 앱은 감사로그를 단일 INSERT로만 기록(hash 포함), 사후 UPDATE 없음 → UPDATE 전면 금지 안전.
-- DELETE는 보존기간 정리(lifecycle purge)가 사용하므로 허용(해시체인·보존정책이 삭제를 규율).
CREATE OR REPLACE FUNCTION audit_log_no_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log는 append-only입니다 — UPDATE 금지(무결성 감사 C3).';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_block_update ON "audit_log";
CREATE TRIGGER audit_log_block_update
  BEFORE UPDATE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_no_update();
