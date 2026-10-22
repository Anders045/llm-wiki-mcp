import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { safePath } from './safe-path.js';

/** Same-directory rename gives single-file replacement, not a vault transaction. */
export function atomicWrite(path: string, content: string): void {
  safePath(dirname(path), basename(path));
  const temporary = join(dirname(path), `.wiki-write-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, content, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    safePath(dirname(path), basename(path));
    renameSync(temporary, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    removeTemporary(temporary);
  }
}

function removeTemporary(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
