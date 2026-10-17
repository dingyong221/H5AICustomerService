import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  buildConversationPrompt as compiledConsumerBuilder,
  buildPreviewPrompt as compiledBuilder,
} from '../../apps/worker/dist/conversation-prompt.js';
import {
  buildConversationPrompt as sourceConsumerBuilder,
  buildPreviewPrompt as sourceBuilder,
} from '../../apps/worker/src/conversation-prompt.ts';
import { controlledServiceReply as compiledBoundary } from '../../apps/worker/dist/service-reply-boundary.js';
import { controlledServiceReply as sourceBoundary } from '../../apps/worker/src/service-reply-boundary.ts';
import retailReviewFixture from '../../apps/merchant-web/app/workspace/draft-readiness.fixture.json' with { type: 'json' };
import { buildImprovementModelScenarioPack } from './improvement-model-scenarios.mjs';

test('uses the compiled candidate Worker builder and the actual source fixture without source fallback', () => {
  const pack = buildImprovementModelScenarioPack();
  assert.equal(pack.mode, 'preview');
  assert.equal(pack.promptBuilder.entrypoint, 'buildPreviewPrompt');
  assert.deepEqual(pack.baseFixture, retailReviewFixture);
  const fixtureExportSource = readFileSync(
    new URL('../../apps/merchant-web/app/workspace/draft-readiness.fixtures.ts', import.meta.url),
    'utf8',
  );
  assert.match(
    fixtureExportSource,
    /import retailFixture from '\.\/draft-readiness\.fixture\.json'/u,
  );
  assert.match(
    fixtureExportSource,
    /export const retailReviewFixture: AssistantDraftConfig = retailFixture;/u,
  );
  assert.equal(pack.promptBuilder.module, 'apps/worker/dist/conversation-prompt.js');
  assert.equal(
    pack.promptBuilder.compiledSha256,
    createHash('sha256')
      .update(
        readFileSync(new URL('../../apps/worker/dist/conversation-prompt.js', import.meta.url)),
      )
      .digest('hex'),
  );
  for (const scenario of pack.scenarios) {
    assert.deepEqual(scenario.prompt, compiledBuilder(scenario.previewFacts, scenario.question));
    assert.deepEqual(scenario.prompt, sourceBuilder(scenario.previewFacts, scenario.question));
    assert.equal(
      JSON.parse(scenario.prompt.confirmedFacts).humanContact,
      retailReviewFixture.humanContact,
    );
    assert.match(scenario.prompt.policy, /此处不实时转接/u);
    assert.deepEqual(scenario.controlledReplyPreview, compiledBoundary(scenario.prompt));
    assert.deepEqual(scenario.controlledReplyPreview, sourceBoundary(scenario.prompt));
  }
});

test('consumer mode uses the real compiled and source consumer builders, never a relabelled draft-preview prompt', () => {
  const preview = buildImprovementModelScenarioPack();
  const consumer = buildImprovementModelScenarioPack({ mode: 'consumer' });
  assert.equal(consumer.mode, 'consumer');
  assert.equal(consumer.promptBuilder.entrypoint, 'buildConversationPrompt');
  assert.deepEqual(consumer.baseFixture, preview.baseFixture);
  assert.equal(consumer.scenarios.length, 9);
  for (const [index, scenario] of consumer.scenarios.entries()) {
    const original = preview.scenarios[index];
    assert.equal(scenario.id, original.id);
    assert.equal(scenario.question, original.question);
    assert.deepEqual(scenario.previewFacts, original.previewFacts);
    assert.deepEqual(scenario.merchantVerification, original.merchantVerification);
    assert.deepEqual(scenario.manualAcceptance, original.manualAcceptance);
    assert.equal(scenario.expectedExecutionPath, original.expectedExecutionPath);
    assert.deepEqual(scenario.controlledReplyPreview, original.controlledReplyPreview);
    const { assistantName: displayName, ...facts } = scenario.previewFacts;
    const claim = { facts: { displayName, ...facts }, question: scenario.question, context: [] };
    assert.deepEqual(scenario.prompt, compiledConsumerBuilder(claim));
    assert.deepEqual(scenario.prompt, sourceConsumerBuilder(claim));
    assert.deepEqual(scenario.prompt.history, []);
    assert.deepEqual(scenario.prompt.confirmedFacts, original.prompt.confirmedFacts);
    assert.equal(Object.hasOwn(scenario.prompt, 'factsLabel'), false);
    assert.doesNotMatch(scenario.prompt.policy, /仅供商家测试|未发布草稿/u);
    assert.match(original.prompt.policy, /仅供商家测试的未发布草稿/u);
    assert.deepEqual(scenario.controlledReplyPreview, sourceBoundary(scenario.prompt));
  }
});

