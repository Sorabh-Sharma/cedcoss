import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { validAnalysis } from './schema.js';

export function createCache(directory, namespace) {
  const version = createHash('sha256').update(namespace).digest('hex').slice(0, 16);
  const pathFor = key => join(directory, `${version}-${key}.json`);

  return {
    async get(key) {
      try {
        const entry = JSON.parse(await readFile(pathFor(key), 'utf8'));
        return validAnalysis(entry) ? entry : null;
      } catch (error) {
        if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
        throw error;
      }
    },
    async set(key, analysis) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const path = pathFor(key);
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(analysis), { mode: 0o600 });
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
    }
  };
}
