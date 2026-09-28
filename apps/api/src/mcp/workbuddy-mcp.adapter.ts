import { Injectable } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';

import { onboardingEventRequestSchema, onboardingSessionIdSchema } from '@h5cs/contracts';
import type { ErrorCode } from '@h5cs/contracts';
import { OnboardingOptimisticLockError, OnboardingPersistenceError } from '@h5cs/database';
import {
  InvalidDomainIdError,
  InvalidOnboardingTransitionError,
  MerchantSelectionRequiredError,
  OnboardingMissingItemsError,
} from '@h5cs/domain';
import type { OnboardingEvent } from '@h5cs/domain';

import {
  AssistantSelectionNotFoundError,
  ManagementConsoleUnavailableError,
  MerchantBindingRequiredError,
  OnboardingSessionNotFoundError,
  SkillOnboardingApplicationService,
} from '../skill/skill-onboarding.service.js';
import {
  WorkBuddyAuthenticationRequiredError,
  WorkBuddyAuthenticationUnavailableError,
} from '../skill/workbuddy-authenticator.js';
import { GenerationUnavailableError } from '../skill/generation-coordinator.js';
import { resolveRequestId } from '../request-id.js';

type IncomingMessageWithBody = IncomingMessage & { body?: unknown; requestId?: string };
type PublicOnboardingEvent = Exclude<
  OnboardingEvent,
  { type: 'generation_failed' | 'generation_succeeded' }
>;

export const WORKBUDDY_MCP_TOOL_NAMES = [
  'h5cs_help',
  'h5cs_onboarding_create_or_resume',
  'h5cs_management_open',
  'h5cs_onboarding_advance',
] as const;

export type WorkBuddyMcpToolError = Readonly<{
  code: ErrorCode;
  message: string;
  retryable: boolean;
}>;

const helpInputSchema = z
  .object({
    topic: z.enum(['create_customer_service', 'open_management_console']).optional(),
  })
  .strict();

const createOrResumeInputSchema = z
  .object({
    resume_session_id: onboardingSessionIdSchema.optional(),
  })
  .strict();

const managementOpenInputSchema = z
  .object({
    assistant_ref: z
      .string()
      .regex(/^[0-9a-f]{32}$/u)
      .optional(),
  })
  .strict();

const advanceInputSchema = z
  .object({
    onboarding_session_id: onboardingSessionIdSchema,
    event: onboardingEventRequestSchema.shape.event,
  })
  .strict();

export const toWorkBuddyMcpToolError = (error: unknown): WorkBuddyMcpToolError => {
  if (error instanceof WorkBuddyAuthenticationRequiredError) {
    return {
      code: 'UNAUTHORIZED',
      message:
        '需要通过 MCP HTTP transport 提供 Bearer 凭据；不要在工具参数或对话中发送 token、密码或验证码。',
      retryable: false,
    };
  }
  if (error instanceof WorkBuddyAuthenticationUnavailableError) {
    return {
      code: 'SERVICE_UNAVAILABLE',
      message: 'WorkBuddy Bearer 鉴权尚未配置，本地适配器不能执行受保护操作。',
      retryable: false,
    };
  }
  if (error instanceof GenerationUnavailableError) {
    return {
      code: 'GENERATION_UNAVAILABLE',
      message: '客服草稿生成服务尚未配置，本次确认没有创建客服。',
      retryable: false,
    };
  }
  if (error instanceof OnboardingPersistenceError) {
    return {
      code: 'DATABASE_UNAVAILABLE',
      message: '入驻数据库尚未配置或当前不可用，未创建、恢复或更新任何入驻记录。',
      retryable: true,
    };
  }
  if (error instanceof MerchantBindingRequiredError) {
    return {
      code: 'BINDING_REQUIRED',
      message: '当前 WorkBuddy 用户尚未绑定商家，请先完成商家绑定。',
      retryable: false,
    };
  }
  if (error instanceof OnboardingSessionNotFoundError) {
    return {
      code: 'NOT_FOUND',
      message: '未找到可访问的入驻会话，请检查会话ID或新建入驻。',
      retryable: false,
    };
  }
  if (error instanceof AssistantSelectionNotFoundError) {
    return {
      code: 'NOT_FOUND',
      message: '当前商家无权访问该客服，请重新查看可选客服。',
      retryable: false,
    };
  }
  if (error instanceof ManagementConsoleUnavailableError) {
    return {
      code: 'SERVICE_UNAVAILABLE',
      message: '管理后台地址尚未配置，当前不能生成跳转链接。',
      retryable: false,
    };
  }
  if (error instanceof OnboardingOptimisticLockError) {
    return {
      code: 'VERSION_CONFLICT',
      message: '入驻状态已被其他请求更新，请重新读取当前会话后再试。',
      retryable: true,
    };
  }
  if (error instanceof InvalidOnboardingTransitionError) {
    return {
      code: 'CONFLICT',
      message: '当前入驻阶段不接受该操作，请先读取并按当前阶段继续。',
      retryable: false,
    };
  }
  if (error instanceof OnboardingMissingItemsError) {
    return {
      code: 'CONFLICT',
      message: `入驻资料尚不完整，缺少：${error.missingItems.map((item) => item.message).join('、')}。`,
      retryable: false,
    };
  }
  if (error instanceof InvalidDomainIdError) {
    return {
      code: 'BAD_REQUEST',
      message: '请求中的会话ID格式无效。',
      retryable: false,
    };
  }
  if (error instanceof MerchantSelectionRequiredError) {
    return {
      code: 'MERCHANT_SELECTION_REQUIRED',
      message: '当前账号关联多个商家，需要先在安全页面明确选择商家。',
      retryable: false,
    };
  }
  return {
    code: 'INTERNAL_ERROR',
    message: 'MCP 适配器处理请求时发生内部错误，请稍后重试。',
    retryable: true,
  };
};

