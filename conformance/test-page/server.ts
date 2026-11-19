import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';

export interface PageServer {
  url(host: string): string;
  close(): Promise<void>;
}

const folder = import.meta.dirname;

// Varial checks only that the URL starts with https, so a self-signed
// certificate is enough.
export async function serveTestPage(): Promise<PageServer> {
  const [script, html, certificate] = await Promise.all([
    bundle(),
    readFile(join(folder, 'index.html')),
    selfSigned(),
  ]);
  const files: Record<string, { type: string; body: Uint8Array }> = {
    '/': { type: 'text/html', body: html },
    '/page.js': { type: 'text/javascript', body: script },
  };
  const server = createServer(certificate, (request, response) => {
    const { pathname } = new URL(request.url ?? '/', 'https://localhost');
    const file = files[pathname];
    if (!file) {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, { 'content-type': `${file.type}; charset=utf-8` })
      .end(file.body);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: (host) => `https://${host}:${port}/`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function bundle(): Promise<Uint8Array> {
  const { outputFiles } = await build({
    entryPoints: [join(folder, 'page.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    logLevel: 'warning',
  });
  const [output] = outputFiles;
  if (!output) throw new Error('esbuild produced no test page script.');
  return output.contents;
}

async function selfSigned(): Promise<{ key: Buffer; cert: Buffer }> {
  const directory = await mkdtemp(join(tmpdir(), 'stardust-conformance-'));
  const key = join(directory, 'key.pem');
  const cert = join(directory, 'cert.pem');
  try {
    await promisify(execFile)('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-keyout',
      key,
      '-out',
      cert,
    ]);
    return { key: await readFile(key), cert: await readFile(cert) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
