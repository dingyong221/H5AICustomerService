// Linux Docker only; fail rather than substituting mocks for OS evidence.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

if (process.platform !== 'linux') throw new Error('Requires a real Linux Docker host');
const image = process.argv[2];
if (!image || !/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]+$/u.test(image))
  throw new Error('Supply the locally built merchant image');
const evidence = resolve(process.env.H5CS_PARSER_EVIDENCE ?? 'artifacts/material-parser-evidence');
await mkdir(evidence, { recursive: true });
const project = `h5cs-parser-ci-${process.pid}-${Date.now()}`;
const base = resolve(evidence, 'synthetic-compose.json');
const fault = resolve(evidence, 'synthetic-fault-compose.json');
const secret = resolve(evidence, 'synthetic-web-only.txt');
const fixtureScript = resolve(evidence, 'synthetic-extractor.mjs');
const marker = 'SYNTHETIC_PARSER_DENIAL_ONLY';
await writeFile(secret, marker, { mode: 0o644 });
await writeFile(
  base,
  JSON.stringify(
    {
      services: {
        'merchant-web': {
          image,
          pull_policy: 'never',
          init: true,
          read_only: true,
          mem_limit: '1024m',
          pids_limit: 128,
          cpus: 0.6,
          cap_drop: ['ALL'],
          security_opt: ['no-new-privileges:true'],
          tmpfs: ['/tmp:rw,noexec,nosuid,nodev,size=64m'],
          environment: {
            HOSTNAME: '0.0.0.0',
            NODE_ENV: 'production',
            PORT: '3000',
            HEALTHCHECK_PATH: '/account/login',
            SYNTHETIC_WEB_ONLY: marker,
          },
          volumes: [`${secret}:/run/secrets/h5cs-web-only:ro`],
        },
      },
    },
    null,
    2,
  ),
);
await writeFile(
  fault,
  JSON.stringify(
    {
      services: {
        'material-parser': {
          pull_policy: 'never',
          volumes: [`${fixtureScript}:/app/scripts/extract-material.mjs:ro`],
        },
      },
    },
    null,
    2,
  ),
);
// This is a test-only bind mount, never shipped in the production image/Compose.
await writeFile(
  fixtureScript,
  `import {spawn} from 'node:child_process';
import {appendFileSync} from 'node:fs';
let text='';for await(const c of process.stdin)text+=c;
if(text==='overflow'){process.stdout.write('x'.repeat(150001));setInterval(()=>{},1000);}
else {const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
appendFileSync('/tmp/parser-owned-pids.jsonl',JSON.stringify([process.pid,child.pid])+'\\n');setInterval(()=>{},1000);}
`,
);
const env = { ...process.env, H5CS_MERCHANT_WEB_IMAGE: image };
const run = (args, options = {}) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: 90000,
    maxBuffer: 2 * 1024 * 1024,
    env,
    ...options,
  });
const files = [
  '-f',
  base,
  '-f',
  resolve('infra/compose/docker-compose.release.material-parser.yml'),
  '-f',
  fault,
];
// Normal phase uses only the production parser overlay (fault override omitted).
const compose = (args, faults = false) =>
  run(['compose', '-p', project, ...files.slice(0, faults ? 6 : 4), ...args]);
const checks = [];
let web, parser;
const save = async () =>
  writeFile(
    resolve(evidence, 'results.json'),
    JSON.stringify(
      {
        image,
        imageId: run(['image', 'inspect', image, '--format', '{{.Id}}']).trim(),
        sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        checks,
      },
      null,
      2,
    ),
  );
const check = async (name, fn) => {
  try {
    const detail = await fn();
    checks.push({ name, passed: true, detail });
    await save();
    console.log(`PASS ${name}`);
  } catch (error) {
    checks.push({ name, passed: false, error: error.message });
    // Capture only this disposable synthetic project before teardown. No Web
    // environment, real secrets or unrestricted host/container logs are read.
    if (parser) {
      try {
        const log = spawnSync('docker', ['logs', '--tail', '100', parser], {
          env,
          encoding: 'utf8',
          timeout: 10000,
          maxBuffer: 256 * 1024,
        });
        if (log.error || log.status !== 0) throw new Error('Synthetic parser log unavailable');
        await writeFile(
          resolve(evidence, `parser-failure-${checks.length}.log`),
          log.stdout + log.stderr,
        );
      } catch {
        /* Preserve the original assertion if a failed container has vanished. */
      }
    }
    await save();
    throw error;
  }
};
const execNode = (container, code, input) =>
  run(
    ['exec', ...(input ? ['-i'] : []), container, 'node', '--input-type=module', '-e', code],
    input ? { input } : {},
  );
