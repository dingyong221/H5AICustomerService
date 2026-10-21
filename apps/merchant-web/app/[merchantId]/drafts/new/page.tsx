import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  loadDatabaseConfig,
  MySqlIndustryTemplateRepository,
  type IndustryTemplateGuide,
} from '@h5cs/database';
import { PageShell } from '@h5cs/ui';
import { currentMerchantCsrfToken } from '../../../account/merchant-actions';
import { requireMerchant } from '../../../tenant-data';
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
      title="新建客服"
      eyebrow="Step 1 / 4"
      description={<p>先填写基本资料。创建后进入知识补充，可上传文档、表格或演示文件。</p>}
      aside={<Link href={merchantPath(merchantId, 'drafts')}>返回客服列表</Link>}
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
