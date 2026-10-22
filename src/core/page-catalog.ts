import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, posix } from 'node:path';
import matter from 'gray-matter';
import { safePath } from '../utils/safe-path.js';
import type { ParsedLink } from '../config/types.js';

/** Personal vaults support at most four directories beneath wiki/. */
export const MAX_PAGE_DEPTH = 4;
export const comparisonKey = (value: string): string => value.normalize('NFC').toLowerCase();

export function validateName(name: string): void {
  if (
    !name ||
    name.trim() !== name ||
    /[<>:"/\\|?*\p{Cc}]/u.test(name) ||
    /[. ]$/.test(name) ||
    name.startsWith('.') ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  ) {
    throw new Error(`Invalid filename: ${name}`);
  }
}

export function validateDirectory(directory: string): void {
  const parts = directory ? directory.split('/') : [];
  if (parts.length > MAX_PAGE_DEPTH)
    throw new Error(`Maximum page directory depth is ${MAX_PAGE_DEPTH}`);
  parts.forEach(validateName);
}

/** All readers use the same bounded traversal; symlinks fail visibly. */
export function listMarkdown(root: string, directory = '', depth = 0): string[] {
  const absolute = safePath(root, directory);
  if (!existsSync(absolute)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = posix.join(directory, entry.name);
    safePath(root, path);
    if (entry.isDirectory()) {
      if (depth >= MAX_PAGE_DEPTH)
        throw new Error(`Maximum page directory depth is ${MAX_PAGE_DEPTH}: ${path}`);
      files.push(...listMarkdown(root, path, depth + 1));
    } else if (entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('.'))
      files.push(path);
  }
  const seen = new Set<string>();
  for (const file of files) {
    const key = comparisonKey(file);
    if (seen.has(key)) throw new Error(`Ambiguous normalized path: ${file}`);
    seen.add(key);
  }
  return files;
}

export interface CatalogPage {
  path: string;
  title: string;
  content: string;
  data: Record<string, unknown>;
  body: string;
}

export function catalog(vault: string, wiki: string): CatalogPage[] {
  return listMarkdown(safePath(vault, wiki)).map((file) => {
    const path = posix.join(wiki, file);
    const content = readFileSync(safePath(vault, path), 'utf8');
    const parsed = matter(content);
    return {
      path,
      content,
      data: parsed.data,
      body: parsed.content,
      title: typeof parsed.data.title === 'string' ? parsed.data.title : basename(file, '.md'),
    };
  });
}

function unique(matches: CatalogPage[], query: string): CatalogPage {
  if (matches.length > 1)
    throw new Error(`Ambiguous page ${query}: ${matches.map((p) => p.path).join(', ')}`);
  if (!matches.length) throw new Error(`Page not found: ${query}`);
  return matches[0];
}

export function resolvePage(
  pages: CatalogPage[],
  lookup: { title?: string; path?: string },
): CatalogPage {
  if (!!lookup.title === !!lookup.path) throw new Error('Provide exactly one of title or path');
  const query = lookup.path ?? lookup.title!;
  const matches = pages.filter(
    (p) => comparisonKey(lookup.path ? p.path : p.title) === comparisonKey(query),
  );
  if (!lookup.path && !matches.length) {
    const legacy = query
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    if (legacy)
      return unique(
        pages.filter((p) => comparisonKey(basename(p.path, '.md')) === legacy),
        query,
      );
  }
  return unique(matches, query);
}

export function resolveLink(
  pages: CatalogPage[],
  wiki: string,
  source: string,
  link: ParsedLink,
): CatalogPage {
  let target = link.target;
  if (!link.raw.startsWith('[[')) {
    target = decodeURIComponent(target.split(/[?#]/)[0]);
    const path = posix.normalize(
      target.startsWith(`${wiki}/`) ? target : posix.join(posix.dirname(source), target),
    );
    return resolvePage(pages, { path });
  }
  target = target.split('#')[0];
  if (target.includes('/') || target.endsWith('.md')) {
    const path = target.startsWith(`${wiki}/`) ? target : posix.join(wiki, target);
    return resolvePage(pages, { path: path.endsWith('.md') ? path : `${path}.md` });
  }
  const byTitle = pages.filter((p) => comparisonKey(p.title) === comparisonKey(target));
  if (byTitle.length) return unique(byTitle, target);
  return unique(
    pages.filter((p) => comparisonKey(basename(p.path, '.md')) === comparisonKey(target)),
    target,
  );
}

/** Match existing directory components by NFC/case without renaming them. */
export function existingDirectory(vault: string, path: string): string {
  let current = '';
  for (const part of path.split('/')) {
    const absolute = safePath(vault, current);
    const matches = existsSync(absolute)
      ? readdirSync(absolute).filter((entry) => comparisonKey(entry) === comparisonKey(part))
      : [];
    if (matches.length > 1) throw new Error(`Ambiguous directory: ${path}`);
    current = posix.join(current, matches[0] ?? part);
    safePath(vault, current);
  }
  return current;
}
