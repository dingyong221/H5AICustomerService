import { createServer } from 'node:http';
if (
  process.env.NODE_ENV !== 'test' ||
  process.env.APP_ENV !== 'test' ||
  !['local-fixture', 'public-free'].includes(process.env.H5CS_MARKETPLACE_MODE)
)
  throw Error('Local fixture only');
let calls = 0;
const maximum = 80;
createServer(async (req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ localFixture: true, calls, maximum }));
    return;
  }
  if (
    req.url !== '/chat/completions' ||
    req.method !== 'POST' ||
    req.headers.authorization !== `Bearer ${process.env.H5CS_E2E_MODEL_KEY}`
  ) {
    res.writeHead(404).end();
    return;
  }
  if (++calls > maximum) {
    res.writeHead(429).end();
    return;
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64000) {
      res.writeHead(413).end();
      return;
    }
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks)),
    policy = body.messages[0].content,
    facts = body.messages[1].content;
  let content =
    '本地模型夹具：提供上门空调清洗服务。' +
    (facts.includes('预约需提前1天') ? '预约需提前1天；不提供安装服务。' : '') +
    (facts.includes('也提供洗衣机清洁咨询') ? '也提供洗衣机清洁咨询。' : '');
  if (policy.includes('商家知识资料整理助手'))
    content = JSON.stringify({
      groups: [
        { topic: '商品/服务', unitIds: JSON.parse(facts.split('\n')[1]).units.map((x) => x.id) },
      ],
      reviewUnitIds: [],
    });
  if (policy.includes('文字撰写助手')) {
    const supplied = JSON.parse(facts.split('\n')[1]);
    content = JSON.stringify({
      options: [supplied.brief, supplied.brief],
      reminders: ['本地合成测试，需核对。'],
    });
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      object: 'chat.completion',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
    }),
  );
}).listen(9020, '127.0.0.1');
