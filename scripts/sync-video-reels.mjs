import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(root, 'video-reels');
const targetDir = path.join(root, 'gdebenz_ui', 'static', 'video-reels');
const videoExtensions = new Set(['.mp4', '.webm', '.mov', '.m4v']);

async function main() {
  const entries = await readdir(sourceDir, { withFileTypes: true }).catch(() => []);
  const files = entries
    .filter((entry) => entry.isFile() && videoExtensions.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort();

  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });

  for (const file of files) {
    await copyFile(path.join(sourceDir, file), path.join(targetDir, file));
  }

  await writeFile(
    path.join(targetDir, 'manifest.json'),
    `${JSON.stringify({ videos: files }, null, 2)}\n`
  );

  console.log(`Synced ${files.length} video reels to ${path.relative(root, targetDir)}`);
}

await main();
