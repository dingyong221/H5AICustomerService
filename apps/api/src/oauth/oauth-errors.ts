import type { OAuthErrorResponse } from '@h5cs/contracts';

export class OAuthProtocolError extends Error {
  public readonly error: OAuthErrorResponse['error'];
  public readonly statusCode: number;
  public readonly redirectUri: string | undefined;
  public readonly state: string | undefined;

  public constructor(
    error: OAuthErrorResponse['error'],
    description: string,
    statusCode = 400,
    redirect?: Readonly<{ redirectUri: string; state?: string | undefined }>,
  ) {
    super(description);
    this.name = 'OAuthProtocolError';
    this.error = error;
    this.statusCode = statusCode;
    this.redirectUri = redirect?.redirectUri;
    this.state = redirect?.state;
  }

  public toResponse(): OAuthErrorResponse {
    return { error: this.error, error_description: this.message };
  }
}

export class OAuthStorageUnavailableError extends Error {
  public constructor(reason = 'OAuth persistence is not configured') {
    super(reason);
    this.name = 'OAuthStorageUnavailableError';
  }
}

export class OAuthTokenCodecUnavailableError extends Error {
  public constructor(reason = 'OAuth token signing and verification are not configured') {
    super(reason);
    this.name = 'OAuthTokenCodecUnavailableError';
  }
}

export class OAuthAccessTokenInvalidError extends Error {
  public constructor() {
    super('MCP access token is invalid');
    this.name = 'OAuthAccessTokenInvalidError';
  }
}

export class OAuthIdentityBindingUnavailableError extends Error {
  public constructor(reason = 'OAuth identity binding resolution is not configured') {
    super(reason);
    this.name = 'OAuthIdentityBindingUnavailableError';
  }
}

export class OAuthResourceOwnerUnavailableError extends Error {
  public constructor(reason = 'OAuth resource-owner authorization is not configured') {
    super(reason);
    this.name = 'OAuthResourceOwnerUnavailableError';
  }
}
