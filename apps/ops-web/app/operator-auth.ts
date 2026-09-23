import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SESSION_SECONDS = 8 * 60 * 60;

export type OperatorAuthConfig = Readonly<{
  username: string;
  passwordHash: string;
  sessionKey: Buffer;
  publicOrigin: string;
  secure: boolean;
}>;

export const loadOperatorAuthConfig = (
  environment: NodeJS.ProcessEnv = process.env,
): OperatorAuthConfig | null => {
  const username = environment['OPS_ADMIN_USERNAME'];
  const passwordHash = environment['OPS_ADMIN_PASSWORD_HASH'];
  const sessionKeyText = environment['OPS_SESSION_SIGNING_KEY'];
  const publicOrigin = environment['OPS_PUBLIC_ORIGIN'];
  if (!username || !passwordHash || !sessionKeyText || !publicOrigin) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(username)) return null;
  if (!/^[A-Za-z0-9_-]{43,}$/u.test(sessionKeyText)) return null;
  const sessionKey = Buffer.from(sessionKeyText, 'base64url');
  if (sessionKey.byteLength < 32) return null;
  try {
    const origin = new URL(publicOrigin);
    const loopback = origin.hostname === 'localhost' || origin.hostname === '127.0.0.1';
    if (
      origin.origin !== publicOrigin ||
      (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback))
    ) {
      return null;
    }
    return {
      username,
      passwordHash,
      sessionKey,
      publicOrigin,
      secure: origin.protocol === 'https:',
    };
  } catch {
    return null;
  }
};

export const operatorCookieName = (config: OperatorAuthConfig): string =>
  config.secure ? '__Host-h5cs_ops' : 'h5cs_ops';

export const verifyOperatorPassword = (
  config: OperatorAuthConfig,
  username: string,
  password: string,
): boolean => {
  const parts = config.passwordHash.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1] ?? '', 'base64url');
  const expected = Buffer.from(parts[2] ?? '', 'base64url');
  if (salt.byteLength < 16 || expected.byteLength !== 64 || password.length > 1_024) return false;
  const actual = scryptSync(password, salt, expected.byteLength);
  const usernameMatch = username === config.username;
  return usernameMatch && timingSafeEqual(actual, expected);
};

const signature = (config: OperatorAuthConfig, payload: string): Buffer =>
  createHmac('sha256', config.sessionKey).update(payload, 'ascii').digest();

export const createOperatorSession = (
  config: OperatorAuthConfig,
  now = Date.now(),
): string => {
  const payload = `${config.username}.${Math.floor(now / 1_000) + SESSION_SECONDS}.${randomBytes(16).toString('base64url')}`;
  return `${payload}.${signature(config, payload).toString('base64url')}`;
};

export const resolveOperatorSession = (
  config: OperatorAuthConfig,
  token: string | undefined,
  now = Date.now(),
): string | null => {
  if (!token || token.length > 512) return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [username, expires, nonce, suppliedSignature] = parts;
  if (
    username !== config.username ||
    !/^[0-9]{10}$/u.test(expires ?? '') ||
    !/^[A-Za-z0-9_-]{22}$/u.test(nonce ?? '') ||
    !/^[A-Za-z0-9_-]{43}$/u.test(suppliedSignature ?? '') ||
    Number(expires) <= Math.floor(now / 1_000)
  ) {
    return null;
  }
  const expected = signature(config, `${username}.${expires}.${nonce}`);
  const supplied = Buffer.from(suppliedSignature ?? '', 'base64url');
  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected)
    ? username ?? null
    : null;
};
