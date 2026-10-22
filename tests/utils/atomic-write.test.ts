import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicWrite } from '../../src/utils/atomic-write.js';

const root = mkdtempSync(join(tmpdir(), 'atomic-wiki-'));
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('cleans the temporary sibling when rename fails and preserves the existing destination', () => {
  const destination = join(root, 'page.md');
  mkdirSync(destination);
  writeFileSync(join(destination, 'existing'), 'keep');
  expect(() => atomicWrite(destination, 'new content')).toThrow();
  expect(readFileSync(join(destination, 'existing'), 'utf8')).toBe('keep');
  expect(readdirSync(root)).toEqual(['page.md']);
});
