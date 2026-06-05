import type { PRComment, ThreadMeta, OpenPR, PRFileInfo } from './types';

const TOKEN_KEY = 'mpv_gh_token';
const USER_KEY  = 'mpv_gh_user';

// ── Token storage ─────────────────────────────────────────────────────────────

export function getStoredToken(): string | null { return localStorage.getItem(TOKEN_KEY); }
export function getStoredUser():  string | null { return localStorage.getItem(USER_KEY); }
export function storeAuth(token: string, login: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, login);
}
export function clearAuth(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

// ── Core HTTP ─────────────────────────────────────────────────────────────────

async function githubRequest<T>(
  path: string,
  token: string,
  options?: { method?: string; body?: unknown }
): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: options?.method ?? 'GET',
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options?.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${res.statusText}`);
  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}

async function githubGraphQL<T>(
  query: string,
  variables: Record<string, unknown>,
  token: string
): Promise<T> {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GitHub GraphQL HTTP ${res.status}`);
  const json = await res.json() as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) throw new Error(json.errors.map(e => e.message).join('; '));
  return json.data as T;
}

// ── Token exchange (PKCE — requires proxy) ────────────────────────────────────

export async function exchangeCodeForToken(
  clientId: string,
  code: string,
  codeVerifier: string,
  redirectUri: string,
  proxyUrl: string
): Promise<string> {
  const res = await fetch(proxyUrl, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, code, redirect_uri: redirectUri, code_verifier: codeVerifier }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`);
  const data = await res.json() as { access_token?: string; error?: string; error_description?: string };
  if (data.error) throw new Error(data.error_description ?? data.error);
  if (!data.access_token) throw new Error('No token received from GitHub.');
  return data.access_token;
}

// ── User ──────────────────────────────────────────────────────────────────────

export async function getCurrentUser(token: string): Promise<{ login: string }> {
  return githubRequest<{ login: string }>('/user', token);
}

// ── PRs ───────────────────────────────────────────────────────────────────────

interface RawPull {
  number: number;
  title: string;
  head: { ref: string; sha: string };
  user: { login: string };
  updated_at: string;
}

export async function listOpenPRs(token: string, owner: string, repo: string): Promise<OpenPR[]> {
  const pulls = await githubRequest<RawPull[]>(
    `/repos/${owner}/${repo}/pulls?state=open&per_page=100&sort=updated&direction=desc`,
    token
  );
  return pulls.map(p => ({
    number: p.number,
    title: p.title,
    branch: p.head.ref,
    headSha: p.head.sha,
    author: p.user.login,
    updatedAt: p.updated_at,
  }));
}

// ── Files ─────────────────────────────────────────────────────────────────────

interface RawPRFile { filename: string; patch?: string; }

function parseValidLines(patch: string): number[] {
  const lines: number[] = [];
  let lineNum = 0;
  for (const raw of patch.split('\n')) {
    const m = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (m) { lineNum = parseInt(m[1], 10) - 1; continue; }
    if (raw.startsWith('-')) continue;
    lineNum++;
    lines.push(lineNum);
  }
  return lines;
}

export async function fetchPRFileInfo(
  token: string,
  owner: string,
  repo: string,
  prNumber: number
): Promise<PRFileInfo> {
  const files = await githubRequest<RawPRFile[]>(
    `/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`,
    token
  );
  const validLinesByPath = new Map<string, number[]>();
  for (const f of files) {
    if (f.patch) validLinesByPath.set(f.filename, parseValidLines(f.patch));
  }
  const markdownFiles = files.map(f => f.filename).filter(f => f.endsWith('.md'));
  return { markdownFiles, validLinesByPath };
}

export async function fetchFileContent(
  token: string,
  owner: string,
  repo: string,
  filePath: string,
  ref: string
): Promise<string> {
  const data = await githubRequest<{ content: string; encoding: string }>(
    `/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(ref)}`,
    token
  );
  if (data.encoding !== 'base64') throw new Error(`Unexpected encoding: ${data.encoding}`);
  const bytes = Uint8Array.from(atob(data.content.replace(/\n/g, '')), c => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

// ── Comments ──────────────────────────────────────────────────────────────────

interface RawComment {
  id: number;
  node_id: string;
  in_reply_to_id?: number;
  path: string;
  line: number | null;
  body: string;
  user: { login: string; avatar_url: string };
  created_at: string;
}

export async function fetchPrComments(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  filePath: string
): Promise<PRComment[]> {
  const raw = await githubRequest<RawComment[]>(
    `/repos/${owner}/${repo}/pulls/${prNumber}/comments?per_page=100`,
    token
  );
  return raw
    .filter(c => c.path === filePath && c.line != null)
    .map(c => ({
      id: c.id,
      node_id: c.node_id,
      in_reply_to_id: c.in_reply_to_id,
      line: c.line!,
      body: c.body,
      user: c.user,
      created_at: c.created_at,
    }));
}

const userNameCache = new Map<string, string>();
const MENTION_RE = /@([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?)/g;

async function fetchDisplayName(token: string, login: string): Promise<void> {
  if (userNameCache.has(login)) return;
  try {
    const u = await githubRequest<{ login: string; name: string | null }>(`/users/${login}`, token);
    userNameCache.set(login, u.name ?? login);
  } catch { userNameCache.set(login, login); }
}

export async function enrichWithDisplayNames(
  token: string,
  comments: PRComment[]
): Promise<PRComment[]> {
  const logins = new Set([
    ...comments.map(c => c.user.login),
    ...[...comments.flatMap(c => [...c.body.matchAll(new RegExp(MENTION_RE.source, 'g'))].map(m => m[1]))],
  ]);
  await Promise.all([...logins].map(l => fetchDisplayName(token, l)));
  return comments.map(c => ({
    ...c,
    user: { ...c.user, name: userNameCache.get(c.user.login) ?? c.user.login },
    body: c.body.replace(new RegExp(MENTION_RE.source, 'g'), (_, login) =>
      `[${userNameCache.get(login) ?? login}](https://github.com/${login})`
    ),
  }));
}

