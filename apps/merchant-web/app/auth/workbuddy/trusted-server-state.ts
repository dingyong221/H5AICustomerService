import { workBuddyAuthorizationResultSchema } from '@h5cs/contracts';

import type { TrustedWorkBuddyAuthorizationSnapshot } from './connection-view-model';

export type TrustedWorkBuddyAuthorizationStateSource = () => Promise<unknown>;

const unavailableSnapshot: TrustedWorkBuddyAuthorizationSnapshot = {
  status: 'backend_unavailable',
};

export async function loadTrustedWorkBuddyAuthorizationSnapshot(
  source?: TrustedWorkBuddyAuthorizationStateSource,
): Promise<TrustedWorkBuddyAuthorizationSnapshot> {
  if (source === undefined) return unavailableSnapshot;

  try {
    const parsed = workBuddyAuthorizationResultSchema.safeParse(await source());
    return parsed.success ? parsed.data : unavailableSnapshot;
  } catch {
    return unavailableSnapshot;
  }
}
