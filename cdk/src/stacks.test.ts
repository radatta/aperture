import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { ApertureDataStack } from './lib/data-stack';
import { ApertureAppStack } from './lib/app-stack';
import { ApertureBillingStack } from './lib/billing-stack';

// Assert the synthesized CloudFormation, with asset bundling skipped so the tests are fast + offline
// (the real esbuild bundling is exercised by `cdk synth`). One app so the cross-stack refs resolve.
function templates() {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const env = { account: '111111111111', region: 'us-west-1' };
  const data = new ApertureDataStack(app, 'ApertureData-dev', {
    stage: 'dev',
    env,
    allowedOrigins: ['*'],
  });
  const appStack = new ApertureAppStack(app, 'ApertureApp-dev', {
    stage: 'dev',
    env,
    table: data.table,
    userPool: data.userPool,
    filesBucket: data.filesBucket,
    cognitoDomain: data.cognitoDomain,
    originSecret: 'test-origin-secret',
    deviceToken: 'test-device-token',
    deviceUserId: 'test-device-user',
    agentToken: 'test-agent-token',
  });
  return { data: Template.fromStack(data), app: Template.fromStack(appStack) };
}

describe('ApertureDataStack', () => {
  const { data } = templates();

  it('is an on-demand, PITR-on, RETAINed single table with GSI1', () => {
    data.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'aperture-dev',
      BillingMode: 'PAY_PER_REQUEST',
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      GlobalSecondaryIndexes: [{ IndexName: 'GSI1' }],
    });
    data.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain' });
  });

  it('is an invite-only user pool (self-signup off), retained', () => {
    data.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    });
    data.hasResource('AWS::Cognito::UserPool', { DeletionPolicy: 'Retain' });
    data.resourceCountIs('AWS::Cognito::UserPoolDomain', 1);
  });

  it('provisions a private, versioned, RETAINed files bucket with CORS for presigned PUT', () => {
    data.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      CorsConfiguration: {
        CorsRules: Match.arrayWith([Match.objectLike({ AllowedMethods: Match.arrayWith(['PUT']) })]),
      },
    });
    // The one bucket in the precious stack is never auto-deleted.
    data.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
    data.resourceCountIs('AWS::S3::Bucket', 1);
  });
});

