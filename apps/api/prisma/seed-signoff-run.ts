/** 서명 대기 마스터(§F 참고치·검사별 설정·EDI)만 멱등 적용하는 standalone 러너.
 *  실행: DATABASE_URL=... npx ts-node prisma/seed-signoff-run.ts
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 *  전체 seed(데모 환자·오더 포함)를 재실행하지 않고 서명-대기 마스터만 채운다(파일럿 안전). */
import { PrismaClient } from '@prisma/client';
import { seedSignoffPending } from './seed-signoff';
import { seedLabMenu } from './seed-lab-menu';

const prisma = new PrismaClient();
seedSignoffPending(prisma)
  .then(() => seedLabMenu(prisma))
  .then(() => {
    // eslint-disable-next-line no-console
    console.log('서명대기 마스터 + 검사실 전 메뉴 시드 완료(§F·검사별설정·EDI·QC·패널·전 도메인 검사)');
  })
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
