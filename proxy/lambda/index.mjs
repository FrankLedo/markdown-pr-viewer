/**
 * AWS Lambda — GitHub OAuth token exchange proxy.
 *
 * Env vars (set via the deploy script or manually in Lambda console):
 *   GITHUB_CLIENT_SECRET  Your GitHub OAuth App client secret
 *   ALLOWED_ORIGIN        The URL of your hosted app, e.g. https://you.github.io/markdown-pr-viewer
 *
 * Deploy:  see proxy/README.md
 */

export const handler = async (event) => {
  const origin = event.headers?.origin ?? event.headers?.Origin ?? '';
  const allowedOrigin = process.env.ALLOWED_ORIGIN ?? '*';

  const corsHeaders = {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.requestContext?.http?.method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  let body;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'invalid_request', error_description: 'Expected JSON body' }),
    };
  }

  const { client_id, code, redirect_uri, code_verifier } = body;
  if (!client_id || !code) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'invalid_request', error_description: 'Missing client_id or code' }),
    };
  }

  const ghRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri,
      code_verifier,
    }),
  });

  const data = await ghRes.json();
  return {
    statusCode: ghRes.ok ? 200 : ghRes.status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  };
};
