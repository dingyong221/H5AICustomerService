import { createHash } from 'node:crypto';
import type { Connection } from 'mysql2/promise';
import type { AssistantDraftConfig } from '@h5cs/domain';

/** Shared SQL primitive. The caller owns authentication, validation, locks and transaction. */
export async function insertAssistantDraftRecords(
  connection: Connection,
  input: {
    assistantId: Buffer;
    merchantId: Buffer;
    merchantUserId: Buffer;
    displayName: string;
    slug: string;
    draft: AssistantDraftConfig;
    now: Date;
  },
) {
  await connection.execute(
    `INSERT INTO assistant (id, merchant_id, display_name, public_slug, public_slug_digest,
      status, active_release_id, draft_revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'draft_only', NULL, 1, ?, ?)`,
    [
      input.assistantId,
      input.merchantId,
      input.displayName,
      input.slug,
      createHash('sha256').update(input.slug).digest(),
      input.now,
      input.now,
    ],
  );
  await connection.execute(
    `INSERT INTO assistant_draft (assistant_id, merchant_id, revision, config, validation, updated_by, updated_at)
     VALUES (?, ?, 1, ?, ?, ?, ?)`,
    [
      input.assistantId,
      input.merchantId,
      JSON.stringify(input.draft),
      JSON.stringify({ publishable: false, reason: 'knowledge_not_verified' }),
      input.merchantUserId,
      input.now,
    ],
  );
}

/** No merchant facts or commercial promises; existing save/confirm validation remains strict. */
export const emptyMarketplaceDraft: AssistantDraftConfig = Object.freeze({
  industry: '',
  businessScope: '',
  materialsSummary: '',
  pricingSummary: '',
  promotionSummary: '',
  welcomeMessage: '您好，我是 AI 客服。请问需要了解什么？',
  insufficientInfoMessage: '商家尚未提供这项资料，请联系商家核实。',
});
