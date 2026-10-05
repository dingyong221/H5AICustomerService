'use client';

import { useActionState, useEffect, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import type { IndustryTemplateGuide } from '@h5cs/database';

import { createAssistantDraft } from './workspace-actions';

const subscribe = () => () => {};
const clientReady = () => true;
const serverReady = () => false;

export function CreateAssistantForm({
  merchantId,
  idempotencyKey,
  templates,
  templatesReady,
}: {
  merchantId: string;
  idempotencyKey: string;
  templates: readonly IndustryTemplateGuide[];
  templatesReady: boolean;
}) {
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [industry, setIndustry] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const router = useRouter();
  const hydrated = useSyncExternalStore(subscribe, clientReady, serverReady);
  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId);
  const [state, action, pending] = useActionState(createAssistantDraft, {
    error: null,
    created: null,
  });
  useEffect(() => {
    if (state.created) router.refresh();
  }, [state.created, router]);
  return (
    <form
      action={action}
      className="assistant-create-form"
      onChange={() => setValidationError(null)}
      onInvalidCapture={() =>
        setValidationError('请补齐必填资料；当前内容尚未保存，也未创建客服。')
      }
    >
      <p>填好资料并创建后，页面会显示客服入口，可继续编辑、试聊和发布。</p>
      <input name="merchantId" type="hidden" value={merchantId} />
      <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
      <label>
        客服名称
        <input maxLength={200} name="displayName" required />
      </label>
      <label>
        行业资料引导（可选）
        <select
          onChange={(event) => {
            const selected = templates.find((template) => template.id === event.target.value);
            setSelectedTemplateId(event.target.value);
            if (selected && !industry.trim()) setIndustry(selected.displayName);
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
        <aside className="assistant-industry-guide">
          <h3>{selectedTemplate.displayName}：资料准备提示</h3>
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
          <p>以上只是收集清单，不会自动成为客服知识；请在下方填写你确认属实的资料。</p>
        </aside>
      ) : null}
      <label>
        细分行业
        <input
          maxLength={128}
          name="industry"
          onChange={(event) => setIndustry(event.target.value)}
          required
          value={industry}
        />
      </label>
      <label>
        业务范围
        <textarea maxLength={2000} name="businessScope" required rows={3} />
      </label>
      <label>
        商品或服务资料
        <textarea maxLength={4000} name="materialsSummary" required rows={4} />
      </label>
      <label>
        价格与条件
        <textarea
          defaultValue="价格需联系商家确认"
          maxLength={4000}
          name="pricingSummary"
          placeholder="没有公开价格时可填写：价格需联系商家确认"
          required
          rows={2}
        />
      </label>
      <label>
        优惠与售卖策略
        <textarea
          defaultValue="目前无已确认优惠"
          maxLength={4000}
          name="promotionSummary"
          placeholder="无优惠时可填写：目前无优惠活动"
          required
          rows={2}
        />
      </label>
      <label>
        欢迎语
        <input
          defaultValue="您好，请问需要了解哪项产品或服务？"
          maxLength={500}
          name="welcomeMessage"
          required
        />
      </label>
      <label>
        资料不足时的回复
        <input
          defaultValue="这项信息尚未确认，请联系商家核实。"
          maxLength={500}
          name="insufficientInfoMessage"
          required
        />
      </label>
      {state.error ? <p role="alert">{state.error}</p> : null}
      {validationError ? <p role="alert">{validationError}</p> : null}
      {state.created ? (
        <div className="assistant-created-result" role="status">
          <strong>已创建客服草稿「{state.created.displayName}」。</strong>
          <p>下一步：核对业务资料，试聊后发布给消费者。</p>
          <Link href={`/${merchantId}/drafts/${state.created.assistantId}`}>
            进入客服配置、试聊和发布
          </Link>
        </div>
      ) : null}
      <button disabled={!hydrated || pending || state.created !== null} type="submit">
        {!hydrated ? '正在准备表单…' : pending ? '正在保存…' : '创建客服草稿'}
      </button>
    </form>
  );
}
