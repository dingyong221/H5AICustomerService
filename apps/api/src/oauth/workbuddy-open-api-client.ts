import { z } from 'zod';

const WORKBUDDY_ISSUER = 'https://www.workbuddy.cn' as const;
const WORKBUDDY_AUTHORIZE_ENDPOINT = `${WORKBUDDY_ISSUER}/openapi/v2/authorize`;
const WORKBUDDY_TOKEN_ENDPOINT = `${WORKBUDDY_ISSUER}/openapi/v2/token`;
const MAX_RESPONSE_BYTES = 64 * 1024;

const nonSecretIdentifierSchema = z.string().trim().min(1).max(256);
const secretSchema = z.string().min(16).max(4_096);
const redirectUriSchema = z
  .string()
  .url()
  .max(2_048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        url.username.length === 0 &&
        url.password.length === 0 &&
        url.search.length === 0 &&
        url.hash.length === 0
      );
    } catch {
      return false;
    }
  }, 'WorkBuddy callback must be a clean HTTPS URL');
const scopeSchema = z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$/u);
const authorizationCodeSchema = z.string().regex(/^\S{8,2048}$/u);
const stateSchema = z.string().regex(/^[A-Za-z0-9_-]{32,512}$/u);

const tokenResponseSchema = z
  .object({
    access_token: z.string().min(16).max(16_384),
    token_type: z.literal('Bearer'),
    expires_in: z
      .number()
      .int()
      .positive()
      .max(366 * 24 * 60 * 60),
    refresh_token: z.string().min(16).max(16_384),
    scope: z.string().max(2_048),
    open_id: z.string().regex(/^\S{1,512}$/u),
  })
  .strict();

export type WorkBuddyOpenApiConfig = Readonly<{
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  requestedScopes: readonly string[];
}>;

export type WorkBuddyOpenApiClientConfigResult =
  | Readonly<{ configured: false; reason: 'WorkBuddy Open API credentials are not set' }>
  | Readonly<{ configured: true; client: WorkBuddyOpenApiClient }>;

type WorkBuddyOpenApiTokenLease = Readonly<{
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  grantedScopes: readonly string[];
  openId: string;
}>;

export class WorkBuddyOpenApiConfigurationError extends Error {
  public constructor(message = 'WorkBuddy Open API configuration is invalid') {
    super(message);
    this.name = 'WorkBuddyOpenApiConfigurationError';
  }
}

export class WorkBuddyOpenApiExchangeError extends Error {
  public readonly retryable = false;

  public constructor() {
    super('WorkBuddy authorization code exchange failed');
    this.name = 'WorkBuddyOpenApiExchangeError';
  }
}

type FetchImplementation = typeof fetch;

const validateConfig = (config: WorkBuddyOpenApiConfig): WorkBuddyOpenApiConfig => {
  const clientId = nonSecretIdentifierSchema.safeParse(config.clientId);
  const clientSecret = secretSchema.safeParse(config.clientSecret);
  const redirectUri = redirectUriSchema.safeParse(config.redirectUri);
  const scopes = z.array(scopeSchema).min(1).max(10).safeParse(config.requestedScopes);
  if (!clientId.success || !clientSecret.success || !redirectUri.success || !scopes.success) {
    throw new WorkBuddyOpenApiConfigurationError();
  }
  if (new Set(scopes.data).size !== scopes.data.length) {
    throw new WorkBuddyOpenApiConfigurationError('WorkBuddy Open API scopes must be unique');
  }
  return {
    clientId: clientId.data,
    clientSecret: clientSecret.data,
    redirectUri: redirectUri.data,
    requestedScopes: scopes.data,
  };
};

const parseGrantedScopes = (value: string): readonly string[] => {
  if (value.trim().length === 0) return [];
  const parsed = z.array(scopeSchema).max(20).safeParse(value.trim().split(/ +/u));
  if (!parsed.success || new Set(parsed.data).size !== parsed.data.length) {
    throw new WorkBuddyOpenApiExchangeError();
  }
  return parsed.data;
};

export class WorkBuddyOpenApiClient {
  readonly #config: WorkBuddyOpenApiConfig;
  readonly #fetch: FetchImplementation;

