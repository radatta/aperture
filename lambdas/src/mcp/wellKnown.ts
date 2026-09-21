// The OAuth metadata FAÇADE for claude.ai custom connectors (phase 2). Pure builders, ZERO outbound
// calls — Cognito's endpoint shapes are formulaic, so the whole document is constructed from env and is
// fully testable offline. Its one job: publish correct OAuth metadata from OUR origin so claude.ai's
// PKCE flow succeeds, while Cognito stays the real authorization server for the login/token exchange.
//
// Two facts drive the shapes:
//  - `issuer` MUST equal the URL the client derived the metadata from — i.e. OUR origin, not Cognito's
//    (RFC 8414 §3.3). The client never validates the JWT itself, so it never sees the issuer mismatch.
//  - Cognito's own openid-configuration omits `code_challenge_methods_supported` (confirmed null live);
//    per the MCP auth spec a client MUST refuse PKCE when that field is absent. The façade injects it.

export interface WellKnownEnv {
  appUrl: string; // our origin, e.g. https://dev.aperture.rahuldatta.dev — the issuer and resource base
  cognitoDomain: string; // hosted-UI host only, e.g. aperture-dev-<acct>.auth.us-west-1.amazoncognito.com
  userPoolId: string; // e.g. us-west-1_abc123 — the region prefix drives the jwks_uri
}

// The scopes both advertised here and configured on the Cognito claude client. The resource-server
// access scope's identifier is `<appUrl>/mcp` (matches the CDK resource server), so its full name is
// `<appUrl>/mcp/access`.
function scopesFor(appUrl: string): string[] {
  return ['openid', 'email', `${appUrl}/mcp/access`];
}

// RFC 9728 protected-resource metadata — points the client at us as the resource and at our origin as
// the authorization server (which our authorizationServer() doc then describes).
export function protectedResource(env: WellKnownEnv) {
  return {
    resource: `${env.appUrl}/mcp`,
    authorization_servers: [env.appUrl],
    bearer_methods_supported: ['header'],
    scopes_supported: scopesFor(env.appUrl),
  };
}

// RFC 8414 authorization-server metadata — issuer is OUR origin; the actual endpoints point at Cognito.
// NO registration_endpoint (we don't do DCR — the client id is pasted into the connector's settings).
export function authorizationServer(env: WellKnownEnv) {
  const region = env.userPoolId.split('_')[0]; // Cognito pool ids are `<region>_<id>`
  return {
    issuer: env.appUrl,
    authorization_endpoint: `https://${env.cognitoDomain}/oauth2/authorize`,
    token_endpoint: `https://${env.cognitoDomain}/oauth2/token`,
    jwks_uri: `https://cognito-idp.${region}.amazonaws.com/${env.userPoolId}/.well-known/jwks.json`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'], // THE fix — the field Cognito omits
    scopes_supported: scopesFor(env.appUrl),
  };
}

// Route a GET path to which façade doc (or null). Serves both RFC 9728 path forms — the root and the
// resource-path-suffixed `/mcp` variant claude.ai probes first — plus the OIDC discovery alias some
// clients try before the OAuth one.
export function matchWellKnown(path: string): 'prm' | 'as' | null {
  if (path.startsWith('/.well-known/oauth-protected-resource')) return 'prm';
  if (path.startsWith('/.well-known/oauth-authorization-server')) return 'as';
  if (path === '/.well-known/openid-configuration') return 'as';
  return null;
}
