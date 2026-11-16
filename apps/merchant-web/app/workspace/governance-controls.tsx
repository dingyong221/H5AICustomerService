'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  emergencyWithdrawAction,
  judgePreviewCheckAction,
  renameAssistantAction,
} from './governance-actions';
import { useUnsavedForm } from './use-unsaved-form';

type Scope = { merchantId: string; assistantId: string; draftRevision: number; csrfToken: string };
function ScopeInputs(scope: Scope) {
  return (
    <>
      {Object.entries(scope).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
    </>
  );
}

export function RenameAssistantForm({ displayName, ...scope }: Scope & { displayName: string }) {
  const [value, setValue] = useState(displayName);
  const [state, action, pending] = useActionState(renameAssistantAction, {
    error: null,
    saved: false,
  });
  const router = useRouter();
  const permit = useUnsavedForm(value !== displayName && !state.saved);
  useEffect(() => {
    if (state.saved) {
      permit();
      router.refresh();
    }
  }, [state.saved, permit, router]);
  return (
    <details className="workflow-disclosure assistant-rename">
      <summary>修改客服名称</summary>
      <form action={action}>
        <ScopeInputs {...scope} />
        <label>
          客服名称
          <input
            name="displayName"
            value={value}
            maxLength={200}
            required
            disabled={pending || state.saved}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        <p>
          名称将保存为新草稿修订，需重新试聊并发布；固定消费者链接不变。欢迎语如含旧名称，请同步核对。
        </p>
        {state.error ? <p role="alert">{state.error}</p> : null}
        {state.saved ? <p role="status">名称已保存。请核对最新草稿并重新试聊。</p> : null}
        <button
          type="submit"
          disabled={pending || state.saved || !value.trim() || value.trim() === displayName}
        >
          {pending ? '正在保存…' : '保存客服名称'}
        </button>
      </form>
    </details>
  );
}

export function PreviewVerdictForm({ checkId, ...scope }: Scope & { checkId: string }) {
  const [state, action, pending] = useActionState(judgePreviewCheckAction, {
    error: null,
    saved: false,
  });
  const router = useRouter();
  useEffect(() => {
    if (state.saved) router.refresh();
  }, [state.saved, router]);
  return (
    <form action={action} className="preview-verdict-form">
      <ScopeInputs {...scope} />
      <input type="hidden" name="checkId" value={checkId} />
      <label>
        <input
          name="reviewConfirmed"
          type="checkbox"
          value="yes"
          required
          disabled={pending || state.saved}
        />
        我已核对本修订的真实试聊回答、价格、优惠与适用条件
      </label>
      {state.error ? <p role="alert">{state.error}</p> : null}
      {state.saved ? <p role="status">判定已保存，请以当前页面的发布检查状态为准。</p> : null}
      <div className="draft-form-actions">
        <button
          data-usage="preview.pass"
          name="verdict"
          value="pass"
          type="submit"
          disabled={pending || state.saved}
        >
          {pending ? '正在记录…' : '回答合格，允许发布本修订'}
        </button>
        <button
          className="secondary"
          name="verdict"
          value="fail"
          type="submit"
          disabled={pending || state.saved}
        >
          需要修改资料
        </button>
      </div>
      <p>判定只对这一次试聊及当前草稿修订有效，不代表所有问题均已解决；修改资料后需重新试聊。</p>
    </form>
  );
}

export function EmergencyWithdrawForm({
  expectedReleaseId,
  ...scope
}: Scope & { expectedReleaseId: string }) {
  const [reason, setReason] = useState('');
  const [state, action, pending] = useActionState(emergencyWithdrawAction, {
    error: null,
    saved: false,
  });
  const router = useRouter();
  const permit = useUnsavedForm(!!reason.trim() && !state.saved);
  useEffect(() => {
    if (state.saved) {
      permit();
      router.refresh();
    }
  }, [state.saved, permit, router]);
  return (
    <details className="workflow-disclosure emergency-withdrawal">
      <summary>错误价格或紧急下架？停止全部已发布版本</summary>
      <form action={action}>
        <ScopeInputs {...scope} />
        <input type="hidden" name="expectedReleaseId" value={expectedReleaseId} />
        <p>
          此操作立即停止本客服当前和旧版本咨询，并终结已有会话及未完成回复。资料与历史保留，固定链接不变，但在重新试聊并发布前无法接待新咨询。普通更新请使用正常发布，不要紧急撤回。
        </p>
        <label>
          撤回原因
          <textarea
            name="reason"
            minLength={5}
            maxLength={500}
            required
            rows={3}
            value={reason}
            disabled={pending || state.saved}
            onChange={(event) => setReason(event.target.value)}
            placeholder="例如：发现价格错误，需要停止旧回答并核实修正"
          />
        </label>
        <label>
          <input
            type="checkbox"
            name="withdrawalConfirmed"
            value="yes"
            required
            disabled={pending || state.saved}
          />
          我确认停止此客服全部已发布版本及已有咨询，稍后修正、试聊并重新发布
        </label>
        {state.error ? <p role="alert">{state.error}</p> : null}
        {state.saved ? (
          <p role="status">已紧急撤回。固定链接保留；请修正资料、重新试聊并发布后恢复接待。</p>
        ) : null}
        <button
          type="submit"
          className="danger"
          disabled={pending || state.saved || reason.trim().length < 5}
        >
          {pending ? '正在撤回…' : '确认紧急撤回全部版本'}
        </button>
      </form>
    </details>
  );
}
