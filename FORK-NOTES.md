# Nora personal-wiki fork

This private installation build is `@anders045/llm-wiki-mcp@0.2.1-nora.1`, based on upstream commit `ee758ff473a0084e184aee4390b019ac869d10fe` of [sumitroajiprabowo/llm-wiki-mcp](https://github.com/sumitroajiprabowo/llm-wiki-mcp). The original author attribution and MIT license remain intact. The package is marked private to prevent an accidental npm publication. Its runtime dependencies are exact versions; `npm-shrinkwrap.json` fixes the complete dependency tree and travels with the installation tarball. CLI and MCP versions both come from `package.json`.

## Scope and installation

Use a reviewed local tarball and its recorded SHA-256. Extract it into the fixed program version directory, run `npm ci --omit=dev --ignore-scripts` inside the extracted package, then use a fixed Node executable with `dist/cli.js --vault /absolute/vault --transport stdio`. Do not use the upstream npm package or `@latest` to obtain these changes. The fork keeps the upstream HTTP code, but this build is intended and tested only for stdio; HTTP and QMD have not been accepted for the personal vault. Search explicitly uses the simple local provider, regardless of executables in PATH. Public search results use vault-relative paths that can be passed directly to page reads and updates.

Do not use `npm install <tarball>` as the fixed deployment procedure: in the tested npm 11 environment that nested install re-resolved transitive dependencies. Extracting the package and running `npm ci` makes its shrinkwrap the root installation lock.

Build and verify from the pinned fork commit:

```sh
npm ci
npm run type-check
npm run lint
npm run format:check
npm test
npm run test:stdio
npm pack
```

`test:stdio` builds the actual CLI and drives JSON-RPC over child-process stdin/stdout. It covers the complete page lifecycle, MCP error flags, two-process duplicate creation and stale update rejection, EOF exit, a SIGKILL between page replacement and index rebuilding, stale-lock recovery, and a failed derived-index write. Tests use synthetic temporary vaults and remove them afterward. OpenCode, deployed Linux identity/permissions, Windows, network filesystems, hostile same-account filesystem changes and power-loss durability require separate acceptance; these local checks do not establish them.

## Data and API changes

- New Unicode filenames retain NFC Chinese titles and punctuation, such as `认知共识.md`. ASCII-only titles keep the established English slug convention. Content is not normalized or renamed. NFC/case-equivalent filenames and same-directory titles conflict instead of overwriting; compatibility characters such as `①` remain distinct from `1`.
- `wiki_create_page` accepts an optional `directory` relative to the configured wiki directory. At most four directory levels are supported. Titles are filenames, never paths; invalid separators, control characters, Windows device names, hidden names and trailing periods/spaces are rejected.
- Existing English files continue to resolve by path, frontmatter title, or legacy slug. Different directories may contain the same title; title-only lookup then returns an ambiguity error with candidate paths. Use the full vault-relative path.
- Markdown links use the actual destination URL, including relative paths and URL encoding. Both link styles are parsed regardless of the configured output style. Wiki paths are vault-relative when prefixed by the configured wiki directory, otherwise wiki-relative. Generated index links always identify the actual file, so a title update does not rename it. External links, images, fragments-only links and code examples are excluded from page-link checks.
- `wiki_read_page` returns a `version` SHA-256. Pass it as mandatory `expectedVersion` to MCP `wiki_update_page` and `wiki_delete_page`. The server checks it while holding the vault write lock. A missing or stale version fails; read the current page and reconcile before retrying. Old clients must update their calls. Creation conflicts return `success: false` and MCP `isError: true`.
- New and updated pages require valid YAML metadata matching a configured page type and its required fields. `title` and `type` are nonempty strings; creation arguments must match them. Tags and subjects are string arrays. Dates are valid `YYYY-MM-DD`. `source_path`, when present, must stay within raw. Validation checks format, not factual truth.
- Page reads, writes and deletes are restricted to the configured wiki area. Raw files, schema, index, log and lock metadata cannot be edited through page tools. Ingest reads only UTF-8 Markdown/TXT from the configured raw area. Other formats must be extracted by an external document tool. Symlinks and hard-linked files are rejected in selected paths; schema storage areas cannot overlap wiki.
- MCP initialization may target only its configured vault. Creating a different vault is an explicit CLI initialization action. Existing schemas are never overwritten.

## Saving, conflicts and recovery

Every page mutation and index rebuild uses [proper-lockfile](https://github.com/moxystudio/node-proper-lockfile) `4.1.2`, with one `.wiki-write.lock` directory inside the vault. It retries contention for a bounded interval and then returns an error. The lock heartbeat is two seconds; an abandoned lock becomes recoverable after ten seconds. All writer processes must use the same fork settings and the same physical vault. Do not remove a lock while a writer is alive. A filesystem lock protects cooperating processes; it does not make raw files immutable to other programs running under the same account.

The SDK's native request cancellation signal is checked before waiting for the write lock, after acquiring it, and immediately before a page replacement or deletion. A queued cancelled write cannot commit and releases any lock it later acquires. Lock acquisition itself uses the library's bounded retry interval. The commit point is the page rename or deletion; cancellation received afterward does not roll back that change, and derived maintenance is allowed to finish. The SDK may suppress a cancelled response, so read the current page before retrying an operation whose commit state is unknown.

A page is validated before being written to a temporary sibling, flushed, closed and renamed into place. The temporary file is mode 0600. This provides a single-file atomic replacement; page, index and log are not a multi-file transaction. A crash may leave a complete new page with an old index, no log entry, or an unused `.wiki-write-*.tmp` sibling. Temporary files are not wiki pages. Review and remove crash leftovers only after all writers have stopped.

Markdown pages are the authoritative data. `wiki_rebuild_index` reconstructs the index without modifying page bytes. Each successful mutation refreshes title, type, path and summary from the actual pages. If a page has already been saved/deleted but derived maintenance fails, the tool returns `isError: true` and explicitly says the page operation was committed. Read the page before retrying, fix the underlying filesystem problem, then call `wiki_rebuild_index`. A missing log entry is not regenerated and the log is not a version history.

Before upgrading an existing vault, stop its writers and back up the complete vault, including raw originals, schema and program version. Review any existing NFC/case collisions, symlinks, unsupported depths and malformed frontmatter first. Use a synthetic vault for the installation and restore test. Rollback requires both the previous program and an appropriate data backup; switching executables alone does not undo saved content. Git synchronization, backup retention, external document parsing, real account isolation and deployment remain outside this package.