export async function createPrComment(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
  commitId: string,
  path: string,
  line: number
): Promise<PRComment> {
  const raw = await githubRequest<RawComment>(
    `/repos/${owner}/${repo}/pulls/${prNumber}/comments`,
    token,
    { method: 'POST', body: { body, commit_id: commitId, path, line, side: 'RIGHT' } }
  );
  return { id: raw.id, node_id: raw.node_id, line: raw.line ?? line, body: raw.body, user: raw.user, created_at: raw.created_at };
}

export async function replyToComment(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  inReplyToId: number,
  body: string
): Promise<PRComment> {
  const raw = await githubRequest<RawComment>(
    `/repos/${owner}/${repo}/pulls/${prNumber}/comments/${inReplyToId}/replies`,
    token,
    { method: 'POST', body: { body } }
  );
  return { id: raw.id, node_id: raw.node_id, in_reply_to_id: inReplyToId, line: raw.line ?? 0, body: raw.body, user: raw.user, created_at: raw.created_at };
}

interface GraphQLThread {
  id: string;
  isResolved: boolean;
  path: string;
  comments: { nodes: Array<{ databaseId: number }> };
}

export async function fetchThreadMeta(
  token: string,
  owner: string,
  repo: string,
  prNumber: number
): Promise<ThreadMeta[]> {
  const query = `
    query GetThreadMeta($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 100) {
            nodes {
              id isResolved path
              comments(first: 1) { nodes { databaseId } }
            }
          }
        }
      }
    }
  `;
  const data = await githubGraphQL<{
    repository: { pullRequest: { reviewThreads: { nodes: GraphQLThread[] } } };
  }>(query, { owner, repo, number: prNumber }, token);

  return data.repository.pullRequest.reviewThreads.nodes
    .filter(n => n.comments.nodes.length > 0)
    .map(n => ({
      nodeId: n.id,
      isResolved: n.isResolved,
      rootCommentId: n.comments.nodes[0].databaseId,
      path: n.path,
    }));
}
