'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ImprovementEdit } from '@h5cs/domain';
import {
  applyImprovementAction,
  createImprovementAction,
  evaluateImprovementAction,
  reviewImprovementAction,
  updateImprovementAction,
} from './improvement-actions';
import { improvementReasonLabels, type ImprovementActionState } from './improvement-model';
import { useImprovementAction } from './use-improvement-action';

type FormIdentity = {
  merchantId: string;
  assistantId: string;
  csrfToken: string;
  requestKey: string;
};
type TaskIdentity = FormIdentity & {
  improvementId: string;
  version: number;
  draftRevision: number;
};

function IdentityFields(
  props: FormIdentity & { improvementId?: string; version?: number; draftRevision?: number },
) {
  return (
    <>
      <input type="hidden" name="merchantId" value={props.merchantId} />
      <input type="hidden" name="assistantId" value={props.assistantId} />
      <input type="hidden" name="csrfToken" value={props.csrfToken} />
      <input type="hidden" name="requestKey" value={props.requestKey} />
      {props.improvementId ? (
        <input type="hidden" name="improvementId" value={props.improvementId} />
      ) : null}
      {props.version !== undefined ? (
        <input type="hidden" name="expectedVersion" value={props.version} />
      ) : null}
      {props.draftRevision !== undefined ? (
        <input type="hidden" name="expectedDraftRevision" value={props.draftRevision} />
      ) : null}
    </>
  );
}

