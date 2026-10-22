import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_SCHEMA } from '../../src/config/types.js';
import { WikiManager } from '../../src/core/wiki-manager.js';
import { LinkResolver } from '../../src/core/link-resolver.js';
import { IndexManager } from '../../src/core/index-manager.js';
import { LogManager } from '../../src/core/log-manager.js';
import { handleLint } from '../../src/tools/lint.js';
import { handleIngest } from '../../src/tools/ingest.js';
import { SimpleProvider } from '../../src/search/simple-provider.js';
import { handleInit } from '../../src/tools/init.js';
import { loadSchema } from '../../src/config/schema-loader.js';
import { handleSearch } from '../../src/tools/search.js';
import lockfile from 'proper-lockfile';

let vault: string;
let manager: WikiManager;
let index: IndexManager;
const resolver = new LinkResolver('wikilink', 'wiki');
const page = (title: string, body = '合成知识', type = 'concept') =>
  `---\ntitle: ${title}\ntype: ${type}\ntags: [合成]\ncreated: 2026-10-22\n---\n\n${body}`;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'personal-wiki-'));
  mkdirSync(join(vault, 'wiki'));
  mkdirSync(join(vault, 'raw'));
  index = new IndexManager(vault, resolver);
  manager = new WikiManager(vault, DEFAULT_SCHEMA, resolver, index, new LogManager(vault));
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

