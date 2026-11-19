import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { store } from './store.ts';

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const requestId = crypto.randomUUID();
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': requestId,
    ...extraHeaders,
  };
  if (status !== 204) {
    headers['content-length'] = String(Buffer.byteLength(text));
  }
  res.writeHead(status, headers);
  if (status !== 204) {
    res.end(text);
  } else {
    res.end();
  }
}

async function readJsonBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const buf = Buffer.concat(chunks);
  if (buf.length === 0) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new Error('Malformed JSON body');
  }
}

export async function handleRest(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  const method = req.method ?? 'GET';
  const authHeader = req.headers['authorization'];
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN;

  if (expectedToken && expectedToken.trim() !== '') {
    if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.slice(7).trim() !== expectedToken.trim()) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return true;
    }
  }

  // Determine user login from token or default
  const currentUserLogin = 'testuser';

  // GET /api/v3 or /api/v3/
  if (pathname === '/api/v3' || pathname === '/api/v3/') {
    if (method !== 'GET') {
      sendJson(res, 405, { message: 'Method not allowed' });
      return true;
    }
    sendJson(res, 200, {
      current_user_url: 'http://entry/api/v3/user',
      rate_limit_url: 'http://entry/api/v3/rate_limit',
      repositories_url: 'http://entry/api/v3/repositories',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  // GET /api/v3/meta
  if (pathname === '/api/v3/meta') {
    if (method !== 'GET') {
      sendJson(res, 405, { message: 'Method not allowed' });
      return true;
    }
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }

  // GET /api/v3/user
  if (pathname === '/api/v3/user') {
    if (method !== 'GET') {
      sendJson(res, 405, { message: 'Method not allowed' });
      return true;
    }
    sendJson(res, 200, {
      login: currentUserLogin,
      id: 1,
      node_id: 'MDQ6VXNlcjE=',
      avatar_url: '',
      type: 'User',
      site_admin: false,
      name: 'Test User',
      email: 'test@example.com',
    });
    return true;
  }

  // GET /api/v3/user/repos
  if (pathname === '/api/v3/user/repos') {
    if (method === 'GET') {
      const repos = store.listRepos();
      sendJson(res, 200, repos);
      return true;
    }
    if (method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const name = body.name;
        if (!name || typeof name !== 'string') {
          sendJson(res, 422, { message: 'Validation Failed: name is required' });
          return true;
        }
        const privateRepo = Boolean(body.private);
        const description = body.description ?? null;
        const repo = store.createRepo(currentUserLogin, name, privateRepo, description);
        sendJson(res, 201, repo);
      } catch (err) {
        sendJson(res, 400, { message: err instanceof Error ? err.message : 'Invalid JSON' });
      }
      return true;
    }
  }

  // POST /api/v3/orgs/{org}/repos
  const orgReposMatch = pathname.match(/^\/api\/v3\/orgs\/([^/]+)\/repos$/);
  if (orgReposMatch) {
    const org = orgReposMatch[1];
    if (method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const name = body.name;
        if (!name || typeof name !== 'string') {
          sendJson(res, 422, { message: 'Validation Failed: name is required' });
          return true;
        }
        const privateRepo = Boolean(body.private);
        const description = body.description ?? null;
        const repo = store.createRepo(org, name, privateRepo, description);
        sendJson(res, 201, repo);
      } catch (err) {
        sendJson(res, 400, { message: err instanceof Error ? err.message : 'Invalid JSON' });
      }
      return true;
    }
  }

  // /api/v3/repos/{owner}/{repo}(/...)
  const repoMatch = pathname.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
  if (repoMatch) {
    const owner = repoMatch[1];
    const repoName = repoMatch[2];
    const subRoute = repoMatch[3] ?? '';

    if (subRoute === '' || subRoute === '/') {
      if (method === 'GET') {
        const repo = store.getRepo(owner, repoName);
        if (!repo) {
          sendJson(res, 404, { message: 'Not Found' });
          return true;
        }
        sendJson(res, 200, repo);
        return true;
      }
      if (method === 'PATCH') {
        try {
          const body = await readJsonBody(req);
          const updated = store.updateRepo(owner, repoName, body);
          if (!updated) {
            sendJson(res, 404, { message: 'Not Found' });
            return true;
          }
          sendJson(res, 200, updated);
        } catch (err) {
          sendJson(res, 400, { message: err instanceof Error ? err.message : 'Invalid JSON' });
        }
        return true;
      }
      if (method === 'DELETE') {
        const success = store.deleteRepo(owner, repoName);
        if (!success) {
          sendJson(res, 404, { message: 'Not Found' });
          return true;
        }
        sendJson(res, 204, null);
        return true;
      }
    }
  }

  return false;
}
