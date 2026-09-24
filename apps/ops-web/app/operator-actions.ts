'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';

import {
  loadDatabaseConfig,
  MerchantInvitationNotReissuableError,
  MySqlPlatformProvisioningRepository,
} from '@h5cs/database';

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

const managementBaseUrl = (): URL | null => {
  const value = process.env['MANAGEMENT_CONSOLE_URL'];
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.pathname !== '/' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
};

const setupUrl = (base: URL, token: string): string => `${base.origin}/setup#${token}`;

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
    !(await verifyOperatorPassword(config, username, password))
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
  const base = managementBaseUrl();
  if (!base) return { error: '商家后台地址尚未正确配置。', created: null };

  try {
    const repository = new MySqlPlatformProvisioningRepository(database.config);
    const created = await repository.provisionMerchant({ name, operatorId: operator });
    return {
      error: null,
      created: {
        name: created.name,
        setupUrl: setupUrl(base, created.setupToken),
        expiresAt: created.setupExpiresAt.toISOString(),
      },
    };
  } catch {
    return {
      error:
        '创建结果暂无法确认。请先刷新商家列表；若已出现等待领取的商家，请重新签发链接，不要重复创建。',
      created: null,
    };
  }
}

export async function reissueMerchantInvitation(
  _previous: ProvisionActionState,
  formData: FormData,
): Promise<ProvisionActionState> {
  const config = loadOperatorAuthConfig();
  const operator = await currentOperator();
  if (!config || !operator) return { error: '登录已失效，请重新登录。', created: null };
  if (!(await requestOriginValid(config.publicOrigin))) {
    return { error: '请求来源校验失败。', created: null };
  }
  const merchantId = formData.get('merchantId');
  const confirmation = formData.get('confirm');
  if (
    typeof merchantId !== 'string' ||
    !/^[0-9a-f]{32}$/u.test(merchantId) ||
    confirmation !== 'invalidate_previous'
  ) {
    return { error: '请选择未领取的商家并确认旧链接立即失效。', created: null };
  }
  const database = loadDatabaseConfig();
  if (!database.configured) return { error: '数据库暂不可用。', created: null };
  const base = managementBaseUrl();
  if (!base) return { error: '商家后台地址尚未正确配置。', created: null };
  try {
    const repository = new MySqlPlatformProvisioningRepository(database.config);
    const created = await repository.reissueInvitation({ merchantId, operatorId: operator });
    return {
      error: null,
      created: {
        name: created.name,
        setupUrl: setupUrl(base, created.setupToken),
        expiresAt: created.setupExpiresAt.toISOString(),
      },
    };
  } catch (error) {
    return {
      error:
        error instanceof MerchantInvitationNotReissuableError
          ? '商家已领取或不存在，不能重新签发。'
          : '重新签发失败；如结果不确定，请刷新商家状态后再操作。',
      created: null,
    };
  }
}
