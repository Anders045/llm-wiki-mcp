import process from 'node:process';
import console from 'node:console';
import { setTimeout, clearTimeout } from 'node:timers';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildSync } from 'esbuild';

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const root = mkdtempSync(join(tmpdir(), 'wiki-stdio-'));
const vault = join(root, 'vault');
const cli = resolve(process.env.WIKI_TEST_CLI ?? 'dist/cli.js');
const page = (title, body = '合成资料') =>
  `---\ntitle: ${title}\ntype: concept\ntags: [合成]\ncreated: 2026-10-22\n---\n\n${body}`;
const children = new Set();

function client() {
  const child = spawn(process.execPath, [cli, '--vault', vault], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  let next = 0;
  let errors = '';
  const pending = new Map();
  child.stderr.on('data', (chunk) => {
    errors += chunk;
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      throw new Error(`Non-JSON stdout: ${line}`);
    }
    if (message.id !== undefined) {
      const callbacks = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) callbacks?.reject(new Error(JSON.stringify(message.error)));
      else callbacks?.resolve(message.result);
    }
  });
  child.on('exit', (code) => {
    children.delete(child);
    for (const { reject } of pending.values())
      reject(new Error(`Server exited ${code}: ${errors}`));
  });
  function request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => reject(new Error(`Timeout: ${method}: ${errors}`)), 15000);
      pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  return {
    child,
    request,
    async init() {
      const response = await request('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'fork-regression', version: '1' },
      });
      assert.equal(response.serverInfo.version, manifest.version);
      assert.equal(response.serverInfo.name, manifest.name);
      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
      );
      return response;
    },
    async call(name, args = {}) {
      return request('tools/call', { name, arguments: args });
    },
    async close() {
      const exited = once(child, 'exit');
      child.stdin.end();
      const [code, signal] = await Promise.race([
        exited,
        delay(3000).then(() => {
          throw new Error('stdio server did not exit on stdin EOF');
        }),
      ]);
      assert.equal(code, 0, `Unexpected exit signal ${signal}`);
    },
  };
}
function data(response) {
  assert.notEqual(response.isError, true, JSON.stringify(response));
  return JSON.parse(response.content[0].text);
}

