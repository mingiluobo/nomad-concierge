import { URL } from 'node:url';
import { copyFile, mkdir, readdir } from 'node:fs/promises';

const source = new URL('../src/knowledge/', import.meta.url);
const destination = new URL('../dist/knowledge/', import.meta.url);
await mkdir(destination, { recursive: true });
for (const name of await readdir(source)) {
  if (name.endsWith('.json')) await copyFile(new URL(name, source), new URL(name, destination));
}
