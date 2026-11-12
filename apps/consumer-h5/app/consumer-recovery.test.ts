import { describe, expect, it } from 'vitest';
import {
  consumerFailure,
  publishedTelephoneNumbers,
  replyProgress,
  supportReference,
} from './consumer-recovery';

describe('customer-facing recovery guidance', () => {
  it('does not invite a second supplier call when the original result is unknown', () => {
    const failure = consumerFailure('MODEL_RESULT_UNKNOWN', true);
    expect(failure.retryable).toBe(false);
    expect(failure.message).toContain('刷新核对');
    expect(failure.message).toContain('请勿重复提交');
    expect(failure.message).not.toContain('重试');
  });
  it('never retries a withdrawn release even if an upstream flag incorrectly allows retry', () => {
    expect(consumerFailure('RELEASE_WITHDRAWN', true)).toMatchObject({
      retryable: false,
      needsLatestVersion: true,
    });
    expect(consumerFailure('RELEASE_WITHDRAWN', false).message).toContain('商家已撤回');
  });

  it('does not display unknown diagnostics and preserves the question for ordinary failures', () => {
    expect(consumerFailure('<script>secret supplier error</script>', false).message).not.toContain(
      'supplier',
    );
    expect(consumerFailure(undefined, true).message).toContain('不会作为新问题重复提交');
    expect(consumerFailure(undefined, false).message).toContain('可以继续提问');
    expect(consumerFailure('RATE_LIMITED', true).message).toContain('稍等片刻');
  });

  it('explains actual waiting without claiming token streaming or a guaranteed reply time', () => {
    expect(replyProgress('sending', 60)).toContain('正在发送');
    expect(replyProgress('waiting', 0)).toContain('正在等待');
    expect(replyProgress('waiting', 15)).toContain('无需重复发送');
    expect(replyProgress('waiting', 45)).toContain('刷新恢复');
    expect(replyProgress('waiting', 90)).not.toContain('秒内完成');
    expect(replyProgress('waiting', 15)).not.toContain('正在生成');
    expect(replyProgress('waiting', 15)).not.toContain('整理回答');
  });

  it('allows only bounded safe request references', () => {
    expect(supportReference('request_1234567890')).toBe('t_1234567890');
    expect(supportReference('short')).toBeNull();
    expect(supportReference('http://secret')).toBeNull();
    expect(supportReference('request_1234567890\nsecret')).toBeNull();
  });

  it('creates telephone actions only for labelled published numbers', () => {
    expect(
      publishedTelephoneNumbers('电话：13812345678\n客服热线：400-123-4567\n电话：010-12345678'),
    ).toEqual(['13812345678', '4001234567', '01012345678']);
    expect(publishedTelephoneNumbers('联系电话：+86 13812345678；电话：13812345678')).toEqual([
      '+8613812345678',
      '13812345678',
    ]);
  });

  it('does not turn arbitrary URLs, unlabelled digits, control bytes or excessive content into links', () => {
    expect(publishedTelephoneNumbers('https://shop.example/13812345678 微信shop_service')).toEqual(
      [],
    );
    expect(publishedTelephoneNumbers('订单13812345678 金额4001234567')).toEqual([]);
    expect(publishedTelephoneNumbers('电话：138123456780')).toEqual([]);
    expect(publishedTelephoneNumbers('电话：13812345678\u0000')).toEqual([]);
    expect(publishedTelephoneNumbers(`电话：13812345678${'a'.repeat(501)}`)).toEqual([]);
  });
});