const successfulToolResult = (result: unknown, requestId: string): CallToolResult => {
  const structuredContent = {
    ok: true,
    result,
    trace_id: requestId,
    request_id: requestId,
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
};

const failedToolResult = (error: unknown, requestId: string): CallToolResult => {
  const structuredContent = {
    ok: false,
    ...toWorkBuddyMcpToolError(error),
    trace_id: requestId,
    request_id: requestId,
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError: true,
  };
};

@Injectable()
export class WorkBuddyMcpAdapter {
  public constructor(private readonly onboarding: SkillOnboardingApplicationService) {}

  public async handleRequest(
    request: IncomingMessageWithBody,
    response: ServerResponse,
  ): Promise<void> {
    if (request.method !== 'POST') {
      this.writeJsonRpcError(response, 405, -32_000, 'Method not allowed. Use POST.');
      return;
    }

    const requestId = request.requestId ?? resolveRequestId(undefined);
    request.requestId = requestId;
    response.setHeader('X-Request-Id', requestId);
    const authorizationHeader = request.headers.authorization;
    const server = this.createServer(authorizationHeader, requestId);
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });

    response.once('close', () => {
      void Promise.allSettled([transport.close(), server.close()]);
    });

    try {
      await server.connect(transport as Parameters<McpServer['connect']>[0]);
      await transport.handleRequest(request, response, request.body);
    } catch {
      if (!response.headersSent) {
        this.writeJsonRpcError(response, 500, -32_603, 'Internal MCP transport error.');
      }
    }
  }

  private createServer(authorizationHeader: string | undefined, requestId: string): McpServer {
    const server = new McpServer({ name: 'h5-ai-customer-service', version: '0.1.0' });

    server.registerTool(
      WORKBUDDY_MCP_TOOL_NAMES[0],
      {
        title: '获取 H5 AI 客服帮助',
        description: '查看可用能力和推荐的下一步；不需要鉴权，不执行写操作。',
        inputSchema: helpInputSchema,
      },
      async ({ topic }) =>
        this.invokeTool(requestId, () =>
          this.onboarding.execute(undefined, {
            intent: 'help',
            ...(topic === undefined ? {} : { topic }),
          }),
        ),
    );

    server.registerTool(
      WORKBUDDY_MCP_TOOL_NAMES[1],
      {
        title: '创建或恢复 AI 客服入驻',
        description:
          '为当前已鉴权 WorkBuddy 用户创建或恢复商家的 AI 客服入驻会话；Bearer 只能来自 HTTP transport。',
        inputSchema: createOrResumeInputSchema,
      },
      async ({ resume_session_id }) =>
        this.invokeTool(requestId, () =>
          this.onboarding.execute(authorizationHeader, {
            intent: 'create_customer_service',
            ...(resume_session_id === undefined
              ? {}
              : { resume_session_id: resume_session_id.toLowerCase() }),
          }),
        ),
    );

    server.registerTool(
      WORKBUDDY_MCP_TOOL_NAMES[2],
      {
        title: '打开 AI 客服管理后台',
        description:
          '返回当前已鉴权用户可访问的客服管理入口；有多个客服时先列出名称，再传入 assistant_ref 明确选择。Bearer 只能来自 HTTP transport。',
        inputSchema: managementOpenInputSchema,
      },
      async ({ assistant_ref }) =>
        this.invokeTool(requestId, () =>
          this.onboarding.execute(authorizationHeader, {
            intent: 'open_management_console',
            ...(assistant_ref === undefined ? {} : { assistant_ref }),
          }),
        ),
    );

    server.registerTool(
      WORKBUDDY_MCP_TOOL_NAMES[3],
      {
        title: '推进 AI 客服入驻',
        description:
          '提交当前阶段所需资料或确认、取消、恢复操作；不接受内部生成成功/失败事件，也不发布客服。',
        inputSchema: advanceInputSchema,
      },
      async ({ onboarding_session_id, event }) =>
        this.invokeTool(requestId, () =>
          this.onboarding.advance({
            authorizationHeader: authorizationHeader ?? '',
            sessionId: onboarding_session_id.toLowerCase(),
            event: event as PublicOnboardingEvent,
          }),
        ),
    );

    return server;
  }

  private async invokeTool(
    requestId: string,
    operation: () => Promise<unknown>,
  ): Promise<CallToolResult> {
    try {
      return successfulToolResult(await operation(), requestId);
    } catch (error) {
      return failedToolResult(error, requestId);
    }
  }

  private writeJsonRpcError(
    response: ServerResponse,
    statusCode: number,
    code: number,
    message: string,
  ): void {
    response.statusCode = statusCode;
    response.setHeader('Allow', 'POST');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
  }
}
