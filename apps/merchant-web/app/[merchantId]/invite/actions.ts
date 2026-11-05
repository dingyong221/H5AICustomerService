'use server';
import { headers } from 'next/headers';
import { growthEnabled, loadDatabaseConfig, MySqlGrowthUsageRepository } from '@h5cs/database';
import { currentMerchantForWrite } from '../../account/merchant-actions';
export async function createInvitation(
  _previous: { error: string | null; url: string | null },
  form: FormData,
) {
  const origin = process.env['MERCHANT_PUBLIC_ORIGIN'];
  if (!growthEnabled() || !origin || (await headers()).get('origin') !== origin)
    return { error: '邀请暂未开放或请求来源无效。', url: null };
  const merchantId = String(form.get('merchantId') ?? ''),
    session = await currentMerchantForWrite(merchantId, String(form.get('csrfToken') ?? ''));
  if (!session) return { error: '请重新登录当前商家。', url: null };
  const database = loadDatabaseConfig();
  if (!database.configured) return { error: '邀请服务暂不可用。', url: null };
  try {
    const code = await new MySqlGrowthUsageRepository(database.config).invitation(
      merchantId,
      session.merchantUserId,
      true,
    );
    return { error: null, url: code ? origin + '/console/r/' + code : null };
  } catch {
    return { error: '请先完成客服发布；只有商家负责人可以生成邀请。', url: null };
  }
}