try {
  assert.equal(
    execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8' }).trim(),
    manifest.version,
  );
  execFileSync(process.execPath, [cli, 'init', vault]);
  writeFileSync(join(vault, 'raw/原件.md'), 'raw-original');
  const a = client();
  const b = client();
  await Promise.all([a.init(), b.init()]);
  const tools = await a.request('tools/list');
  assert.equal(
    tools.tools
      .find((t) => t.name === 'wiki_update_page')
      .inputSchema.required.includes('expectedVersion'),
    true,
  );
  const create = data(
    await a.call('wiki_create_page', {
      title: '认知共识',
      content: page('认知共识', '[系统](阅读笔记/系统思维.md)'),
    }),
  );
  assert.equal(create.path, 'wiki/认知共识.md');
  data(
    await a.call('wiki_create_page', {
      title: '系统思维',
      directory: '阅读笔记',
      content: page('系统思维', '[[认知共识]]'),
    }),
  );
  const original = data(await a.call('wiki_read_page', { title: '系统思维' }));
  assert.equal(
    data(await a.call('wiki_search', { query: '系统思维' })).results[0].path,
    '阅读笔记/系统思维.md',
  );
  assert.deepEqual(data(await a.call('wiki_lint')).broken_links, []);
  assert.equal(
    (
      await a.call('wiki_create_page', {
        title: '系统思维',
        directory: '阅读笔记',
        content: page('系统思维'),
      })
    ).isError,
    true,
  );
  assert.equal(
    (await a.call('wiki_update_page', { path: original.path, content: page('系统思维') })).isError,
    true,
  );
  const updates = await Promise.all(
    [a, b].map((c, i) =>
      c.call('wiki_update_page', {
        path: original.path,
        expectedVersion: original.version,
        content: page('系统思维', `并发版本${i}`),
      }),
    ),
  );
  assert.equal(updates.filter((r) => r.isError === true).length, 1);
  assert.equal(updates.filter((r) => r.isError !== true).length, 1);
  const creates = await Promise.all(
    [a, b].map((c) => c.call('wiki_create_page', { title: '竞争创建', content: page('竞争创建') })),
  );
  assert.equal(creates.filter((r) => r.isError === true).length, 1);
  assert.equal((await a.call('wiki_init', { path: join(root, 'forbidden') })).isError, true);
  assert.equal(existsSync(join(root, 'forbidden')), false);
  assert.equal(
    (
      await a.call('wiki_update_page', {
        path: 'raw/原件.md',
        content: page('原件'),
        expectedVersion: original.version,
      })
    ).isError,
    true,
  );
  assert.equal(readFileSync(join(vault, 'raw/原件.md'), 'utf8'), 'raw-original');
  const current = data(await b.call('wiki_read_page', { path: original.path }));
  const removed = data(
    await b.call('wiki_delete_page', { path: original.path, expectedVersion: current.version }),
  );
  assert.deepEqual(removed.brokenLinks, ['wiki/认知共识.md']);
  writeFileSync(join(vault, 'index.md'), 'damaged-index');
  data(await a.call('wiki_rebuild_index'));
  assert.match(readFileSync(join(vault, 'index.md'), 'utf8'), /认知共识/);
  await Promise.all([a.close(), b.close()]);
  assert.equal(existsSync(join(vault, '.wiki-write.lock')), false);
  console.log(
    'PASS stdio lifecycle, metadata/version, error flags, raw/init protection, concurrent create/update, EOF cleanup',
  );

  // Kill the actual manager after its page rename and before derived-index persistence.
  // The override exists only in this synthetic worker, never in production code.
  const workerPath = join(root, 'crash-worker.cjs');
  buildSync({
    entryPoints: ['tests/runtime/crash-worker.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: workerPath,
    logLevel: 'silent',
  });
  const worker = spawn(process.execPath, [workerPath, vault], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(worker);
  const ready = createInterface({ input: worker.stdout });
  await Promise.race([
    once(ready, 'line'),
    delay(5000).then(() => {
      throw new Error('Crash worker not ready');
    }),
  ]);
  assert.equal(existsSync(join(vault, 'wiki/崩溃恢复.md')), true);
  const killed = once(worker, 'exit');
  worker.kill('SIGKILL');
  await killed;
  children.delete(worker);
  assert.equal(existsSync(join(vault, '.wiki-write.lock')), true);
  const restarted = client();
  await restarted.init();
  assert.match(
    data(await restarted.call('wiki_read_page', { title: '崩溃恢复' })).content,
    /中断前已保存/,
  );
  // Before expiration a live-looking orphan lock must reject rather than be stolen.
  const blocked = await restarted.call('wiki_rebuild_index');
  assert.equal(blocked.isError, true);
  await delay(10500);
  data(await restarted.call('wiki_rebuild_index'));
  assert.match(readFileSync(join(vault, 'index.md'), 'utf8'), /崩溃恢复/);
  await restarted.close();
  assert.equal(existsSync(join(vault, '.wiki-write.lock')), false);
  console.log(
    'PASS SIGKILL after page commit, visible lock contention, stale-lock recovery, index reconstruction, restart cleanup',
  );

  // A failed derived write is an error with an explicit already-committed page state.
  rmSync(join(vault, 'index.md'));
  mkdirSync(join(vault, 'index.md'));
  const failed = client();
  await failed.init();
  const failure = await failed.call('wiki_create_page', {
    title: '派生失败',
    content: page('派生失败'),
  });
  assert.equal(failure.isError, true);
  assert.match(failure.content[0].text, /committed.*maintenance failed/);
  assert.equal(
    data(await failed.call('wiki_read_page', { title: '派生失败' })).frontmatter.title,
    '派生失败',
  );
  rmSync(join(vault, 'index.md'), { recursive: true });
  data(await failed.call('wiki_rebuild_index'));
  await failed.close();
  console.log('PASS visible partial-maintenance failure and explicit recovery');
} finally {
  for (const child of children) child.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
}
