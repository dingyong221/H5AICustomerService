import Link from 'next/link';
import { PageShell } from '@h5cs/ui';
import { loadDatabaseConfig, MySqlGrowthUsageRepository, growthEnabled } from '@h5cs/database';
import { currentOperator } from '../operator-actions';
import { retentionValue } from './retention';
export const dynamic = 'force-dynamic';
const roles: Record<string, string> = {
  anonymous: '匿名浏览器',
  merchant: '商家账号',
  consumer: '消费者浏览器',
  operator: '运营账号',
};
const pages: Record<string, string> = {
  product: '产品介绍',
  registration: '免费开通',
  login: '登录',
  workspace: '工作台',
  drafts: 'AI客服资料',
  knowledge: '知识补充',
  preview: '效果试聊',
  publish: '发布分享',
  conversations: '咨询管理',
  improvements: '持续改进',
  writing: '填写助手',
  help: '帮助中心',
  invite: '邀请商家',
  consumer: '客户咨询',
  ops: '运营后台',
  other: '其他页面',
};
const controls: Record<string, string> = {
  'product.register': '进入免费开通',
  'register.submit': '提交开通',
  'login.submit': '提交登录',
  'invite.create': '生成邀请入口',
  'invite.copy': '复制邀请链接',
  'invite.qr': '下载邀请二维码',
  'draft.save': '保存客服资料',
  'knowledge.upload': '上传材料',
  'knowledge.organize': 'AI整理材料',
  'knowledge.save': '保存知识整理稿',
  'preview.send': '提交试聊',
  'preview.pass': '确认试聊通过',
  'publish.confirm': '提交发布',
  'share.copy': '复制客户链接',
  'share.qr': '下载客户二维码',
  'help.open': '进入帮助',
  'writing.generate': '生成资料文案',
  'conversation.send': '提交客户问题',
  'conversation.new': '开始新咨询',
  logout: '退出登录',
  navigation: '菜单导航',
  unregistered_button: '其他按钮（未细分）',
  unregistered_link: '其他链接（未细分）',
  unregistered_form: '其他表单（未细分）',
};
async function readGrowth() {
  const database = loadDatabaseConfig();
  if (!database.configured) return null;
  try {
    const repo = new MySqlGrowthUsageRepository(database.config);
    return { data: await repo.usageReport(), invite: await repo.invitationStats() };
  } catch {
    return null;
  }
}
export default async function GrowthPage() {
  if (!(await currentOperator()))
    return (
      <PageShell title="增长与使用">
        <p>
          请先<Link href="/login">登录运营后台</Link>。
        </p>
      </PageShell>
    );
  const loaded = await readGrowth();
  if (!loaded)
    return (
      <PageShell title="增长与使用">
        <p role="alert">数据暂不可用，或本轮迁移尚未完成；没有将读取失败显示成0。</p>
      </PageShell>
    );
  const { data, invite } = loaded;
  return (
    <PageShell title="增长与使用" eyebrow="客来答运营">
      <section className="ops-provision-panel">
        <h2>邀请转化</h2>
        <p>
          近30天触达记录 {invite.visits} · 累计首次开通 {invite.opened} 家 · 完成发布{' '}
          {invite.published} 家 · 收到咨询 {invite.used} 家
        </p>
        <p>
          来自服务端邀请归属和业务事实。咨询含商家自测，不能直接证明真实客户使用或问题已解决。奖励未启用。
        </p>
      </section>
      <section className="ops-provision-panel">
        <h2>使用观测</h2>
        <p>
          采集{growthEnabled() ? '已启用' : '当前已关闭，以下仅为历史数据'}
          。页面/点击为客户端观测，不等于业务成功；页面累计时长不等于自然人真实在线时长。
        </p>
        <p>
          触达与使用事件每日合计最多采集2万条，达到上限会停止新增采集；退出统计、网络失败也会导致缺样，不影响业务使用。
        </p>
        {data.days.length ? (
          <div className="growth-table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  {['日期', '对象', '观测用户', '浏览', '操作', '页面有效分钟'].map((s) => (
                    <th key={s}>{s}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.days.map((r, i) => (
                  <tr key={i}>
                    <td>{String(r['day'])}</td>
                    <td>{roles[String(r['role'])]}</td>
                    <td>{String(r['observed_users'])}</td>
                    <td>{String(r['views'])}</td>
                    <td>{String(r['actions'])}</td>
                    <td>{(Number(r['active_ms']) / 60000).toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>尚无已采集的使用事件，不代表历史没有用户。</p>
        )}
      </section>
      <section className="ops-provision-panel">
        <h2>近14天按钮使用</h2>
        <div className="growth-table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th>页面</th>
                <th>控件</th>
                <th>点击次数</th>
              </tr>
            </thead>
            <tbody>
              {data.controls.map((r, i) => (
                <tr key={i}>
                  <td>{pages[String(r['page'])] ?? '其他页面'}</td>
                  <td>{controls[String(r['control'])] ?? '其他操作'}</td>
                  <td>{String(r['clicks'])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>未登记控件只记其他操作，不能据此推断具体功能使用。点击提交不等于业务成功。</p>
      </section>
      <section className="ops-provision-panel">
        <h2>观测回访留存</h2>
        <p>
          按北京时间首次被采集日分组，精确D1/D7/D30，目标日完整结束后计算；与注册留存、核心业务使用留存分开。浏览器不等于自然人，运营单独列示。
        </p>
        <div className="growth-table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                {['队列日期', '对象', '样本', 'D1', 'D7', 'D30'].map((s) => (
                  <th key={s}>{s}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.retention.map((r, i) => (
                <tr key={i}>
                  <td>{String(r['cohort'])}</td>
                  <td>{roles[String(r['role'])]}</td>
                  <td>{String(r['size'])}</td>
                  {([1, 7, 30] as const).map((n) => (
                    <td key={n}>
                      {retentionValue(
                        String(r['cohort']),
                        Number(r['size']),
                        Number(r['d' + n]),
                        n,
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          采集上线之前没有点击或停留证据，不反向补造。新增商家、实际提问与运行报表请同时查看既有商家使用与每日使用报表。
        </p>
      </section>
    </PageShell>
  );
}
