import type { IncomingMessage, ServerResponse } from 'node:http';
import { store } from './store.ts';
import { buildPackfile } from './packfile.ts';

function pktLine(str: string): Buffer {
  const len = Buffer.byteLength(str) + 4;
  const lenHex = len.toString(16).padStart(4, '0');
  return Buffer.from(lenHex + str);
}

const flushPacket = Buffer.from('0000');

export async function handleGitHttp(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, subPath: string): Promise<boolean> {
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    res.writeHead(404, { 'content-type': 'text/plain', 'content-length': 19, 'connection': 'close' });
    res.end('Repository not found');
    return true;
  }

  const method = req.method ?? 'GET';
  const urlObj = new URL(req.url ?? '/', 'http://entry');

  if (method === 'GET' && subPath === 'info/refs') {
    const service = urlObj.searchParams.get('service');
    if (!service || (service !== 'git-upload-pack' && service !== 'git-receive-pack')) {
      res.writeHead(400, { 'content-type': 'text/plain', 'content-length': 34, 'connection': 'close' });
      res.end('Missing or invalid service parameter');
      return true;
    }

    const chunks: Buffer[] = [];
    chunks.push(pktLine(`# service=${service}\n`));
    chunks.push(flushPacket);

    const gitProtocol = req.headers['git-protocol'] ?? '';
    const isV2 = service === 'git-upload-pack' && (typeof gitProtocol === 'string' && gitProtocol.includes('version=2'));

    if (isV2) {
      chunks.push(pktLine('version 2\n'));
      chunks.push(pktLine('agent=git/forge\n'));
      chunks.push(pktLine('ls-refs=\n'));
      chunks.push(pktLine('fetch=shallow ofs-delta\n'));
      chunks.push(flushPacket);
    } else {
      const refs = store.listRefs(owner, repoName);
      const headSha = store.getRef(owner, repoName, 'HEAD') || '0000000000000000000000000000000000000000';
      
      let first = true;
      const capabilities = 'multi_ack thin-pack side-band side-band-64k ofs-delta shallow no-progress include-tag multi_ack_detailed no-done symref=HEAD:refs/heads/main agent=git/forge';

      const headLine = `${headSha} HEAD\0${first ? capabilities : ''}\n`;
      chunks.push(pktLine(headLine));
      first = false;

      for (const r of refs) {
        if (r.name === 'HEAD') continue;
        const line = `${r.sha} ${r.name}\n`;
        chunks.push(pktLine(first ? `${line.trimEnd()}\0${capabilities}\n` : line));
        first = false;
      }

      if (refs.length === 0 && headSha === '0000000000000000000000000000000000000000') {
        chunks.push(pktLine(`0000000000000000000000000000000000000000 capabilities^{}\0${capabilities}\n`));
      }

      chunks.push(flushPacket);
    }

    const payload = Buffer.concat(chunks);
    res.writeHead(200, {
      'content-type': `application/x-${service}-advertisement`,
      'cache-control': 'no-cache',
      'content-length': payload.length,
      'connection': 'close',
    });
    res.end(payload);
    return true;
  }

  if (method === 'POST' && subPath === 'git-upload-pack') {
    const gitProtocol = req.headers['git-protocol'] ?? '';
    const isV2 = typeof gitProtocol === 'string' && gitProtocol.includes('version=2');

    const bodyBuf = await readBody(req);

    const chunks: Buffer[] = [];
    if (isV2) {
      const lines = parsePktLines(bodyBuf);
      let command = '';
      const args: string[] = [];
      for (const line of lines) {
        if (line.startsWith('command=')) {
          command = line.slice(8).trim();
        } else if (line) {
          args.push(line);
        }
      }

      if (command === 'ls-refs') {
        const refs = store.listRefs(owner, repoName);
        for (const r of refs) {
          chunks.push(pktLine(`${r.sha} ${r.name}\n`));
        }
        chunks.push(flushPacket);
      } else if (command === 'fetch') {
        const wants: string[] = [];
        const haves: string[] = [];
        for (const arg of args) {
          if (arg.startsWith('want ')) {
            wants.push(arg.slice(5).trim());
          } else if (arg.startsWith('have ')) {
            haves.push(arg.slice(5).trim());
          }
        }

        const pack = buildPackfile(owner, repoName, wants, haves);
        chunks.push(sidebandPack(pack));
        chunks.push(flushPacket);
      } else {
        chunks.push(flushPacket);
      }
    } else {
      const lines = parsePktLines(bodyBuf);
      const wants: string[] = [];
      const haves: string[] = [];
      for (const line of lines) {
        if (line.startsWith('want ')) {
          wants.push(line.slice(5).trim());
        } else if (line.startsWith('have ')) {
          haves.push(line.slice(5).trim());
        }
      }

      chunks.push(pktLine('NAK\n'));
      const pack = buildPackfile(owner, repoName, wants, haves);
      chunks.push(sidebandPack(pack));
    }

    const payload = Buffer.concat(chunks);
    res.writeHead(200, {
      'content-type': 'application/x-git-upload-pack-result',
      'cache-control': 'no-cache',
      'content-length': payload.length,
      'connection': 'close',
    });
    res.end(payload);
    return true;
  }

  if (method === 'POST' && subPath === 'git-receive-pack') {
    const bodyBuf = await readBody(req);
    const chunks: Buffer[] = [];
    chunks.push(pktLine('unpack ok\n'));
    chunks.push(pktLine('ok refs/heads/main\n'));
    chunks.push(flushPacket);

    const payload = Buffer.concat(chunks);
    res.writeHead(200, {
      'content-type': 'application/x-git-receive-pack-result',
      'cache-control': 'no-cache',
      'content-length': payload.length,
      'connection': 'close',
    });
    res.end(payload);
    return true;
  }

  return false;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

function parsePktLines(buf: Buffer): string[] {
  const lines: string[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const lenHex = buf.subarray(offset, offset + 4).toString('ascii');
    if (lenHex === '0000') {
      offset += 4;
      continue;
    }
    const len = parseInt(lenHex, 16);
    if (isNaN(len) || len <= 4 || offset + len > buf.length) {
      break;
    }
    const line = buf.subarray(offset + 4, offset + len).toString('utf8');
    lines.push(line.replace(/\n$/, ''));
    offset += len;
  }
  return lines;
}

function sidebandPack(pack: Buffer): Buffer {
  const maxPayload = 65516;
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < pack.length) {
    const sliceLen = Math.min(maxPayload, pack.length - offset);
    const slice = pack.subarray(offset, offset + sliceLen);
    const pktLen = sliceLen + 5;
    const lenHex = pktLen.toString(16).padStart(4, '0');
    const pkt = Buffer.alloc(5 + sliceLen);
    pkt.write(lenHex, 0, 4, 'ascii');
    pkt[4] = 1;
    slice.copy(pkt, 5);
    chunks.push(pkt);
    offset += sliceLen;
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0);
}
