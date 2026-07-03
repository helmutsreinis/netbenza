import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const functionsDir = path.join(root, 'netlify', 'functions');
const entries = (await readdir(functionsDir, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
  .map((entry) => path.join(functionsDir, entry.name))
  .sort();

for (const file of entries) {
  const mod = await import(pathToFileURL(file).href);
  if (typeof mod.default !== 'function') {
    throw new Error(`${file} does not export a default function`);
  }
  if (!mod.config?.path) {
    throw new Error(`${file} does not export config.path`);
  }
}

console.log(`Imported ${entries.length} Netlify functions`);
