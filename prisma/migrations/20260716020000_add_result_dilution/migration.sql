-- AlterTable: 결과 희석/재검 필드
ALTER TABLE "result" ADD COLUMN     "dilution_factor" DOUBLE PRECISION,
ADD COLUMN     "rerun" BOOLEAN NOT NULL DEFAULT false;
