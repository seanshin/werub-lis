-- D1 검체 품질 HIL 지표(용혈·황달·지질혈) — 영향 analyte 간섭 경고 근거.
ALTER TABLE "specimen" ADD COLUMN "hemolysis" TEXT;
ALTER TABLE "specimen" ADD COLUMN "icterus" TEXT;
ALTER TABLE "specimen" ADD COLUMN "lipemia" TEXT;