  public constructor(
    config: WorkBuddyOpenApiConfig,
    fetchImplementation: FetchImplementation = fetch,
  ) {
    this.#config = validateConfig(config);
    this.#fetch = fetchImplementation;
  }

  public get issuer(): typeof WORKBUDDY_ISSUER {
    return WORKBUDDY_ISSUER;
  }

  public get clientId(): string {
    return this.#config.clientId;
  }

  public buildAuthorizationUrl(state: string): string {
    const parsedState = stateSchema.safeParse(state);
    if (!parsedState.success)
      throw new WorkBuddyOpenApiConfigurationError('OAuth state is invalid');

    const url = new URL(WORKBUDDY_AUTHORIZE_ENDPOINT);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.#config.clientId);
    url.searchParams.set('redirect_uri', this.#config.redirectUri);
    if (this.#config.requestedScopes.length > 0) {
      url.searchParams.set('scope', this.#config.requestedScopes.join(' '));
    }
    url.searchParams.set('state', parsedState.data);
    return url.toString();
  }

  public async exchangeAuthorizationCode(code: string): Promise<WorkBuddyOpenApiTokenLease> {
    const parsedCode = authorizationCodeSchema.safeParse(code);
    if (!parsedCode.success) throw new WorkBuddyOpenApiExchangeError();

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: parsedCode.data,
      client_id: this.#config.clientId,
      client_secret: this.#config.clientSecret,
      redirect_uri: this.#config.redirectUri,
    });

    let response: Response;
    try {
      response = await this.#fetch(WORKBUDDY_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // State is consumed before exchange, so an ambiguous failure must restart the bridge flow.
      throw new WorkBuddyOpenApiExchangeError();
    }

    if (!response.ok) {
      throw new WorkBuddyOpenApiExchangeError();
    }
    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      throw new WorkBuddyOpenApiExchangeError();
    }

    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new WorkBuddyOpenApiExchangeError();
    }
    let unknownResponse: unknown;
    try {
      unknownResponse = JSON.parse(text);
    } catch {
      throw new WorkBuddyOpenApiExchangeError();
    }
    const parsed = tokenResponseSchema.safeParse(unknownResponse);
    if (!parsed.success) throw new WorkBuddyOpenApiExchangeError();

    const grantedScopes = parseGrantedScopes(parsed.data.scope);
    if (
      grantedScopes.length !== this.#config.requestedScopes.length ||
      grantedScopes.some((scope) => !this.#config.requestedScopes.includes(scope))
    ) {
      throw new WorkBuddyOpenApiExchangeError();
    }

    return {
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token,
      expiresInSeconds: parsed.data.expires_in,
      grantedScopes,
      openId: parsed.data.open_id,
    };
  }
}

export const loadWorkBuddyOpenApiClient = (
  environment: NodeJS.ProcessEnv = process.env,
  fetchImplementation: FetchImplementation = fetch,
): WorkBuddyOpenApiClientConfigResult => {
  const clientId = environment['WORKBUDDY_OPEN_API_CLIENT_ID'];
  const clientSecret = environment['WORKBUDDY_OPEN_API_CLIENT_SECRET'];
  const redirectUri = environment['WORKBUDDY_OPEN_API_REDIRECT_URI'];
  const rawScopes = environment['WORKBUDDY_OPEN_API_SCOPES'];
  const values = [clientId, clientSecret, redirectUri, rawScopes];
  const isUnset = (value: string | undefined): boolean =>
    value === undefined || value.trim() === '';
  if (values.every(isUnset)) {
    return { configured: false, reason: 'WorkBuddy Open API credentials are not set' };
  }
  if (values.some(isUnset)) {
    throw new WorkBuddyOpenApiConfigurationError(
      'WorkBuddy Open API configuration must be supplied as one complete set',
    );
  }

  return {
    configured: true,
    client: new WorkBuddyOpenApiClient(
      {
        clientId: clientId as string,
        clientSecret: clientSecret as string,
        redirectUri: redirectUri as string,
        requestedScopes: (rawScopes as string).split(' ').filter((scope) => scope.length > 0),
      },
      fetchImplementation,
    ),
  };
};
