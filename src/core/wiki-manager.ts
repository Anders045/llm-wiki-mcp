import { mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, posix, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import matter from 'gray-matter';
import yaml from 'js-yaml';
import lockfile from 'proper-lockfile';
import type { WikiSchema, PageData } from '../config/types.js';
import type { LinkResolver } from './link-resolver.js';
import type { IndexManager } from './index-manager.js';
import type { LogManager } from './log-manager.js';
import { safePath } from '../utils/safe-path.js';
import { atomicWrite } from '../utils/atomic-write.js';
import {
  catalog,
  comparisonKey,
  existingDirectory,
  resolveLink,
  resolvePage,
  validateDirectory,
  validateName,
} from './page-catalog.js';
import { validateSchemaPaths } from '../config/schema-loader.js';

export const pageVersion = (content: string): string =>
  createHash('sha256').update(content).digest('hex');

/** File-backed facade. Every mutation holds the same vault lock across revision checks,
 * page replacement and derived-index refresh. This is not a multi-file transaction. */
export class WikiManager {
  constructor(
    private vaultPath: string,
    private schema: WikiSchema,
    private linkResolver: LinkResolver,
    private indexManager: IndexManager,
    private logManager: LogManager,
  ) {
    validateSchemaPaths(vaultPath, schema);
  }

  private pagePath(path: string): string {
    const absolute = safePath(this.vaultPath, path);
    const wiki = safePath(this.vaultPath, this.schema.paths.wiki);
    const inner = relative(wiki, absolute).split('\\').join('/');
    if (
      inner.startsWith('../') ||
      inner === '..' ||
      !inner.endsWith('.md') ||
      inner.startsWith('/')
    ) {
      throw new Error('Page path must be a Markdown file within the configured wiki directory');
    }
    validateDirectory(posix.dirname(inner) === '.' ? '' : posix.dirname(inner));
    validateName(posix.basename(inner));
    return absolute;
  }

  private validateContent(content: string, title?: string, pageType?: string) {
    const parsed = matter(content, {
      engines: { yaml: (source) => yaml.load(source, { schema: yaml.CORE_SCHEMA }) as object },
    });
    const data = parsed.data;
    if (typeof data.title !== 'string' || !data.title.trim())
      throw new Error('Frontmatter title is required and must be a string');
    validateName(data.title);
    if (title !== undefined && title.normalize('NFC') !== data.title.normalize('NFC'))
      throw new Error('Create title must match frontmatter title');
    if (typeof data.type !== 'string' || !this.schema.pageTypes[data.type])
      throw new Error('Frontmatter type must be a configured page type');
    if (pageType !== undefined && pageType !== data.type)
      throw new Error('pageType must match frontmatter type');
    for (const field of this.schema.pageTypes[data.type].requiredFields) {
      if (data[field] === undefined || data[field] === null || data[field] === '')
        throw new Error(`Frontmatter required field: ${field}`);
    }
    for (const field of ['tags', 'subjects']) {
      if (
        data[field] !== undefined &&
        (!Array.isArray(data[field]) ||
          data[field].some((v: unknown) => typeof v !== 'string' || !v.trim()))
      )
        throw new Error(`Frontmatter ${field} must be an array of nonempty strings`);
    }
    if (this.schema.tags.required && (!Array.isArray(data.tags) || !data.tags.length))
      throw new Error('Frontmatter tags are required');
    for (const field of ['created', 'updated']) {
      if (data[field] === undefined) continue;
      const value =
        data[field] instanceof Date ? data[field].toISOString().slice(0, 10) : data[field];
      if (
        typeof value !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString().slice(0, 10) !== value
      )
        throw new Error(`Frontmatter ${field} must be a valid YYYY-MM-DD date`);
    }
    if (data.source_path !== undefined) {
      if (typeof data.source_path !== 'string')
        throw new Error('Frontmatter source_path must be a string');
      const source = safePath(this.vaultPath, data.source_path);
      const raw = safePath(this.vaultPath, this.schema.paths.raw);
      if (!source.startsWith(raw + sep))
        throw new Error('source_path must be within the raw directory');
    }
    return parsed;
  }

  private async writing<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    safePath(this.vaultPath, '.');
    const lockPath = safePath(this.vaultPath, '.wiki-write.lock');
    const release = await lockfile.lock(this.vaultPath, {
      lockfilePath: lockPath,
      stale: 10000,
      update: 2000,
      retries: { retries: 20, minTimeout: 50, maxTimeout: 250, factor: 1.2 },
    });
    try {
      // A cancelled request may have waited for another process's lock.
      signal?.throwIfAborted();
      return await operation();
    } finally {
      await release();
    }
  }

  async createPage(
    title: string,
    content: string,
    pageType?: string,
    directory = '',
    signal?: AbortSignal,
  ) {
    validateName(title);
    validateDirectory(directory);
    this.validateContent(content, title, pageType);
    const filename = this.linkResolver.slugify(title);
    validateName(filename);
    const parent = posix.join(this.schema.paths.wiki, directory.normalize('NFC'));
    let path = posix.join(parent, `${filename}.md`);
    this.pagePath(path);
    return this.writing(async () => {
      path = posix.join(existingDirectory(this.vaultPath, parent), `${filename}.md`);
      const pages = catalog(this.vaultPath, this.schema.paths.wiki);
      const collision = pages.find(
        (p) =>
          comparisonKey(p.path) === comparisonKey(path) ||
          (comparisonKey(posix.dirname(p.path)) === comparisonKey(posix.dirname(path)) &&
            comparisonKey(p.title) === comparisonKey(title)),
      );
      if (collision || existsSync(this.pagePath(path)))
        return {
          success: false,
          path,
          message: `Page already exists or normalized name conflicts: ${collision?.path ?? path}`,
        };
      const absolute = this.pagePath(path);
      mkdirSync(dirname(absolute), { recursive: true });
      this.pagePath(path);
      signal?.throwIfAborted();
      // Commit point: after rename, finish derived maintenance even if cancelled.
      atomicWrite(absolute, content);
      await this.afterMutation('create', title, path);
      return { success: true, path, version: pageVersion(content), message: `Created: ${path}` };
    }, signal);
  }

  async readPage(lookup: { title?: string; path?: string }): Promise<PageData> {
    if (lookup.path) this.pagePath(lookup.path);
    const page = resolvePage(catalog(this.vaultPath, this.schema.paths.wiki), lookup);
    return {
      content: page.content,
      frontmatter: page.data,
      path: page.path,
      version: pageVersion(page.content),
    };
  }

  private current(path: string, expectedVersion?: string) {
    this.pagePath(path);
    const page = resolvePage(catalog(this.vaultPath, this.schema.paths.wiki), { path });
    if (!expectedVersion || expectedVersion !== pageVersion(page.content))
      throw new Error(
        `Conflict: expectedVersion is missing or stale for ${page.path}; read the page again`,
      );
    return page;
  }

  async updatePage(path: string, content: string, expectedVersion?: string, signal?: AbortSignal) {
    this.pagePath(path);
    const parsed = this.validateContent(content);
    return this.writing(async () => {
      const page = this.current(path, expectedVersion);
      const collision = catalog(this.vaultPath, this.schema.paths.wiki).find(
        (other) =>
          other.path !== page.path &&
          comparisonKey(posix.dirname(other.path)) === comparisonKey(posix.dirname(page.path)) &&
          comparisonKey(other.title) === comparisonKey(parsed.data.title),
      );
      if (collision) throw new Error(`Conflict: title already exists at ${collision.path}`);
      signal?.throwIfAborted();
      atomicWrite(this.pagePath(page.path), content);
      await this.afterMutation('update', parsed.data.title, page.path);
      return {
        success: true,
        path: page.path,
        version: pageVersion(content),
        message: `Updated: ${page.path}`,
      };
    }, signal);
  }

  async deletePage(path: string, expectedVersion?: string, signal?: AbortSignal) {
    this.pagePath(path);
    return this.writing(async () => {
      const page = this.current(path, expectedVersion);
      const pages = catalog(this.vaultPath, this.schema.paths.wiki);
      const brokenLinks = pages
        .filter(
          (p) =>
            p.path !== page.path &&
            this.linkResolver.parseLinks(p.content).some((link) => {
              try {
                return resolveLink(pages, this.schema.paths.wiki, p.path, link).path === page.path;
              } catch {
                return false;
              }
            }),
        )
        .map((p) => p.path);
      signal?.throwIfAborted();
      unlinkSync(this.pagePath(page.path));
      await this.afterMutation('delete', page.title, page.path);
      return { success: true, message: `Deleted: ${page.path}`, brokenLinks };
    }, signal);
  }

  private async afterMutation(operation: string, title: string, path: string): Promise<void> {
    try {
      await this.rebuildUnlocked();
      safePath(this.vaultPath, 'log.md');
      await this.logManager.append({
        date: new Date().toISOString().slice(0, 10),
        operation,
        title,
        details: `${operation}: ${path}`,
      });
    } catch (error) {
      throw new Error(
        `Page ${operation} committed at ${path}, but index/log maintenance failed: ${(error as Error).message}. Read the page before retrying; run wiki_rebuild_index to restore the derived index.`,
      );
    }
  }

  private async rebuildUnlocked(): Promise<void> {
    safePath(this.vaultPath, 'index.md');
    await this.indexManager.rebuild(
      catalog(this.vaultPath, this.schema.paths.wiki).map((p) => ({
        title: p.title,
        path: p.path,
        pageType: typeof p.data.type === 'string' ? p.data.type : 'other',
        summary:
          p.body
            .split('\n')
            .map((line) => line.trim())
            .find((line) => line && !line.startsWith('#'))
            ?.slice(0, 120) ?? '',
      })),
    );
  }

  async rebuildIndex(signal?: AbortSignal): Promise<{ success: boolean; message: string }> {
    return this.writing(async () => {
      await this.rebuildUnlocked();
      return { success: true, message: 'Derived index rebuilt from Markdown pages' };
    }, signal);
  }

  listWikiFiles(): string[] {
    return catalog(this.vaultPath, this.schema.paths.wiki).map((p) => p.path);
  }
}