describe('ApertureAppStack', () => {
  const { app, data } = templates();

  it('runs the BFF on Node 22 with the table + pool env wired', () => {
    app.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Timeout: 15,
      MemorySize: 512,
      Environment: { Variables: Match.objectLike({ STAGE: 'dev' }) },
    });
  });

  it('forwards the OAuth callback query params on /api/* (CloudFront strips them by default)', () => {
    app.hasResourceProperties('AWS::CloudFront::OriginRequestPolicy', {
      OriginRequestPolicyConfig: Match.objectLike({
        QueryStringsConfig: {
          QueryStringBehavior: 'whitelist', // CloudFormation's term for allowList
          QueryStrings: Match.arrayWith(['code', 'state', 'error']),
        },
      }),
    });
  });

  it('scopes the BFF SSM access to the Google parameter path', () => {
    app.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'ssm:GetParameter',
            Resource: {
              'Fn::Join': [
                '',
                Match.arrayWith([Match.stringLikeRegexp('parameter/aperture/dev/google/\\*')]),
              ],
            },
          }),
          Match.objectLike({ Action: Match.arrayWith(['ssm:PutParameter', 'ssm:DeleteParameter']) }),
        ]),
      },
    });
  });

  it('grants the BFF object-scoped access to the files bucket and wires FILES_BUCKET', () => {
    app.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ FILES_BUCKET: Match.anyValue() }) },
    });
    // PutObject/GetObject only, scoped to the u/* object prefix — no bucket-level or List permission.
    app.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: Match.arrayWith(['s3:PutObject', 's3:GetObject']) }),
        ]),
      },
    });
  });

  it('sets no APP_URL without a custom domain (CloudFront domain is a cycle-forming token)', () => {
    const fns = app.findResources('AWS::Lambda::Function');
    const bff = Object.values(fns).find((f) => f.Properties?.FunctionName === 'aperture-bff-dev');
    expect(bff?.Properties?.Environment?.Variables?.APP_URL).toBeUndefined();
  });

  it('provisions a second aperture-mcp function carrying the agent token (never on the BFF)', () => {
    const fns = app.findResources('AWS::Lambda::Function');
    const mcp = Object.values(fns).find((f) => f.Properties?.FunctionName === 'aperture-mcp-dev');
    const bff = Object.values(fns).find((f) => f.Properties?.FunctionName === 'aperture-bff-dev');
    expect(mcp?.Properties?.Environment?.Variables?.AGENT_TOKEN).toBe('test-agent-token');
    expect(mcp?.Properties?.Environment?.Variables?.DEVICE_USER_ID).toBe('test-device-user');
    expect(bff?.Properties?.Environment?.Variables?.AGENT_TOKEN).toBeUndefined();
  });

  it('gives the MCP function its own Function URL (two total) and a /mcp behavior', () => {
    app.resourceCountIs('AWS::Lambda::Url', 2);
    app.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        CacheBehaviors: Match.arrayWith([Match.objectLike({ PathPattern: '/mcp' })]),
      },
    });
  });

  it('the /mcp origin policy forwards the agent-token header (CloudFront strips anything not listed)', () => {
    app.hasResourceProperties('AWS::CloudFront::OriginRequestPolicy', {
      OriginRequestPolicyConfig: Match.objectLike({
        HeadersConfig: Match.objectLike({
          HeaderBehavior: 'whitelist',
          Headers: Match.arrayWith(['x-aperture-agent-token']),
        }),
      }),
    });
  });

  it('scopes the MCP function SSM to READ-only — only the BFF gets ssm:PutParameter', () => {
    const policies = app.findResources('AWS::IAM::Policy');
    const putCount = Object.values(policies).filter((p) => {
      const stmts = (p.Properties?.PolicyDocument?.Statement ?? []) as { Action?: unknown }[];
      return stmts.some((s) => Array.isArray(s.Action) && (s.Action as string[]).includes('ssm:PutParameter'));
    }).length;
    expect(putCount).toBe(1); // the BFF connects/disconnects Google accounts; the MCP function never writes SSM
  });

  it('fronts the Lambda with a public Function URL gated by the origin-secret header', () => {
    // Auth NONE (OAC can't sign POST bodies to a Function URL); CloudFront stamps the shared secret and
    // the handler enforces it. Assert both halves are present.
    app.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'NONE' });
    app.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        Origins: Match.arrayWith([
          Match.objectLike({
            OriginCustomHeaders: Match.arrayWith([
              Match.objectLike({
                HeaderName: 'x-aperture-origin-secret',
                HeaderValue: 'test-origin-secret',
              }),
            ]),
          }),
        ]),
      },
    });
  });

  it('keeps the site bucket fully private', () => {
    app.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('fronts everything with CloudFront + SPA fallback (403/404 → index.html)', () => {
    app.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        DefaultRootObject: 'index.html',
        CustomErrorResponses: [
          { ErrorCode: 403, ResponseCode: 200, ResponsePagePath: '/index.html' },
          { ErrorCode: 404, ResponseCode: 200, ResponsePagePath: '/index.html' },
        ],
      },
    });
    // OAC on the S3 origin only (the Function URL origin uses the secret header, not OAC).
    app.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    // /api/* must route to the Function URL behavior (leading slash — a bare `api/*` silently falls
    // through to the S3 default, which we hit once for real).
    app.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        CacheBehaviors: Match.arrayWith([Match.objectLike({ PathPattern: '/api/*' })]),
      },
    });
  });

  it('creates a secret-less SPA app client', () => {
    app.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ClientName: 'aperture-app-dev',
      GenerateSecret: false,
      AllowedOAuthFlows: ['code'],
    });
  });

  // The refresh token is the session's real ceiling — it's what the app renews with across relaunches,
  // so this is what sets how often a password gets typed. CDK emits validity in minutes. Pinned to the
  // SPA client by name so a longer-lived second client (the claude.ai one) can't mask a regression.
  it('caps the SPA refresh token at a week', () => {
    app.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ClientName: 'aperture-app-dev',
      RefreshTokenValidity: 7 * 24 * 60,
      TokenValidityUnits: Match.objectLike({ RefreshToken: 'minutes' }),
    });
  });

  // Phase 2 — the claude.ai OAuth surface.
  it('provisions the claude.ai MCP OAuth client (30-day refresh, code flow, connector callbacks)', () => {
    app.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ClientName: 'aperture-claude-dev',
      GenerateSecret: false,
      AllowedOAuthFlows: ['code'],
      RefreshTokenValidity: 30 * 24 * 60,
      CallbackURLs: Match.arrayWith(['https://claude.ai/api/mcp/auth_callback']),
    });
  });

  it('creates the MCP resource server in the app stack, NOT the precious data stack', () => {
    app.resourceCountIs('AWS::Cognito::UserPoolResourceServer', 1);
    data.resourceCountIs('AWS::Cognito::UserPoolResourceServer', 0);
  });

  it('wires the MCP function with the Cognito bearer env (pool id, client id, hosted-UI domain)', () => {
    const fns = app.findResources('AWS::Lambda::Function');
    const mcp = Object.values(fns).find((f) => f.Properties?.FunctionName === 'aperture-mcp-dev');
    const vars = mcp?.Properties?.Environment?.Variables ?? {};
    expect(vars.MCP_CLIENT_ID).toBeDefined();
    expect(vars.COGNITO_DOMAIN).toBeDefined();
    expect(vars.USER_POOL_ID).toBeDefined();
  });

  it('gives the BFF the MCP client id so it can DENY that client (D14)', () => {
    const fns = app.findResources('AWS::Lambda::Function');
    const bff = Object.values(fns).find((f) => f.Properties?.FunctionName === 'aperture-bff-dev');
    expect(bff?.Properties?.Environment?.Variables?.MCP_CLIENT_ID).toBeDefined();
  });

  it('forwards Authorization to /mcp via a zero-TTL cache policy (CDK bars it from the origin policy)', () => {
    app.hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: Match.objectLike({
        MinTTL: 0,
        MaxTTL: 1, // NOT 0 — an all-zero TTL is "caching disabled", which CloudFront won't accept with a HeaderBehavior
        DefaultTTL: 0,
        ParametersInCacheKeyAndForwardedToOrigin: Match.objectLike({
          HeadersConfig: Match.objectLike({
            HeaderBehavior: 'whitelist',
            Headers: Match.arrayWith(['authorization']),
          }),
        }),
      }),
    });
  });

  it('serves three narrowly-scoped well-known OAuth behaviors (never /.well-known/*)', () => {
    app.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            PathPattern: '/.well-known/oauth-protected-resource*',
            AllowedMethods: Match.arrayWith(['GET', 'HEAD']),
          }),
          Match.objectLike({ PathPattern: '/.well-known/oauth-authorization-server*' }),
          Match.objectLike({ PathPattern: '/.well-known/openid-configuration' }),
        ]),
      }),
    });
  });

  it('outputs the MCP client id for the claude.ai connector', () => {
    app.hasOutput('McpClientId', {});
  });
});

