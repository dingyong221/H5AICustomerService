'use client';

import { useActionState } from 'react';

import { deactivateIndustryTemplate } from './industry-template-actions';

export function DeactivateIndustryTemplateForm({ id }: { id: string }) {
  const [state, action, pending] = useActionState(deactivateIndustryTemplate, {
    error: null,
    done: false,
  });
  return (
    <form action={action} className="ops-template-deactivate">
      <input name="id" type="hidden" value={id} />
      <p>停用后，商家创建客服时不再看到此行业；旧版不会自动恢复。已创建的客服不受影响。</p>
      {state.error ? <p role="alert">{state.error}</p> : null}
      {state.done ? <p role="status">模板已停用。刷新页面可查看状态。</p> : null}
      <button disabled={pending || state.done} type="submit">
        {pending ? '正在停用…' : '确认停用此行业模板'}
      </button>
    </form>
  );
}
