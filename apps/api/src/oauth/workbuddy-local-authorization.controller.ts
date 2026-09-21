import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Headers,
  Post,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';

import {
  WorkBuddyLocalAuthorizationService,
  WorkBuddyLocalAuthorizationUnavailableError,
  WorkBuddyAuthorizationTransactionInvalidError,
  WorkBuddyMerchantSelectionInvalidError,
  WorkBuddyMutationContextInvalidError,
  type WorkBuddyAuthorizationResult,
} from './workbuddy-local-authorization.service.js';

const callbackSchema = z
  .object({
    code: z.string().regex(/^\S{8,2048}$/u),
    state: z.string().regex(/^[A-Za-z0-9_-]{32,512}$/u),
  })
  .strict();

const transactionRefSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const statusSchema = z.object({ transaction_ref: transactionRefSchema.optional() }).strict();
const consentSchema = z
  .object({
    decision: z.enum(['grant', 'deny']),
    transaction_ref: transactionRefSchema,
  })
  .strict();
const merchantSelectionSchema = z
  .object({
    candidate_ref: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9:_-]{0,190})$/u),
    transaction_ref: transactionRefSchema,
  })
  .strict();

@Controller('/api/v1/auth/workbuddy')
export class WorkBuddyLocalAuthorizationController {
  public constructor(private readonly authorization: WorkBuddyLocalAuthorizationService) {}

  @Post('/authorizations')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  public async start(
    @Headers('cookie') cookieHeader: string | undefined,
    @Headers('origin') origin: string | undefined,
    @Headers('x-csrf-token') csrfToken: string | undefined,
  ): Promise<WorkBuddyAuthorizationResult> {
    return this.#run(() =>
      this.authorization.startAuthorization({ cookieHeader, csrfToken, origin }),
    );
  }

  @Get('/callback')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  public async callback(
    @Query() query: unknown,
    @Headers('cookie') cookieHeader?: string,
  ): Promise<WorkBuddyAuthorizationResult> {
    const parsed = callbackSchema.safeParse(query);
    if (!parsed.success) throw this.#badRequest('Invalid WorkBuddy authorization callback');
    return this.#run(() =>
      this.authorization.completeCallback({
        authorizationCode: parsed.data.code,
        cookieHeader,
        state: parsed.data.state,
      }),
    );
  }

  @Get('/status')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  public async status(
    @Query() query: unknown,
    @Headers('cookie') cookieHeader: string | undefined,
  ): Promise<WorkBuddyAuthorizationResult> {
    const parsed = statusSchema.safeParse(query);
    if (!parsed.success) throw this.#badRequest('Invalid authorization transaction reference');
    return this.#run(() =>
      this.authorization.readStatus(cookieHeader, parsed.data.transaction_ref),
    );
  }

  @Post('/consent')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  public async consent(
    @Headers('cookie') cookieHeader: string | undefined,
    @Headers('origin') origin: string | undefined,
    @Headers('x-csrf-token') csrfToken: string | undefined,
    @Body() body: unknown,
  ): Promise<WorkBuddyAuthorizationResult> {
    const parsed = consentSchema.safeParse(body);
    if (!parsed.success) throw this.#badRequest('Invalid WorkBuddy consent decision');
    return this.#run(() =>
      this.authorization.recordConsent(
        { cookieHeader, csrfToken, origin },
        parsed.data.transaction_ref,
        parsed.data.decision,
      ),
    );
  }

  @Post('/merchant-selection')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  public async selectMerchant(
    @Headers('cookie') cookieHeader: string | undefined,
    @Headers('origin') origin: string | undefined,
    @Headers('x-csrf-token') csrfToken: string | undefined,
    @Body() body: unknown,
  ): Promise<WorkBuddyAuthorizationResult> {
    const parsed = merchantSelectionSchema.safeParse(body);
    if (!parsed.success) throw this.#badRequest('Invalid merchant selection');
    return this.#run(() =>
      this.authorization.selectMerchant(
        { cookieHeader, csrfToken, origin },
        parsed.data.transaction_ref,
        parsed.data.candidate_ref,
      ),
    );
  }

  async #run(operation: () => Promise<WorkBuddyAuthorizationResult>) {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof WorkBuddyLocalAuthorizationUnavailableError) {
        throw new ServiceUnavailableException({
          code: 'SERVICE_UNAVAILABLE',
          message: 'WorkBuddy authorization is unavailable',
          retryable: true,
        });
      }
      if (error instanceof WorkBuddyMerchantSelectionInvalidError) {
        throw this.#badRequest('Invalid merchant selection');
      }
      if (error instanceof WorkBuddyAuthorizationTransactionInvalidError) {
        throw new ConflictException({
          code: 'CONFLICT',
          message: 'Authorization transaction is no longer valid',
          retryable: false,
        });
      }
      if (error instanceof WorkBuddyMutationContextInvalidError) {
        throw new ForbiddenException({
          code: 'FORBIDDEN',
          message: 'Mutation request verification failed',
          retryable: false,
        });
      }
      throw error;
    }
  }

  #badRequest(message: string): BadRequestException {
    return new BadRequestException({ code: 'BAD_REQUEST', message, retryable: false });
  }
}
