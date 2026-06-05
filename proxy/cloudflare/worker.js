/**
 * Cloudflare Worker — GitHub OAuth token exchange proxy.
 *
 * Env vars (set in Cloudflare dashboard → Workers → Settings → Variables):
 *   GITHUB_CLIENT_SECRET  Your GitHub OAuth App client secret
 *   ALLOWED_ORIGIN        The URL of your hosted app, e.g. https://you.github.io/markdown-pr-viewer
 *
 * Deploy:
 *   npx wrangler deploy
 */

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') ?? '';
    const corsHeaders = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN ?? '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: 'invalid_request', error_description: 'Expected JSON body' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const { client_id, code, redirect_uri, code_verifier } = body;
    if (!client_id || !code) {
      return new Response(JSON.stringify({ error: 'invalid_request', error_description: 'Missing client_id or code' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const ghRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri,
        code_verifier,
      }),
    });

    const data = await ghRes.json();
    return Response.json(data, { headers: corsHeaders });
  },
};
