import { loadDatabaseConfig, MySqlAssistantLifecycleRepository } from '@h5cs/database';
import { toAssistantId, toMerchantId, toMerchantUserId } from '@h5cs/domain';
import { notFound, redirect } from 'next/navigation';
import { currentMerchant } from './account/merchant-actions';
import { merchantPath } from './tenant-paths';
import type { PublicationGovernance } from './workspace/governance-model';

export async function requireMerchant(merchantId: string, next?: string) {
  if (!/^[0-9a-f]{32}$/u.test(merchantId)) notFound();
  const member = await currentMerchant(merchantId);
  if (!member)
    redirect(
      `/console/account/login?merchant=${merchantId}&next=${encodeURIComponent(next ?? merchantPath(merchantId))}`,
    );
  return member;
}

export async function merchantAssistantGovernance(
  merchantId: string,
  assistantIds: readonly string[],
) {
  const member = await requireMerchant(merchantId);
  const database = loadDatabaseConfig();
  if (!database.configured) return new Map<string, PublicationGovernance | null>();
  const repository = new MySqlAssistantLifecycleRepository(database.config);
  const values = await Promise.all(
    assistantIds.slice(0, 5).map(async (assistantId) => {
      try {
        return [
          assistantId,
          await repository.getPublicationGovernance({
            merchantId: toMerchantId(merchantId),
            assistantId: toAssistantId(assistantId),
            merchantUserId: toMerchantUserId(member.merchantUserId),
            now: new Date(),
          }),
        ] as const;
      } catch {
        return [assistantId, null] as const;
      }
    }),
  );
  return new Map(values);
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
