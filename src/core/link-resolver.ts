import { posix } from 'node:path';
import type { ParsedLink } from '../config/types.js';
import { validateName } from './page-catalog.js';

/** Parse both link styles regardless of the preferred output style. */
export class LinkResolver {
  constructor(
    private linkStyle: 'wikilink' | 'markdown',
    private wikiDir: string,
  ) {}

  slugify(title: string): string {
    const normalized = title.normalize('NFC').trim();
    // Preserve the established ASCII filenames; Unicode titles remain readable.
    if ([...normalized].some((character) => character.codePointAt(0)! > 127)) {
      validateName(normalized);
      return normalized;
    }
    return normalized
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  createLink(
    targetTitle: string,
    displayText?: string,
    targetPath?: string,
    sourcePath = 'index.md',
  ): string {
    const text = displayText ?? targetTitle;
    if (
      this.linkStyle === 'wikilink' &&
      ![...(targetPath ?? targetTitle)].some((character) => '#[]'.includes(character))
    ) {
      const target = targetPath ?? targetTitle;
      return target === text ? `[[${target}]]` : `[[${target}|${text}]]`;
    }
    const path = targetPath ?? `${this.wikiDir}/${this.slugify(targetTitle)}.md`;
    const relative = posix.relative(posix.dirname(sourcePath), path);
    const encoded = relative
      .split('/')
      .map(encodeURIComponent)
      .join('/')
      .replace(/\(/g, '%28')
      .replace(/\)/g, '%29');
    return `[${text.replace(/[\\[\]]/g, '\\$&')}](${encoded})`;
  }

  parseLinks(content: string): ParsedLink[] {
    const links: ParsedLink[] = [];
    // Avoid interpreting examples in fenced and inline code as page links.
    const text = content.replace(/```[^]*?```|~~~[^]*?~~~/g, '').replace(/`[^`\n]*`/g, '');
    const pattern =
      /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|(?<!!)\[((?:\\.|[^\]\\\n])+)\]\((<[^>]+>|(?:[^\s()]|\([^()]*\))+)(?:\s+["'][^]*?["'])?\)/g;
    for (const match of text.matchAll(pattern)) {
      if (match[1] !== undefined) {
        if (match[1].startsWith('#')) continue;
        links.push({ raw: match[0], target: match[1], displayText: match[2] });
      } else {
        const target = match[4].replace(/^<|>$/g, '');
        if (
          /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target) ||
          !target.split(/[?#]/)[0].endsWith('.md')
        )
          continue;
        links.push({ raw: match[0], target, displayText: match[3].replace(/\\([\\[\]])/g, '$1') });
      }
    }
    return links;
  }
}
