import type { MiddlewareConsumer, NestModule } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';

import { ApiEnvelopeInterceptor } from './api-envelope.interceptor.js';
import { ApiExceptionFilter } from './api-exception.filter.js';
import { AppController } from './app.controller.js';
import { HealthService } from './health.service.js';
import { WorkBuddyMcpAdapter } from './mcp/workbuddy-mcp.adapter.js';
import { WorkBuddyMcpMiddleware } from './mcp/workbuddy-mcp.middleware.js';
import { OAuthController } from './oauth/oauth.controller.js';
import { createRuntimeOAuth, OAuthRuntime } from './oauth/oauth-runtime.js';
import { McpBearerAuthMiddleware } from './oauth/mcp-bearer-auth.middleware.js';
import { RequestIdMiddleware } from './request-id.js';
import { SkillOnboardingApplicationService } from './skill/skill-onboarding.service.js';
import { createRuntimeSkillOnboardingService } from './skill/runtime.js';
import { SkillController } from './skill/skill.controller.js';

@Module({
  controllers: [AppController, SkillController, OAuthController],
  providers: [
    HealthService,
    {
      provide: OAuthRuntime,
      useFactory: () => createRuntimeOAuth(),
    },
    {
      provide: SkillOnboardingApplicationService,
      inject: [OAuthRuntime],
      useFactory: (oauth: OAuthRuntime) =>
        createRuntimeSkillOnboardingService(process.env, oauth.authenticator),
    },
    WorkBuddyMcpAdapter,
    WorkBuddyMcpMiddleware,
    McpBearerAuthMiddleware,
    { provide: APP_INTERCEPTOR, useClass: ApiEnvelopeInterceptor },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  public configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
    consumer.apply(McpBearerAuthMiddleware).forRoutes('mcp');
    consumer.apply(WorkBuddyMcpMiddleware).forRoutes('mcp');
  }
}
