'use client';

export function PageRecoveryActions() {
  return (
    <div className="page-recovery-actions">
      <button onClick={() => window.location.reload()} type="button">
        刷新客服状态
      </button>
      <p>仍无法使用时，请返回商家的店铺或原购买渠道联系。此页不会自动提交咨询。</p>
    </div>
  );
}
