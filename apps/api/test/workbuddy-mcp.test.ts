import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { NestFactory } from '@nestjs/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SkillIntentRequest, SkillIntentResult } from '@h5cs/contracts';
import { UnavailableOnboardingRepository } from '@h5cs/database';
import type { OnboardingEvent, VerifiedExternalIdentity } from '@h5cs/domain';
import { MerchantSelectionRequiredError } from '@h5cs/domain';

import {
  toWorkBuddyMcpToolError,
  WORKBUDDY_MCP_TOOL_NAMES,
  WorkBuddyMcpAdapter,
} from '../src/mcp/workbuddy-mcp.adapter.js';
import { AppModule } from '../src/app.module.js';
import {
  GenerationUnavailableError,
  type GenerationCoordinator,
} from '../src/skill/generation-coordinator.js';
import type { AdvanceOnboardingCommand } from '../src/skill/skill-onboarding.service.js';
import { SkillOnboardingApplicationService } from '../src/skill/skill-onboarding.service.js';
import { createRuntimeSkillOnboardingService } from '../src/skill/runtime.js';
import type { WorkBuddyAuthenticator } from '../src/skill/workbuddy-authenticator.js';

const TEST_SESSION_ID = '0123456789abcdef0123456789abcdef';
const TEST_REQUEST_ID = 'req_mcp_protocol_1234';

type McpHarness = Readonly<{
  client: Client;
  close: () => Promise<void>;
}>;

const activeHarnesses: McpHarness[] = [];

