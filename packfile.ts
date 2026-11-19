import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { store } from './store.ts';

const OBJ_COMMIT = 1;
const OBJ_TREE = 2;
const OBJ_BLOB = 3;
const OBJ_TAG = 4;

const typeMap: Record<string, number> = {
  commit: OBJ_COMMIT,
  tree: OBJ_TREE,
  blob: OBJ_BLOB,
  tag: OBJ_TAG,
};

export function buildPackfile(owner: string, repo: string, wants: string[], haves: string[]): Buffer {
  const objectClosure = new Set<string>();
  const haveClosure = new Set<string>();

  // Collect 'have' closure
  for (const h of haves) {
    collectClosure(h, haveClosure);
  }

  // Collect 'want' closure
  for (const w of wants) {
    collectClosure(w, objectClosure);
  }

  // Exclude haves
  const finalShas: string[] = [];
  for (const sha of objectClosure) {
    if (!haveClosure.has(sha)) {
      finalShas.push(sha);
    }
  }

  // Also ensure explicit wants are included even if something tricky happened
  for (const w of wants) {
    if (!finalShas.includes(w) && store.getStoredObject(w)) {
      finalShas.push(w);
    }
  }

  const objectsToPack: Array<{ type: string; content: Buffer }> = [];
  for (const sha of finalShas) {
    const obj = store.getStoredObject(sha);
    if (obj) {
      objectsToPack.push(obj);
    }
  }

  // Build pack file buffer
  const chunks: Buffer[] = [];

  // Header: 'PACK' + version (2, 4 bytes BE) + count (N, 4 bytes BE)
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objectsToPack.length, 8);
  chunks.push(header);

  for (const obj of objectsToPack) {
    const typeNum = typeMap[obj.type] || OBJ_BLOB;
    const content = obj.content;
    const compressed = zlib.deflateSync(content);

    // Encode type and size
    const typeAndSizeHeader = encodeTypeAndSize(typeNum, content.length);
    chunks.push(typeAndSizeHeader);
    chunks.push(compressed);
  }

  const preTrailer = Buffer.concat(chunks);
  const checksum = crypto.createHash('sha1').update(preTrailer).digest();
  
  return Buffer.concat([preTrailer, checksum]);
}

function collectClosure(sha: string, visited: Set<string>) {
  if (visited.has(sha)) return;
  const obj = store.getStoredObject(sha);
  if (!obj) return;
  visited.add(sha);

  if (obj.type === 'commit') {
    // Parse commit: tree <sha>\nparent <sha>\n...
    const text = obj.content.toString('utf8');
    const lines = text.split('\n');
    for (const line of lines) {
      if (line.startsWith('tree ')) {
        collectClosure(line.slice(5).trim(), visited);
      } else if (line.startsWith('parent ')) {
        collectClosure(line.slice(7).trim(), visited);
      }
    }
  } else if (obj.type === 'tree') {
    // Parse tree: binary format [mode] [name]\0[20-byte binary sha]
    const buf = obj.content;
    let offset = 0;
    while (offset < buf.length) {
      const nullIdx = buf.indexOf(0, offset);
      if (nullIdx === -1) break;
      const spaceIdx = buf.indexOf(32, offset);
      if (spaceIdx === -1 || spaceIdx > nullIdx) break;
      // 20 bytes sha follows nullIdx
      if (nullIdx + 21 <= buf.length) {
        const shaBytes = buf.subarray(nullIdx + 1, nullIdx + 21);
        const childSha = shaBytes.toString('hex');
        collectClosure(childSha, visited);
      }
      offset = nullIdx + 21;
    }
  } else if (obj.type === 'tag') {
    const text = obj.content.toString('utf8');
    const match = text.match(/^object\s+([0-9a-f]{40})/m);
    if (match) {
      collectClosure(match[1], visited);
    }
  }
}

function encodeTypeAndSize(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let b = (type << 4) | (size & 0x0f);
  size >>= 4;
  while (size > 0) {
    bytes.push(b | 0x80);
    b = size & 0x7f;
    size >>= 7;
  }
  bytes.push(b);
  return Buffer.from(bytes);
}
