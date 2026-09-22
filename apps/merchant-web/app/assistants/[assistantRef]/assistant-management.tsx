'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button, StatusBadge } from '@h5cs/ui';

import {
  AssistantManagementClientError,
  createAssistantManagementApiClient,
  readAssistantManagementCsrfToken,
  type AssistantDraftUpdate,
  type AssistantManagementApiClient,
  type AssistantManagementClientErrorKind,
} from './assistant-management-api-client';
import type { AssistantDraftSnapshot, ReleaseOperation } from './assistant-management-contract';
import {
  buildAssistantManagementViewModel,
  validateAssistantDraftUpdate,
  type AssistantDraftFieldErrors,
} from './assistant-management-view-model';

interface AssistantManagementProps {
  apiBaseUrl?: string | undefined;
  assistantRef: string;
}

type RetryCommand =
  | Readonly<{
      draft: AssistantDraftUpdate;
      etag: string;
      idempotencyKey: string;
      kind: 'save';
    }>
  | Readonly<{
      draftRevision: number;
      etag: string;
      idempotencyKey: string;
      kind: 'publish';
    }>;

const emptyDraft: AssistantDraftUpdate = {
  assistantName: '',
  businessScope: '',
  insufficientInfoMessage: '',
  welcomeMessage: '',
};

function errorDetails(error: unknown): {
  kind: AssistantManagementClientErrorKind;
  message: string;
  retryable: boolean;
} {
  return error instanceof AssistantManagementClientError
    ? { kind: error.kind, message: error.message, retryable: error.retryable }
    : {
        kind: 'unavailable',
        message: '客服管理操作没有得到可信服务端确认。',
        retryable: true,
      };
}

function draftFromSnapshot(snapshot: AssistantDraftSnapshot): AssistantDraftUpdate {
  return {
    assistantName: snapshot.draft.assistantName,
    businessScope: snapshot.draft.businessScope,
    insufficientInfoMessage: snapshot.draft.insufficientInfoMessage,
    welcomeMessage: snapshot.draft.welcomeMessage,
  };
}

