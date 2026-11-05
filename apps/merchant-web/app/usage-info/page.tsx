import { PageShell, UsagePreference } from '@h5cs/ui';
export default function UsageInfoPage() {
  return (
    <PageShell title="使用数据说明" eyebrow="客来答">
      <section className="merchant-account-card">
        <p>
          我们使用本站的基础事件统计，了解页面访问、按钮使用、观测有效停留和回访，帮助改善开通和客服体验。不使用第三方广告追踪或设备指纹。
        </p>
        <p>
          不采集密码、输入内容、手机号、聊天正文、附件内容或剪贴板。账号、商家和消费者角色分别统计，浏览器匿名标识不代表自然人。
        </p>
        <p>
          可关闭本浏览器的基础使用统计。浏览器隐私信号也会被尊重；关闭不影响正常开通和咨询。必要业务记录、安全审计和你主动打开邀请链接的来源记录与此分析采集分别管理。
        </p>
        <UsagePreference />
      </section>
    </PageShell>
  );
}
