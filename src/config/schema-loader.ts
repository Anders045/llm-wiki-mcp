import { readFileSync, existsSync } from 'node:fs';
import { safePath } from '../utils/safe-path.js';
import { comparisonKey, validateDirectory } from '../core/page-catalog.js';
import yaml from 'js-yaml';
import { DEFAULT_SCHEMA, type WikiSchema } from './types.js';

/**
 * Loads the wiki schema from `.wiki-schema.yaml` at the vault root.
 *
 * Missing fields are back-filled from `DEFAULT_SCHEMA`, so users only
 * need to declare the values they want to override. If the config file
 * does not exist at all, a full copy of the defaults is returned.
 *
 * @param vaultPath - Absolute path to the vault root directory
 * @returns A fully populated WikiSchema
 * @throws If `linkStyle` is present but not a recognized value
 */
export function loadSchema(vaultPath: string): WikiSchema {
  const configPath = safePath(vaultPath, '.wiki-schema.yaml');

  // No config file — use sensible defaults
  if (!existsSync(configPath)) {
    validateSchemaPaths(vaultPath, DEFAULT_SCHEMA);
    return structuredClone(DEFAULT_SCHEMA);
  }

  const raw = readFileSync(configPath, 'utf-8');
  const loaded = yaml.load(raw);
  if (loaded != null && (typeof loaded !== 'object' || Array.isArray(loaded)))
    throw new Error('Schema must be a YAML object');
  const parsed = (loaded ?? {}) as Partial<WikiSchema>;

  // Validate early so typos surface as clear error messages
  if (parsed.linkStyle && parsed.linkStyle !== 'wikilink' && parsed.linkStyle !== 'markdown') {
    throw new Error(`Invalid linkStyle: "${parsed.linkStyle}". Must be "wikilink" or "markdown".`);
  }

  // Merge each section independently so partial overrides don't wipe defaults
  const schema: WikiSchema = {
    name: parsed.name ?? DEFAULT_SCHEMA.name,
    version: parsed.version ?? DEFAULT_SCHEMA.version,
    linkStyle: parsed.linkStyle ?? DEFAULT_SCHEMA.linkStyle,
    paths: {
      ...DEFAULT_SCHEMA.paths,
      ...parsed.paths,
    },
    pageTypes: parsed.pageTypes ?? DEFAULT_SCHEMA.pageTypes,
    tags: {
      ...DEFAULT_SCHEMA.tags,
      ...parsed.tags,
    },
    log: {
      ...DEFAULT_SCHEMA.log,
      ...parsed.log,
    },
  };
  validateSchemaPaths(vaultPath, schema);
  return schema;
}

/** Reject malformed or overlapping storage areas before any tool can write. */
export function validateSchemaPaths(vaultPath: string, schema: WikiSchema): void {
  for (const value of Object.values(schema.paths)) {
    if (typeof value !== 'string' || !value)
      throw new Error('Schema paths must be nonempty relative directories');
    validateDirectory(value);
    safePath(vaultPath, value);
  }
  const wiki = comparisonKey(schema.paths.wiki);
  for (const area of [schema.paths.raw, schema.paths.assets, 'index.md', 'log.md']) {
    const key = comparisonKey(area);
    if (wiki === key || wiki.startsWith(key + '/') || key.startsWith(wiki + '/'))
      throw new Error('Wiki directory must not overlap raw, assets or metadata');
  }
  for (const [name, type] of Object.entries(schema.pageTypes)) {
    if (
      !type ||
      !Array.isArray(type.requiredFields) ||
      type.requiredFields.some((field) => typeof field !== 'string')
    )
      throw new Error(`Invalid requiredFields for page type ${name}`);
  }
}
