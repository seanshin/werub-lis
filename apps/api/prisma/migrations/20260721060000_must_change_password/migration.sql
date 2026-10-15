-- 관리자 발급·재설정 비밀번호는 최초 로그인 시 강제 변경(보안 검토 조치).
-- 기존 계정은 false(영향 없음), 신규/재설정 시 true로 설정된다.
ALTER TABLE "app_user" ADD COLUMN IF NOT EXISTS "must_change_password" BOOLEAN NOT NULL DEFAULT false;
