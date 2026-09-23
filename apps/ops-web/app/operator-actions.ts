'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { loadDatabaseConfig, MySqlPlatformProvisioningRepository } from '@h5cs/database';

import {
  createOperatorSession,
  loadOperatorAuthConfig,
  operatorCookieName,
  resolveOperatorSession,
  verifyOperatorPassword,
} from './operator-auth';

export type LoginActionState = { error: string | null };
export type ProvisionActionState = {
  error: string | null;
  created: { name: string; setupUrl: string; expiresAt: string } | null;
};

const requestOriginValid = async (expected: string): Promise<boolean> => {
  const origin = (await headers()).get('origin');
  return origin === expected;
};

export async function currentOperator(): Promise<string | null> {
  const config = loadOperatorAuthConfig();
  if (!config) return null;
  const token = (await cookies()).get(operatorCookieName(config))?.value;
  return resolveOperatorSession(config, token);
}

export async function loginOperator(
  _previous: LoginActionState,
  formData: FormData,
): Promise<LoginActionState> {
  const config = loadOperatorAuthConfig();
  if (!config) return { error: '运营登录尚未配置，请联系部署管理员。' };
  if (!(await requestOriginValid(config.publicOrigin))) {
    return { error: '请求来源校验失败，请从正式运营地址重新打开。' };
  }
  const username = formData.get('username');
  const password = formData.get('password');
  if (
    typeof username !== 'string' ||
    typeof password !== 'string' ||
    !verifyOperatorPassword(config, username, password)
  ) {
    return { error: '账号或密码不正确。' };
  }
  (await cookies()).set(operatorCookieName(config), createOperatorSession(config), {
    httpOnly: true,
    secure: config.secure,
    sameSite: 'strict',
    path: '/',
    maxAge: 8 * 60 * 60,
  });
  redirect('/');
}

export async function logoutOperator(): Promise<void> {
  const config = loadOperatorAuthConfig();
  if (!config || !(await requestOriginValid(config.publicOrigin))) return;
  (await cookies()).delete(operatorCookieName(config));
  redirect('/login');
}

export async function provisionMerchant(
  _previous: ProvisionActionState,
  formData: FormData,
): Promise<ProvisionActionState> {
  const config = loadOperatorAuthConfig();
  const operator = await currentOperator();
  if (!config || !operator) return { error: '登录已失效，请重新登录。', created: null };
  if (!(await requestOriginValid(config.publicOrigin))) {
    return { error: '请求来源校验失败。', created: null };
  }
  const name = formData.get('name');
  if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 200) {
    return { error: '商家名称须为 2–200 个字符。', created: null };
  }
  const database = loadDatabaseConfig();
  if (!database.configured) return { error: '数据库尚未配置，无法创建商家。', created: null };
  const managementUrl = process.env['MANAGEMENT_CONSOLE_URL'];
  if (!managementUrl) return { error: '商家后台地址尚未配置。', created: null };
  let base: URL;
  try {
    base = new URL(managementUrl);
    if (
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      (base.protocol !== 'https:' &&
        !(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname)))
    ) {
      throw new Error('Invalid management URL');
    }
  } catch {
    return { error: '商家后台地址配置无效。', created: null };
  }

  try {
    const repository = new MySqlPlatformProvisioningRepository(database.config);
    const created = await repository.provisionMerchant({ name, operatorId: operator });
    const setupUrl = `${base.toString().replace(/\/$/u, '')}/setup#${created.setupToken}`;
    return {
      error: null,
      created: { name: created.name, setupUrl, expiresAt: created.setupExpiresAt.toISOString() },
    };
  } catch {
    return { error: '创建商家失败，未生成有效链接。请检查数据库连接并重试。', created: null };
  }
}
