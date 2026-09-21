import type { MiddlewareConsumer, NestModule } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';

import { ApiEnvelopeInterceptor } from './api-envelope.interceptor.js';
import { ApiExceptionFilter } from './api-exception.filter.js';
import { AppController } from './app.controller.js';
import { HealthService } from './health.service.js';
import { WorkBuddyMcpAdapter } from './mcp/workbuddy-mcp.adapter.js';
import { WorkBuddyMcpMiddleware } from './mcp/workbuddy-mcp.middleware.js';
import { RequestIdMiddleware } from './request-id.js';
import { SkillOnboardingApplicationService } from './skill/skill-onboarding.service.js';
import { createRuntimeSkillOnboardingService } from './skill/runtime.js';
import { SkillController } from './skill/skill.controller.js';

@Module({
  controllers: [AppController, SkillController],
  providers: [
    HealthService,
    {
      provide: SkillOnboardingApplicationService,
      useFactory: () => createRuntimeSkillOnboardingService(),
    },
    WorkBuddyMcpAdapter,
    WorkBuddyMcpMiddleware,
    { provide: APP_INTERCEPTOR, useClass: ApiEnvelopeInterceptor },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  public configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
    consumer.apply(WorkBuddyMcpMiddleware).forRoutes('mcp');
  }
}
