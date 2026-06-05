# Auth options

Markdown PR Viewer supports three ways to authenticate with the GitHub API.

---

## Option A — Personal Access Token (PAT)  ✅ no backend required

A PAT is a long-lived GitHub token you create once and paste into the app.
The token is stored in your browser's `localStorage` and is sent directly from
your browser to `api.github.com` — it never touches any server you own.

**Who it's for:** individual use, small teams, situations where everyone can manage their own token.

### Creating a fine-grained PAT

1. Go to **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**
2. Set an expiration (90 days is reasonable).
3. Under **Repository access**, choose the repos you want to review.
4. Under **Permissions → Repository permissions**, enable:
   - **Contents** — Read-only
   - **Pull requests** — Read-only
5. Copy the token (`github_pat_…`) and paste it into the app's token field.

> Fine-grained PATs are scoped to specific repos and expire automatically,
> making them significantly safer than the legacy "classic" tokens.

**Limitation:** Every reviewer needs their own token. Not ideal for a shared team deployment where non-technical users shouldn't need to manage tokens.

---

## Option B — Cloudflare Worker proxy  ✅ ~3 min setup, free tier

GitHub's OAuth token endpoint blocks browser-direct requests (CORS). A thin proxy
worker receives the OAuth `code`, appends your `client_secret` server-side, and
returns the `access_token` to the browser.

**Who it's for:** team deployments where you want a "Sign in with GitHub" button.

### Setup

**1. Create a GitHub OAuth App**

GitHub → Settings → Developer settings → OAuth Apps → New OAuth App:

| Field | Value |
|-------|-------|
| Homepage URL | `https://YOUR-USERNAME.github.io/markdown-pr-viewer` |
| Authorization callback URL | `https://YOUR-USERNAME.github.io/markdown-pr-viewer` |

Note the **Client ID**. Generate a **Client secret** and keep it safe.

**2. Deploy the worker**

The `proxy/cloudflare/` directory ships a `wrangler.toml` (worker name + entry point),
so `wrangler deploy` works out of the box.

*Option B1 — interactive (local machine with a browser):*

```bash
cd proxy/cloudflare
npm install -g wrangler   # skip if already installed
wrangler login            # opens a browser to authorize wrangler
wrangler deploy
```

*Option B2 — non-interactive (no browser / remote / CI):*

`wrangler login` requires a browser and a copy-paste callback, which fails on
headless or remote machines. Skip it entirely by authenticating with an API token:

```bash
# Cloudflare dashboard → My Profile → API Tokens → Create Token
#   → use the "Edit Cloudflare Workers" template → copy the token
export CLOUDFLARE_API_TOKEN=<your-token>

cd proxy/cloudflare
npx wrangler deploy        # no browser, no copy-paste prompt
```

The deploy URL looks like `https://markdown-pr-viewer-proxy.YOUR-SUBDOMAIN.workers.dev`.

**3. Set the worker's secrets**

Either in the dashboard (Cloudflare → Workers → your worker → Settings → Variables):

| Variable | Value |
|----------|-------|
| `GITHUB_CLIENT_SECRET` | your OAuth App client secret |
| `ALLOWED_ORIGIN` | `https://YOUR-USERNAME.github.io/markdown-pr-viewer` |

…or non-interactively from the CLI (same `CLOUDFLARE_API_TOKEN` as above):

```bash
echo "<your-oauth-client-secret>" | npx wrangler secret put GITHUB_CLIENT_SECRET
echo "https://YOUR-USERNAME.github.io/markdown-pr-viewer" | npx wrangler secret put ALLOWED_ORIGIN
```

**4. Build the app with OAuth enabled**

```bash
OAUTH_CLIENT_ID=Iv23abc... \
OAUTH_PROXY_URL=https://markdown-pr-viewer-proxy.YOUR-SUBDOMAIN.workers.dev \
npm run build
```

The build bakes the values in. Users will see the "Sign in with GitHub" button.

**Cost:** Cloudflare Workers free tier includes 100,000 requests/day — more than enough for any team.

---

## Option C — AWS Lambda proxy  ~10 min setup

Same concept as Option B, just hosted on AWS Lambda with a Function URL.

**Who it's for:** teams already on AWS, or anyone who prefers AWS over Cloudflare.

### Setup

**1. Create a GitHub OAuth App** (same as Option B above).

**2. Create the Lambda function**

```bash
cd proxy/lambda
zip function.zip index.mjs

aws lambda create-function \
  --function-name markdown-pr-viewer-proxy \
  --runtime nodejs20.x \
  --handler index.handler \
  --zip-file fileb://function.zip \
  --role arn:aws:iam::YOUR-ACCOUNT-ID:role/YOUR-LAMBDA-ROLE
```

**3. Enable a Function URL** (public HTTPS endpoint, no API Gateway needed)

```bash
aws lambda create-function-url-config \
  --function-name markdown-pr-viewer-proxy \
  --auth-type NONE \
  --cors '{"AllowOrigins":["https://YOUR-USERNAME.github.io"],"AllowMethods":["POST","OPTIONS"],"AllowHeaders":["Content-Type"]}'
```

Note the `FunctionUrl` in the response.

**4. Set environment variables**

```bash
aws lambda update-function-configuration \
  --function-name markdown-pr-viewer-proxy \
  --environment "Variables={GITHUB_CLIENT_SECRET=YOUR_SECRET,ALLOWED_ORIGIN=https://YOUR-USERNAME.github.io/markdown-pr-viewer}"
```

**5. Build the app with OAuth enabled**

```bash
OAUTH_CLIENT_ID=Iv23abc... \
OAUTH_PROXY_URL=https://XXXXXXXXXX.lambda-url.us-east-1.on.aws \
npm run build
```

**Cost:** AWS Lambda free tier covers 1 million requests/month — effectively free for team use.

---

## Choosing between the options

| | PAT | Cloudflare Worker | AWS Lambda |
|---|---|---|---|
| Backend required | No | Yes | Yes |
| Setup time | 2 min | ~3 min | ~10 min |
| "Sign in with GitHub" button | No | Yes | Yes |
| Cost | Free | Free | Free |
| Best for | Personal / small teams | Most teams | AWS-native teams |

If you're not sure, start with a PAT. You can always add OAuth later by deploying a worker and rebuilding.
