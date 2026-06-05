import {
  getStoredToken, getStoredUser, storeAuth, clearAuth,
  getCurrentUser, exchangeCodeForToken,
  listOpenPRs, fetchPRFileInfo, fetchFileContent,
  fetchPrComments, fetchThreadMeta, replyToComment, createPrComment,
  resolveThread, unresolveThread,
  enrichWithDisplayNames,
} from './lib/github';
import type { PRComment, ThreadMeta } from './lib/types';
import { renderMarkdown } from './webview/renderer';
import { placeOverlays, initSelectionHandlers, initCodeBlockToggles, initDiagramZoom, snapLineFor, type OverlayCallbacks } from './webview/overlay';
import { resolveDiagramAnchors, type Point } from './webview/diagram-anchors';
import { NavStrip } from './webview/nav';

// ── Build-time OAuth config (empty = PAT-only mode) ───────────────────────────

declare const __OAUTH_CLIENT_ID__: string;
declare const __OAUTH_PROXY_URL__: string;

const OAUTH_CLIENT_ID = __OAUTH_CLIENT_ID__;
const OAUTH_PROXY_URL = __OAUTH_PROXY_URL__;
const OAUTH_ENABLED   = OAUTH_CLIENT_ID.length > 0 && OAUTH_PROXY_URL.length > 0;

// ── State ─────────────────────────────────────────────────────────────────────

let allComments:   PRComment[]  = [];
let allThreadMeta: ThreadMeta[] = [];
let navStrip:      NavStrip | undefined;
let diagramAnchors: Map<number, Point> = new Map();
let activePrNumber: number | null = null;
let activePrPath:   string | null = null;
let activeHeadSha:  string | null = null;
let activeOwner:    string = '';
let activeRepo:     string = '';
let validLinesByPath = new Map<string, number[]>();
let refreshTimer: ReturnType<typeof setInterval> | null = null;

const COMMENT_REFRESH_MS = 30_000;
const REPO_KEY = 'mpv_repo';
const BASE_TITLE = 'Markdown PR Viewer';

// ── DOM refs ──────────────────────────────────────────────────────────────────

const repoSection   = document.getElementById('repo-section')!;
const repoInput     = document.getElementById('repo-input')   as HTMLInputElement;
const repoSubmit    = document.getElementById('repo-submit')  as HTMLButtonElement;
const repoError     = document.getElementById('repo-error')!;

const authSection   = document.getElementById('auth-section')!;
const oauthBtn      = document.getElementById('oauth-btn')    as HTMLButtonElement | null;
const patInput      = document.getElementById('pat-input')    as HTMLInputElement;
const patSubmit     = document.getElementById('pat-submit')   as HTMLButtonElement;
const authError     = document.getElementById('auth-error')!;
const userDisplay   = document.getElementById('user-display')!;
const signOutBtn    = document.getElementById('sign-out-btn') as HTMLButtonElement;

const prControls    = document.getElementById('pr-controls')!;
const prSelect      = document.getElementById('pr-select')    as HTMLSelectElement;
const fileSelect    = document.getElementById('file-select')  as HTMLSelectElement;
const prRefresh     = document.getElementById('pr-refresh')   as HTMLButtonElement;
const navStripSlot  = document.getElementById('nav-strip-slot')!;
const contentEl     = document.getElementById('content')!;
const statusEl      = document.getElementById('status')!;
const landingEl     = document.getElementById('landing')!;

// ── PKCE helpers ──────────────────────────────────────────────────────────────

