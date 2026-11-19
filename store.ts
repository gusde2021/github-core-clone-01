import crypto from 'node:crypto';
import zlib from 'node:zlib';

export interface Repository {
  id: number;
  name: string;
  full_name: string;
  owner: {
    login: string;
    id: number;
    type: string;
  };
  private: boolean;
  default_branch: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

interface RepoItem {
  repo: Repository;
  objects: Map<string, { type: string; content: Buffer }>;
  refs: Map<string, string>;
  issues: Map<number, any>;
  pulls: Map<number, any>;
  labels: Set<string>;
}

export class GitStore {
  private repos = new Map<string, RepoItem>();
  private objectsMap = new Map<string, { type: string; content: Buffer }>();
  private nextRepoId = 1;

  constructor() {}

  public computeSha1(type: string, content: Buffer): string {
    const header = Buffer.from(`${type} ${content.length}\0`);
    const full = Buffer.concat([header, content]);
    return crypto.createHash('sha1').update(full).digest('hex');
  }

  public storeObject(type: 'blob' | 'tree' | 'commit' | 'tag', content: Buffer): string {
    const sha = this.computeSha1(type, content);
    if (!this.objectsMap.has(sha)) {
      this.objectsMap.set(sha, { type, content });
    }
    return sha;
  }

  public getStoredObject(sha: string): { type: string; content: Buffer } | null {
    return this.objectsMap.get(sha) ?? null;
  }

  public createRepo(ownerLogin: string, repoName: string, isPrivate = false, description: string | null = null): Repository {
    const full_name = `${ownerLogin}/${repoName}`;
    const key = full_name.toLowerCase();
    if (this.repos.has(key)) {
      return this.repos.get(key)!.repo;
    }
    const repo: Repository = {
      id: this.nextRepoId++,
      name: repoName,
      full_name,
      owner: {
        login: ownerLogin,
        id: 1,
        type: ownerLogin.toLowerCase() === 'org' ? 'Organization' : 'User'
      },
      private: isPrivate,
      default_branch: 'main',
      description,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    const refs = new Map<string, string>();
    const objects = new Map<string, { type: string; content: Buffer }>();
    const issues = new Map<number, any>();
    const pulls = new Map<number, any>();
    const labels = new Set<string>();

    this.repos.set(key, { repo, objects, refs, issues, pulls, labels });
    return repo;
  }

  private getRepoItem(ownerLogin: string, repoName: string): RepoItem | null {
    const key = `${ownerLogin}/${repoName}`.toLowerCase();
    return this.repos.get(key) ?? null;
  }

  public getRepo(ownerLogin: string, repoName: string): Repository | null {
    const item = this.getRepoItem(ownerLogin, repoName);
    return item ? item.repo : null;
  }

  public deleteRepo(ownerLogin: string, repoName: string): boolean {
    const key = `${ownerLogin}/${repoName}`.toLowerCase();
    return this.repos.delete(key);
  }

  public listRepos(ownerLogin?: string): Repository[] {
    const list: Repository[] = [];
    for (const item of this.repos.values()) {
      if (!ownerLogin || item.repo.owner.login.toLowerCase() === ownerLogin.toLowerCase()) {
        list.push(item.repo);
      }
    }
    return list;
  }

  public updateRepo(ownerLogin: string, repoName: string, updates: Partial<Repository>): Repository | null {
    const item = this.getRepoItem(ownerLogin, repoName);
    if (!item) return null;
    Object.assign(item.repo, updates, { updated_at: new Date().toISOString() });
    return item.repo;
  }

  public setRef(ownerLogin: string, repoName: string, refName: string, sha: string) {
    const item = this.getRepoItem(ownerLogin, repoName);
    if (!item) return;
    item.refs.set(refName, sha);
    if (refName === 'refs/heads/main' && !item.refs.has('HEAD')) {
      item.refs.set('HEAD', 'ref: refs/heads/main');
    }
  }

  public getRef(ownerLogin: string, repoName: string, refName: string): string | null {
    const item = this.getRepoItem(ownerLogin, repoName);
    if (!item) return null;
    let val = item.refs.get(refName);
    if (val && val.startsWith('ref: ')) {
      return this.getRef(ownerLogin, repoName, val.slice(5).trim());
    }
    return val ?? null;
  }

  public listRefs(ownerLogin: string, repoName: string): Array<{ name: string; sha: string }> {
    const item = this.getRepoItem(ownerLogin, repoName);
    if (!item) return [];
    const result: Array<{ name: string; sha: string }> = [];
    for (const [name, target] of item.refs.entries()) {
      if (name === 'HEAD') continue;
      let sha = target;
      if (sha.startsWith('ref: ')) {
        const resolved = this.getRef(ownerLogin, repoName, sha.slice(5).trim());
        if (resolved) sha = resolved;
      }
      if (/^[0-9a-f]{40}$/.test(sha)) {
        result.push({ name, sha });
      }
    }
    return result;
  }
}

export const store = new GitStore();
