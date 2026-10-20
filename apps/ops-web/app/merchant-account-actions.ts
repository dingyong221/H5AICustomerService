'use server';
import {
  loadDatabaseConfig,
  MySqlMerchantAccountAdminRepository,
  AccountResetConflict,
  isMerchantPasswordResetReason,
} from '@h5cs/database';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { currentOperator } from './operator-actions';
import { loadOperatorAuthConfig, verifyOperatorPassword } from './operator-auth';

export type AccountResetState = { error: string | null; done: boolean };
export async function resetMerchantPassword(
  _previous: AccountResetState,
  form: FormData,
): Promise<AccountResetState> {
  const config = loadOperatorAuthConfig(),
    operator = await currentOperator();
  if (!config || !operator || (await headers()).get('origin') !== config.publicOrigin)
    return { error: '运营登录或请求来源无效。', done: false };
  const read = (key: string) =>
    typeof form.get(key) === 'string' ? (form.get(key) as string) : '';
  const merchantId = read('merchantId'),
    userId = read('userId'),
    password = read('password'),
    reason = read('reason');
  if (
    !/^[0-9a-f]{32}$/u.test(merchantId) ||
    !/^[0-9a-f]{32}$/u.test(userId) ||
    password.length < 12 ||
    password.length > 128 ||
    password !== read('passwordConfirm') ||
    !isMerchantPasswordResetReason(reason) ||
    read('confirmed') !== 'yes'
  )
    return { error: '请填写两次一致的 12–128 位新密码、选择重置原因并确认影响。', done: false };
  if (!(await verifyOperatorPassword(config, operator, read('operatorPassword'))))
    return { error: '运营密码验证失败。', done: false };
  const database = loadDatabaseConfig();
  if (!database.configured) return { error: '数据库暂不可用。', done: false };
  try {
    const affected: unknown = JSON.parse(read('affectedMerchantIds'));
    if (
      !Array.isArray(affected) ||
      !affected.every((value): value is string => typeof value === 'string')
    )
      throw new Error('Invalid scope');
    await new MySqlMerchantAccountAdminRepository(database.config).reset({
      merchantId,
      userId,
      password,
      reason,
      expectedVersion: read('version'),
      affectedMerchantIds: affected,
      operatorId: operator,
    });
    revalidatePath(`/merchants/${merchantId}`);
    revalidatePath('/');
    return { error: null, done: true };
  } catch (error) {
    return {
      error:
        error instanceof AccountResetConflict
          ? '账号或关联商家已变化，请刷新核对后重试。'
          : '无法确认重置结果，请核对审计记录后再操作，不要连续重复提交。',
      done: false,
    };
  }
}