function Feedback({ state }: { state: ImprovementActionState }) {
  return (
    <div aria-live="polite">
      {state.error ? (
        <p className="improvement-error" role="alert">
          {state.error}
        </p>
      ) : null}
      {state.message ? (
        <p className="improvement-success" role="status">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}

function RequestNotice({ note }: { note: string | null }) {
  return note ? (
    <p className="improvement-error" role="status">
      {note}
    </p>
  ) : null;
}

function restoredEdit(
  base: ImprovementEdit,
  stored: Readonly<Record<string, string>>,
  edited: Partial<ImprovementEdit>,
  sourceQuestion: boolean,
): ImprovementEdit {
  const reason = edited.reason ?? stored['reason'] ?? base.reason;
  return {
    question: sourceQuestion
      ? base.question
      : (edited.question ?? stored['question'] ?? base.question),
    expectedAnswer: edited.expectedAnswer ?? stored['expectedAnswer'] ?? base.expectedAnswer,
    reason: reason in improvementReasonLabels ? (reason as ImprovementEdit['reason']) : base.reason,
    notes: edited.notes ?? stored['notes'] ?? base.notes,
  };
}

function useResultRefresh(state: ImprovementActionState) {
  const router = useRouter();
  useEffect(() => {
    if (state.resultKey) router.refresh();
  }, [state.resultKey, router]);
}

function EditFields({
  value,
  onChange,
  sourceQuestion,
}: {
  value: ImprovementEdit;
  onChange: (value: ImprovementEdit) => void;
  sourceQuestion?: boolean;
}) {
  return (
    <>
      <label>
        消费者问题或测试问题
        <textarea
          name="question"
          required
          maxLength={2000}
          rows={3}
          value={value.question}
          readOnly={sourceQuestion}
          onChange={(event) => onChange({ ...value, question: event.target.value })}
        />
      </label>
      {sourceQuestion ? (
        <small>来自原始咨询的问题不可改写，避免丢失上下文。可新建其他测试场景。</small>
      ) : null}
      <label>
        改进原因
        <select
          name="reason"
          value={value.reason}
          onChange={(event) =>
            onChange({ ...value, reason: event.target.value as ImprovementEdit['reason'] })
          }
        >
          {Object.entries(improvementReasonLabels).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        商家期望答案（真实有效的事实和处理方式）
        <textarea
          name="expectedAnswer"
          maxLength={2000}
          rows={5}
          value={value.expectedAnswer}
          placeholder="例如：满 99 元包邮，仅限中国大陆非偏远地区；其他地区先联系商家确认运费。没有确认的条件不要补造。"
          onChange={(event) => onChange({ ...value, expectedAnswer: event.target.value })}
        />
      </label>
      <small>
        可以先留空建立任务。应用到草稿前必须补全答案；如需查订单或退款，写清人工处理渠道，不假装已经操作。
      </small>
      <label>
        商家备注（仅用于任务管理，不发送给模型）
        <textarea
          name="notes"
          maxLength={2000}
          rows={3}
          value={value.notes}
          placeholder="记录需要核实的条件、处理原因或相关人员；不要填写客户隐私和密码。"
          onChange={(event) => onChange({ ...value, notes: event.target.value })}
        />
      </label>
    </>
  );
}

export function ImprovementCreateForm(props: {
  merchantId: string;
  csrfToken: string;
  requestKey: string;
  assistants: readonly { id: string; displayName: string }[];
  assistantId: string;
  source?: { messageId: string; sessionId: string; question: string } | undefined;
}) {
  const [assistantId, setAssistantId] = useState(props.assistantId);
  const request = useImprovementAction(
    createImprovementAction,
    {
      operation: 'create',
      merchantId: props.merchantId,
      assistantId,
      ...(props.source ? { sourceMessageId: props.source.messageId } : {}),
    },
    props.requestKey,
  );
  const { state, action, pending, ready } = request;
  const [edited, setEdit] = useState<Partial<ImprovementEdit>>({});
  const edit = restoredEdit(
    {
      question: props.source?.question ?? '',
      expectedAnswer: '',
      reason: 'missing_information',
      notes: '',
    },
    request.restoredValues,
    edited,
    Boolean(props.source),
  );
  const router = useRouter();
  useEffect(() => {
    if (state.improvementId && state.resultKey)
      router.push(
        `/${props.merchantId}/improvements/${state.improvementId}?assistant=${assistantId}`,
      );
  }, [state.improvementId, state.resultKey, props.merchantId, assistantId, router]);
  if (props.assistants.length === 0) return <p>请先创建一个客服，再为它建立测试或改进场景。</p>;
  return (
    <form action={action} className="improvement-form">
      <IdentityFields
        merchantId={props.merchantId}
        assistantId={assistantId}
        csrfToken={props.csrfToken}
        requestKey={request.requestKey}
      />
      {props.source ? (
        <>
          <input type="hidden" name="sourceMessageId" value={props.source.messageId} />
          <input type="hidden" name="sourceSessionId" value={props.source.sessionId} />
        </>
      ) : null}
      <fieldset disabled={pending || !ready || Boolean(state.improvementId)}>
        <legend>{props.source ? '从这条咨询建立改进任务' : '手工新增测试或改进场景'}</legend>
        <label>
          关联客服
          <select
            value={assistantId}
            disabled={Boolean(props.source)}
            onChange={(event) => setAssistantId(event.target.value)}
          >
            {props.assistants.map((assistant) => (
              <option key={assistant.id} value={assistant.id}>
                {assistant.displayName}
              </option>
            ))}
          </select>
        </label>
        <EditFields value={edit} onChange={setEdit} sourceQuestion={Boolean(props.source)} />
        {request.requestNote ? (
          <button type="button" className="improvement-secondary" onClick={() => setEdit({})}>
            恢复上次提交内容
          </button>
        ) : null}
        <p>只建立待处理记录，不会改动原始咨询、草稿或线上版本。</p>
        <button type="submit">{pending ? '正在建立任务…' : '建立改进任务'}</button>
      </fieldset>
      <RequestNotice note={request.requestNote} />
      <Feedback state={state} />
    </form>
  );
}

export function ImprovementEditForm(
  props: TaskIdentity & { edit: ImprovementEdit; fromMessage: boolean },
) {
  const request = useImprovementAction(
    updateImprovementAction,
    {
      operation: 'update',
      merchantId: props.merchantId,
      assistantId: props.assistantId,
      improvementId: props.improvementId,
    },
    props.requestKey,
  );
  const { state, action, pending, ready } = request;
  const [edited, setEdit] = useState<Partial<ImprovementEdit>>({});
  const edit = restoredEdit(props.edit, request.restoredValues, edited, props.fromMessage);
  useResultRefresh(state);
  return (
    <form action={action} className="improvement-form">
      <IdentityFields {...props} requestKey={request.requestKey} />
      <fieldset disabled={pending || !ready}>
        <legend>修正期望答案和备注</legend>
        <EditFields value={edit} onChange={setEdit} sourceQuestion={props.fromMessage} />
        {request.requestNote ? (
          <button type="button" className="improvement-secondary" onClick={() => setEdit({})}>
            恢复上次提交内容
          </button>
        ) : null}
        <p>保存任务后，之前的复测判定将过期。此处保存不会直接改草稿，也不会发布。</p>
        <button type="submit">{pending ? '正在保存…' : '保存改进任务'}</button>
      </fieldset>
      <RequestNotice note={request.requestNote} />
      <Feedback state={state} />
    </form>
  );
}

export function ImprovementApplyForm(props: TaskIdentity & { available: boolean }) {
  const request = useImprovementAction(
    applyImprovementAction,
    {
      operation: 'apply',
      merchantId: props.merchantId,
      assistantId: props.assistantId,
      improvementId: props.improvementId,
    },
    props.requestKey,
  );
  const { state, action, pending, ready } = request;
  const [confirmed, setConfirmed] = useState(false);
  useResultRefresh(state);
  return (
    <form action={action} className="improvement-form">
      <IdentityFields {...props} requestKey={request.requestKey} />
      <fieldset disabled={pending || !ready || !props.available}>
        <legend>应用这条 FAQ 修正</legend>
        <label className="improvement-check">
          <input
            type="checkbox"
            name="factsVerified"
            value="yes"
            required
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          <span>已核对真实事实和适用条件，允许把上方 FAQ 写入当前客服的草稿。</span>
        </label>
        <p>仅写草稿的商品或服务资料；保留其他内容。不会自动确认资料，也不会发布给消费者。</p>
        <button type="submit" disabled={!confirmed}>
          {pending ? '正在应用…' : '应用修正到草稿 FAQ'}
        </button>
      </fieldset>
      <RequestNotice note={request.requestNote} />
      <Feedback state={state} />
    </form>
  );
}

export function ImprovementEvaluateForm(props: TaskIdentity & { available: boolean }) {
  const request = useImprovementAction(
    evaluateImprovementAction,
    {
      operation: 'evaluate',
      merchantId: props.merchantId,
      assistantId: props.assistantId,
      improvementId: props.improvementId,
    },
    props.requestKey,
  );
  const { state, action, pending, ready } = request;
  const [consent, setConsent] = useState(false);
  useResultRefresh(state);
  return (
    <form action={action} className="improvement-form">
      <IdentityFields {...props} requestKey={request.requestKey} />
      <fieldset disabled={pending || !ready || !props.available}>
        <legend>用当前已保存草稿复测</legend>
        <label className="improvement-check">
          <input
            type="checkbox"
            name="modelConsent"
            value="yes"
            required
            checked={consent}
            onChange={(event) => setConsent(event.target.checked)}
          />
          <span>
            同意将当前草稿的业务资料和本条问题发送至阿里云千问，仅使用已获授权的测试资料。
          </span>
        </label>
        <p>
          期望答案不会作为测试提示单独发送；模型将依据当前草稿作答。备注不发送。每次调用可能产生模型费用，并与试聊共享限流。
        </p>
        <button type="submit" disabled={!consent}>
          {pending ? '正在复测并记录结果…' : '发送问题并记录复测'}
        </button>
      </fieldset>
      <RequestNotice note={request.requestNote} />
      <Feedback state={state} />
    </form>
  );
}

export function ImprovementReviewForm(props: TaskIdentity & { runId: string; available: boolean }) {
  const request = useImprovementAction(
    reviewImprovementAction,
    {
      operation: 'review',
      merchantId: props.merchantId,
      assistantId: props.assistantId,
      improvementId: props.improvementId,
      runId: props.runId,
    },
    props.requestKey,
  );
  const { state, action, pending, ready } = request;
  useResultRefresh(state);
  return (
    <form action={action} className="improvement-form">
      <IdentityFields {...props} requestKey={request.requestKey} />
      <input type="hidden" name="runId" value={props.runId} />
      <fieldset disabled={pending || !ready || !props.available}>
        <legend>人工判定本次回答</legend>
        <p>
          不要求逐字一致。请检查事实、价格优惠的适用条件、资料不足时是否诚实说明，以及是否给出合理的后续处理方式。
        </p>
        <div className="improvement-buttons">
          <button type="submit" name="verdict" value="pass">
            {pending ? '正在记录…' : '符合预期，判定通过'}
          </button>
          <button type="submit" name="verdict" value="fail" className="improvement-secondary">
            不符合预期，继续改进
          </button>
        </div>
      </fieldset>
      <RequestNotice note={request.requestNote} />
      <Feedback state={state} />
    </form>
  );
}
