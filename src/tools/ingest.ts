import { readFileSync, existsSync } from 'node:fs';
import { extname, sep } from 'node:path';
import { catalog } from '../core/page-catalog.js';
import { validateSchemaPaths } from '../config/schema-loader.js';
import type { WikiSchema } from '../config/types.js';
import { safePath } from '../utils/safe-path.js';

/** Parameters for ingesting a raw source document. */
interface IngestInput {
  source_path: string;
}

/**
 * Everything the LLM needs to turn a raw source into wiki pages:
 * the source content, a list of pages that already exist (to avoid duplicates),
 * and the schema rules (page types and link style) to follow.
 */
interface IngestOutput {
  content: string;
  existing_pages: string[];
  schema: {
    pageTypes: WikiSchema['pageTypes'];
    linkStyle: WikiSchema['linkStyle'];
  };
}

/**
 * Reads a raw source file and returns it alongside wiki context.
 * The caller (typically an LLM) uses this context to split the source into wiki pages.
 */
export async function handleIngest(
  input: IngestInput,
  vaultPath: string,
  schema: WikiSchema,
): Promise<IngestOutput> {
  // safePath prevents path-traversal attacks (e.g. "../../etc/passwd")
  validateSchemaPaths(vaultPath, schema);
  const absPath = safePath(vaultPath, input.source_path);

  if (!absPath.startsWith(safePath(vaultPath, schema.paths.raw) + sep))
    throw new Error('Source must be within the configured raw directory');
  if (!existsSync(absPath)) {
    throw new Error(`Source not found: ${input.source_path}`);
  }

  if (!['.md', '.markdown', '.txt'].includes(extname(absPath).toLowerCase()))
    throw new Error(
      'Ingest accepts Markdown or TXT; extract other formats with an external document tool first',
    );
  const content = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(absPath));

  const existingPages = catalog(vaultPath, schema.paths.wiki).map((page) => page.path);

  return {
    content,
    existing_pages: existingPages,
    schema: {
      pageTypes: schema.pageTypes,
      linkStyle: schema.linkStyle,
    },
  };
}
