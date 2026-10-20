import { loadDatabaseConfig, MySqlMerchantAccountAdminRepository } from '@h5cs/database';
import { currentOperator } from './operator-actions';
import { MerchantAccountForm } from './merchant-account-form';
export async function MerchantAccounts({ merchantId }: { merchantId: string }) {
  if (!(await currentOperator())) return null;
  let accounts = null;
  try {
    const database = loadDatabaseConfig();
    if (database.configured)
      accounts = await new MySqlMerchantAccountAdminRepository(database.config).list(merchantId);
  } catch {
    /* Fail closed, not empty. */
  }
  return (
    <section aria-label="商家账号管理">
      <h2>账号与密码管理</h2>
      {accounts === null ? (
        <p role="alert">账号信息暂不可用，请稍后刷新。</p>
      ) : accounts.length ? (
        accounts.map((account) => (
          <MerchantAccountForm key={account.userId} merchantId={merchantId} account={account} />
        ))
      ) : (
        <p>商家尚未领取，或没有可管理的密码账号。请先让负责人使用领取链接设置账号。</p>
      )}
    </section>
  );
}
