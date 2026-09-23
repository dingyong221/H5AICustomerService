'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { loadDatabaseConfig, MerchantAccessError, MySqlMerchantAccessRepository } from '@h5cs/database';

export type MerchantAccessState = Readonly<{ error: string | null }>;

const getRepository = (): MySqlMerchantAccessRepository | null => {
  const database = loadDatabaseConfig();
  const key = process.env['MERCHANT_PHONE_LOOKUP_KEY'];
  if (!database.configured || !key) return null;
  try {
    return new MySqlMerchantAccessRepository(database.config, key);
  } catch {
    return null;
  }
};

const merchantOrigin = (): URL | null => {
  try {
    const value = process.env['MERCHANT_PUBLIC_ORIGIN'];
    if (!value) return null;
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1'].includes(url.hostname);
    if (
      url.origin !== value ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    ) return null;
    return url;
  } catch {
    return null;
  }
};

const sameOrigin = async (expected: URL): Promise<boolean> =>
  (await headers()).get('origin') === expected.origin;

const sessionCookieName = (secure: boolean): string =>
  secure ? '__Host-h5cs_session' : 'h5cs_session';

const csrfCookieName = (secure: boolean): string =>
  secure ? '__Host-h5cs-csrf' : 'h5cs_csrf';

const setSession = async (session: { sessionToken: string; csrfToken: string }): Promise<void> => {
  const origin = merchantOrigin();
  if (!origin) throw new MerchantAccessError('商家后台域名未配置');
  const secure = origin.protocol === 'https:';
  const store = await cookies();
  store.set(sessionCookieName(secure), session.sessionToken, {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: '/',
    maxAge: 12 * 60 * 60,
  });
  store.set(csrfCookieName(secure), session.csrfToken, {
    httpOnly: false,
    secure,
    sameSite: 'strict',
    path: '/',
    maxAge: 12 * 60 * 60,
  });
};

export async function currentMerchant(merchantId: string) {
  const repository = getRepository();
  const origin = merchantOrigin();
  if (!repository || !origin) return null;
  const token = (await cookies()).get(sessionCookieName(origin.protocol === 'https:'))?.value;
  if (!token) return null;
  try {
    return await repository.resolveSession(token, merchantId);
  } catch {
    return null;
  }
}

export async function claimMerchant(
  _previous: MerchantAccessState,
  formData: FormData,
): Promise<MerchantAccessState> {
  const origin = merchantOrigin();
  const repository = getRepository();
  if (!origin || !repository) return { error: '商家账号服务尚未配置。' };
  if (!(await sameOrigin(origin))) return { error: '请求来源校验失败。' };
  const setupToken = formData.get('setupToken');
  const phone = formData.get('phone');
  const password = formData.get('password');
  if (
    typeof setupToken !== 'string' ||
    typeof phone !== 'string' ||
    typeof password !== 'string'
  ) return { error: '请填写完整的领取信息。' };
  let merchantId: string;
  try {
    const session = await repository.claimInvitation({ setupToken, phone, password });
    await setSession(session);
    merchantId = session.merchantId;
  } catch (error) {
    return { error: error instanceof MerchantAccessError ? error.message : '领取失败，请稍后重试。' };
  }
  redirect(`/workspace/${merchantId}`);
}

export async function loginMerchant(
  _previous: MerchantAccessState,
  formData: FormData,
): Promise<MerchantAccessState> {
  const origin = merchantOrigin();
  const repository = getRepository();
  if (!origin || !repository) return { error: '商家账号服务尚未配置。' };
  if (!(await sameOrigin(origin))) return { error: '请求来源校验失败。' };
  const phone = formData.get('phone');
  const password = formData.get('password');
  const merchantIdInput = formData.get('merchantId');
  if (typeof phone !== 'string' || typeof password !== 'string') {
    return { error: '请输入手机号和密码。' };
  }
  let merchantId: string;
  try {
    const session = await repository.login({
      phone,
      password,
      ...(typeof merchantIdInput === 'string' && merchantIdInput
        ? { merchantId: merchantIdInput }
        : {}),
    });
    await setSession(session);
    merchantId = session.merchantId;
  } catch (error) {
    return { error: error instanceof MerchantAccessError ? error.message : '登录失败，请稍后重试。' };
  }
  redirect(`/workspace/${merchantId}`);
}