const healthy = () =>
  execNode(
    web,
    `const r=await fetch('http://127.0.0.1:3000/account/login');if(!r.ok)throw Error('Web unhealthy');console.log(r.status);`,
  ).trim();
const extraction = (bytes, mime, expected = true) =>
  execNode(
    web,
    `import{parseIsolated}from './scripts/material-parser-runtime.mjs';const chunks=[];for await(const c of process.stdin)chunks.push(c);try{const text=await parseIsolated(Buffer.concat(chunks),${JSON.stringify(mime)});if(!${expected})throw Error('Unexpected success');console.log(JSON.stringify({text}));}catch(e){if(${expected})throw e;console.log(JSON.stringify({code:e.code}));}`,
    bytes,
  );
const raw = (wire, wait = 3000) =>
  execNode(
    web,
    `import{connect}from'node:net';const s=connect('/run/h5cs-material-parser/parser.sock');let result='';const timer=setTimeout(()=>s.destroy(),${wait});s.on('connect',()=>s.write(${JSON.stringify(wire)}));s.on('data',c=>result+=c);s.on('close',()=>{clearTimeout(timer);if(result.includes('200 OK'))throw Error('Protocol accepted');console.log(result.split('\\r\\n')[0]||'closed');});s.on('error',()=>{});`,
  );
