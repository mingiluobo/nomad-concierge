import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { knowledgeFileSchema } from './schema.js';
import type { KnowledgeCatalog } from './schema.js';

export function loadKnowledge(directory = fileURLToPath(new URL('.', import.meta.url))): KnowledgeCatalog {
  const read = (filename: string) => knowledgeFileSchema.parse(JSON.parse(readFileSync(join(directory, filename), 'utf8')) as unknown);
  const portugal = read('portugal.json');
  const generic = read('generic.json');
  if (portugal.country !== 'PT' || portugal.coverage !== 'full' || generic.coverage !== 'generic') throw new Error('Knowledge catalog countries or coverage are invalid');
  return { portugal, generic };
}