export function AssistantManagement({ apiBaseUrl, assistantRef }: AssistantManagementProps) {
  const loaded = useRef(false);
  const [snapshot, setSnapshot] = useState<AssistantDraftSnapshot>();
  const [operation, setOperation] = useState<ReleaseOperation | null>();
  const [draft, setDraft] = useState<AssistantDraftUpdate>(emptyDraft);
  const [fieldErrors, setFieldErrors] = useState<AssistantDraftFieldErrors>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<{
    kind: AssistantManagementClientErrorKind;
    message: string;
    retryable: boolean;
  }>();
  const [retryCommand, setRetryCommand] = useState<RetryCommand>();

  const createClient = useCallback((): AssistantManagementApiClient => {
    return createAssistantManagementApiClient({
      ...(apiBaseUrl === undefined ? {} : { apiBaseUrl }),
      assistantRef,
      getCsrfToken: () => readAssistantManagementCsrfToken(document.cookie),
      origin: window.location.origin,
    });
  }, [apiBaseUrl, assistantRef]);

  const acceptSnapshot = useCallback((next: AssistantDraftSnapshot) => {
    setSnapshot(next);
    setOperation(next.publication);
    setDraft(draftFromSnapshot(next));
    setFieldErrors({});
    setError(undefined);
    setRetryCommand(undefined);
  }, []);

  const loadSnapshot = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      acceptSnapshot(await createClient().loadSnapshot());
    } catch (loadError) {
      const details = errorDetails(loadError);
      setError(details);
      if (details.kind === 'not_found' || details.kind === 'forbidden') setSnapshot(undefined);
    } finally {
      setLoading(false);
    }
  }, [acceptSnapshot, createClient]);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void loadSnapshot();
  }, [loadSnapshot]);

  const executeSave = useCallback(
    async (command: Extract<RetryCommand, { kind: 'save' }>) => {
      setBusy(true);
      setError(undefined);
      try {
        acceptSnapshot(await createClient().saveDraft(command));
      } catch (saveError) {
        const details = errorDetails(saveError);
        setError(details);
        if (details.kind === 'not_found' || details.kind === 'forbidden') {
          setSnapshot(undefined);
          setOperation(undefined);
        }
        setRetryCommand(details.retryable ? command : undefined);
      } finally {
        setBusy(false);
      }
    },
    [acceptSnapshot, createClient],
  );

  const executePublish = useCallback(
    async (command: Extract<RetryCommand, { kind: 'publish' }>) => {
      setBusy(true);
      setError(undefined);
      try {
        const accepted = await createClient().startRelease(command);
        setOperation({ operationId: accepted.operationId, state: 'accepted' });
        setRetryCommand(undefined);
        setConfirmed(false);
      } catch (publishError) {
        const details = errorDetails(publishError);
        setError(details);
        if (details.kind === 'not_found' || details.kind === 'forbidden') {
          setSnapshot(undefined);
          setOperation(undefined);
        }
        setRetryCommand(details.retryable ? command : undefined);
      } finally {
        setBusy(false);
      }
    },
    [createClient],
  );

  const pollOperation = useCallback(
    async (operationId: string) => {
      try {
        const next = await createClient().readOperation(operationId);
        setOperation(next);
        setError(undefined);
      } catch (pollError) {
        setError(errorDetails(pollError));
      }
    },
    [createClient],
  );

  useEffect(() => {
    if (operation?.state !== 'accepted' && operation?.state !== 'processing') return;
    const operationId = operation.operationId;
    const timer = window.setTimeout(() => void pollOperation(operationId), 1_500);
    return () => window.clearTimeout(timer);
  }, [operation, pollOperation]);

  const model = buildAssistantManagementViewModel({
    applicationOrigin: typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
    ...(error === undefined ? {} : { errorKind: error.kind }),
    loading,
    operation,
    snapshot,
  });

  const updateDraft = (field: keyof AssistantDraftUpdate, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
  };

  const save = () => {
    if (snapshot === undefined || !model.canSave || busy) return;
    const errors = validateAssistantDraftUpdate(draft);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    const normalized = Object.fromEntries(
      Object.entries(draft).map(([key, value]) => [key, value.trim()]),
    ) as unknown as AssistantDraftUpdate;
    void executeSave({
      draft: normalized,
      etag: snapshot.etag,
      idempotencyKey: crypto.randomUUID(),
      kind: 'save',
    });
  };

  const publish = () => {
    if (snapshot === undefined || !model.canPublish || !confirmed || busy) return;
    void executePublish({
      draftRevision: snapshot.draft.revision,
      etag: snapshot.etag,
      idempotencyKey: crypto.randomUUID(),
      kind: 'publish',
    });
  };

  const retry = () => {
    if (retryCommand?.kind === 'save') void executeSave(retryCommand);
    else if (retryCommand?.kind === 'publish') void executePublish(retryCommand);
    else if (operation?.state === 'accepted' || operation?.state === 'processing') {
      void pollOperation(operation.operationId);
    } else void loadSnapshot();
  };

  const currentRelease =
    operation?.state === 'succeeded'
      ? { releaseId: operation.result.releaseId, releaseNo: operation.result.releaseNo }
      : snapshot?.currentRelease;

  return (
    <>
      <div className="connection-banner" role={error ? 'alert' : 'status'}>
        <span aria-hidden="true" className="connection-banner__pulse" />
        <div>
          <strong>{model.label}</strong>
          <span>{error?.message ?? model.description}</span>
        </div>
      </div>

      {snapshot === undefined ? (
        <section className="login-gate">
          <div>
            <p className="panel__eyebrow">Fail closed</p>
            <h2>{model.label}</h2>
            <p>{error?.message ?? model.description}</p>
            <Button busy={loading} disabled={busy} onClick={() => void loadSnapshot()}>
              重新读取
            </Button>
          </div>
        </section>
      ) : (
        <div className="onboarding-layout">
          <div>
            <section className="onboarding-step-card">
              <div className="section-title-row">
                <div>
                  <p className="panel__eyebrow">Assistant draft</p>
                  <h2>客服草稿</h2>
                </div>
                <StatusBadge tone={model.tone}>Revision {snapshot.draft.revision}</StatusBadge>
              </div>
              <div className="form-grid">
                <DraftField
                  disabled={busy || !model.canSave}
                  error={fieldErrors.assistantName}
                  label="客服名称"
                  onChange={(value) => updateDraft('assistantName', value)}
                  value={draft.assistantName}
                />
                <DraftArea
                  disabled={busy || !model.canSave}
                  error={fieldErrors.businessScope}
                  label="业务范围"
                  onChange={(value) => updateDraft('businessScope', value)}
                  value={draft.businessScope}
                />
                <DraftArea
                  disabled={busy || !model.canSave}
                  error={fieldErrors.welcomeMessage}
                  label="欢迎语"
                  onChange={(value) => updateDraft('welcomeMessage', value)}
                  value={draft.welcomeMessage}
                />
                <DraftArea
                  disabled={busy || !model.canSave}
                  error={fieldErrors.insufficientInfoMessage}
                  label="资料不足策略"
                  onChange={(value) => updateDraft('insufficientInfoMessage', value)}
                  value={draft.insufficientInfoMessage}
                />
              </div>
              <div className="onboarding-actions">
                <Button busy={busy} disabled={!model.canSave} onClick={save}>
                  保存草稿
                </Button>
              </div>
            </section>

            <section className="onboarding-step-card">
              <p className="panel__eyebrow">Publish check</p>
              <h2>发布前检查</h2>
              <ul className="requirements-list">
                {model.publishItems.map((item) => (
                  <li data-ready={item.level === 'passed'} key={item.code}>
                    {item.message}
                    {item.level === 'warning' ? '（警告）' : ''}
                  </li>
                ))}
              </ul>
              <div className="confirmation-note">
                <label>
                  <input
                    checked={confirmed}
                    disabled={busy || !model.canPublish}
                    onChange={(event) => setConfirmed(event.target.checked)}
                    type="checkbox"
                  />
                  <span>我确认发布当前 Revision，并在成功后将其激活为线上版本。</span>
                </label>
              </div>
              <div className="onboarding-actions">
                <Button
                  busy={loading}
                  disabled={!model.canCheck || busy}
                  onClick={() => void loadSnapshot()}
                  variant="secondary"
                >
                  重新运行发布检查
                </Button>
                <Button busy={busy} disabled={!model.canPublish || !confirmed} onClick={publish}>
                  明确确认并发布
                </Button>
              </div>
            </section>
          </div>

          <aside className="onboarding-aside">
            <section className="missing-panel">
              <p className="panel__eyebrow">可信摘要</p>
              <h2>业务资料与策略</h2>
              <dl className="confirmation-summary">
                <div>
                  <dt>行业</dt>
                  <dd>{snapshot.draft.industry?.label ?? '尚未确认'}</dd>
                </div>
                <div>
                  <dt>资料</dt>
                  <dd>{snapshot.draft.materialsSummary}</dd>
                </div>
                <div>
                  <dt>价格策略</dt>
                  <dd>{snapshot.draft.pricingSummary}</dd>
                </div>
                <div>
                  <dt>优惠策略</dt>
                  <dd>{snapshot.draft.promotionSummary}</dd>
                </div>
              </dl>
            </section>

            <section className="help-panel">
              <p className="panel__eyebrow">Current release</p>
              <h2>
                {currentRelease ? `Release #${String(currentRelease.releaseNo)}` : '尚未发布'}
              </h2>
              <p>
                {model.state === 'publishing'
                  ? '服务端操作处理中；尚未显示公开入口。'
                  : (model.operationFailure?.message ?? '线上版本只在服务端成功后改变。')}
              </p>
              {model.operationFailure?.traceId ? (
                <small>追踪编号：{model.operationFailure.traceId}</small>
              ) : null}
              {model.publicHref ? (
                <Link className="secure-auth-link" href={model.publicHref}>
                  打开固定公开入口
                </Link>
              ) : null}
              {error !== undefined || retryCommand !== undefined ? (
                <Button busy={busy} onClick={retry} variant="secondary">
                  重试原操作
                </Button>
              ) : null}
            </section>
          </aside>
        </div>
      )}
    </>
  );
}

function DraftField({
  disabled,
  error,
  label,
  onChange,
  value,
}: {
  disabled: boolean;
  error?: string | undefined;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  const errorId = `${label.replace(/\s/gu, '-')}-error`;
  return (
    <label>
      {label}
      <input
        aria-describedby={error ? errorId : undefined}
        aria-invalid={error ? true : undefined}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      />
      {error ? (
        <span className="field-error" id={errorId} role="alert">
          {error}
        </span>
      ) : null}
    </label>
  );
}

function DraftArea({
  disabled,
  error,
  label,
  onChange,
  value,
}: {
  disabled: boolean;
  error?: string | undefined;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  const errorId = `${label.replace(/\s/gu, '-')}-error`;
  return (
    <label className="form-grid__wide">
      {label}
      <textarea
        aria-describedby={error ? errorId : undefined}
        aria-invalid={error ? true : undefined}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        rows={3}
        value={value}
      />
      {error ? (
        <span className="field-error" id={errorId} role="alert">
          {error}
        </span>
      ) : null}
    </label>
  );
}
