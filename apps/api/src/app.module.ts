import type { MiddlewareConsumer, NestModule } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';

import { ApiEnvelopeInterceptor } from './api-envelope.interceptor.js';
import { ApiExceptionFilter } from './api-exception.filter.js';
import { AppController } from './app.controller.js';
import { HealthService } from './health.service.js';
import { RequestIdMiddleware } from './request-id.js';
import { SkillOnboardingApplicationService } from './skill/skill-onboarding.service.js';
import { createRuntimeSkillOnboardingService } from './skill/runtime.js';

@Module({
  controllers: [AppController],
  providers: [
    HealthService,
    {
      provide: SkillOnboardingApplicationService,
      useFactory: () => createRuntimeSkillOnboardingService(),
    },
    { provide: APP_INTERCEPTOR, useClass: ApiEnvelopeInterceptor },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  public configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
