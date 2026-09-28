import { redirect } from 'next/navigation';

import { PageShell } from '@h5cs/ui';

import { LoginForm } from './login-form';
import { currentOperator } from '../operator-actions';

export default async function OperatorLoginPage() {
  if (await currentOperator()) redirect('/');
  return (
    <PageShell
      description={<p>只有平台运营人员可以开通商家和查看运营数据。</p>}
      eyebrow="Platform Operations"
      title="登录平台管理后台"
    >
      <section className="ops-login-card">
        <h2>运营身份验证</h2>
        <p>密码仅发送到本站服务端。登录成功后才能创建商家并生成一次性后台领取链接。</p>
        <LoginForm />
      </section>
    </PageShell>
  );
}
