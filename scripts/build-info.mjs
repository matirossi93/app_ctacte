/** Identidad determinista del código desplegable, independiente de que Docker incluya .git. */
import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(process.argv[2] || '.');
const roots = ['src','server-lib','public','supabase/migrations','server.ts','index.html','package.json','package-lock.json','Dockerfile','vite.config.ts','tsconfig.json','tsconfig.app.json','tsconfig.node.json','tsconfig.server.json'];
const files = [];
async function collect(relative) {
  const absolute = path.join(root, relative);
  const s = await stat(absolute);
  if (s.isDirectory()) {
    for (const entry of (await readdir(absolute)).sort()) await collect(path.posix.join(relative, entry));
  } else if (!/(?:^|\/)\.env(?:\.|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relative)) files.push(relative);
}
for (const item of roots) await collect(item);
const hash = createHash('sha256');
hash.update('generador\0');
hash.update(await readFile(fileURLToPath(import.meta.url)));
hash.update('\0');
for (const file of files.sort()) {
  const content = await readFile(path.join(root, file));
  hash.update(file + '\0' + content.length + '\0');
  hash.update(content);
}
const info = { version: hash.digest('hex'), schema: 42 };
if (process.argv.includes('--write')) await writeFile(path.join(root, 'dist-server', 'build-info.json'), JSON.stringify(info) + '\n');
process.stdout.write(info.version + '\n');
