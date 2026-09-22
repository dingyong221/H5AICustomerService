'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { WorkBuddyAuthorizationResult } from '@h5cs/contracts';

import {
  createWorkBuddyAuthorizationApiClient,
  readWorkBuddyCsrfToken,
  WorkBuddyAuthorizationClientError,
  type WorkBuddyAuthorizationApiClient,
} from './authorization-api-client';
import { consumeWorkBuddyAuthorizationQuery } from './authorization-query';
import { WorkBuddyAuthorizationStatePanel } from './authorization-state-panel';
import {
  buildWorkBuddyConnectionViewModel,
  type TrustedWorkBuddyAuthorizationSnapshot,
} from './connection-view-model';

interface WorkBuddyAuthorizationFlowProps {
  apiBaseUrl?: string | undefined;
  backHref?: string | undefined;
}

function clientErrorMessage(error: unknown): string {
  return error instanceof WorkBuddyAuthorizationClientError
    ? error.message
    : '授权操作没有得到可信服务端确认。';
}

function resultTransactionRef(result: WorkBuddyAuthorizationResult): string | undefined {
  return 'transaction_ref' in result ? result.transaction_ref : undefined;
}

export function WorkBuddyAuthorizationFlow({
  apiBaseUrl,
  backHref,
}: WorkBuddyAuthorizationFlowProps) {
  const loaded = useRef(false);
  const [snapshot, setSnapshot] = useState<TrustedWorkBuddyAuthorizationSnapshot>({
    status: 'backend_unavailable',
  });
  const [busy, setBusy] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string>();
  const [untrustedParametersPresent, setUntrustedParametersPresent] = useState(false);

  const createClient = useCallback((): WorkBuddyAuthorizationApiClient => {
    return createWorkBuddyAuthorizationApiClient({
      ...(apiBaseUrl === undefined ? {} : { apiBaseUrl }),
      getCsrfToken: () => readWorkBuddyCsrfToken(document.cookie),
      origin: window.location.origin,
    });
  }, [apiBaseUrl]);

  const acceptTrustedResult = useCallback((result: WorkBuddyAuthorizationResult) => {
    setSnapshot(result);
    setErrorMessage(undefined);

    const transactionRef = resultTransactionRef(result);
    const nextUrl = new URL(window.location.href);
    nextUrl.search = '';
    if (transactionRef !== undefined) nextUrl.searchParams.set('transaction_ref', transactionRef);
    window.history.replaceState(null, '', `${nextUrl.pathname}${nextUrl.search}`);
  }, []);

  const perform = useCallback(
    async (
      operation: (client: WorkBuddyAuthorizationApiClient) => Promise<WorkBuddyAuthorizationResult>,
      failureSnapshot?: TrustedWorkBuddyAuthorizationSnapshot,
    ) => {
      setBusy(true);
      setErrorMessage(undefined);
      try {
        acceptTrustedResult(await operation(createClient()));
      } catch (error) {
        if (failureSnapshot !== undefined) setSnapshot(failureSnapshot);
        setErrorMessage(clientErrorMessage(error));
      } finally {
        setBusy(false);
      }
    },
    [acceptTrustedResult, createClient],
  );

  const loadFromServer = useCallback(async () => {
    const query = consumeWorkBuddyAuthorizationQuery({
      href: window.location.href,
      replaceUrl: (url) => window.history.replaceState(null, '', url),
    });
    setUntrustedParametersPresent(query.untrustedParametersPresent);
    const intent = query.intent;
    if (intent.kind === 'callback') {
      await perform(
        (client) => client.completeCallback({ code: intent.code, state: intent.state }),
        { status: 'authorization_failed' },
      );
      return;
    }
    await perform((client) =>
      client.readStatus('transactionRef' in intent ? intent.transactionRef : undefined),
    );
  }, [perform]);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void loadFromServer();
  }, [loadFromServer]);

  const model = buildWorkBuddyConnectionViewModel({
    trustedServerSnapshot: snapshot,
    untrustedCallbackPresent: untrustedParametersPresent,
  });

  const start = () => void perform((client) => client.startAuthorization());
  const retry = () => {
    const transactionRef = model.transactionRef;
    void perform((client) => client.readStatus(transactionRef));
  };
  const selectMerchant = (candidateRef: string) => {
    const transactionRef = model.transactionRef;
    if (transactionRef === undefined) return;
    void perform((client) => client.selectMerchant({ candidateRef, transactionRef }));
  };
  const consent = (decision: 'deny' | 'grant') => {
    const transactionRef = model.transactionRef;
    if (transactionRef === undefined) return;
    void perform((client) => client.recordConsent({ decision, transactionRef }));
  };

  return (
    <>
      <div className="connection-banner" role={errorMessage ? 'alert' : 'status'}>
        <span aria-hidden="true" className="connection-banner__pulse" />
        <div>
          <strong>{busy ? '正在读取可信服务端状态' : model.label}</strong>
          <span>{busy ? '页面不会在服务端确认前推进授权步骤。' : model.description}</span>
        </div>
      </div>
      <WorkBuddyAuthorizationStatePanel
        {...(backHref === undefined ? {} : { backHref })}
        busy={busy}
        errorMessage={errorMessage}
        model={model}
        onConsent={consent}
        onRetry={retry}
        onSelectMerchant={selectMerchant}
        onStart={start}
      />
    </>
  );
}
