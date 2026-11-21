import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, join } from 'node:path';
import { build } from 'esbuild';

const pages: Record<string, string> = {
  '/': 'freighter',
  '/kit': 'kit',
  '/sep60': 'sep60',
};
const folder = import.meta.dirname;

const { outputFiles } = await build({
  entryPoints: Object.values(pages).map((name) =>
    join(folder, 'src', `${name}.ts`),
  ),
  outdir: join(folder, 'out'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  logLevel: 'warning',
});

const files = new Map<string, { type: string; body: Uint8Array }>();
for (const { path, contents } of outputFiles) {
  files.set(`/${basename(path)}`, { type: 'text/javascript', body: contents });
}
for (const [route, name] of Object.entries(pages)) {
  const body = await readFile(join(folder, 'pages', `${name}.html`));
  files.set(route, { type: 'text/html', body });
}

createServer((request, response) => {
  const { pathname } = new URL(request.url ?? '/', 'http://localhost');
  const file = files.get(pathname);
  if (!file) {
    response.writeHead(404).end();
    return;
  }
  response
    .writeHead(200, { 'content-type': `${file.type}; charset=utf-8` })
    .end(file.body);
}).listen(3000);
