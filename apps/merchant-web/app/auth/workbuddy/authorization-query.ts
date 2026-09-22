import {
  workBuddyAuthorizationCallbackQuerySchema,
  workBuddyAuthorizationStatusQuerySchema,
} from '@h5cs/contracts';

export type WorkBuddyAuthorizationQueryIntent =
  | Readonly<{ code: string; kind: 'callback'; state: string }>
  | Readonly<{ kind: 'status'; transactionRef: string }>
  | Readonly<{ kind: 'status' }>;

export function parseWorkBuddyAuthorizationQuery(
  search: string,
): Readonly<{ intent: WorkBuddyAuthorizationQueryIntent; untrustedParametersPresent: boolean }> {
  const parameters = new URLSearchParams(search);
  const entries = Object.fromEntries(parameters.entries());
  const untrustedParametersPresent = parameters.size > 0;
  const keys = [...parameters.keys()];
  const hasDuplicateKeys = new Set(keys).size !== keys.length;

  if (hasDuplicateKeys) {
    return { intent: { kind: 'status' }, untrustedParametersPresent };
  }

  const callback = workBuddyAuthorizationCallbackQuerySchema.safeParse(entries);
  if (callback.success) {
    return {
      intent: { code: callback.data.code, kind: 'callback', state: callback.data.state },
      untrustedParametersPresent,
    };
  }

  const status = workBuddyAuthorizationStatusQuerySchema.safeParse(entries);
  if (status.success && status.data.transaction_ref !== undefined) {
    return {
      intent: { kind: 'status', transactionRef: status.data.transaction_ref },
      untrustedParametersPresent,
    };
  }

  return { intent: { kind: 'status' }, untrustedParametersPresent };
}

export function consumeWorkBuddyAuthorizationQuery(input: {
  href: string;
  replaceUrl: (url: string) => void;
}): Readonly<{
  intent: WorkBuddyAuthorizationQueryIntent;
  untrustedParametersPresent: boolean;
}> {
  const url = new URL(input.href);
  const parsed = parseWorkBuddyAuthorizationQuery(url.search);
  if (
    parsed.intent.kind === 'callback' ||
    url.searchParams.has('code') ||
    url.searchParams.has('state')
  ) {
    url.search = '';
    input.replaceUrl(`${url.pathname}${url.hash}`);
  }
  return parsed;
}