const startHarness = async (
  adapter: WorkBuddyMcpAdapter,
  authorizationHeader?: string,
): Promise<McpHarness> => {
  const httpServer: Server = createServer((request, response) => {
    Object.assign(request, { requestId: TEST_REQUEST_ID });
    void adapter.handleRequest(request, response);
  });
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const address = httpServer.address();
  if (address === null || typeof address === 'string') throw new Error('Missing test server port');

  const client = new Client({ name: 'h5cs-mcp-protocol-test', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/mcp`),
    authorizationHeader === undefined
      ? undefined
      : { requestInit: { headers: { Authorization: authorizationHeader } } },
  );
  await client.connect(transport as Parameters<Client['connect']>[0]);

  let closed = false;
  const harness: McpHarness = {
    client,
    close: async () => {
      if (closed) return;
      closed = true;
      await client.close();
      httpServer.close();
      await once(httpServer, 'close');
    },
  };
  activeHarnesses.push(harness);
  return harness;
};

const structuredContent = (result: Awaited<ReturnType<Client['callTool']>>) =>
  result.structuredContent as Record<string, unknown>;

afterEach(async () => {
  await Promise.all(activeHarnesses.splice(0).map(async (harness) => harness.close()));
});

describe('WorkBuddy MCP adapter', () => {
  it('protects POST /mcp with OAuth discovery before entering the raw transport', async () => {
    const application = await NestFactory.create(AppModule, { logger: false });
    await application.listen(0, '127.0.0.1');

    try {
      const response = await fetch(`${await application.getUrl()}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toContain(
        'resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/mcp"',
      );

      const metadata = await fetch(
        `${await application.getUrl()}/.well-known/oauth-protected-resource/mcp`,
      );
      expect(metadata.status).toBe(200);
      await expect(metadata.json()).resolves.toMatchObject({
        resource: 'http://localhost:3000/mcp',
        scopes_supported: ['mcp:tools'],
      });
    } finally {
      await application.close();
    }
  });

  it('keeps connector metadata, Skill allowed-tools, and the server tool list aligned', async () => {
    const repositoryRoot = resolve(process.cwd(), '../..');
    const integrationRoot = resolve(repositoryRoot, 'integrations/workbuddy');
    const skill = await readFile(
      resolve(integrationRoot, 'skills/h5-ai-customer-service/SKILL.md'),
      'utf8',
    );
    const allowedTools = /^allowed-tools:\s*(.+)$/mu.exec(skill)?.[1]?.split(/,\s*/u);
    expect(allowedTools).toEqual(WORKBUDDY_MCP_TOOL_NAMES);

    const connectorMeta = JSON.parse(
      await readFile(resolve(integrationRoot, 'connector-meta.json'), 'utf8'),
    ) as { source: string; type: string; minWorkbuddyVersion: string };
    expect(connectorMeta).toMatchObject({
      source: 'h5-ai-customer-service',
      type: 'mcp',
      minWorkbuddyVersion: '4.24.0',
    });

    const mcpConfig = JSON.parse(await readFile(resolve(integrationRoot, 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { type: string; url: string; timeout: number }>;
    };
    expect(Object.keys(mcpConfig.mcpServers)).toEqual(['h5-ai-customer-service']);
    expect(mcpConfig.mcpServers['h5-ai-customer-service']).toEqual({
      type: 'streamableHttp',
      url: 'https://h5cs.1rying.com/mcp',
      timeout: 25_000,
    });
  });

  it('exposes exactly four strict facade tools and forwards Bearer only from the transport', async () => {
    const execute = vi.fn(
      async (
        _authorizationHeader: string | undefined,
        request: SkillIntentRequest,
      ): Promise<SkillIntentResult> => {
        if (request.intent === 'help') {
          return {
            action: 'help',
            supported_intents: ['create_customer_service', 'open_management_console'],
          };
        }
        if (request.intent === 'open_management_console') {
          return { action: 'start_first_onboarding', reason: 'no_assistant' };
        }
        return {
          action: 'continue_onboarding',
          onboarding_session_id: TEST_SESSION_ID,
          state: 'industry',
          missing_items: [],
        };
      },
    );
    const advance = vi.fn(
      async (_command: AdvanceOnboardingCommand): Promise<SkillIntentResult> => ({
        action: 'continue_onboarding',
        onboarding_session_id: TEST_SESSION_ID,
        state: 'materials',
        missing_items: [],
      }),
    );
    const service = { execute, advance } as unknown as SkillOnboardingApplicationService;
    const { client } = await startHarness(
      new WorkBuddyMcpAdapter(service),
      'Bearer protocol-only-token',
    );

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(WORKBUDDY_MCP_TOOL_NAMES);
    for (const tool of listed.tools) {
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      const schema = JSON.stringify(tool.inputSchema);
      for (const forbidden of [
        'open_id',
        'merchant_id',
        'password',
        'otp',
        'token',
        'authorization',
      ]) {
        expect(schema).not.toContain(`"${forbidden}"`);
      }
    }

    const helpResult = await client.callTool({ name: 'h5cs_help', arguments: {} });
    expect(structuredContent(helpResult)).toMatchObject({
      ok: true,
      request_id: TEST_REQUEST_ID,
      trace_id: TEST_REQUEST_ID,
      result: { action: 'help' },
    });
    expect(execute.mock.calls[0]?.[0]).toBeUndefined();

    await client.callTool({
      name: 'h5cs_onboarding_create_or_resume',
      arguments: { resume_session_id: TEST_SESSION_ID },
    });
    await client.callTool({ name: 'h5cs_management_open', arguments: {} });
    await client.callTool({
      name: 'h5cs_onboarding_advance',
      arguments: {
        onboarding_session_id: TEST_SESSION_ID,
        event: { type: 'provide_industry', industryCode: 'retail' },
      },
    });

    expect(execute.mock.calls[1]?.[0]).toBe('Bearer protocol-only-token');
    expect(execute.mock.calls[2]?.[0]).toBe('Bearer protocol-only-token');
    expect(advance).toHaveBeenCalledWith({
      authorizationHeader: 'Bearer protocol-only-token',
      sessionId: TEST_SESSION_ID,
      event: { type: 'provide_industry', industryCode: 'retail' },
    });
  });

  it('rejects secret-like extra inputs before entering the application service', async () => {
    const execute = vi.fn(async (): Promise<SkillIntentResult> => {
      throw new Error('must not be called');
    });
    const service = { execute, advance: vi.fn() } as unknown as SkillOnboardingApplicationService;
    const { client } = await startHarness(new WorkBuddyMcpAdapter(service), 'Bearer test-token');

    const result = await client.callTool({
      name: 'h5cs_onboarding_create_or_resume',
      arguments: { token: 'must-not-enter-tool-input' },
    });

    expect(result.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns stable readable failures when authentication or persistence is unavailable', async () => {
    const runtimeService = createRuntimeSkillOnboardingService({});

    const unauthenticated = await startHarness(new WorkBuddyMcpAdapter(runtimeService));
    const missingAuthentication = await unauthenticated.client.callTool({
      name: 'h5cs_onboarding_create_or_resume',
      arguments: {},
    });
    expect(missingAuthentication.isError).toBe(true);
    expect(structuredContent(missingAuthentication)).toMatchObject({
      ok: false,
      code: 'UNAUTHORIZED',
      retryable: false,
      request_id: TEST_REQUEST_ID,
    });

    const unavailableAuthentication = await startHarness(
      new WorkBuddyMcpAdapter(runtimeService),
      'Bearer unavailable-auth',
    );
    const authResult = await unavailableAuthentication.client.callTool({
      name: 'h5cs_management_open',
      arguments: {},
    });
    expect(structuredContent(authResult)).toMatchObject({
      ok: false,
      code: 'SERVICE_UNAVAILABLE',
      retryable: false,
    });

    const authenticator: WorkBuddyAuthenticator = {
      assertReady: async () => Promise.resolve(),
      authenticateAccessToken: async (): Promise<VerifiedExternalIdentity> => ({
        provider: 'workbuddy',
        issuer: 'https://workbuddy.example.test',
        audience: 'h5cs-test',
        subjectLookupKey: new Uint8Array(32),
        subjectLookupKeyVersion: 1,
        phoneMatchVerifiedAt: null,
        verifiedAt: new Date('2026-09-21T00:00:00.000Z'),
      }),
    };
    const generationCoordinator: GenerationCoordinator = {
      assertReady: async () => Promise.resolve(),
    };
    const missingDatabaseService = new SkillOnboardingApplicationService(
      authenticator,
      new UnavailableOnboardingRepository('database not configured'),
      generationCoordinator,
    );
    const missingDatabase = await startHarness(
      new WorkBuddyMcpAdapter(missingDatabaseService),
      'Bearer valid-for-test',
    );
    const databaseResult = await missingDatabase.client.callTool({
      name: 'h5cs_onboarding_create_or_resume',
      arguments: {},
    });
    expect(structuredContent(databaseResult)).toMatchObject({
      ok: false,
      code: 'DATABASE_UNAVAILABLE',
      retryable: true,
    });
  });

  it('uses shared HTTP error codes, including merchant selection, without leaking exceptions', () => {
    expect(toWorkBuddyMcpToolError(new MerchantSelectionRequiredError())).toEqual({
      code: 'MERCHANT_SELECTION_REQUIRED',
      message: '当前账号关联多个商家，需要先在安全页面明确选择商家。',
      retryable: false,
    });
    expect(toWorkBuddyMcpToolError(new Error('secret stack marker'))).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'MCP 适配器处理请求时发生内部错误，请稍后重试。',
      retryable: true,
    });
    expect(toWorkBuddyMcpToolError(new GenerationUnavailableError())).toEqual({
      code: 'GENERATION_UNAVAILABLE',
      message: '客服草稿生成服务尚未配置，本次确认没有创建客服。',
      retryable: false,
    });
  });

  it('does not expose server-internal generation events in the advance schema', async () => {
    const service = {
      execute: vi.fn(),
      advance: vi.fn(async (_command: { event: OnboardingEvent }) => {
        throw new Error('must not be called');
      }),
    } as unknown as SkillOnboardingApplicationService;
    const { client } = await startHarness(new WorkBuddyMcpAdapter(service), 'Bearer test-token');

    const result = await client.callTool({
      name: 'h5cs_onboarding_advance',
      arguments: {
        onboarding_session_id: TEST_SESSION_ID,
        event: {
          type: 'generation_succeeded',
          assistantId: '11111111111111111111111111111111',
        },
      },
    });

    expect(result.isError).toBe(true);
    expect(service.advance).not.toHaveBeenCalled();
  });
});
