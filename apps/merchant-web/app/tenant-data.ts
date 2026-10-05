import { loadDatabaseConfig, MySqlAssistantLifecycleRepository } from '@h5cs/database';
import { toMerchantId, toMerchantUserId } from '@h5cs/domain';
import { notFound, redirect } from 'next/navigation';
import { currentMerchant } from './account/merchant-actions';
import { merchantPath } from './tenant-paths';

export async function requireMerchant(merchantId: string, next?: string) {
  if (!/^[0-9a-f]{32}$/u.test(merchantId)) notFound();
  const member = await currentMerchant(merchantId);
  if (!member)
    redirect(
      `/console/account/login?merchant=${merchantId}&next=${encodeURIComponent(next ?? merchantPath(merchantId))}`,
    );
  return member;
}

export async function merchantAssistants(merchantId: string, next?: string) {
  const member = await requireMerchant(merchantId, next);
  const database = loadDatabaseConfig();
  if (!database.configured) throw new Error('Merchant database unavailable');
  return new MySqlAssistantLifecycleRepository(database.config).listMerchantAssistants(
    toMerchantUserId(member.merchantUserId),
    toMerchantId(merchantId),
  );
}
