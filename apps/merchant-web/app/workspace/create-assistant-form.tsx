'use client';

import { useActionState, useState } from 'react';

import type { IndustryTemplateGuide } from '@h5cs/database';

import { createAssistantDraft } from './workspace-actions';

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
  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId);
  const [state, action, pending] = useActionState(createAssistantDraft, {
    error: null,
    created: null,
  });
  return (
    <form action={action} className="assistant-create-form">
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
          maxLength={4000}
          name="promotionSummary"
          placeholder="无优惠时可填写：目前无优惠活动"
          required
          rows={2}
        />
      </label>
      <label>
        欢迎语
        <input maxLength={500} name="welcomeMessage" required />
      </label>
      <label>
        资料不足时的回复
        <input maxLength={500} name="insufficientInfoMessage" required />
      </label>
      {state.error ? <p role="alert">{state.error}</p> : null}
      {state.created ? (
        <p role="status">已创建客服草稿「{state.created.displayName}」。请在下方列表查看。</p>
      ) : null}
      <button disabled={pending || state.created !== null} type="submit">
        {pending ? '正在保存…' : '创建客服草稿'}
      </button>
    </form>
  );
}
