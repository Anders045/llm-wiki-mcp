import { existsSync, readFileSync } from 'node:fs';
import type { WikiSchema } from '../config/types.js';
import type { LinkResolver } from '../core/link-resolver.js';
import { catalog, resolveLink } from '../core/page-catalog.js';
import { safePath } from '../utils/safe-path.js';

/** recent currently performs the same complete check as full. */
interface LintInput {
  scope?: 'full' | 'recent';
}
export async function handleLint(
  input: LintInput,
  vaultPath: string,
  schema: WikiSchema,
  linkResolver: LinkResolver,
) {
  const pages = catalog(vaultPath, schema.paths.wiki);
  const inbound = new Set<string>();
  const broken: { from: string; to: string; reason?: string }[] = [];
  for (const page of pages) {
    for (const link of linkResolver.parseLinks(page.content)) {
      try {
        inbound.add(resolveLink(pages, schema.paths.wiki, page.path, link).path);
      } catch (error) {
        const reason = (error as Error).message;
        broken.push({
          from: page.path,
          to: link.target,
          ...(reason.startsWith('Ambiguous') ? { reason } : {}),
        });
      }
    }
  }
  const stale: string[] = [];
  const index = safePath(vaultPath, 'index.md');
  if (existsSync(index)) {
    for (const link of linkResolver.parseLinks(readFileSync(index, 'utf8'))) {
      try {
        resolveLink(pages, schema.paths.wiki, 'index.md', link);
      } catch {
        stale.push(link.target);
      }
    }
  }
  return {
    orphan_pages: pages.filter((p) => !inbound.has(p.path)).map((p) => p.path),
    broken_links: broken,
    missing_pages: [...new Set(broken.map((link) => link.to))],
    pages_without_frontmatter: pages.filter((p) => !Object.keys(p.data).length).map((p) => p.path),
    stale_index_entries: stale,
  };
}