test('exported mode selection rejects unknown values without echoing caller input', () => {
  const sentinel = 'synthetic_private_argument_must_not_appear';
  assert.throws(
    () => buildImprovementModelScenarioPack({ mode: sentinel }),
    (error) => {
      assert.equal(error.message, 'Unsupported scenario mode.');
      assert.doesNotMatch(error.message, new RegExp(sentinel, 'u'));
      return true;
    },
  );
});

test('distinguishes two deterministic capability-boundary replies from seven model scenarios', () => {
  const pack = buildImprovementModelScenarioPack();
  const controlled = pack.scenarios.filter(
    ({ expectedExecutionPath }) => expectedExecutionPath === 'controlled_service_boundary',
  );
  assert.deepEqual(
    controlled.map(({ id }) => id),
    ['retail-complaint-refund', 'retail-explicit-human-help'],
  );
  assert.equal(
    pack.scenarios.filter(
      ({ expectedExecutionPath }) => expectedExecutionPath === 'model_generation',
    ).length,
    7,
  );
  assert.equal(pack.responseBoundary.version, 'explicit-service-request-v1');
  for (const scenario of controlled) {
    assert.match(scenario.controlledReplyPreview.answer, /此窗口不实时转接/u);
    assert.doesNotMatch(
      scenario.controlledReplyPreview.answer,
      /已记录|已受理|已提交|已发起|同步转达|我们承担运费/u,
    );
  }
  const promotion = pack.scenarios.find(({ id }) => id === 'retail-promotion-conditions');
  assert.match(promotion.prompt.policy, /已有明确限制必须直接说明/u);
  assert.match(promotion.prompt.policy, /不能又说“无法判断是否可叠加”/u);
});

test('covers nine synthetic business cases with actionable manual criteria and no model-generated results or scores', () => {
  const pack = buildImprovementModelScenarioPack();
  assert.equal(pack.scenarios.length, 9);
  assert.equal(new Set(pack.scenarios.map(({ id }) => id)).size, 9);
  assert.equal(pack.syntheticDataOnly, true);
  assert.equal(pack.manualReviewRequired, true);
  assert.equal(pack.automaticScoring, false);
  assert.equal(pack.modelWasInvokedByThisScript, false);
  for (const scenario of pack.scenarios) {
    assert.ok(scenario.question.length > 0 && scenario.question.length <= 2_000);
    assert.ok(scenario.merchantVerification.length > 0);
    assert.ok(scenario.manualAcceptance.requiredChecks.length > 0);
    assert.ok(scenario.manualAcceptance.forbiddenOutcomes.length > 0);
    assert.equal(scenario.manualAcceptance.verdict, null);
    assert.equal(Object.hasOwn(scenario, 'answer'), false);
    assert.equal(Object.hasOwn(scenario, 'accuracy'), false);
  }
});

test('preserves the first eight factual scenarios and acceptance standards while adding a separate all-pricing-missing case', () => {
  for (const mode of ['preview', 'consumer']) {
    const pack = buildImprovementModelScenarioPack({ mode });
    const frozenOriginal = pack.scenarios
      .slice(0, 8)
      .map(
        ({
          id,
          title,
          question,
          pair,
          previewFacts,
          merchantVerification,
          manualAcceptance,
          expectedExecutionPath,
        }) => ({
          id,
          title,
          question,
          pair,
          previewFacts,
          merchantVerification,
          manualAcceptance,
          expectedExecutionPath,
        }),
      );
    assert.equal(
      createHash('sha256').update(JSON.stringify(frozenOriginal)).digest('hex'),
      '68bc62af25bfe9b3745ffe32fe1e738aaf04b6681ba41cc2c71e94895157b8aa',
    );
    const missing = pack.scenarios[8];
    assert.equal(missing.id, 'retail-all-pricing-missing');
    assert.equal(missing.expectedExecutionPath, 'model_generation');
    assert.match(missing.previewFacts.pricingSummary, /尚未提供任何商品的具体售价/u);
    assert.doesNotMatch(missing.previewFacts.pricingSummary, /89|99|8元|15元/u);
    assert.match(missing.previewFacts.promotionSummary, /尚未提供/u);
    const pricingFacts = JSON.parse(missing.prompt.confirmedFacts);
    assert.equal(pricingFacts.pricingAndConditions, missing.previewFacts.pricingSummary);
    assert.equal(pricingFacts.promotionsAndSalesPolicy, missing.previewFacts.promotionSummary);
    assert.ok(
      missing.manualAcceptance.forbiddenOutcomes.some((check) => check.includes('估计区间')),
    );
    assert.equal(missing.manualAcceptance.verdict, null);
  }
});

