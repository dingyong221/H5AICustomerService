'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  runtimeControlRequestSchema,
  type RuntimeControlRequest,
  type RuntimeControlView,
  type RuntimeScope,
} from '@h5cs/contracts';
import { controlRuntime, type RuntimeActionResult } from './runtime-control-actions';

export const runtimeStateLabel = (view: RuntimeControlView) =>
  !view.enabled
    ? '运行控制未启用'
    : view.effectiveState === 'unavailable'
      ? '运行状态不可用'
      : view.state === 'manually_stopped'
        ? '本范围已人工暂停'
        : view.blockingScopes.length
          ? '本范围已恢复，仍受上级暂停影响'
          : '本范围允许运行';

export function RuntimeControlForm({
  view,
  scope,
  label,
  operatorId,
  controllable = true,
}: {
  view: RuntimeControlView | null;
  scope: RuntimeScope;
  label: string;
  operatorId: string;
  controllable?: boolean;
}) {
  const router = useRouter();
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState(false);
  const [original, setOriginal] = useState<RuntimeControlRequest | null>(null);
  const [result, setResult] = useState<RuntimeActionResult | null>(null);
  const lock = useRef(false);
  const scopeKey =
    scope.kind === 'global'
      ? 'global'
      : scope.kind === 'merchant'
        ? `merchant:${scope.merchantId}`
        : `job:${scope.jobId}`;
  const key = `h5cs:runtime-control:${operatorId}:${scopeKey}`;
  const scopeText = JSON.stringify(scope);
  useEffect(() => {
    try {
      const saved = window.sessionStorage.getItem(key);
      if (saved) {
        const request = runtimeControlRequestSchema.parse(JSON.parse(saved) as unknown);
        if (JSON.stringify(request.scope) !== scopeText) throw Error('scope');
        // Hydrate the external browser recovery record only after SSR.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setOriginal(request);
      }
      setLoaded(true);
    } catch {
      setResult({
        error: '无法读取操作恢复记录，请恢复浏览器存储后刷新。',
        uncertain: true,
        receipt: null,
        current: null,
      });
    }
  }, [key, scopeText]);
  async function execute(request: RuntimeControlRequest, lookup: boolean) {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    let sent = false;
    try {
      // Store the exact request before dispatch. After a lost response only a
      // read of this operator's original receipt is offered, even after reload.
      window.sessionStorage.setItem(key, JSON.stringify(request));
      setOriginal(request);
      sent = true;
      const next = await controlRuntime(request, lookup);
      setResult(next);
      if (!next.uncertain) {
        window.sessionStorage.removeItem(key);
        setOriginal(null);
      }
    } catch {
      setResult({
        error: sent
          ? '操作结果无法确认，请保留此页并查询原操作收据。'
          : '无法保存操作恢复记录，本次未发送。请恢复浏览器存储后刷新。',
        uncertain: sent,
        receipt: null,
        current: null,
      });
    } finally {
      lock.current = false;
      setPending(false);
    }
  }
  const current = result ? result.current : view;
  const disabled =
    !loaded ||
    pending ||
    !view?.enabled ||
    view.effectiveState === 'unavailable' ||
    !controllable ||
    !!original ||
    !!result;
  return (
    <section className="runtime-control" aria-label={`${label}运行控制`}>
      <h3>{label} · 运行暂停与恢复</h3>
      <p role="status">{current ? runtimeStateLabel(current) : '运行状态查询失败；暂不能修改。'}</p>
      {current ? (
        <p>
          当前修订 {current.revision} · 有效状态 {current.effectiveState}
          {current.changedAt ? ` · 更新于 ${current.changedAt}` : ''}
        </p>
      ) : null}
      {current?.blockingScopes.length ? (
        <p>
          阻断范围：
          {current.blockingScopes
            .map((s) => (s.kind === 'global' ? '全局' : s.kind === 'merchant' ? '商家' : '任务'))
            .join('、')}
        </p>
      ) : null}
      <p>
        只暂停新的任务领取与模型发出；已发出的调用继续核对结果，可能计费。资料、历史和固定链接保留，管理访问与结果采纳仍可用。恢复本范围后仍需核对上级暂停。
      </p>
      {!view?.enabled ? <p>控制开关默认关闭；关闭开关不代表解除之前的持久暂停。</p> : null}
      {current?.reason ? (
        <details>
          <summary>最近运行控制审计</summary>
          <p>{current.reason}</p>
          <p>操作账号：{current.actorId ?? '未记录'}</p>
        </details>
      ) : null}
      {result?.receipt ? (
        <p role="status">
          原操作收据：{result.receipt.action === 'pause' ? '暂停' : '恢复'}，修订{' '}
          {result.receipt.revision}，时间 {result.receipt.changedAt}
          。这是该次历史收据；当前状态以上方重新查询结果为准。
        </p>
      ) : null}
      {result?.receipt && !result.current ? (
        <p role="alert">已取得历史收据，当前状态查询失败，不能据此判断现在仍为该状态。</p>
      ) : null}
      {result?.error ? <p role="alert">{result.error}</p> : null}
      {original ? (
        <div>
          <p>
            待确认请求：<code>{original.requestId}</code>
          </p>
          <button type="button" disabled={pending} onClick={() => void execute(original, true)}>
            {pending ? '正在核对…' : '查询原操作收据及当前状态'}
          </button>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (disabled || !view) return;
            const data = new FormData(event.currentTarget);
            const parsed = runtimeControlRequestSchema.safeParse({
              scope: view.scope,
              action: view.state === 'manually_stopped' ? 'resume' : 'pause',
              expectedRevision: view.revision,
              requestId: `runtime_${crypto.randomUUID().replaceAll('-', '')}`,
              reason: data.get('reason'),
              confirmed: data.get('confirmed') === 'yes',
            });
            if (parsed.success) void execute(parsed.data, false);
          }}
        >
          <fieldset disabled={disabled}>
            <label>
              操作原因（仅运营审计）
              <textarea name="reason" required minLength={5} maxLength={512} rows={2} />
            </label>
            <label className="runtime-confirm">
              <input type="checkbox" name="confirmed" value="yes" required />
              已核对{label}、修订号和影响；此操作区别于商家业务停用
            </label>
            <button type="submit">
              {pending
                ? '正在提交…'
                : view?.state === 'manually_stopped'
                  ? '确认恢复运行'
                  : '确认暂停运行'}
            </button>
          </fieldset>
        </form>
      )}
      {result && !original ? (
        <button
          type="button"
          onClick={() => {
            setResult(null);
            router.refresh();
          }}
        >
          刷新当前状态后再操作
        </button>
      ) : null}
    </section>
  );
}
