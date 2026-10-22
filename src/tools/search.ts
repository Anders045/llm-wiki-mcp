import { posix, relative, sep } from 'node:path';
import { safePath } from '../utils/safe-path.js';
import type { SearchProvider } from '../search/search-provider.js';
import type { SearchResult } from '../config/types.js';

/** Parameters for a wiki search query. */
interface SearchInput {
  query: string;
  max_results?: number;
}

/** Wrapper around raw search results for consistent tool output shape. */
interface SearchOutput {
  results: SearchResult[];
}

/** Runs a text or semantic search across all wiki pages. */
export async function handleSearch(
  input: SearchInput,
  searchProvider: SearchProvider,
  wikiDir: string,
  wikiRelativePath: string,
): Promise<SearchOutput> {
  const maxResults = input.max_results ?? 10;

  const results = await searchProvider.search(input.query, {
    maxResults,
    wikiDir,
  });

  return {
    results: results.map((result) => ({
      ...result,
      path: posix.join(
        wikiRelativePath,
        relative(wikiDir, safePath(wikiDir, result.path)).split(sep).join('/'),
      ),
    })),
  };
}