describe('personal wiki public operations', () => {
  it('does not commit a queued write after cancellation and releases an acquired lock', async () => {
    const held = await lockfile.lock(vault, { lockfilePath: join(vault, '.wiki-write.lock') });
    const controller = new AbortController();
    const pending = manager.createPage(
      '取消验收',
      page('取消验收'),
      undefined,
      '',
      controller.signal,
    );
    controller.abort(new Error('Synthetic request cancellation'));
    await held();
    await expect(pending).rejects.toThrow(/cancellation/);
    expect(manager.listWikiFiles()).toEqual([]);
    expect(existsSync(join(vault, '.wiki-write.lock'))).toBe(false);
    expect(existsSync(join(vault, 'index.md'))).toBe(false);
  });

  it('returns a public search path that can be reused directly for reading', async () => {
    await manager.createPage('搜索复用', page('搜索复用'), 'concept', '笔记');
    const result = await handleSearch(
      { query: '搜索复用' },
      new SimpleProvider(),
      join(vault, 'wiki'),
      'wiki',
    );
    expect((await manager.readPage({ path: result.results[0].path })).frontmatter.title).toBe(
      '搜索复用',
    );
  });
  it('preserves Chinese spaces/punctuation and resolves encoded Markdown filenames', async () => {
    const title = '阅读 共识（①）#问题[甲]';
    await manager.createPage(title, page(title));
    const generated = readFileSync(join(vault, 'index.md'), 'utf8');
    expect(generated).toContain(encodeURIComponent('#'));
    expect((await index.read())[0].title).toBe(title);
    expect((await handleLint({}, vault, DEFAULT_SCHEMA, resolver)).stale_index_entries).toEqual([]);
    expect((await manager.readPage({ title })).content).toContain(title);
  });

  it('treats NFC-equivalent and case-equivalent names as conflicts without folding compatibility characters', async () => {
    await manager.createPage('Café', page('Café'));
    const duplicate = await manager.createPage('Cafe\u0301', page('Cafe\u0301'));
    expect(duplicate.success).toBe(false);
    expect((await manager.readPage({ title: 'Cafe\u0301' })).frontmatter.title).toBe('Café');
    await manager.createPage('Case Page', page('Case Page'));
    expect((await manager.createPage('CASE PAGE', page('CASE PAGE'))).success).toBe(false);
    await manager.createPage('知识①', page('知识①'));
    await manager.createPage('知识1', page('知识1'));
    expect(manager.listWikiFiles()).toHaveLength(4);
  });

  it('allows four nested directories and rejects the fifth before writing', async () => {
    await manager.createPage('深度', page('深度'), 'concept', '甲/乙/丙/丁');
    expect((await manager.readPage({ title: '深度' })).path).toBe('wiki/甲/乙/丙/丁/深度.md');
    await expect(
      manager.createPage('越界深度', page('越界深度'), 'concept', '甲/乙/丙/丁/戊'),
    ).rejects.toThrow(/depth/);
    expect(manager.listWikiFiles()).toHaveLength(1);
  });

  it('does not split existing directories on case or NFC differences', async () => {
    await manager.createPage('一', page('一'), 'concept', 'Notes');
    const created = await manager.createPage('二', page('二'), 'concept', 'notes');
    expect(created.path).toBe('wiki/Notes/二.md');
  });

  it('rejects unsafe filenames, directories and schema overlap', async () => {
    for (const title of ['CON', 'NUL.md', 'a/b', 'a\\b', 'bad\u0000', 'tail.', '.hidden']) {
      await expect(manager.createPage(title, page(title))).rejects.toThrow();
    }
    for (const directory of ['../raw', '/tmp', '甲/../raw', '.hidden']) {
      await expect(
        manager.createPage('安全', page('安全'), 'concept', directory),
      ).rejects.toThrow();
    }
    writeFileSync(join(vault, '.wiki-schema.yaml'), 'paths:\n  wiki: raw/pages\n');
    expect(() => loadSchema(vault)).toThrow(/overlap/);
  });

  it('keeps original bytes on validation failure and rejects missing/delete stale revisions', async () => {
    await manager.createPage('原文', page('原文'));
    const original = await manager.readPage({ title: '原文' });
    for (const content of [
      page('原文').replace('2026-10-22', '2026-02-31'),
      page('原文').replace('tags: [合成]', 'tags: wrong'),
      '---\ntitle: [broken\n---\ntext',
    ]) {
      await expect(manager.updatePage(original.path, content, original.version)).rejects.toThrow();
      expect(readFileSync(join(vault, original.path), 'utf8')).toBe(original.content);
    }
    await expect(manager.updatePage(original.path, page('原文'))).rejects.toThrow(/Conflict/);
    await manager.updatePage(original.path, page('原文', '新版'), original.version);
    await expect(manager.deletePage(original.path, original.version)).rejects.toThrow(/Conflict/);
  });

  it('resolves relative Markdown backlinks and reports ambiguous wiki links', async () => {
    await manager.createPage('目标', page('目标'));
    await manager.createPage(
      '引用',
      page('引用', '[unrelated display](../目标.md#标题)\nhttps://example.com\n`[[代码示例]]`'),
      'concept',
      '笔记',
    );
    expect((await handleLint({}, vault, DEFAULT_SCHEMA, resolver)).broken_links).toEqual([]);
    const target = await manager.readPage({ title: '目标' });
    expect((await manager.deletePage(target.path, target.version)).brokenLinks).toEqual([
      'wiki/笔记/引用.md',
    ]);
    await manager.createPage('重复', page('重复'), 'concept', '甲');
    await manager.createPage('重复', page('重复'), 'concept', '乙');
    await manager.createPage('歧义引用', page('歧义引用', '[[重复]]'));
    const lint = await handleLint({}, vault, DEFAULT_SCHEMA, resolver);
    const reason = lint.broken_links.find((link) => link.to === '重复')?.reason;
    expect(reason).toContain('Ambiguous');
    expect(reason).toContain('wiki/甲/重复.md');
    expect(reason).toContain('wiki/乙/重复.md');
  });

  it('reports committed pages when index maintenance fails and can recover without rewriting pages', async () => {
    const failure = vi
      .spyOn(index, 'rebuild')
      .mockRejectedValueOnce(new Error('synthetic disk failure'));
    await expect(manager.createPage('已保存', page('已保存'))).rejects.toThrow(
      /committed.*maintenance failed/,
    );
    failure.mockRestore();
    const original = await manager.readPage({ title: '已保存' });
    await manager.rebuildIndex();
    expect((await manager.readPage({ title: '已保存' })).version).toBe(original.version);
    expect((await index.read())[0].title).toBe('已保存');
  });

  it('restricts MCP initialization and rejects symlinked metadata without touching the target', async () => {
    await expect(handleInit({ path: join(vault, 'elsewhere') }, vault)).rejects.toThrow(
      /configured vault/,
    );
    writeFileSync(join(vault, 'raw/保持.txt'), '原件');
    symlinkSync(join(vault, 'raw/保持.txt'), join(vault, '.wiki-schema.yaml'));
    await expect(handleInit({ path: vault }, vault)).rejects.toThrow(/Symbolic/);
    expect(readFileSync(join(vault, 'raw/保持.txt'), 'utf8')).toBe('原件');
  });
  it('preserves distinct Chinese filenames and recursively resolves paths, titles and both links', async () => {
    await manager.createPage('认知共识', page('认知共识', '[系统](阅读笔记/系统思维.md)'));
    await manager.createPage('系统思维', page('系统思维', '[[认知共识]]'), 'concept', '阅读笔记');
    expect((await manager.readPage({ title: '认知共识' })).path).toBe('wiki/认知共识.md');
    expect((await manager.readPage({ title: '系统思维' })).path).toBe('wiki/阅读笔记/系统思维.md');
    expect((await index.read()).map((p) => p.path)).toHaveLength(2);
    expect((await handleLint({}, vault, DEFAULT_SCHEMA, resolver)).broken_links).toEqual([]);
    expect(
      (
        await new SimpleProvider().search('系统思维', {
          wikiDir: join(vault, 'wiki'),
          maxResults: 10,
        })
      )[0].path,
    ).toBe('阅读笔记/系统思维.md');
  });

  it('rejects ambiguous titles but permits full paths and legacy English pages', async () => {
    await manager.createPage('同名', page('同名'), 'concept', '甲');
    await manager.createPage('同名', page('同名'), 'concept', '乙');
    await expect(manager.readPage({ title: '同名' })).rejects.toThrow(/Ambiguous/);
    expect((await manager.readPage({ path: 'wiki/乙/同名.md' })).frontmatter.title).toBe('同名');
    writeFileSync(join(vault, 'wiki/legacy-page.md'), page('Legacy Page'));
    expect((await manager.readPage({ title: 'Legacy Page' })).path).toBe('wiki/legacy-page.md');
  });

  it('rejects mismatched or invalid metadata before creating a page', async () => {
    await expect(manager.createPage('一致', page('不同'))).rejects.toThrow(/title/);
    await expect(manager.createPage('坏页', '---\ntitle: [broken\n---\ntext')).rejects.toThrow();
    await expect(
      manager.createPage('缺字段', '---\ntitle: 缺字段\ntype: concept\n---\ntext'),
    ).rejects.toThrow(/required/);
    expect(manager.listWikiFiles()).toEqual([]);
  });

  it('refuses raw, metadata, escaping and symlink targets without modifying sources', async () => {
    const source = join(vault, 'raw/原件.md');
    writeFileSync(source, 'original');
    symlinkSync(join(vault, 'raw'), join(vault, 'wiki/别名'));
    for (const path of [
      'raw/原件.md',
      '.wiki-schema.yaml',
      'index.md',
      '../outside.md',
      'wiki/别名/原件.md',
    ]) {
      await expect(manager.updatePage(path, page('破坏'), 'invalid')).rejects.toThrow();
      await expect(manager.deletePage(path, 'invalid')).rejects.toThrow();
    }
    await expect(
      handleIngest({ source_path: 'index.md' }, vault, DEFAULT_SCHEMA),
    ).rejects.toThrow();
    expect(readFileSync(source, 'utf8')).toBe('original');
  });

  it('refreshes derived metadata, rejects stale revisions and rebuilds a damaged index', async () => {
    await manager.createPage('原题', page('原题'));
    const original = await manager.readPage({ title: '原题' });
    await manager.updatePage(original.path, page('新题', '新摘要', 'entity'), original.version);
    expect((await index.read())[0]).toMatchObject({
      title: '新题',
      summary: '新摘要',
      pageType: 'entity',
      path: original.path,
    });
    await expect(manager.updatePage(original.path, page('旧写'), original.version)).rejects.toThrow(
      /Conflict/,
    );
    writeFileSync(join(vault, 'index.md'), 'damaged');
    await manager.rebuildIndex();
    expect((await index.read())[0].title).toBe('新题');
  });

  it.each(['新[标题]', '新标题]'])(
    'preserves updated display title %s while the existing filename stays unchanged',
    async (title) => {
      await manager.createPage('原题', page('原题'));
      const original = await manager.readPage({ title: '原题' });
      const updated = page(title, '更新后的正文');
      await manager.updatePage(original.path, updated, original.version);

      expect((await index.read())[0]).toMatchObject({ title, path: original.path });
      expect((await manager.readPage({ title })).content).toBe(updated);
      expect(manager.listWikiFiles()).toEqual([original.path]);
      const generated = readFileSync(join(vault, 'index.md'), 'utf8');
      expect(generated).toContain('\\]');
      expect(resolver.parseLinks(generated)[0].displayText).toBe(title);
      expect((await handleLint({}, vault, DEFAULT_SCHEMA, resolver)).stale_index_entries).toEqual(
        [],
      );
    },
  );
});
