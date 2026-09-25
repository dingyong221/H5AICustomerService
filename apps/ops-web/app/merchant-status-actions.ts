'use server';

import {
  loadDatabaseConfig,
  MerchantStatusTransitionError,
  MySqlPlatformProvisioningRepository,
} from '@h5cs/database';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { currentOperator } from './operator-actions';
import { loadOperatorAuthConfig } from './operator-auth';

export type MerchantStatusActionState = Readonly<{
  error: string | null;
  done: 'active' | 'paused' | null;
}>;

export async function setMerchantPaused(
  _previous: MerchantStatusActionState,
  formData: FormData,
): Promise<MerchantStatusActionState> {
  const config = loadOperatorAuthConfig();
  const operator = await currentOperator();
  if (!config || !operator || (await headers()).get('origin') !== config.publicOrigin) {
    return { error: '运营登录或请求来源无效。', done: null };
  }
  const merchantId = formData.get('merchantId');
  const operation = formData.get('operation');
  const reason = formData.get('reason');
  const confirmed = formData.get('confirmed');
  if (
    typeof merchantId !== 'string' ||
    !/^[0-9a-f]{32}$/u.test(merchantId) ||
    (operation !== 'pause' && operation !== 'resume') ||
    typeof reason !== 'string' ||
    reason.trim().length < 5 ||
    reason.trim().length > 512 ||
    confirmed !== 'yes'
  ) {
    return { error: '请填写原因并确认操作对象与影响。', done: null };
  }
  const database = loadDatabaseConfig();
  if (!database.configured) return { error: '数据库暂不可用。', done: null };
  try {
    const done = await new MySqlPlatformProvisioningRepository(database.config).setMerchantPaused({
      merchantId,
      paused: operation === 'pause',
      reason,
      operatorId: operator,
    });
    revalidatePath('/');
    return { error: null, done };
  } catch (error) {
    return {
      error:
        error instanceof MerchantStatusTransitionError
          ? '商家状态已变化或不允许本次操作；请刷新列表核对后再试。'
          : '操作结果暂无法确认；请刷新商家列表及审计记录，不要盲目重复提交。',
      done: null,
    };
  }
}
