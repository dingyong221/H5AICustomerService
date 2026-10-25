'use client';

import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import type { IndustryTemplateGuide } from '@h5cs/database';

import type { CreateAssistantState } from './workspace-actions';
import { parseAssistantDraftForm } from './draft-form';
import { retailDefaultDraft, retailTemplateCode } from './retail-preset';
import { DraftFields, type DraftFieldValues } from '../writing/draft-fields';
import { merchantPath } from '../tenant-paths';
import { useUnsavedForm } from './use-unsaved-form';

const subscribe = () => () => {};
const clientReady = () => true;
const serverReady = () => false;

export function CreateAssistantForm({
  merchantId,
  idempotencyKey,
  templates,
  templatesReady,
  csrfToken,
}: {
  merchantId: string;
  idempotencyKey: string;
  templates: readonly IndustryTemplateGuide[];
  templatesReady: boolean;
  csrfToken: string;
}) {
  const defaultTemplate = templates.find((template) => template.code === retailTemplateCode);
  const preset = defaultTemplate ? retailDefaultDraft : null;
  const [selectedTemplateId, setSelectedTemplateId] = useState(defaultTemplate?.id ?? '');
  const [values, setValues] = useState<DraftFieldValues>({
    displayName: preset ? '电商零售客服' : '',
    industry: preset?.industry ?? '',
    businessScope: preset?.businessScope ?? '',
    materialsSummary: preset?.materialsSummary ?? '',
    pricingSummary: preset?.pricingSummary ?? '价格需联系商家确认',
    promotionSummary: preset?.promotionSummary ?? '目前无已确认优惠',
    welcomeMessage: preset?.welcomeMessage ?? '您好，请问需要了解哪项产品或服务？',
    insufficientInfoMessage:
      preset?.insufficientInfoMessage ?? '这项信息尚未确认，请联系商家核实。',
  });
  const [validationError, setValidationError] = useState<string | null>(null);
  const [humanContact, setHumanContact] = useState('');
  const humanContactId = useId();
  const signature = JSON.stringify({ ...values, humanContact });
  const [initialSignature] = useState(signature);
  const permitNavigation = useUnsavedForm(signature !== initialSignature);
  const navigated = useRef(false);
  const router = useRouter();
  const hydrated = useSyncExternalStore(subscribe, clientReady, serverReady);
  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId);
  const [state, setState] = useState<CreateAssistantState>({
    error: null,
    created: null,
  });
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || state.created) return;
    const data = new FormData(event.currentTarget);
    const labels: Record<string, string> = {
      displayName: '客服名称',
      industry: '细分行业',
      businessScope: '业务范围',
      materialsSummary: '商品或服务资料',
      pricingSummary: '价格与条件',
      promotionSummary: '优惠与售卖策略',
      welcomeMessage: '欢迎语',
      insufficientInfoMessage: '资料不足时的回复',
    };
    const missing = Object.entries(labels)
      .filter(([name]) => !String(data.get(name) ?? '').trim())
      .map(([, label]) => label);
    if (missing.length || !parseAssistantDraftForm(data)) {
      setValidationError(
        missing.length
          ? `尚未创建客服，请填写：${missing.join('、')}。`
          : '尚未创建客服，请检查资料长度或特殊字符。',
      );
      const name = missing.length
        ? Object.entries(labels).find(([, label]) => missing.includes(label))?.[0]
        : undefined;
      const invalid = name
        ? event.currentTarget.querySelector<HTMLElement>(`[name="${name}"]`)
        : null;
      const group = invalid?.closest('details');
      if (group) group.open = true;
      invalid?.focus();
      return;
    }
    setValidationError(null);
    setState({ error: null, created: null });
    setPending(true);
    try {
      const response = await fetch(`/${merchantId}/drafts/create`, {
        method: 'POST',
        credentials: 'same-origin',
        body: data,
      });
      const result = await response.json();
      if (
        response.ok &&
        result.created &&
        /^[0-9a-f]{32}$/u.test(result.created.assistantId) &&
        typeof result.created.displayName === 'string'
      ) {
        setState({ error: null, created: result.created });
      } else {
        setState({
          error:
            typeof result.error === 'string'
              ? result.error
              : '保存未成功，当前资料已保留，请重试。',
          created: null,
        });
      }
    } catch {
      setState({
        error: '未收到保存结果，资料已保留。请稍后使用相同表单重试，避免重复创建。',
        created: null,
      });
    } finally {
      setPending(false);
    }
  }
  useEffect(() => {
    if (!state.created || state.created.reusedExisting || navigated.current) return;
    navigated.current = true;
    permitNavigation();
    router.push(merchantPath(merchantId, 'knowledge', state.created.assistantId));
  }, [state.created, merchantId, router, permitNavigation]);
  return (
    <form
      noValidate
      onSubmit={submit}
      className="assistant-create-form"
      onChange={() => setValidationError(null)}
    >
      <p className="draft-form-group__hint">
        创建后进入知识补充，可上传文件。此时只保存草稿，最后一步才正式发布。
      </p>
      <input name="merchantId" type="hidden" value={merchantId} />
      <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
      <label>
        行业资料引导（可选）
        <select
          disabled={pending || state.created !== null}
          onChange={(event) => {
            const selected = templates.find((template) => template.id === event.target.value);
            setSelectedTemplateId(event.target.value);
            if (selected && !values.industry.trim())
              setValues((previous) => ({ ...previous, industry: selected.displayName }));
          }}
          value={selectedTemplateId}
        >
          <option value="">手动填写，不使用模板</option>
          {templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.displayName} · v{template.version}
            </option>
          ))}
        </select>
      </label>
      {!templatesReady ? <p role="status">行业引导暂不可用，仍可手动填写业务资料。</p> : null}
      {selectedTemplate ? (
        <details className="assistant-industry-guide">
          <summary>{selectedTemplate.displayName}：查看资料准备提示</summary>
          <p>{selectedTemplate.referenceNotes}</p>
          <strong>建议提供的产品/服务资料</strong>
          <ul>
            {selectedTemplate.requiredMaterials.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          {selectedTemplate.requiredPolicies.length > 0 ? (
            <>
              <strong>需确认的售卖策略</strong>
              <ul>
                {selectedTemplate.requiredPolicies.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </>
          ) : null}
          <p>
            电商零售预设已填入通用知识。请核对是否适用，并补充你的实际商品、价格和交易规则；其他行业模板仅提供资料收集提示。
          </p>
        </details>
      ) : null}
      <fieldset
        disabled={pending || (state.created !== null && !state.created.reusedExisting)}
        className="draft-form-fields"
      >
        <DraftFields
          merchantId={merchantId}
          csrfToken={csrfToken}
          values={values}
          includeName
          onChange={(field, value) => setValues((previous) => ({ ...previous, [field]: value }))}
          responseFields={
            <div className="draft-field">
              <label htmlFor={humanContactId}>人工联系说明（可选）</label>
              <textarea
                id={humanContactId}
                name="humanContact"
                maxLength={500}
                rows={3}
                value={humanContact}
                onChange={(event) => setHumanContact(event.target.value)}
                placeholder="填写真实联系方式和服务时间；此处不实时转接人工"
              />
              <p className="draft-form-group__hint">
                最多 500 字，发布后消费者可见。不要填写密码或敏感资料。
              </p>
            </div>
          }
        />
      </fieldset>
      {validationError || state.error ? (
        <p role="alert">{validationError ?? state.error} 当前填写内容不会清空。</p>
      ) : null}
      {state.created ? (
        <div className="assistant-created-result" role="status">
          {state.created.reusedExisting ? (
            <strong>你已开通客服「{state.created.displayName}」。</strong>
          ) : (
            <strong>已创建客服草稿「{state.created.displayName}」。</strong>
          )}
          <p>
            {state.created.reusedExisting
              ? '每个商家只有一个 AI 客服。本次填写未覆盖原资料，请复制需要的内容，再进入原客服修改。'
              : '正在进入知识补充；当前尚未发布。'}
          </p>
          <Link href={merchantPath(merchantId, 'knowledge', state.created.assistantId)}>
            {state.created.reusedExisting ? '进入我的 AI 客服' : '下一步：上传与补充知识'}
          </Link>
        </div>
      ) : null}
      <button disabled={!hydrated || pending || state.created !== null} type="submit">
        {!hydrated ? '正在准备表单…' : pending ? '正在保存…' : '创建客服草稿'}
      </button>
    </form>
  );
}
