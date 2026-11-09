import { describe, expect, it } from 'vitest';
import { authorizationServer, matchWellKnown, protectedResource } from './wellKnown';

const env = {
  appUrl: 'https://dev.aperture.rahuldatta.dev',
  cognitoDomain: 'aperture-dev-123.auth.us-west-1.amazoncognito.com',
  userPoolId: 'us-west-1_ABC123',
};
const scopes = ['openid', 'email', 'https://dev.aperture.rahuldatta.dev/mcp/access'];

describe('wellKnown façade builders', () => {
  it('protected-resource metadata points at us as the resource + our origin as the AS', () => {
    expect(protectedResource(env)).toEqual({
      resource: 'https://dev.aperture.rahuldatta.dev/mcp',
      authorization_servers: ['https://dev.aperture.rahuldatta.dev'],
      bearer_methods_supported: ['header'],
      scopes_supported: scopes,
    });
  });

  it('authorization-server metadata: issuer is OUR origin, endpoints are Cognito, PKCE injected', () => {
    expect(authorizationServer(env)).toEqual({
      issuer: 'https://dev.aperture.rahuldatta.dev',
      authorization_endpoint:
        'https://aperture-dev-123.auth.us-west-1.amazoncognito.com/oauth2/authorize',
      token_endpoint: 'https://aperture-dev-123.auth.us-west-1.amazoncognito.com/oauth2/token',
      jwks_uri:
        'https://cognito-idp.us-west-1.amazonaws.com/us-west-1_ABC123/.well-known/jwks.json',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: scopes,
    });
  });

  it('issuer is our origin, NOT Cognito (RFC 8414 §3.3 — the client checks issuer vs metadata URL)', () => {
    expect(authorizationServer(env).issuer).toBe(env.appUrl);
    expect(authorizationServer(env).issuer).not.toContain('cognito');
  });

  it('code_challenge_methods_supported is exactly ["S256"] — the field Cognito omits', () => {
    expect(authorizationServer(env).code_challenge_methods_supported).toEqual(['S256']);
  });

  it('advertises NO registration_endpoint (no DCR — the client id is pasted)', () => {
    expect(authorizationServer(env)).not.toHaveProperty('registration_endpoint');
  });

  it('derives the jwks region from the pool id prefix', () => {
    expect(authorizationServer({ ...env, userPoolId: 'eu-central-1_XYZ' }).jwks_uri).toBe(
      'https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_XYZ/.well-known/jwks.json',
    );
  });
});

describe('matchWellKnown', () => {
  it('routes both RFC 9728 path forms to the protected-resource doc', () => {
    expect(matchWellKnown('/.well-known/oauth-protected-resource')).toBe('prm');
    expect(matchWellKnown('/.well-known/oauth-protected-resource/mcp')).toBe('prm');
  });

  it('routes the AS + OIDC discovery aliases to the authorization-server doc', () => {
    expect(matchWellKnown('/.well-known/oauth-authorization-server')).toBe('as');
    expect(matchWellKnown('/.well-known/oauth-authorization-server/mcp')).toBe('as');
    expect(matchWellKnown('/.well-known/openid-configuration')).toBe('as');
  });

  it('does not match /mcp itself or unrelated well-known paths', () => {
    expect(matchWellKnown('/mcp')).toBeNull();
    expect(matchWellKnown('/.well-known/other')).toBeNull();
    expect(matchWellKnown('/')).toBeNull();
  });
});
