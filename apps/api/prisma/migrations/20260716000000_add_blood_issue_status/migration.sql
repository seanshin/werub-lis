-- AlterTable: 혈액 출고 반납 추적 컬럼(출고취소·반납)
ALTER TABLE "blood_issue" ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'ISSUED',
ADD COLUMN     "return_reason" TEXT,
ADD COLUMN     "returned_dt" TIMESTAMP(3);
