import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { safePath } from '../utils/safe-path.js';
import yaml from 'js-yaml';
import { DEFAULT_SCHEMA, type WikiSchema } from '../config/types.js';

/** Parameters for initializing a new wiki vault. */
interface InitInput {
  path: string;
  name?: string;
  linkStyle?: 'wikilink' | 'markdown';
}

/** Summary of what the init operation created (or skipped). */
interface InitOutput {
  success: boolean;
  message: string;
  created: string[];
}

/**
 * Scaffolds a new wiki vault: creates directories, writes the schema file,
 * and seeds index.md and log.md. Safe to call on an existing vault -- it
 * will bail out without overwriting if the schema file already exists.
 */
export async function handleInit(input: InitInput, allowedVault?: string): Promise<InitOutput> {
  const { path: vaultPath, name, linkStyle } = input;
  if (allowedVault && resolve(vaultPath) !== resolve(allowedVault))
    throw new Error('MCP initialization is limited to its configured vault');
  const schemaPath = safePath(vaultPath, '.wiki-schema.yaml');

  // Idempotency guard: never overwrite an existing vault
  if (existsSync(schemaPath)) {
    return {
      success: true,
      message: 'Vault already initialized — skipping without overwrite.',
      created: [],
    };
  }

  const schema: WikiSchema = {
    ...DEFAULT_SCHEMA,
    name: name ?? DEFAULT_SCHEMA.name,
    linkStyle: linkStyle ?? DEFAULT_SCHEMA.linkStyle,
  };

  for (const item of [...Object.values(schema.paths), 'index.md', 'log.md'])
    safePath(vaultPath, item);
  const created: string[] = [];

  const dirs = [schema.paths.raw, schema.paths.assets, schema.paths.wiki];

  for (const dir of dirs) {
    const absDir = safePath(vaultPath, dir);
    if (!existsSync(absDir)) {
      mkdirSync(absDir, { recursive: true });
      created.push(dir + '/');
    }
  }

  // lineWidth: -1 disables line wrapping so paths and values stay on one line
  const yamlContent = yaml.dump(schema, { lineWidth: -1 });
  writeFileSync(schemaPath, yamlContent, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
  created.push('.wiki-schema.yaml');

  const indexPath = safePath(vaultPath, 'index.md');
  if (!existsSync(indexPath)) {
    writeFileSync(indexPath, '# Wiki Index\n', { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
    created.push('index.md');
  }

  const logPath = safePath(vaultPath, 'log.md');
  if (!existsSync(logPath)) {
    const today = new Date().toISOString().slice(0, 10);
    const logContent = `# Wiki Log\n\n## [${today}] init | ${schema.name}\nVault initialized.\n`;
    writeFileSync(logPath, logContent, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
    created.push('log.md');
  }

  return {
    success: true,
    message: `Vault initialized at ${vaultPath}`,
    created,
  };
}
