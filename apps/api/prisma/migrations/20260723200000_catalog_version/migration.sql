-- 표준 코드셋 버전 반입(CLSI 브레이크포인트 등) — DRAFT 반입 → 차이 확인 → 활성화
CREATE TABLE "catalog_version" (
    "catalog_id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "standard" TEXT,
    "effective_date" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "item_count" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "imported_by" TEXT,
    "imported_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activated_by" TEXT,
    "activated_dt" TIMESTAMP(3),
    CONSTRAINT "catalog_version_pkey" PRIMARY KEY ("catalog_id","version")
);
CREATE INDEX "catalog_version_catalog_id_status_idx" ON "catalog_version"("catalog_id", "status");

CREATE TABLE "catalog_item" (
    "item_id" TEXT NOT NULL,
    "catalog_id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "item_key" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    CONSTRAINT "catalog_item_pkey" PRIMARY KEY ("item_id")
);
CREATE UNIQUE INDEX "catalog_item_catalog_id_version_item_key_key" ON "catalog_item"("catalog_id", "version", "item_key");
CREATE INDEX "catalog_item_catalog_id_version_idx" ON "catalog_item"("catalog_id", "version");
ALTER TABLE "catalog_item" ADD CONSTRAINT "catalog_item_catalog_id_version_fkey" FOREIGN KEY ("catalog_id", "version") REFERENCES "catalog_version"("catalog_id", "version") ON DELETE CASCADE ON UPDATE CASCADE;
