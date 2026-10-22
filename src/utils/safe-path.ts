import { resolve, relative, sep } from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';

/**
 * Validates that a resolved path stays within the vault root directory.
 * Prevents path traversal attacks (e.g., `../../etc/passwd`).
 *
 * @param vaultPath - The absolute path to the vault root
 * @param userPath - The user-supplied relative path
 * @returns The resolved absolute path
 * @throws Error if the resolved path escapes the vault root
 */
export function safePath(vaultPath: string, userPath: string): string {
  const root = resolve(vaultPath);
  const resolved = resolve(root, userPath);

  if (!resolved.startsWith(root + sep) && resolved !== root) {
    throw new Error('Path must be within the vault');
  }

  if (userPath.includes('\\') || userPath.includes('\0')) {
    throw new Error('Invalid path separator or control character');
  }
  // Permit a system-provided parent alias (e.g. macOS /tmp), but never a
  // symlink at the vault itself or any user-selected descendant.
  assertNotSymlink(root);
  let current = root;
  for (const part of relative(root, resolved).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    assertNotSymlink(current);
  }
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(resolved);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      throw new Error('Path must be within the vault');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  return resolved;
}

function assertNotSymlink(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${path}`);
    if (stat.isFile() && stat.nlink > 1)
      throw new Error(`Hard-linked files are not allowed: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
