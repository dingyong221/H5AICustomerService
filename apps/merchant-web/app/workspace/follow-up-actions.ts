'use server';

import { loadDatabaseConfig, MySqlMerchantConversationRepository } from '@h5cs/database';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { currentMerchantForWrite } from '../account/merchant-actions';
import { validFollowUpStatus } from './follow-up-status';

export type FollowUpActionState = Readonly<{ error: string | null; saved: boolean }>;

export async function updateFollowUpStatus(
  _previous: FollowUpActionState,
  formData: FormData,
): Promise<FollowUpActionState> {
  const expectedOrigin = process.env['MERCHANT_PUBLIC_ORIGIN'];
  if (!expectedOrigin || (await headers()).get('origin') !== expectedOrigin) {
    return { error: '请求来源校验失败。', saved: false };
  }
  const merchantId = formData.get('merchantId');
  const sessionId = formData.get('sessionId');
  const csrfToken = formData.get('csrfToken');
  const statusValue = formData.get('status');
  const status = typeof statusValue === 'string' ? validFollowUpStatus(statusValue) : null;
  if (
    typeof merchantId !== 'string' ||
    !/^[0-9a-f]{32}$/u.test(merchantId) ||
    typeof sessionId !== 'string' ||
    !/^[0-9a-f]{32}$/u.test(sessionId) ||
    typeof csrfToken !== 'string' ||
    !status
  ) {
    return { error: '跟进状态参数无效。', saved: false };
  }
  const member = await currentMerchantForWrite(merchantId, csrfToken);
  if (!member) return { error: '登录已失效或无权操作此商家。', saved: false };
  const database = loadDatabaseConfig();
  if (!database.configured) return { error: '数据库暂不可用。', saved: false };
  try {
    await new MySqlMerchantConversationRepository(database.config).setFollowUpStatus({
      merchantId,
      merchantUserId: member.merchantUserId,
      sessionId,
      status,
    });
    revalidatePath(`/workspace/${merchantId}/conversations`);
    revalidatePath(`/workspace/${merchantId}/conversations/${sessionId}`);
    return { error: null, saved: true };
  } catch {
    return { error: '更新失败；请刷新页面确认状态后再试。', saved: false };
  }
}
