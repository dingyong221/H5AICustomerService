import { OAuthAuthorizationServer } from './oauth-authorization-server.js';
import { McpAccessTokenAuthenticator } from './mcp-access-token-authenticator.js';
import { McpOAuthTokenVerifier } from './mcp-oauth-token-verifier.js';
import type { OAuthResourceOwnerAuthorizer, OAuthServerConfig } from './oauth-types.js';
import {
  UnavailableOAuthAccessTokenCodec,
  UnavailableOAuthIdentityBindingResolver,
  UnavailableOAuthRepository,
  UnavailableOAuthResourceOwnerAuthorizer,
} from './unavailable-adapters.js';

const validBaseUrl = (value: string): string => {
  const url = new URL(value);
  const isLoopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    url.pathname !== '/'
  ) {
    throw new Error('OAUTH_ISSUER must be HTTPS, except for an HTTP loopback development issuer');
  }
  return url.toString().replace(/\/$/u, '');
};

export const loadOAuthServerConfig = (
  environment: NodeJS.ProcessEnv = process.env,
): OAuthServerConfig => {
  const configuredIssuer = environment['OAUTH_ISSUER'];
  if (configuredIssuer === undefined && environment['NODE_ENV'] === 'production') {
    throw new Error('OAUTH_ISSUER is required in production');
  }
  const issuer = validBaseUrl(configuredIssuer ?? 'http://localhost:3000');
  const resourceUrl = new URL(environment['OAUTH_MCP_RESOURCE'] ?? `${issuer}/mcp`);
  if (
    resourceUrl.origin !== new URL(issuer).origin ||
    resourceUrl.pathname !== '/mcp' ||
    resourceUrl.username.length > 0 ||
    resourceUrl.password.length > 0 ||
    resourceUrl.search.length > 0 ||
    resourceUrl.hash.length > 0
  ) {
    throw new Error('OAUTH_MCP_RESOURCE must be the issuer origin with the exact /mcp path');
  }
  const resource = resourceUrl.toString();
  const workbuddyConnectorSource = environment['WORKBUDDY_CONNECTOR_SOURCE'];
  if (
    workbuddyConnectorSource !== undefined &&
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(workbuddyConnectorSource)
  ) {
    throw new Error('WORKBUDDY_CONNECTOR_SOURCE must be a lowercase kebab-case source');
  }
  return {
    issuer,
    resource,
    ...(workbuddyConnectorSource === undefined ? {} : { workbuddyConnectorSource }),
    authorizationEndpoint: `${issuer}/oauth/authorize`,
    tokenEndpoint: `${issuer}/oauth/token`,
    registrationEndpoint: `${issuer}/oauth/register`,
    accessTokenTtlSeconds: 600,
    authorizationCodeTtlSeconds: 60,
    refreshTokenTtlSeconds: 30 * 24 * 60 * 60,
  };
};

export class OAuthRuntime {
  public readonly server: OAuthAuthorizationServer;
  public readonly resourceOwner: OAuthResourceOwnerAuthorizer;
  public readonly authenticator: McpAccessTokenAuthenticator;
  public readonly tokenVerifier: McpOAuthTokenVerifier;
  public readonly protectedResourceMetadataUrl: string;

  public constructor(
    server: OAuthAuthorizationServer,
    resourceOwner: OAuthResourceOwnerAuthorizer,
    authenticator: McpAccessTokenAuthenticator,
    tokenVerifier: McpOAuthTokenVerifier,
    protectedResourceMetadataUrl: string,
  ) {
    this.server = server;
    this.resourceOwner = resourceOwner;
    this.authenticator = authenticator;
    this.tokenVerifier = tokenVerifier;
    this.protectedResourceMetadataUrl = protectedResourceMetadataUrl;
  }
}

export const createRuntimeOAuth = (environment: NodeJS.ProcessEnv = process.env): OAuthRuntime => {
  const config = loadOAuthServerConfig(environment);
  // Production persistence and signing are deliberately unavailable until dedicated adapters and
  // key management are configured. Never substitute process-local state or a development identity.
  const repository = new UnavailableOAuthRepository();
  const accessTokens = new UnavailableOAuthAccessTokenCodec();
  const bindings = new UnavailableOAuthIdentityBindingResolver();
  const resourceOwner = new UnavailableOAuthResourceOwnerAuthorizer();
  const protectedResourceMetadataUrl = `${config.issuer}/.well-known/oauth-protected-resource/mcp`;
  return new OAuthRuntime(
    new OAuthAuthorizationServer(config, repository, accessTokens),
    resourceOwner,
    new McpAccessTokenAuthenticator(accessTokens, bindings),
    new McpOAuthTokenVerifier(accessTokens, config.resource),
    protectedResourceMetadataUrl,
  );
};
