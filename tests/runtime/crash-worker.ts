import { WikiManager } from '../../src/core/wiki-manager.js';
import { IndexManager } from '../../src/core/index-manager.js';
import { LogManager } from '../../src/core/log-manager.js';
import { LinkResolver } from '../../src/core/link-resolver.js';
import { DEFAULT_SCHEMA } from '../../src/config/types.js';

const vault = process.argv[2];
const links = new LinkResolver('wikilink', 'wiki');
const index = new IndexManager(vault, links);
index.rebuild = async () => {
  process.stdout.write('PAGE_COMMITTED\n');
  await new Promise(() => {
    setInterval(() => {}, 1000);
  });
};
const wiki = new WikiManager(vault, DEFAULT_SCHEMA, links, index, new LogManager(vault));
void wiki.createPage(
  '崩溃恢复',
  '---\ntitle: 崩溃恢复\ntype: concept\ntags: []\ncreated: 2026-10-22\n---\n\n中断前已保存',
);