const inspect = (id) => JSON.parse(run(['inspect', id]))[0];
try {
  // Override pull policy without altering the reviewed isolation settings.
  const noPull = resolve(evidence, 'local-image.json');
  await writeFile(
    noPull,
    JSON.stringify({ services: { 'material-parser': { pull_policy: 'never' } } }),
  );
  run([
    'compose',
    '-p',
    project,
    ...files.slice(0, 4),
    '-f',
    noPull,
    'up',
    '-d',
    '--wait',
    '--wait-timeout',
    '120',
  ]);
  web = compose(['ps', '-q', 'merchant-web']).trim();
  parser = compose(['ps', '-q', 'material-parser']).trim();
  assert(web && parser);
  await check('actual container resource and mount boundaries', async () => {
    const p = inspect(parser),
      w = inspect(web),
      h = p.HostConfig;
    assert.equal(h.NetworkMode, 'none');
    assert.equal(h.ReadonlyRootfs, true);
    assert.equal(h.Memory, 512 * 1024 * 1024);
    assert.equal(h.MemorySwap, h.Memory);
    assert.equal(h.NanoCpus, 400000000);
    assert.equal(h.PidsLimit, 48);
    assert(h.CapDrop.includes('ALL'));
    assert(h.SecurityOpt.some((value) => /^no-new-privileges(?::true)?$/u.test(value)));
    assert.equal(p.Config.User, '1000:1000');
    const diskMounts = p.Mounts.filter((m) => m.Type !== 'tmpfs');
    assert.equal(diskMounts.length, 1);
    assert.equal(diskMounts[0].Destination, '/run/h5cs-material-parser');
    assert(diskMounts[0].RW);
    assert.equal(diskMounts[0].Type, 'volume');
    assert(
      /noexec/u.test(h.Tmpfs['/tmp']) &&
        /nosuid/u.test(h.Tmpfs['/tmp']) &&
        /nodev/u.test(h.Tmpfs['/tmp']),
    );
    assert(w.Mounts.every((m) => !m.Destination.includes('docker.sock')));
    assert.equal(w.Mounts.find((m) => m.Destination === '/run/h5cs-material-parser').RW, false);
    assert(!p.Config.Env.some((e) => /MYSQL|DATABASE|QWEN|SESSION|SYNTHETIC_WEB_ONLY/u.test(e)));
    const detail = {
      network: h.NetworkMode,
      memory: h.Memory,
      cpu: h.NanoCpus,
      pids: h.PidsLimit,
      tmpfs: h.Tmpfs,
      user: p.Config.User,
      mounts: p.Mounts.map((m) => ({ type: m.Type, path: m.Destination, rw: m.RW })),
    };
    await writeFile(resolve(evidence, 'actual-boundaries.json'), JSON.stringify(detail, null, 2));
    return detail;
  });
  await check('OS denies network, Web-only synthetic secret and rootfs write', () => {
    assert.equal(
      execNode(
        web,
        `import{readFileSync}from'node:fs';console.log(readFileSync('/run/secrets/h5cs-web-only','utf8'));`,
      ).trim(),
      marker,
    );
    return JSON.parse(
      execNode(
        parser,
        `import assert from'node:assert/strict';import{readFileSync,writeFileSync,lstatSync}from'node:fs';import{networkInterfaces}from'node:os';import{connect}from'node:net';
assert.throws(()=>readFileSync('/run/secrets/h5cs-web-only'),{code:'ENOENT'});assert.throws(()=>writeFileSync('/app/denied','x'),{code:'EROFS'});assert(/NoNewPrivs:\\s+1/u.test(readFileSync('/proc/self/status','utf8')));assert(/CapEff:\\s+0+\\n/u.test(readFileSync('/proc/self/status','utf8')));assert.equal(readFileSync('/sys/fs/cgroup/memory.max','utf8').trim(),'536870912');
assert.deepEqual(Object.keys(networkInterfaces()),['lo']);await new Promise((resolve,reject)=>{const s=connect({host:'198.51.100.1',port:9});s.setTimeout(1000,()=>{s.destroy();reject(Error('unexpected route/timeout'))});s.on('connect',()=>{s.destroy();reject(Error('network allowed'))});s.on('error',e=>{assert(['ENETUNREACH','EHOSTUNREACH'].includes(e.code));resolve()});});
const d=lstatSync('/run/h5cs-material-parser'),s=lstatSync('/run/h5cs-material-parser/parser.sock');assert.equal(d.uid,1000);assert.equal(d.mode&511,448);assert(s.isSocket());assert.equal(s.mode&511,384);console.log(JSON.stringify({interfaces:Object.keys(networkInterfaces()),directoryMode:d.mode&511,socketMode:s.mode&511,secret:'ENOENT',rootfs:'EROFS',network:'unreachable'}));`,
      ),
    );
  });
  await check('real Office and UTF-8 formats across Web socket', async () => {
    const fixtures = [
      ['simple.doc', 'application/msword', 'simple file'],
      [
        'SampleDoc.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'I am a test document',
      ],
      ['basic_test_ppt_file.ppt', 'application/vnd.ms-powerpoint', 'This is a test title'],
      [
        'SampleShow.pptx',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'Title of the first slide',
      ],
      ['testEXCEL_95.xls', 'application/vnd.ms-excel', 'Numbers and their Squares'],
      [
        'sample.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Lorem 111',
      ],
    ];
    const results = [];
    for (const [file, mime, expected] of fixtures) {
      const bytes = await readFile(resolve('apps/merchant-web/app/knowledge/fixtures', file));
      assert(JSON.parse(extraction(bytes, mime)).text.includes(expected));
      results.push({ file, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    for (const mime of ['text/plain', 'text/csv', 'text/markdown'])
      assert(JSON.parse(extraction(Buffer.from('测试商品,99'), mime)).text.includes('测试商品'));
    return results;
  });
  await check('real PDF and invalid/encrypted/oversized extraction preserve Web', async () => {
    // Public synthetic fixture pins and generated valid PDF are also covered by
    // the host native suite; exercise PDFium here using the fixture's text layer.
    const fixtureDir = resolve('apps/merchant-web/app/knowledge/fixtures');
    const content = 'BT /F1 18 Tf 40 100 Td (Retail shipping policy) Tj ET';
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    for (const [i, object] of objects.entries()) {
      offsets.push(Buffer.byteLength(pdf));
      pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
    }
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
      .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    assert(
      JSON.parse(extraction(Buffer.from(pdf), 'application/pdf')).text.includes(
        'Retail shipping policy',
      ),
    );
    for (const file of ['encrypted.pdf', 'image-only.pdf'])
      assert(
        ['invalid', 'empty'].includes(
          JSON.parse(
            extraction(await readFile(resolve(fixtureDir, file)), 'application/pdf', false),
          ).code,
        ),
      );
    assert.equal(
      JSON.parse(extraction(Buffer.from('测'.repeat(24001)), 'text/plain', false)).code,
      'empty',
    );
    assert.equal(
      JSON.parse(extraction(Buffer.from('%PDF-broken'), 'application/pdf', false)).code,
      'invalid',
    );
    assert.equal(
      JSON.parse(
        extraction(
          Buffer.from('504b0304', 'hex'),
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          false,
        ),
      ).code,
      'invalid',
    );
    assert.equal(healthy(), '200');
    return { web: 'healthy' };
  });
  await check('strict raw RPC rejects paths, MIME, length and TE ambiguity', () => {
    const rejected = [];
    for (const wire of [
      'POST /v1/extract?url=http://example.invalid/ HTTP/1.1\r\nHost: local\r\nContent-Type: text/plain\r\nContent-Length: 1\r\n\r\nx',
      'POST /etc/passwd HTTP/1.1\r\nHost: local\r\nContent-Type: text/plain\r\nContent-Length: 1\r\n\r\nx',
      'POST /v1/extract HTTP/1.1\r\nHost: local\r\nContent-Type: application/octet-stream\r\nContent-Length: 1\r\n\r\nx',
      'POST /v1/extract HTTP/1.1\r\nHost: local\r\nContent-Type: text/plain\r\nContent-Length: 10485761\r\n\r\n',
      'POST /v1/extract HTTP/1.1\r\nHost: local\r\nContent-Type: text/plain\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n',
      'POST /v1/extract HTTP/1.1\r\nHost: local\r\nContent-Type: text/plain\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\nx',
    ])
      rejected.push(raw(wire).trim());
    return rejected;
  });
  await check('receive-stage cancellation, single admission and absolute 20s body budget', () => {
    return execNode(
      web,
      `import assert from'node:assert/strict';import{connect}from'node:net';import{parseIsolated}from'./scripts/material-parser-runtime.mjs';
const slow=()=>new Promise(resolve=>{const s=connect('/run/h5cs-material-parser/parser.sock');s.on('error',()=>{});s.on('connect',()=>{s.write('POST /v1/extract HTTP/1.1\\r\\nHost: local\\r\\nContent-Type: text/plain\\r\\nContent-Length: 100\\r\\n\\r\\nx');resolve(s)});});
let s=await slow();await new Promise(r=>setTimeout(r,100));await assert.rejects(parseIsolated(Buffer.from('one'),'text/plain'),e=>e.code==='busy');s.destroy();await new Promise(r=>setTimeout(r,300));assert.equal(await parseIsolated(Buffer.from('recovered'),'text/plain'),'recovered');
const start=Date.now();s=await slow();await new Promise((resolve,reject)=>{const t=setTimeout(()=>{s.destroy();reject(Error('receive timeout exceeded'))},22000);s.on('close',()=>{clearTimeout(t);resolve()})});assert(Date.now()-start>=19000);console.log(JSON.stringify({receiveDeadlineMs:Date.now()-start,cancelledBody:'recovered',busy:'rejected'}));`,
    ).trim();
  });
  await check('actual cgroup CPU throttling and PID refusal', () =>
    execNode(
      parser,
      `import assert from'node:assert/strict';import{readFileSync}from'node:fs';import{spawn}from'node:child_process';
const stat=()=>Object.fromEntries(readFileSync('/sys/fs/cgroup/cpu.stat','utf8').trim().split('\\n').map(l=>l.split(' ').map((x,i)=>i?Number(x):x)));const before=stat();const start=Date.now();while(Date.now()-start<2200){}const after=stat();assert(after.nr_throttled>before.nr_throttled);
assert.equal(readFileSync('/sys/fs/cgroup/pids.max','utf8').trim(),'48');const children=[];let denied=0;for(let i=0;i<60;i++){const child=spawn('/bin/sleep',['20'],{stdio:'ignore'});children.push(child);child.on('error',e=>{assert.equal(e.code,'EAGAIN');denied++});}await new Promise(r=>setTimeout(r,500));for(const c of children)c.kill('SIGKILL');assert(denied>0);console.log(JSON.stringify({throttled:after.nr_throttled-before.nr_throttled,pidDenied:denied,cpuMax:readFileSync('/sys/fs/cgroup/cpu.max','utf8').trim()}));`,
    ).trim(),
  );
  await check('tmpfs enforces size, noexec and cleanup without affecting Web', () => {
    const result = execNode(
      parser,
      `import assert from'node:assert/strict';import{openSync,writeSync,closeSync,unlinkSync,writeFileSync,readFileSync}from'node:fs';import{spawnSync}from'node:child_process';
const path='/tmp/isolation-cap';let fd;let written=0;try{fd=openSync(path,'w');const b=Buffer.alloc(1024*1024);for(let i=0;i<70;i++)written+=writeSync(fd,b);throw Error('tmp unbounded');}catch(e){assert.equal(e.code,'ENOSPC');}finally{if(fd!==undefined)closeSync(fd);unlinkSync(path);}assert(written<=64*1024*1024);writeFileSync(path,'#!/bin/sh\\nexit 0\\n',{mode:0o755});assert.equal(spawnSync(path).error.code,'EACCES');unlinkSync(path);console.log(JSON.stringify({written,mount:readFileSync('/proc/mounts','utf8').split('\\n').find(l=>l.includes(' /tmp '))}));`,
    ).trim();
    assert.equal(healthy(), '200');
    return result;
  });
  await check(
    'RSS cgroup OOM kills disposable stress while Web survives and parser recovers',
    async () => {
      const since = new Date(Date.now() - 1000).toISOString();
      let status = 0;
      try {
        execNode(
          parser,
          `const keep=[];setInterval(()=>{for(let i=0;i<4;i++)keep.push(Buffer.alloc(8*1024*1024,0xff));},10);`,
        );
      } catch (error) {
        status = error.status;
      }
      assert(status !== 0, 'stress must be terminated by the OS limit');
      const events = run([
        'events',
        '--since',
        since,
        '--until',
        new Date().toISOString(),
        '--filter',
        `container=${parser}`,
        '--filter',
        'event=oom',
        '--format',
        '{{json .}}',
      ]);
      assert(events.trim(), 'must observe Docker OOM event, not merely a heap error');
      assert.equal(healthy(), '200');
      let recovered = false;
      for (let i = 0; i < 30; i++) {
        try {
          assert.equal(
            JSON.parse(extraction(Buffer.from('post OOM'), 'text/plain')).text,
            'post OOM',
          );
          recovered = true;
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      assert(recovered, 'parser did not recover after bounded OOM');
      return { exit: status, oomEvents: events.trim().split('\n').length, web: 'healthy' };
    },
  );
  await check('service loss fails closed and recovery does not require Web restart', async () => {
    compose(['stop', 'material-parser']);
    assert.equal(
      JSON.parse(extraction(Buffer.from('not local fallback'), 'text/plain', false)).code,
      'unavailable',
    );
    assert.equal(healthy(), '200');
    compose(['start', 'material-parser']);
    let recovered = false;
    for (let i = 0; i < 30; i++) {
      try {
        assert.equal(
          JSON.parse(extraction(Buffer.from('post restart'), 'text/plain')).text,
          'post restart',
        );
        recovered = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    assert(recovered, 'parser RPC did not recover after restart');
    assert.equal(compose(['ps', '-q', 'merchant-web']).trim(), web);
    assert.equal(healthy(), '200');
    return { failClosed: true, rpcRecovered: true, sameWebContainer: true, web: 'healthy' };
  });
  // A separate phase replaces only the trusted child implementation, to make
  // timeout/descendant/overflow behavior deterministic without product test hooks.
  compose(
    ['up', '-d', '--force-recreate', '--wait', '--wait-timeout', '60', 'material-parser'],
    true,
  );
  parser = compose(['ps', '-q', 'material-parser'], true).trim();
  await check('child-stage abort and deadline kill owned process group including descendant', () =>
    JSON.parse(
      execNode(
        web,
        `import assert from'node:assert/strict';import{request}from'node:http';import{parseIsolated}from'./scripts/material-parser-runtime.mjs';
const observed=[];for(const timeout of [1500,20000]){const controller=new AbortController();const start=Date.now();const result=parseIsolated(Buffer.from('hang'),'text/plain',{signal:controller.signal});if(timeout===1500)setTimeout(()=>controller.abort(),timeout);await assert.rejects(result,e=>{observed.push({expected:timeout===1500?'cancelled':'timeout',actual:e.code,elapsedMs:Date.now()-start});assert.equal(e.code,timeout===1500?'cancelled':'timeout',JSON.stringify(observed));return true});const elapsed=Date.now()-start;assert(elapsed>=timeout-100&&elapsed<timeout+1500,JSON.stringify(observed));await new Promise(r=>setTimeout(r,500));}
// Bypass the client's own deadline once: the broker itself must flush 408 JSON,
// rather than merely relying on the client to turn a closed socket into timeout.
const start=Date.now();const rpc=await new Promise((resolve,reject)=>{const req=request({socketPath:'/run/h5cs-material-parser/parser.sock',path:'/v1/extract',method:'POST',agent:false,headers:{'content-type':'text/plain','content-length':4,connection:'close'}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,payload:JSON.parse(Buffer.concat(chunks))}))});const timer=setTimeout(()=>{req.destroy();reject(Error('broker timeout reply exceeded 22s'))},22000);req.on('error',reject);req.on('close',()=>clearTimeout(timer));req.end('hang')});assert.deepEqual(rpc,{status:408,payload:{error:'timeout'}});const elapsedMs=Date.now()-start;assert(elapsedMs>=19900&&elapsedMs<21500);observed.push({expected:'broker-timeout-json',...rpc,elapsedMs});console.log(JSON.stringify(observed));`,
      ).trim(),
    ),
  );
  await check(
    'owned descendants are gone after cancellation/deadline; output cap preserves Web',
    () => {
      const detail = execNode(
        parser,
        `import assert from'node:assert/strict';import{readFileSync,existsSync}from'node:fs';const pairs=readFileSync('/tmp/parser-owned-pids.jsonl','utf8').trim().split('\\n').map(l=>JSON.parse(l));assert.equal(pairs.length,3);const pids=pairs.flat();const start=Date.now();while(pids.some(pid=>existsSync('/proc/'+pid))&&Date.now()-start<5000)await new Promise(r=>setTimeout(r,100));for(const pid of pids)assert(!existsSync('/proc/'+pid),'owned process survived: '+pid);console.log(JSON.stringify({ownedPidsGone:pids,cleanupWaitMs:Date.now()-start}));`,
      ).trim();
      assert.equal(
        JSON.parse(extraction(Buffer.from('overflow'), 'text/plain', false)).code,
        'overflow',
      );
      assert.equal(healthy(), '200');
      return detail;
    },
  );
  // Non-socket stale entry must not be removed or turned into a listener.
  await check('socket directory refuses ordinary stale entries without unlinking them', () => {
    compose(['stop', 'material-parser'], true);
    // Mount the owned test volume in a one-shot container under the same UID.
    const volume = inspect(parser).Mounts.find(
      (m) => m.Destination === '/run/h5cs-material-parser',
    ).Name;
    run([
      'run',
      '--rm',
      '--network',
      'none',
      '--user',
      '1000:1000',
      '--volume',
      `${volume}:/run/h5cs-material-parser`,
      image,
      'node',
      '--input-type=module',
      '-e',
      `import{unlinkSync,writeFileSync}from'node:fs';try{unlinkSync('/run/h5cs-material-parser/parser.sock')}catch{}writeFileSync('/run/h5cs-material-parser/parser.sock','synthetic-do-not-unlink');`,
    ]);
    let rejected = false;
    try {
      run([
        'run',
        '--rm',
        '--network',
        'none',
        '--user',
        '1000:1000',
        '--volume',
        `${volume}:/run/h5cs-material-parser`,
        image,
        'node',
        'scripts/serve-material-parser.mjs',
      ]);
    } catch (error) {
      assert.match(error.stderr ?? '', /Unsafe parser socket entry/u);
      rejected = true;
    }
    assert(rejected);
    const preserved = run([
      'run',
      '--rm',
      '--network',
      'none',
      '--user',
      '1000:1000',
      '--volume',
      `${volume}:/run/h5cs-material-parser`,
      image,
      'node',
      '--input-type=module',
      '-e',
      `import assert from'node:assert/strict';import{readFileSync}from'node:fs';assert.equal(readFileSync('/run/h5cs-material-parser/parser.sock','utf8'),'synthetic-do-not-unlink');console.log('preserved');`,
    ]).trim();
    assert.equal(preserved, 'preserved');
    return { refusedNonSocket: true, ordinaryEntryPreserved: true };
  });
} finally {
  // Only the unique disposable Compose project and its socket volume are removed.
  compose(['down', '--volumes', '--remove-orphans'], true);
}
