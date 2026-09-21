import {
  decodeTrustedWorkBuddyAuthorizationSnapshot,
  type TrustedWorkBuddyAuthorizationSnapshot,
} from './connection-view-model';

export type TrustedWorkBuddyAuthorizationStateSource = () => Promise<unknown>;

const unavailableSnapshot: TrustedWorkBuddyAuthorizationSnapshot = {
  stage: 'backend_unavailable',
};

export async function loadTrustedWorkBuddyAuthorizationSnapshot(
  source?: TrustedWorkBuddyAuthorizationStateSource,
): Promise<TrustedWorkBuddyAuthorizationSnapshot> {
  // No account/session/consent backend route is wired in this increment. Query parameters and
  // environment-provided state are intentionally not fallbacks for this server-owned snapshot.
  if (source === undefined) return unavailableSnapshot;

  try {
    return decodeTrustedWorkBuddyAuthorizationSnapshot(await source()) ?? unavailableSnapshot;
  } catch {
    return unavailableSnapshot;
  }
}
