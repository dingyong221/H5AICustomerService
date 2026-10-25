import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  loadDatabaseConfig,
  MySqlIndustryTemplateRepository,
  type IndustryTemplateGuide,
} from '@h5cs/database';
import { PageShell } from '@h5cs/ui';
import { currentMerchantCsrfToken } from '../../../account/merchant-actions';
import { requireMerchant, merchantAssistants } from '../../../tenant-data';
import { merchantPath } from '../../../tenant-paths';
import { CreateAssistantForm } from '../../../workspace/create-assistant-form';

export const dynamic = 'force-dynamic';

export default async function CreateAssistantPage({
  params,
}: {
  params: Promise<{ merchantId: string }>;
}) {
  const { merchantId } = await params;
  if (!/^[0-9a-f]{32}$/u.test(merchantId)) notFound();
  await requireMerchant(merchantId, `${merchantPath(merchantId, 'drafts')}/new`);
  const [current] = await merchantAssistants(merchantId);
  if (current) redirect(merchantPath(merchantId, 'drafts', current.assistantId));
  const database = loadDatabaseConfig();
  let templates: readonly IndustryTemplateGuide[] = [];
  let templatesReady = false;
  if (database.configured) {
    try {
      templates = await new MySqlIndustryTemplateRepository(database.config).listActive();
      templatesReady = true;
    } catch {
      /* The form still supports manual input. */
    }
  }
  return (
    <PageShell
      title="开通我的AI客服"
      eyebrow="Step 1 / 4"
      description={<p>每个商家只有一个AI客服。首次开通后，所有资料和发布都在这个客服中维护。</p>}
      aside={<Link href={merchantPath(merchantId, 'drafts')}>我的AI客服</Link>}
    >
      <section className="merchant-account-card assistant-create-card">
        {database.configured ? (
          <CreateAssistantForm
            merchantId={merchantId}
            idempotencyKey={randomUUID()}
            templates={templates}
            templatesReady={templatesReady}
            csrfToken={await currentMerchantCsrfToken()}
          />
        ) : (
          <p role="alert">数据库暂不可用，当前无法创建客服。</p>
        )}
      </section>
    </PageShell>
  );
}
