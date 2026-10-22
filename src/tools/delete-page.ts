import type { WikiManager } from '../core/wiki-manager.js';

/** Parameters for deleting an existing wiki page. */
interface DeletePageInput {
  path: string;
  expectedVersion?: string;
}

/**
 * Deletes a wiki page and reports any links that became broken as a result.
 * Callers can use the returned `brokenLinks` array to fix or remove dangling references.
 */
export async function handleDeletePage(
  input: DeletePageInput,
  wikiManager: WikiManager,
  signal?: AbortSignal,
): Promise<{ success: boolean; message: string; brokenLinks: string[] }> {
  return wikiManager.deletePage(input.path, input.expectedVersion, signal);
}
