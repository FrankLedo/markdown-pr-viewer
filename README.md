# Markdown PR Viewer

A browser-based tool for reviewing GitHub pull requests that contain markdown files — with rendered previews and inline comments, no VS Code required.

Built for teams that do design docs, RFCs, or runbooks in markdown and review them through GitHub PRs.

---

## Features

- **Rendered markdown** — tables, code blocks, mermaid diagrams, front matter
- **Inline GitHub comments** — threads appear as bubbles anchored to the relevant line, click to expand
- **Thread navigation** — jump between unresolved threads with keyboard or nav strip
- **Code block collapse** — toggle long code blocks out of the way while reading
- **Diagram zoom** — click any mermaid diagram to view it full-screen
- **Three auth options** — PAT (no backend), Cloudflare Worker, or AWS Lambda
- **Works with any public or private repo** — just enter `owner/repo`

---

## Quick start

```bash
git clone https://github.com/YOUR-USERNAME/markdown-pr-viewer
cd markdown-pr-viewer
npm install
npm run dev          # opens http://localhost:8080
```

Then:

1. Enter a repo in the header (`owner/repo`)
2. Paste a GitHub token in the token field and click **Connect**
3. Pick an open PR from the dropdown

> Need a token? [Create a fine-grained PAT](https://github.com/settings/tokens/new?description=markdown-pr-viewer)
> with **Contents: Read-only** and **Pull requests: Read and write** on the target repo.
> (Use **Pull requests: Read-only** if you only want to *view* comments — posting,
> replying, and resolving all require write access.)

---

## Auth options

| | Setup | Notes |
|---|---|---|
| **PAT (token)** | 2 min | No backend. Token stays in your browser. |
| **Cloudflare Worker** | ~3 min | Enables "Sign in with GitHub" button. Free. |
| **AWS Lambda** | ~10 min | Same as above, AWS-hosted. Free tier. |

PAT is the simplest option and works well for personal use or small teams. See
[`proxy/README.md`](proxy/README.md) for full instructions on all three options.

---

## Deploy to GitHub Pages

```bash
# 1. Build (PAT-only mode — no backend needed)
npm run build

# 2. Copy dist/ and static assets to your gh-pages branch
#    (or use the gh-pages npm package)
npx gh-pages -d . --dotfiles \
  -x "node_modules" -x ".git" -x "proxy"
```

The app is entirely static — no server needed for PAT auth.

**For OAuth ("Sign in with GitHub"), build with your proxy URL baked in:**

```bash
OAUTH_CLIENT_ID=Iv23abc... \
OAUTH_PROXY_URL=https://your-worker.workers.dev \
npm run build
```

See [`proxy/README.md`](proxy/README.md) for the worker setup.

---

## Development

```
npm run dev      # esbuild watch + local server on :8080
npm run build    # production build to dist/
```

All source is in TypeScript. Entry point is `app.ts`; overlay/thread logic is in `webview/`.

### Environment variables (build-time)

| Variable | Default | Effect |
|---|---|---|
| `OAUTH_CLIENT_ID` | `""` | If set, enables the OAuth sign-in button |
| `OAUTH_PROXY_URL` | `""` | Required when `OAUTH_CLIENT_ID` is set |

Both are baked into the bundle at build time via esbuild `define`. Leaving them
empty produces a PAT-only build with no backend dependency.

---

## How it works

GitHub's REST API returns markdown files as raw text. This app:

1. Fetches the file content for the PR's head commit
2. Renders it with [markdown-it](https://github.com/markdown-it/markdown-it) (locally, no CDN)
3. Fetches all PR review comments and maps each to the rendered line via `data-line` attributes
4. Places comment bubbles anchored to the nearest block element at or above the comment's line

With a write-scoped token you can **post new comments, reply to threads, and resolve/unresolve conversations** directly from the viewer — changes are written straight to GitHub via the REST and GraphQL APIs. With a read-only token the comments render but posting is disabled.

---

## Contributing

Issues and PRs welcome. A few conventions:

- No CDN dependencies — all scripts are bundled or self-hosted in `dist/`
- No `innerHTML` with user-derived content — use `createElement` + `textContent`
- No new backend dependencies for the default (PAT) path

---

## Related

- [markdown-pr-review](https://github.com/YOUR-USERNAME/markdown-pr-review) — the VS Code extension this was adapted from
