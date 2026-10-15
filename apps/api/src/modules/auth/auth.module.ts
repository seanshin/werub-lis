/**
 * auth 모듈 배선(NestJS DI).
 *
 * 컨트롤러: AuthController.
 * 프로바이더: AuthService, JwtStrategy.
 * 의존 모듈: PassportModule, JwtModule.register({       secret: getJwtSecret(), signOptions: { expiresIn: (process.env.JWT_EXPIRES || '8h') as `${number}h` }, }).
 * 외부 공개: AuthService — 다른 모듈이 주입해 쓴다.
 * 배선만 담당하며 로직은 두지 않는다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './jwt.strategy';
import { getJwtSecret } from './jwt-secret.util';

@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      secret: getJwtSecret(),
      signOptions: { expiresIn: (process.env.JWT_EXPIRES || '8h') as `${number}h` },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
