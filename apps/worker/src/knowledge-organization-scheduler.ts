import type { KnowledgeOrganizationProcessor } from './knowledge-organization-processor.js';
import type { ModelRuntime } from './model-runtime.js';
import { MerchantModelTaskScheduler } from './merchant-model-task-scheduler.js';
/** Compatibility adapter: knowledge keeps its existing public contract. */
export class KnowledgeOrganizationScheduler extends MerchantModelTaskScheduler {
  constructor(
    processor: KnowledgeOrganizationProcessor,
    runtime: ModelRuntime,
    ready: (ready: boolean) => void = () => undefined,
  ) {
    super(
      {
        heads: async (now, cursor) =>
          (
            await processor.listRunnableMerchantHeads(now, {
              limit: 64,
              ...(cursor ? { afterMerchantId: cursor } : {}),
            })
          ).map((h) => ({
            key: h.merchantId,
            merchantId: h.merchantId,
            operation: 'organize' as const,
          })),
        run: (head, permit, onClaimed) =>
          processor.processOnce(permit.signal, head.merchantId, permit, (claim) => {
            if (claim) runtime.bindKnowledgeClaim(permit, claim);
            onClaimed();
          }),
      },
      runtime,
      ready,
    );
  }
}
