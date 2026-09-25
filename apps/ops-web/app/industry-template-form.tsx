'use client';

import { useActionState } from 'react';

import { createIndustryTemplate } from './industry-template-actions';

export function IndustryTemplateForm() {
  const [state, action, pending] = useActionState(createIndustryTemplate, {
    error: null,
    created: null,
  });
  return (
    <form action={action} className="ops-form ops-template-form">
      <label>
        行业代码
        <input
          maxLength={64}
          name="code"
          pattern="[a-z][a-z0-9_-]+"
          placeholder="local_services"
          required
        />
      </label>
      <label>
        版本号
        <input defaultValue="1" max="100000" min="1" name="version" required type="number" />
      </label>
      <label>
        行业名称
        <input maxLength={128} name="displayName" placeholder="本地生活服务" required />
      </label>
      <label>
        行业参考说明
        <textarea
          maxLength={4000}
          name="referenceNotes"
          placeholder="仅填写收集资料的提示；不要把未核实的商家事实写成默认答案。"
          required
          rows={3}
        />
      </label>
      <label>
        应收集的产品/服务资料（每行一项）
        <textarea
          maxLength={2500}
          name="requiredMaterials"
          placeholder={'服务项目与适用范围\n交付方式与服务地区\n售后或退改规则'}
          required
          rows={4}
        />
      </label>
      <label>
        应确认的售卖策略（每行一项，可留空）
        <textarea
          maxLength={2500}
          name="requiredPolicies"
          placeholder={'价格单位、起步条件与有效期\n优惠适用条件与截止时间'}
          rows={3}
        />
      </label>
      <p>模板只向商家提示待补资料，不会自动写入客服回答；每个代码和版本创建后不可覆盖。</p>
      {state.error ? <p role="alert">{state.error}</p> : null}
      {state.created ? (
        <p role="status">已创建行业模板 {state.created}。刷新页面可查看列表。</p>
      ) : null}
      <button disabled={pending || state.created !== null} type="submit">
        {pending ? '正在创建…' : '创建行业模板'}
      </button>
    </form>
  );
}