test('compares the exact same Xinjiang question before and after changing only the pricing facts', () => {
  const pack = buildImprovementModelScenarioPack();
  const before = pack.scenarios.find(({ id }) => id === 'retail-xinjiang-before');
  const after = pack.scenarios.find(({ id }) => id === 'retail-xinjiang-after');
  assert.equal(before.question, after.question);
  assert.equal(before.pair.id, after.pair.id);
  assert.equal(before.pair.phase, 'before');
  assert.equal(after.pair.phase, 'after');
  assert.notEqual(before.previewFacts.pricingSummary, after.previewFacts.pricingSummary);
  const { pricingSummary: _beforePricing, ...beforeOtherFacts } = before.previewFacts;
  const { pricingSummary: _afterPricing, ...afterOtherFacts } = after.previewFacts;
  assert.deepEqual(beforeOtherFacts, afterOtherFacts);
  assert.match(before.previewFacts.pricingSummary, /新疆.*尚未提供/u);
  assert.match(after.previewFacts.pricingSummary, /新疆.*15元/u);
});

test('includes a genuine contradictory-policy fixture and no real personal or production identifiers', () => {
  const pack = buildImprovementModelScenarioPack();
  const conflicting = pack.scenarios.find(({ id }) => id === 'retail-conflicting-return-policy');
  assert.match(conflicting.previewFacts.materialsSummary, /7天/u);
  assert.match(conflicting.previewFacts.materialsSummary, /30天/u);
  const businessData = JSON.stringify({ baseFixture: pack.baseFixture, scenarios: pack.scenarios });
  assert.doesNotMatch(businessData, /(?<!\d)1[3-9]\d{9}(?!\d)/u);
  assert.doesNotMatch(
    businessData,
    /sk-[A-Za-z0-9]{16,}|github_pat_|gh[pousr]_[A-Za-z0-9]{20,}|BEGIN (?:OPENSSH|RSA) PRIVATE KEY/u,
  );
  assert.doesNotMatch(
    businessData,
    /114\.132\.92\.111|h5cs\.1rying\.com|b35bf7e4d02550f384384535952266d3/u,
  );
  assert.doesNotMatch(businessData, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u);
});

test('CLI prints only JSON and does not leak credential-like environmental input or echo arbitrary arguments', () => {
  const script = fileURLToPath(new URL('./improvement-model-scenarios.mjs', import.meta.url));
  const sentinel = 'synthetic_credential_probe_never_output_6d25d0';
  const cli = spawnSync(process.execPath, [script, '--json'], {
    encoding: 'utf8',
    env: { MODEL_SECRET_PROBE: sentinel },
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stderr, '');
  assert.doesNotMatch(cli.stdout, new RegExp(sentinel, 'u'));
  assert.equal(JSON.parse(cli.stdout).scenarios.length, 9);
  assert.equal(JSON.parse(cli.stdout).mode, 'preview');
  for (const args of [['--consumer'], ['--json', '--consumer'], ['--consumer', '--json']]) {
    const consumerCli = spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      env: { MODEL_SECRET_PROBE: sentinel },
    });
    assert.equal(consumerCli.status, 0, consumerCli.stderr);
    assert.equal(consumerCli.stderr, '');
    assert.doesNotMatch(consumerCli.stdout, new RegExp(sentinel, 'u'));
    const pack = JSON.parse(consumerCli.stdout);
    assert.equal(pack.mode, 'consumer');
    assert.equal(pack.promptBuilder.entrypoint, 'buildConversationPrompt');
    assert.equal(pack.scenarios.length, 9);
  }
  const invalid = spawnSync(process.execPath, [script, sentinel], { encoding: 'utf8', env: {} });
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout, '');
  assert.doesNotMatch(invalid.stderr, new RegExp(sentinel, 'u'));
  const conflicting = spawnSync(process.execPath, [script, '--consumer', '--preview'], {
    encoding: 'utf8',
    env: {},
  });
  assert.equal(conflicting.status, 2);
  assert.equal(conflicting.stdout, '');
});