function base64urlEncode(buf: Uint8Array): string {
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function generateVerifier(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return base64urlEncode(buf);
}
async function generateChallenge(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64urlEncode(new Uint8Array(hash));
}

// ── Repo setup ────────────────────────────────────────────────────────────────

function showRepoError(msg: string): void {
  repoError.textContent = msg;
  repoError.hidden = !msg;
}

function applyRepo(ownerRepo: string): void {
  const [owner, repo] = ownerRepo.split('/');
  activeOwner = owner ?? '';
  activeRepo  = repo  ?? '';
  localStorage.setItem(REPO_KEY, ownerRepo);
  repoInput.value = ownerRepo;
  repoSection.dataset.state = 'set';
  showRepoError('');
}

repoSubmit.addEventListener('click', () => {
  const val = repoInput.value.trim();
  if (!val.includes('/') || val.split('/').length !== 2 || val.startsWith('/') || val.endsWith('/')) {
    showRepoError('Enter a repo as owner/repo, e.g. facebook/react');
    return;
  }
  applyRepo(val);
});

repoInput.addEventListener('keydown', e => { if (e.key === 'Enter') repoSubmit.click(); });

document.getElementById('repo-change')?.addEventListener('click', () => {
  repoSection.dataset.state = 'editing';
  repoInput.focus();
  repoInput.select();
});

// ── Auth ──────────────────────────────────────────────────────────────────────

function showAuthError(msg: string): void {
  authError.textContent = msg;
  authError.hidden = !msg;
}

function applyAuthState(login: string | null): void {
  if (login) {
    authSection.dataset.state = 'signed-in';
    userDisplay.textContent = login;
    prControls.hidden = false;
  } else {
    authSection.dataset.state = 'signed-out';
    userDisplay.textContent = '';
    prControls.hidden = true;
    prRefresh.hidden = true;
    navStripSlot.replaceChildren();
    navStrip = undefined;
    contentEl.replaceChildren();
    document.querySelectorAll('.pr-bubble, .pr-popover, .pr-thread, .pr-table-thread-row').forEach(el => el.remove());
    clearRefreshTimer();
    landingEl.hidden = false;
    document.title = BASE_TITLE;
  }
}

// PAT sign-in
patSubmit.addEventListener('click', async () => {
  const token = patInput.value.trim();
  if (!token) return;
  showAuthError('');
  patSubmit.disabled = true;
  patSubmit.textContent = 'Connecting…';
  try {
    const { login } = await getCurrentUser(token);
    storeAuth(token, login);
    applyAuthState(login);
    await loadPRList();
    restoreHashedPR();
  } catch (err) {
    showAuthError(`Could not connect — ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    patSubmit.disabled = false;
    patSubmit.textContent = 'Connect';
  }
});
patInput.addEventListener('keydown', e => { if (e.key === 'Enter') patSubmit.click(); });

// OAuth sign-in (only wired if OAUTH_ENABLED)
oauthBtn?.addEventListener('click', async () => {
  if (!OAUTH_ENABLED) return;
  showAuthError('');
  oauthBtn.disabled = true;

  const verifier  = generateVerifier();
  const challenge = await generateChallenge(verifier);
  const state     = generateVerifier();

  sessionStorage.setItem('pkce_verifier', verifier);
  sessionStorage.setItem('oauth_state', state);
  if (location.hash) sessionStorage.setItem('pre_auth_hash', location.hash);

  const params = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: `${location.origin}${location.pathname}`,
    scope: 'repo',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  location.href = `https://github.com/login/oauth/authorize?${params}`;
});

signOutBtn.addEventListener('click', () => {
  clearAuth();
  setActiveHash(null);
  applyAuthState(null);
  resetPrSelect();
  fileSelect.replaceChildren();
  fileSelect.hidden = true;
  showStatus('');
  showAuthError('');
});

// ── OAuth callback ────────────────────────────────────────────────────────────

async function handleOAuthCallback(): Promise<boolean> {
  if (!OAUTH_ENABLED) return false;
  const params   = new URLSearchParams(location.search);
  const code     = params.get('code');
  const state    = params.get('state');
  if (!code) return false;

  const preAuthHash = sessionStorage.getItem('pre_auth_hash') ?? location.hash;
  sessionStorage.removeItem('pre_auth_hash');
  history.replaceState({}, '', location.pathname + preAuthHash);

  const savedState = sessionStorage.getItem('oauth_state');
  const verifier   = sessionStorage.getItem('pkce_verifier');
  sessionStorage.removeItem('oauth_state');
  sessionStorage.removeItem('pkce_verifier');

  if (state !== savedState) { showAuthError('Sign in failed — state mismatch. Please try again.'); return true; }

  try {
    const token = await exchangeCodeForToken(
      OAUTH_CLIENT_ID, code, verifier!,
      `${location.origin}${location.pathname}`,
      OAUTH_PROXY_URL
    );
    const { login } = await getCurrentUser(token);
    storeAuth(token, login);
    applyAuthState(login);
    await loadPRList();
    restoreHashedPR();
  } catch (err) {
    showAuthError(`Sign in failed — ${err instanceof Error ? err.message : String(err)}`);
  }
  return true;
}

// ── URL hash deep-link ────────────────────────────────────────────────────────

function setActiveHash(prNumber: number | null): void {
  history.replaceState({}, '', prNumber != null ? `${location.pathname}#pr-${prNumber}` : location.pathname);
}

function restoreHashedPR(): void {
  const m = location.hash.match(/^#pr-(\d+)$/);
  if (!m) return;
  const num = parseInt(m[1], 10);
  const opt = prSelect.querySelector<HTMLOptionElement>(`option[value="${num}"]`);
  if (!opt) return;
  prSelect.value = String(num);
  loadAndRenderPR(num, opt.dataset.sha ?? '');
}

// ── Status ────────────────────────────────────────────────────────────────────

function showStatus(msg: string, isError = false): void {
  statusEl.textContent = msg;
  statusEl.className = isError ? 'status error' : 'status';
  statusEl.hidden = !msg;
}

// ── PR list ───────────────────────────────────────────────────────────────────

async function loadPRList(): Promise<void> {
  const token = getStoredToken();
  if (!token || !activeOwner || !activeRepo) return;

  const previousPr = activePrNumber;
  prRefresh.disabled = true;
  showStatus('Loading open PRs…');

  try {
    const prs = await listOpenPRs(token, activeOwner, activeRepo);
    resetPrSelect();
    for (const pr of prs) {
      const opt = document.createElement('option');
      opt.value = String(pr.number);
      opt.textContent = `#${pr.number} — ${pr.title}`;
      opt.dataset.sha = pr.headSha;
      prSelect.appendChild(opt);
    }
    if (previousPr != null) {
      const opt = prSelect.querySelector<HTMLOptionElement>(`option[value="${previousPr}"]`);
      if (opt) prSelect.value = String(previousPr);
    }
    showStatus(prs.length === 0 ? 'No open PRs found.' : '');
  } catch (err) {
    showStatus(`Failed to load PRs — ${err instanceof Error ? err.message : String(err)}`, true);
  } finally {
    prRefresh.disabled = false;
  }
}

prRefresh.addEventListener('click', async () => {
  await loadPRList();
  await refreshOverlays();
});

prSelect.addEventListener('change', async () => {
  const opt = prSelect.selectedOptions[0];
  if (!opt?.value) {
    landingEl.hidden = false;
    prRefresh.hidden = true;
    contentEl.replaceChildren();
    navStripSlot.replaceChildren();
    navStrip = undefined;
    document.querySelectorAll('.pr-bubble, .pr-popover, .pr-thread, .pr-table-thread-row').forEach(el => el.remove());
    clearRefreshTimer();
    fileSelect.replaceChildren();
    fileSelect.hidden = true;
    setActiveHash(null);
    document.title = BASE_TITLE;
    return;
  }
  await loadAndRenderPR(parseInt(opt.value, 10), opt.dataset.sha ?? '');
});

fileSelect.addEventListener('change', async () => {
  const path = fileSelect.value;
  if (!path || activePrNumber == null) return;
  await loadAndRenderFile(path);
});

// ── Render ────────────────────────────────────────────────────────────────────

async function loadAndRenderPR(prNumber: number, headSha: string): Promise<void> {
  const token = getStoredToken();
  if (!token) return;

  activePrNumber  = prNumber;
  activePrPath    = null;
  activeHeadSha   = headSha;
  validLinesByPath = new Map();
  landingEl.hidden = true;
  contentEl.replaceChildren();
  navStripSlot.replaceChildren();
  navStrip = undefined;
  clearRefreshTimer();
  setActiveHash(prNumber);
  showStatus('Loading PR files…');

  try {
    const fileInfo = await fetchPRFileInfo(token, activeOwner, activeRepo, prNumber);

    if (fileInfo.markdownFiles.length === 0) {
      showStatus('No markdown files changed in this PR.', true);
      return;
    }

    validLinesByPath = fileInfo.validLinesByPath;

    // Populate file picker
    
    for (const f of fileInfo.markdownFiles) {
      const opt = document.createElement('option');
      opt.value = f;
      opt.textContent = f.split('/').pop() ?? f;
      opt.title = f;
      fileSelect.appendChild(opt);
    }
    fileSelect.hidden = fileInfo.markdownFiles.length <= 1;

    prRefresh.hidden = false;
    showStatus('');
    await loadAndRenderFile(fileInfo.markdownFiles[0]);
  } catch (err) {
    showStatus(`Failed to load — ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

async function loadAndRenderFile(filePath: string): Promise<void> {
  const token = getStoredToken();
  if (!token || activePrNumber == null || !activeHeadSha) return;

  activePrPath = filePath;
  fileSelect.value = filePath;
  showStatus('Loading…');

  try {
    const [markdown, comments, threadMeta] = await Promise.all([
      fetchFileContent(token, activeOwner, activeRepo, filePath, activeHeadSha),
      fetchPrComments(token, activeOwner, activeRepo, activePrNumber, filePath),
      fetchThreadMeta(token, activeOwner, activeRepo, activePrNumber),
    ]);

    allComments   = await enrichWithDisplayNames(token, comments.map(processComment));
    allThreadMeta = threadMeta;

    showStatus('');
    const prLabel = prSelect.selectedOptions[0]?.textContent?.trim() ?? '';
    document.title = prLabel ? `${prLabel} — ${BASE_TITLE}` : BASE_TITLE;

    await renderDocument(allComments, allThreadMeta, markdown);

    if (!navStrip) {
      navStrip = new NavStrip(
        navStripSlot,
        () => Array.from(document.querySelectorAll<HTMLElement>('[data-thread-id]')),
        () => {}
      );
    }
    navStrip.update(countThreads());

    startRefreshTimer(activePrNumber, filePath);
  } catch (err) {
    showStatus(`Failed to load — ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

async function renderDocument(comments: PRComment[], threadMeta: ThreadMeta[], markdown: string): Promise<void> {
  // renderMarkdown uses markdown-it with html:false, so all raw HTML in source
  // is escaped to text — this assignment is safe against XSS.
  contentEl.innerHTML = renderMarkdown(markdown);

  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  mermaid.initialize({ startOnLoad: false, theme: prefersDark ? 'dark' : 'default' });

  const mermaidNodes = contentEl.querySelectorAll<HTMLElement>('.mermaid');
  const mermaidSources = new Map<HTMLElement, string>();
  mermaidNodes.forEach(el => mermaidSources.set(el, el.textContent?.trim() ?? ''));

  if (mermaidNodes.length > 0) {
    try { await mermaid.run({ nodes: mermaidNodes }); } catch { /* parse error — continue */ }
  }

  diagramAnchors = resolveDiagramAnchors(contentEl, comments, mermaidSources);
  initCodeBlockToggles(contentEl, placeOverlaysSync);
  initDiagramZoom(contentEl);

  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  placeOverlays(contentEl, comments, threadMeta, buildCallbacks(), diagramAnchors);
}

function placeOverlaysSync(): void {
  placeOverlays(contentEl, allComments, allThreadMeta, buildCallbacks(), diagramAnchors);
  navStrip?.refresh(countThreads());
}

async function refreshOverlays(): Promise<void> {
  const token = getStoredToken();
  if (!token || activePrNumber == null || !activePrPath) return;
  try {
    const [comments, threadMeta] = await Promise.all([
      fetchPrComments(token, activeOwner, activeRepo, activePrNumber, activePrPath),
      fetchThreadMeta(token, activeOwner, activeRepo, activePrNumber),
    ]);
    allComments   = await enrichWithDisplayNames(token, comments.map(processComment));
    allThreadMeta = threadMeta;
    placeOverlaysSync();
  } catch { /* silent */ }
}

function buildCallbacks(): OverlayCallbacks {
  return {
    onReply: handleReply,
    onResolve: handleResolve,
    onUnresolve: handleUnresolve,
    currentUserLogin: getStoredUser() ?? undefined,
  };
}

// ── Resolve / unresolve threads ───────────────────────────────────────────────

async function handleResolve(threadNodeId: string): Promise<void> {
  const token = getStoredToken();
  if (!token) return;
  try {
    await resolveThread(token, threadNodeId);
    await refreshOverlays();
  } catch (err) {
    showAuthError(`Could not resolve thread — ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleUnresolve(threadNodeId: string): Promise<void> {
  const token = getStoredToken();
  if (!token) return;
  try {
    await unresolveThread(token, threadNodeId);
    await refreshOverlays();
  } catch (err) {
    showAuthError(`Could not unresolve thread — ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Reply / new comment ───────────────────────────────────────────────────────

function handleReply(panel: HTMLElement, rootId: number, _line: number): void {
  if (panel.querySelector('.pr-reply-compose')) return;
  const token = getStoredToken();
  if (!token || activePrNumber == null) return;

  const box      = document.createElement('div');
  box.className  = 'pr-reply-compose';
  const textarea = document.createElement('textarea');
  textarea.placeholder = 'Reply…';
  textarea.className   = 'pr-compose-textarea';
  const actions  = document.createElement('div');
  actions.className = 'pr-compose-actions';
  const postBtn  = document.createElement('button');
  postBtn.className   = 'pr-btn-primary';
  postBtn.textContent = 'Post reply';
  const cancelBtn = document.createElement('button');
  cancelBtn.className   = 'pr-btn-secondary';
  cancelBtn.textContent = 'Cancel';
  const errEl = document.createElement('div');
  errEl.className = 'pr-compose-error';

  cancelBtn.addEventListener('click', () => box.remove());
  postBtn.addEventListener('click', async () => {
    const body = textarea.value.trim();
    if (!body) return;
    postBtn.disabled = cancelBtn.disabled = true;
    postBtn.textContent = 'Posting…';
    try {
      await replyToComment(token, activeOwner, activeRepo, activePrNumber!, rootId, body);
      box.remove();
      await refreshOverlays();
    } catch (err) {
      postBtn.disabled = cancelBtn.disabled = false;
      postBtn.textContent = 'Post reply';
      errEl.textContent = err instanceof Error ? err.message : String(err);
    }
  });

  actions.appendChild(postBtn);
  actions.appendChild(cancelBtn);
  box.appendChild(textarea);
  box.appendChild(actions);
  box.appendChild(errEl);
  panel.appendChild(box);
  setTimeout(() => textarea.focus(), 0);
}

function handleAddComment(anchor: HTMLElement, line: number): void {
  const token = getStoredToken();
  if (!token || activePrNumber == null || !activePrPath || !activeHeadSha) return;

  const validLines    = validLinesByPath.get(activePrPath) ?? [];
  const effectiveLine = snapLineFor(line, validLines) ?? line;

  document.querySelectorAll('.pr-compose-popover').forEach(el => el.remove());

  const wrapper = document.createElement('div');
  wrapper.className = 'pr-popover pr-compose-popover';

  const closeBtn = document.createElement('button');
  closeBtn.className   = 'pr-popover-close';
  closeBtn.textContent = '×';
  closeBtn.title = 'Close';
  closeBtn.addEventListener('click', () => wrapper.remove());

  const title = document.createElement('div');
  title.className   = 'pr-compose-title';
  title.textContent = 'New comment';

  const textarea = document.createElement('textarea');
  textarea.placeholder = 'Leave a comment…';
  textarea.className   = 'pr-compose-textarea';

  const actions = document.createElement('div');
  actions.className = 'pr-compose-actions';

  const postBtn = document.createElement('button');
  postBtn.className   = 'pr-btn-primary';
  postBtn.textContent = 'Comment';

  const cancelBtn = document.createElement('button');
  cancelBtn.className   = 'pr-btn-secondary';
  cancelBtn.textContent = 'Cancel';

  const errEl = document.createElement('div');
  errEl.className = 'pr-compose-error';

  cancelBtn.addEventListener('click', () => wrapper.remove());
  postBtn.addEventListener('click', async () => {
    const body = textarea.value.trim();
    if (!body) return;
    postBtn.disabled = cancelBtn.disabled = true;
    postBtn.textContent = 'Posting…';
    try {
      await createPrComment(token, activeOwner, activeRepo, activePrNumber!, body, activeHeadSha!, activePrPath!, effectiveLine);
      wrapper.remove();
      await refreshOverlays();
    } catch (err) {
      postBtn.disabled = cancelBtn.disabled = false;
      postBtn.textContent = 'Comment';
      errEl.textContent = err instanceof Error ? err.message : String(err);
    }
  });

  actions.appendChild(postBtn);
  actions.appendChild(cancelBtn);
  wrapper.appendChild(closeBtn);
  wrapper.appendChild(title);
  wrapper.appendChild(textarea);
  wrapper.appendChild(actions);
  wrapper.appendChild(errEl);
  document.body.appendChild(wrapper);

  const contentRect = contentEl.getBoundingClientRect();
  const GAP = 12;
  let left = contentRect.right + window.scrollX + GAP;
  if (contentRect.right + GAP + 300 > window.innerWidth - GAP) {
    left = Math.max(GAP + window.scrollX, contentRect.left + window.scrollX - 300 - GAP);
  }
  const anchorRect = anchor.getBoundingClientRect();
  const top = Math.max(window.scrollY + GAP, anchorRect.top + window.scrollY);
  wrapper.style.cssText = `position:absolute;z-index:199;left:${left}px;top:${top}px;width:300px;`;
  setTimeout(() => textarea.focus(), 0);
}

// ── Background refresh ────────────────────────────────────────────────────────

function startRefreshTimer(prNumber: number, filePath: string): void {
  clearRefreshTimer();
  refreshTimer = setInterval(async () => {
    const token = getStoredToken();
    if (!token || activePrNumber !== prNumber) { clearRefreshTimer(); return; }
    try {
      const [comments, threadMeta] = await Promise.all([
        fetchPrComments(token, activeOwner, activeRepo, prNumber, filePath),
        fetchThreadMeta(token, activeOwner, activeRepo, prNumber),
      ]);
      allComments   = await enrichWithDisplayNames(token, comments.map(processComment));
      allThreadMeta = threadMeta;
      placeOverlaysSync();
    } catch { /* silent */ }
  }, COMMENT_REFRESH_MS);
}

function clearRefreshTimer(): void {
  if (refreshTimer != null) { clearInterval(refreshTimer); refreshTimer = null; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resetPrSelect(): void {
  prSelect.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '— select a PR —';
  prSelect.appendChild(placeholder);
}

function countThreads(): number {
  return document.querySelectorAll<HTMLElement>('[data-thread-id]').length;
}

const LINE_META_RE = /\n\n---\n\*Comment on line (\d+)\*$/;
function processComment(c: PRComment): PRComment {
  const m = c.body.match(LINE_META_RE);
  if (!m) return c;
  return { ...c, body: c.body.slice(0, m.index as number), line: parseInt(m[1], 10) };
}

// ── Keyboard & resize ─────────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  if ((e.target as Element).closest('textarea, input, select')) return;
  if (e.key === '[') { e.preventDefault(); navStrip?.prev(); }
  if (e.key === ']') { e.preventDefault(); navStrip?.next(); }
});

document.addEventListener('click', e => {
  const a = (e.target as Element).closest('a');
  if (!a) return;
  const href = a.getAttribute('href');
  if (!href?.startsWith('#')) return;
  e.preventDefault();
  document.querySelector(href)?.scrollIntoView({ behavior: 'smooth' });
});

let resizeTimer: ReturnType<typeof setTimeout> | null = null;
window.addEventListener('resize', () => {
  if (resizeTimer != null) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    resizeTimer = null;
    if (allComments.length > 0) placeOverlaysSync();
  }, 150);
});

// ── mermaid ───────────────────────────────────────────────────────────────────

declare const mermaid: {
  initialize(opts: object): void;
  run(opts: { nodes: NodeList | HTMLElement[] }): Promise<void>;
};

// ── Boot ──────────────────────────────────────────────────────────────────────

document.title = BASE_TITLE;

// Show OAuth button only when configured
if (oauthBtn) oauthBtn.hidden = !OAUTH_ENABLED;

// Restore saved repo
const savedRepo = localStorage.getItem(REPO_KEY);
if (savedRepo) applyRepo(savedRepo);

// Wire selection handlers once
initSelectionHandlers(
  contentEl,
  handleAddComment,
  () => (activePrPath ? (validLinesByPath.get(activePrPath) ?? []) : [])
);

(async () => {
  const wasCallback = await handleOAuthCallback();
  if (wasCallback) return;

  const token = getStoredToken();
  const login = getStoredUser();
  if (token && login) {
    applyAuthState(login);
    await loadPRList();
    restoreHashedPR();
  } else {
    applyAuthState(null);
  }
})();
