import type { AuthoringTaskProcessor } from './authoring-task-processor.js';
import type { ModelRuntime } from './model-runtime.js';
import { MerchantModelTaskScheduler } from './merchant-model-task-scheduler.js';
export class AuthoringTaskScheduler extends MerchantModelTaskScheduler {
  constructor(
    processor: AuthoringTaskProcessor,
    runtime: ModelRuntime,
    ready: (ready: boolean) => void = () => undefined,
  ) {
    super(
      {
        heads: async (now, cursor) =>
          (
            await processor.listRunnableMerchantHeads(now, {
              limit: 64,
              ...(cursor ? { afterKey: cursor } : {}),
            })
          ).map((h) => ({
            key: `${h.merchantId}:${h.kind}`,
            merchantId: h.merchantId,
            operation: h.kind === 'draft.expand' ? ('writing' as const) : ('preview' as const),
          })),
        run: (head, permit, onClaimed) =>
          processor.processOnce(
            permit.signal,
            head.merchantId,
            head.operation === 'writing' ? 'draft.expand' : 'preview.reply',
            permit,
            (claim) => {
              if (claim) runtime.bindAuthoringClaim(permit, claim);
              onClaimed();
            },
          ),
      },
      runtime,
      ready,
    );
  }
}