describe('ApertureAppStack with a custom domain (Phase 14)', () => {
  // A stage wired with a us-east-1 ACM cert ARN: CloudFront gets the alias + cert, and the app client's
  // callbacks include BOTH the custom domain and the CloudFront default (redirect_uri = location.origin).
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const env = { account: '111111111111', region: 'us-west-1' };
  const certArn = 'arn:aws:acm:us-east-1:111111111111:certificate/abcd-1234';
  const data = new ApertureDataStack(app, 'ApertureData-dev', {
    stage: 'dev',
    env,
    allowedOrigins: ['https://dev.aperture.rahuldatta.dev'],
  });
  const appStack = new ApertureAppStack(app, 'ApertureApp-dev', {
    stage: 'dev',
    env,
    table: data.table,
    userPool: data.userPool,
    filesBucket: data.filesBucket,
    cognitoDomain: data.cognitoDomain,
    originSecret: 'test-origin-secret',
    deviceToken: 'test-device-token',
    agentToken: 'test-agent-token',
    domainName: 'dev.aperture.rahuldatta.dev',
    certificateArn: certArn,
  });
  const t = Template.fromStack(appStack);

  it('aliases the distribution to the custom domain with the referenced cert', () => {
    t.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        Aliases: ['dev.aperture.rahuldatta.dev'],
        ViewerCertificate: Match.objectLike({ AcmCertificateArn: certArn }),
      },
    });
  });

  it('registers both the custom domain and the CloudFront default as OAuth callbacks', () => {
    t.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      CallbackURLs: Match.arrayWith(['https://dev.aperture.rahuldatta.dev']),
    });
  });

  it('exposes APP_URL as the custom-domain base for the OAuth redirect', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({ APP_URL: 'https://dev.aperture.rahuldatta.dev' }),
      },
    });
  });
});

describe('ApertureAppStack monitoring (prod-only, Option B)', () => {
  const build = (stage: string) => {
    const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const env = { account: '111111111111', region: 'us-west-1' };
    const data = new ApertureDataStack(app, `ApertureData-${stage}`, {
      stage,
      env,
      allowedOrigins: ['*'],
    });
    const appStack = new ApertureAppStack(app, `ApertureApp-${stage}`, {
      stage,
      env,
      table: data.table,
      userPool: data.userPool,
      filesBucket: data.filesBucket,
      cognitoDomain: data.cognitoDomain,
      originSecret: 'test-origin-secret',
      deviceToken: 'test-device-token',
      agentToken: 'test-agent-token',
    });
    return Template.fromStack(appStack);
  };

  it('adds three Lambda alarms + an SNS email topic in prod', () => {
    const t = build('prod');
    t.resourceCountIs('AWS::CloudWatch::Alarm', 3);
    t.resourceCountIs('AWS::SNS::Topic', 1);
    t.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email' });
  });

  it('adds no alarms or SNS topic in dev (prod-only)', () => {
    const t = build('dev');
    t.resourceCountIs('AWS::CloudWatch::Alarm', 0);
    t.resourceCountIs('AWS::SNS::Topic', 0);
  });
});

describe('ApertureBillingStack (hand-deployed cost guard)', () => {
  const app = new App();
  const t = Template.fromStack(new ApertureBillingStack(app, 'ApertureBilling', { env: { region: 'us-east-1' } }));

  it('has a monthly cost budget with email notifications', () => {
    t.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({ BudgetType: 'COST', TimeUnit: 'MONTHLY' }),
    });
  });

  // No CfnAnomalyMonitor: AWS auto-creates a default account-wide SERVICE monitor (one per dimension max),
  // so a second one fails with AlreadyExists. The budget is the sole cost guard here.
  it('does not create a Cost Anomaly monitor (reuses the account default)', () => {
    t.resourceCountIs('AWS::CE::AnomalyMonitor', 0);
    t.resourceCountIs('AWS::CE::AnomalySubscription', 0);
  });
});
