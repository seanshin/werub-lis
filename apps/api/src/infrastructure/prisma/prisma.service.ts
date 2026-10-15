/**
 * PrismaService — prisma 도메인 서비스.
 *
 * 주요 진입점: `onModuleInit()`, `onModuleDestroy()`
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * PrismaService — DB 접근 계층 (Infrastructure)
 * HIS 규약(infrastructure/prisma) 준거.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
