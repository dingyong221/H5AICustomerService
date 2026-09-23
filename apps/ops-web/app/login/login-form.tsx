'use client';

import { useActionState } from 'react';

import { loginOperator } from '../operator-actions';

export function LoginForm() {
  const [state, action, pending] = useActionState(loginOperator, { error: null });
  return (
    <form action={action} className="ops-form">
      <label>
        运营账号
        <input autoComplete="username" name="username" required type="text" />
      </label>
      <label>
        密码
        <input autoComplete="current-password" name="password" required type="password" />
      </label>
      {state.error ? <p role="alert">{state.error}</p> : null}
      <button disabled={pending} type="submit">
        {pending ? '正在验证…' : '登录运营后台'}
      </button>
    </form>
  );
}
