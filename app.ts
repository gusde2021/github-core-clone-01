import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import { handleRest } from './rest.ts';
import { handleGitHttp } from './git-http.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const requestId = crypto.randomUUID();
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
    ...headers,
  });
  res.end(text);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

export function createApp(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';

    // Health check
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // Git smart HTTP under /{owner}/{repo}.git/...
    const gitMatch = path.match(/^\/([^/]+)\/([^/]+\.git)(?:\/(.*))?$/);
    if (gitMatch) {
      const owner = gitMatch[1];
      const repoWithDotGit = gitMatch[2];
      const repoName = repoWithDotGit.endsWith('.git') ? repoWithDotGit.slice(0, -4) : repoWithDotGit;
      const subPath = gitMatch[3] ?? '';

      try {
        const handled = await handleGitHttp(req, res, owner, repoName, subPath);
        if (handled) return;
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end(err instanceof Error ? err.message : 'Internal Server Error');
        }
        return;
      }
    }

    // REST v3 API under /api/v3/...
    if (path.startsWith('/api/v3')) {
      try {
        const handled = await handleRest(req, res, path);
        if (handled) return;
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        }
        return;
      }
    }

    // Fallback 404 JSON for unknown routes
    sendJson(res, 404, { message: 'Not Found' });
  });
}
