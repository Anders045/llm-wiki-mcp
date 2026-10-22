import { McpServer } from '@modelcontextprotocol/server';
import { loadSchema } from './config/schema-loader.js';
import { LinkResolver } from './core/link-resolver.js';
import { LogManager } from './core/log-manager.js';
import { IndexManager } from './core/index-manager.js';
import { WikiManager } from './core/wiki-manager.js';
import { SimpleProvider } from './search/simple-provider.js';
import { VERSION, PACKAGE_NAME } from './version.js';
import { registerTools } from './tools/index.js';

/** Configuration required to spin up an MCP server instance. */
export interface ServerConfig {
  vaultPath: string;
}

/**
 * Creates and configures an MCP server wired to the given vault.
 *
 * Each call produces an independent server instance, which is important
 * for the HTTP transport where every client session gets its own server.
 */
export async function createServer(config: ServerConfig): Promise<McpServer> {
  const { vaultPath } = config;

  // Load the vault's .wiki-schema.yaml (or fall back to defaults)
  const schema = loadSchema(vaultPath);

  // Instantiate core services that tools depend on
  const linkResolver = new LinkResolver(schema.linkStyle, schema.paths.wiki);
  const logManager = new LogManager(vaultPath);
  const indexManager = new IndexManager(vaultPath, linkResolver);
  const wikiManager = new WikiManager(vaultPath, schema, linkResolver, indexManager, logManager);

  // Keep the accepted local search behavior independent of PATH.
  const searchProvider = new SimpleProvider();

  const server = new McpServer({
    name: PACKAGE_NAME,
    version: VERSION,
  });

  // Expose all wiki tools (create, read, update, delete, search, etc.)
  registerTools(server, {
    wikiManager,
    linkResolver,
    searchProvider,
    schema,
    vaultPath,
  });

  return server;
}
