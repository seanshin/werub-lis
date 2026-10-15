-- 로그인 계정 ↔ 의사 마스터(Provider) 연결.
-- 병리 사인아웃 등 Provider로 기록되는 임상 서명을 서버가 인증 주체로부터 유도하기 위함
-- (클라이언트가 서명자를 지정하면 타 판독의 명의 서명이 가능 — 보안 검토 조치).
ALTER TABLE "app_user" ADD COLUMN IF NOT EXISTS "provider_id" TEXT;
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_provider_id_fkey"
  FOREIGN KEY ("provider_id") REFERENCES "provider"("provider_id") ON DELETE SET NULL ON UPDATE CASCADE;
