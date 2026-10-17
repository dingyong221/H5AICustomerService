'use client';

import { useActionState, useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { emptyImprovementAction, type ImprovementActionState } from './improvement-model';
import {
  improvementRequestScope,
  parseImprovementRequest,
  prepareImprovementRequest,
  settleImprovementRequest,
  UnknownImprovementRequest,
} from './improvement-request';

const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
};
const serverSnapshot = () => '!server';

/** Stable through RSC refresh and same-tab reload; only a confirmed terminal result rotates the key. */
export function useImprovementAction(
  action: (previous: ImprovementActionState, form: FormData) => Promise<ImprovementActionState>,
  scopeInput: Parameters<typeof improvementRequestScope>[0],
  initialKey: string,
) {
  const scope = improvementRequestScope(scopeInput);
  const [nextKey, setNextKey] = useState(initialKey);
  const snapshot = useSyncExternalStore(
    subscribe,
    useCallback(() => {
      try {
        return window.sessionStorage.getItem(scope);
      } catch {
        return '!unavailable';
      }
    }, [scope]),
    serverSnapshot,
  );
  const cached = useMemo(() => {
    if (snapshot === '!server' || snapshot === '!unavailable')
      return { record: null, invalid: snapshot === '!unavailable' };
    try {
      return { record: parseImprovementRequest(snapshot), invalid: false };
    } catch {
      return { record: null, invalid: true };
    }
  }, [snapshot]);
  const ready = snapshot !== '!server' && !cached.invalid;
  const [state, dispatch, pending] = useActionState(
    async (previous: ImprovementActionState, form: FormData) => {
      let record;
      try {
        record = await prepareImprovementRequest({
          storage: window.sessionStorage,
          scope,
          form,
          initialKey: nextKey,
        });
        notify();
      } catch (error) {
        return {
          ...emptyImprovementAction,
          outcome: 'unknown' as const,
          error:
            error instanceof UnknownImprovementRequest
              ? error.message
              : '浏览器无法保存请求标识，已停止提交。请允许此站点会话存储，当前内容仍保留。',
        };
      }
      let result: ImprovementActionState;
      try {
        result = await action(previous, form);
      } catch {
        result = {
          ...emptyImprovementAction,
          outcome: 'unknown',
          error:
            '网络返回中断，提交结果尚未确认。请核对记录；重试将复用原请求，不会盲目创建新请求。',
        };
      }
      try {
        settleImprovementRequest({ storage: window.sessionStorage, scope, record, state: result });
        if (result.outcome === 'confirmed') setNextKey(globalThis.crypto.randomUUID());
      } catch {
        // Keep the in-memory key and block a different intent if the browser cannot clear a terminal record.
        result = {
          ...result,
          error: `${result.error ? `${result.error} ` : ''}浏览器请求记录未能更新，请先核对已保存结果再进行下一次操作。`,
        };
      }
      notify();
      return result;
    },
    emptyImprovementAction,
  );
  return {
    state,
    action: dispatch,
    pending,
    ready,
    requestKey: cached.record?.key ?? nextKey,
    restoredValues: cached.record?.values ?? {},
    requestNote: cached.invalid
      ? '当前浏览器无法安全保存请求标识。请允许会话存储或换用正常窗口；未发送新请求。'
      : cached.record && cached.record.outcome !== 'rejected'
        ? '上次请求结果尚未确认。已保留请求标识和必要输入；重试同一内容会复用原请求。修改内容前请先核对当前记录。'
        : null,
  };
}
