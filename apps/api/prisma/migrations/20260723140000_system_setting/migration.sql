-- 운영 설정(위험치 통보 채널 등) — 재기동 없이 화면에서 변경
CREATE TABLE "system_setting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_by" TEXT,
    "updated_dt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "system_setting_pkey" PRIMARY KEY ("key")
);
