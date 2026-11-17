import { readFileSync } from 'node:fs';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { ApertureDataStack } from './lib/data-stack';
import { ApertureAppStack } from './lib/app-stack';
import { ApertureBillingStack } from './lib/billing-stack';
import { DEV_MAX_READ_UNITS, DEV_MAX_WRITE_UNITS } from './lib/data-stack';
import { allowlistPolicy, guardrailsPolicy } from './lib/org-stack';
import {
  DEV_CONCURRENCY_CEILING,
  DEV_RESERVED_CONCURRENCY,
  DEV_URL_FUNCTIONS,
  reservedConcurrency,
  slotOf,
} from './config/devAccount';
import { laneFor, synthesizerFor } from './config/lane';
import type { Lane } from './config/lane';

// cdk.json's feature flags, so a test synthesizes what `cdk synth` does (e.g. minimizePolicies merges
// IAM statements — a test app without it asserts a policy shape that never deploys).
const CDK_FLAGS = (
  JSON.parse(readFileSync(new URL('../cdk.json', import.meta.url), 'utf8')) as {
    context: Record<string, unknown>;
  }
).context;

// Assert the synthesized CloudFormation, with asset bundling skipped so the tests are fast + offline
// (the real esbuild bundling is exercised by `cdk synth`). One app so the cross-stack refs resolve.
function templates() {
  const app = new App({ context: { ...CDK_FLAGS, 'aws:cdk:bundling-stacks': [] } });
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
        CorsRules: Match.arrayWith([
          Match.objectLike({ AllowedMethods: Match.arrayWith(['PUT']) }),
        ]),
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

  // Dev, in its own account, owns its groups outright — no LogRetention provider (app-stack.ts, Two lanes).
  it('gives dev its own BFF and MCP log groups, kept two weeks and deleted with the stack', () => {
    app.resourceCountIs('Custom::LogRetention', 0);
    for (const fn of ['bff', 'mcp'])
      app.hasResource('AWS::Logs::LogGroup', {
        Properties: { LogGroupName: `/aws/lambda/aperture-${fn}-dev`, RetentionInDays: 14 },
        DeletionPolicy: 'Delete',
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
          // minimizePolicies merges the Google and Plaid paths into one statement per action set.
          Match.objectLike({
            Action: 'ssm:GetParameter',
            Resource: Match.arrayWith([
              {
                'Fn::Join': [
                  '',
                  Match.arrayWith([Match.stringLikeRegexp('parameter/aperture/dev/google/\\*')]),
                ],
              },
            ]),
          }),
          Match.objectLike({ Action: ['ssm:DeleteParameter', 'ssm:PutParameter'] }),
        ]),
      },
    });
  });

  it('grants the BFF object-scoped access to the files bucket and wires FILES_BUCKET', () => {
    app.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ FILES_BUCKET: Match.anyValue() }) },
    });
    // Put/Get/Delete only, scoped to the u/* object prefix — no bucket-level or List permission.
    app.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: ['s3:DeleteObject', 's3:GetObject', 's3:PutObject'] }), // sorted by minimizePolicies
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
      return stmts.some(
        (s) => Array.isArray(s.Action) && (s.Action as string[]).includes('ssm:PutParameter'),
      );
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
  // SPA client by name so the claude.ai client, also 30 days, can't mask a regression. Global sign-out is
  // the recovery for a leaked one (TECH §3); revocation is pinned too rather than left to Cognito's default.
  it('caps the SPA refresh token at 30 days, revocable', () => {
    app.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ClientName: 'aperture-app-dev',
      RefreshTokenValidity: 30 * 24 * 60,
      TokenValidityUnits: Match.objectLike({ RefreshToken: 'minutes' }),
      EnableTokenRevocation: true,
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
  const app = new App({ context: { ...CDK_FLAGS, 'aws:cdk:bundling-stacks': [] } });
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

  // Cognito validates Name against [\w\s+=,.@-]+ at deploy time (synth doesn't). On a domain stage the
  // identifier is a URL, so CDK's default Name (= identifier) would fail — this pins the explicit name.
  it('gives the MCP resource server a URL identifier but a Cognito-legal Name', () => {
    const rs = Object.values(t.findResources('AWS::Cognito::UserPoolResourceServer'))[0];
    expect(rs?.Properties?.Identifier).toBe('https://dev.aperture.rahuldatta.dev/mcp');
    expect(rs?.Properties?.Name).toMatch(/^[\w\s+=,.@-]+$/);
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
    const app = new App({ context: { ...CDK_FLAGS, 'aws:cdk:bundling-stacks': [] } });
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

  type AlarmProps = {
    Properties: Record<string, unknown> & { MetricName: string; Dimensions?: unknown };
  };
  const alarmsNamed = (t: Template, metricName: string) =>
    Object.entries(t.findResources('AWS::CloudWatch::Alarm') as Record<string, AlarmProps>).filter(
      ([, r]) => r.Properties.MetricName === metricName,
    );

  it('adds a duration alarm per Lambda (BFF, MCP, finance sync) and two account-wide alarms on one SNS email topic in prod', () => {
    const t = build('prod');
    t.resourceCountIs('AWS::CloudWatch::Alarm', 5);
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Threshold: 295000,
      Statistic: 'Maximum',
      MetricName: 'Duration',
    });
    // The push dispatch and the coach worker add none (no fixed monthly cost; the org's free ten are full): the
    // account-wide Errors alarm covers them.
    expect(
      Object.keys(t.findResources('AWS::CloudWatch::Alarm')).filter(
        (id) => id.includes('PushDispatch') || id.includes('CoachWorker'),
      ),
    ).toEqual([]);
    t.resourceCountIs('AWS::SNS::Topic', 1);
    t.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email' });
  });

  it("watches the MCP function's p99 duration at 80% of its 15 s timeout", () => {
    const t = build('prod');
    const [mcpFnId] = Object.keys(
      t.findResources('AWS::Lambda::Function', {
        Properties: { FunctionName: 'aperture-mcp-prod' },
      }),
    );
    expect(mcpFnId).toBeDefined();
    const durations = alarmsNamed(t, 'Duration');
    expect(durations.map(([id]) => id.replace(/[0-9A-F]{8}$/, '')).sort()).toEqual([
      'MonitoringDurationNearTimeout', // the BFF keeps its original id
      'MonitoringFinanceSyncDurationOverBudget',
      'MonitoringMcpDurationOverBudget',
    ]);
    const mcp = durations.filter(([id]) => id.startsWith('MonitoringMcpDurationOverBudget'));
    expect(mcp).toHaveLength(1);
    expect(mcp[0]?.[1].Properties).toMatchObject({
      ExtendedStatistic: 'p99',
      Threshold: 12000,
      Dimensions: [{ Name: 'FunctionName', Value: { Ref: mcpFnId } }],
    });
  });

  // Prod's five plus the dev account's five kill alarms fill CloudWatch's free ten, shared across the org — so
  // Errors and Throttles are one alarm each for the whole account, at the BFF alarm's old id so it updates in place.
  it.each(['Errors', 'Throttles'])(
    "%s: one account-wide alarm, at the BFF alarm's old id",
    (metricName) => {
      const alarms = alarmsNamed(build('prod'), metricName);
      expect(alarms).toHaveLength(1);
      const [[id = '', r] = []] = alarms;
      expect(id).toMatch(new RegExp(`^Monitoring${metricName}`));
      expect(r?.Properties).toMatchObject({
        Namespace: 'AWS/Lambda',
        Statistic: 'Sum',
        Threshold: 1,
      });
      expect(r?.Properties.Dimensions).toBeUndefined();
    },
  );

  // enforceSSL's TopicPolicy replaces SNS's default policy, so CloudWatch needs its own Allow or no alarm ever emails.
  it('lets CloudWatch alarms publish to the email topic, with the SSL-only deny kept', () => {
    const t = build('prod');
    t.resourceCountIs('AWS::SNS::TopicPolicy', 1);
    const [topicId = ''] = Object.keys(t.findResources('AWS::SNS::Topic'));
    t.hasResourceProperties('AWS::SNS::TopicPolicy', {
      Topics: [{ Ref: topicId }],
      PolicyDocument: {
        Statement: Match.arrayWith([
          // arrayWith matches in order: CDK's SSL deny is statement 0, the Allow follows it
          Match.objectLike({
            Sid: 'AllowPublishThroughSSLOnly',
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
          Match.objectLike({
            Sid: 'AllowCloudWatchAlarmsPublish',
            Effect: 'Allow',
            Principal: { Service: 'cloudwatch.amazonaws.com' },
            Action: 'sns:Publish',
            Resource: { Ref: topicId },
            Condition: {
              StringEquals: { 'aws:SourceAccount': '111111111111' },
              ArnLike: {
                'aws:SourceArn': {
                  'Fn::Join': [
                    '',
                    [
                      'arn:',
                      { Ref: 'AWS::Partition' },
                      ':cloudwatch:us-west-1:111111111111:alarm:*',
                    ],
                  ],
                },
              },
            },
          }),
        ]),
      },
    });
  });

  it('adds no alarms or SNS topic in dev (prod-only)', () => {
    const t = build('dev');
    t.resourceCountIs('AWS::CloudWatch::Alarm', 0);
    t.resourceCountIs('AWS::SNS::Topic', 0);
    t.resourceCountIs('AWS::SNS::TopicPolicy', 0);
  });
});

describe('ApertureAppStack finance sync', () => {
  const { app } = templates();
  const syncFn = () => {
    const fns = app.findResources('AWS::Lambda::Function', {
      Properties: { FunctionName: 'aperture-finance-sync-dev' },
    });
    const [id, res] = Object.entries(fns)[0]!;
    return { id, props: res.Properties as Record<string, unknown> };
  };
  const workerId = () =>
    Object.keys(
      app.findResources('AWS::Lambda::Function', {
        Properties: { FunctionName: 'aperture-coach-worker-dev' },
      }),
    )[0]!;
  // A function's Role is { Fn::GetAtt: [roleId, 'Arn'] }; a policy attaches by { Ref: roleId }.
  const policiesOfRole = (fnRole: unknown) =>
    Object.values(app.findResources('AWS::IAM::Policy'))
      .filter((p) =>
        JSON.stringify(p.Properties.Roles).includes(
          JSON.stringify({ Ref: (fnRole as { 'Fn::GetAtt': string[] })['Fn::GetAtt'][0] }),
        ),
      )
      .flatMap(
        (p) => p.Properties.PolicyDocument.Statement as { Action: unknown; Resource: unknown }[],
      );

  it('runs a third function, 300 s / 512 MB on Node 22, with no Function URL', () => {
    app.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'aperture-finance-sync-dev',
      Runtime: 'nodejs22.x',
      Timeout: 300,
      MemorySize: 512,
    });
    app.resourceCountIs('AWS::Lambda::Url', 2); // BFF + MCP only
    expect(syncFn().props.ReservedConcurrentExecutions).toBe(1); // dev's cost cap; the CAS lock serialises anyway
  });

  it('gets only the table, stage and Plaid env — no auth secrets', () => {
    const env = (syncFn().props.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(Object.keys(env).sort()).toEqual(['PLAID_ENV', 'STAGE', 'TABLE_NAME']);
    expect(env.PLAID_ENV).toBe('sandbox');
  });

  it('is never retried by Lambda, and keeps logs for 30 days', () => {
    app.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
      MaximumRetryAttempts: 0,
      MaximumEventAgeInSeconds: 60,
    });
    app.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/aws/lambda/aperture-finance-sync-dev',
      RetentionInDays: 30,
    });
  });

  it('its role gets GetItem/PutItem/Query, Plaid SSM read-only, and no invoke or S3', () => {
    const stmts = policiesOfRole(syncFn().props.Role);
    const actions = stmts.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    expect(actions.filter((a) => String(a).startsWith('dynamodb:')).sort()).toEqual([
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:Query',
    ]);
    expect(actions).toContain('ssm:GetParameter');
    for (const bad of ['ssm:PutParameter', 'ssm:DeleteParameter', 'lambda:InvokeFunction'])
      expect(actions).not.toContain(bad);
    expect(actions.some((a) => String(a).startsWith('s3:'))).toBe(false);
    expect(JSON.stringify(stmts)).toMatch(/parameter\/aperture\/dev\/plaid\/items\/\*/);
    expect(JSON.stringify(stmts)).not.toMatch(/google/);
  });

  it('the BFF gets Plaid env, the sync function name, token writes, and invoke on exactly the sync and the worker', () => {
    const bff = Object.values(
      app.findResources('AWS::Lambda::Function', {
        Properties: { FunctionName: 'aperture-bff-dev' },
      }),
    )[0]!.Properties as Record<string, unknown>;
    const env = (bff.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(env.PLAID_ENV).toBe('sandbox');
    expect(env.FINANCE_SYNC_FN).toEqual({ Ref: syncFn().id });
    const stmts = policiesOfRole(bff.Role);
    const resourcesFor = (action: string) =>
      JSON.stringify(
        stmts.filter((st) => (Array.isArray(st.Action) ? st.Action : [st.Action]).includes(action)),
      );
    for (const leaf of ['plaid/client_id', 'plaid/secret', 'plaid/items/*'])
      expect(resourcesFor('ssm:GetParameter')).toContain(`aperture/dev/${leaf}`);
    for (const action of ['ssm:PutParameter', 'ssm:DeleteParameter'])
      expect(resourcesFor(action)).toContain('aperture/dev/plaid/items/*');
    // Exactly two ARNs, never `arn:*`: the sync and the coach worker (minimizePolicies may merge their statements).
    const invoke = stmts.filter((st) => JSON.stringify(st.Action).includes('lambda:'));
    expect(
      invoke
        .flatMap((st) => st.Resource)
        .map((r) => JSON.stringify(r))
        .sort(),
    ).toEqual(
      [syncFn().id, workerId()].map((id) => JSON.stringify({ 'Fn::GetAtt': [id, 'Arn'] })).sort(),
    );
  });

  // Attachment deletes run on both functions (BFF panel + MCP delete_attachment/delete_task). A plain
  // DeleteObject on the versioned bucket leaves a 30-day noncurrent version — no version purge, no List.
  it('both functions may delete objects under u/* only, never purge versions or list', () => {
    for (const name of ['aperture-bff-dev', 'aperture-mcp-dev']) {
      const props = Object.values(
        app.findResources('AWS::Lambda::Function', { Properties: { FunctionName: name } }),
      )[0]!.Properties as Record<string, unknown>;
      const s3 = policiesOfRole(props.Role).filter((st) =>
        JSON.stringify(st.Action).includes('s3:'),
      );
      expect(s3.map((st) => st.Action)).toEqual([
        ['s3:DeleteObject', 's3:GetObject', 's3:PutObject'],
      ]);
      expect(JSON.stringify(s3[0]!.Resource)).toContain('/u/*');
    }
  });

  // Quick add: both functions read the one Anthropic key — exactly that parameter, never a wildcard.
  it('the BFF and the MCP function may read exactly the anthropic/api_key parameter', () => {
    for (const name of ['aperture-bff-dev', 'aperture-mcp-dev']) {
      const props = Object.values(
        app.findResources('AWS::Lambda::Function', { Properties: { FunctionName: name } }),
      )[0]!.Properties as Record<string, unknown>;
      const anth = policiesOfRole(props.Role).filter((st) =>
        JSON.stringify(st.Resource).includes('/anthropic'),
      );
      expect(anth.length).toBeGreaterThan(0);
      for (const st of anth) {
        expect(st.Action).toBe('ssm:GetParameter');
        expect(
          JSON.stringify(st.Resource).match(/parameter\/aperture\/dev\/anthropic[^"]*/g),
        ).toEqual(['parameter/aperture/dev/anthropic/api_key']);
      }
    }
  });

  it('the MCP function gets nothing Plaid', () => {
    const mcp = Object.values(
      app.findResources('AWS::Lambda::Function', {
        Properties: { FunctionName: 'aperture-mcp-dev' },
      }),
    )[0]!.Properties as Record<string, unknown>;
    expect(policiesOfRole(mcp.Role).length).toBeGreaterThan(0);
    expect(JSON.stringify(policiesOfRole(mcp.Role))).not.toMatch(/plaid/);
    expect(JSON.stringify(mcp.Environment)).not.toMatch(/PLAID|FINANCE_SYNC/);
    // Its one invoke grant is the coach worker's exact ARN — never the sync's.
    const invoke = policiesOfRole(mcp.Role).filter((st) =>
      JSON.stringify(st.Action).includes('lambda:'),
    );
    expect(invoke).toEqual([
      expect.objectContaining({
        Action: 'lambda:InvokeFunction',
        Resource: { 'Fn::GetAtt': [workerId(), 'Arn'] },
      }),
    ]);
  });

  it('schedules a sync 3×/day in LA time for the device user, never retried', () => {
    app.hasResourceProperties('AWS::Scheduler::Schedule', {
      Name: 'aperture-finance-sync-dev',
      ScheduleExpression: 'cron(15 5,15,20 * * ? *)',
      ScheduleExpressionTimezone: 'America/Los_Angeles',
      FlexibleTimeWindow: { Mode: 'OFF' },
      Target: Match.objectLike({
        Arn: { 'Fn::GetAtt': [syncFn().id, 'Arn'] },
        Input: Match.serializedJson({ userId: 'test-device-user', mode: 'scheduled' }),
        RetryPolicy: { MaximumRetryAttempts: 0, MaximumEventAgeInSeconds: 60 },
      }),
    });
    app.hasResourceProperties('AWS::Scheduler::ScheduleGroup', { Name: 'aperture-finance-dev' });
    const schedule = Object.values(
      app.findResources('AWS::Scheduler::Schedule', {
        Properties: { Name: 'aperture-finance-sync-dev' },
      }),
    )[0]!;
    const [groupId] = Object.keys(
      app.findResources('AWS::Scheduler::ScheduleGroup', {
        Properties: { Name: 'aperture-finance-dev' },
      }),
    );
    expect((schedule.Properties as { GroupName: unknown }).GroupName).toEqual({ Ref: groupId });
    const roleArn = (schedule.Properties as { Target: { RoleArn: unknown } }).Target.RoleArn;
    expect(policiesOfRole(roleArn)).toEqual([
      {
        Action: 'lambda:InvokeFunction',
        Effect: 'Allow',
        Resource: { 'Fn::GetAtt': [syncFn().id, 'Arn'] },
      },
    ]);
    const roleId = (roleArn as { 'Fn::GetAtt': string[] })['Fn::GetAtt'][0]!;
    const role = app.findResources('AWS::IAM::Role')[roleId]!;
    const [trust] = role.Properties.AssumeRolePolicyDocument.Statement;
    expect(trust.Principal).toEqual({ Service: 'scheduler.amazonaws.com' });
    expect(Object.keys(trust.Condition)).toEqual(['StringEquals']);
    expect(trust.Condition.StringEquals['aws:SourceAccount']).toBe('111111111111');
    // Scheduler matches SourceArn against the schedule group; a schedule ARN fails CreateSchedule.
    expect(trust.Condition.StringEquals['aws:SourceArn']).toEqual({
      'Fn::GetAtt': [groupId, 'Arn'],
    });
  });
});

describe('ApertureAppStack finance sync by stage', () => {
  const build = (stage: string, deviceUserId?: string) => {
    const app = new App({ context: { ...CDK_FLAGS, 'aws:cdk:bundling-stacks': [] } });
    const env = { account: '111111111111', region: 'us-west-1' };
    const data = new ApertureDataStack(app, `ApertureData-${stage}`, {
      stage,
      env,
      allowedOrigins: ['*'],
    });
    return Template.fromStack(
      new ApertureAppStack(app, `ApertureApp-${stage}`, {
        stage,
        env,
        table: data.table,
        userPool: data.userPool,
        filesBucket: data.filesBucket,
        cognitoDomain: data.cognitoDomain,
        originSecret: 'o',
        deviceToken: 'd',
        agentToken: 'a',
        ...(deviceUserId ? { deviceUserId } : {}),
      }),
    );
  };

  it('prod uses Plaid Production on both functions', () => {
    const t = build('prod', 'u');
    for (const name of ['aperture-bff-prod', 'aperture-finance-sync-prod'])
      t.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: name,
        Environment: { Variables: Match.objectLike({ PLAID_ENV: 'production' }) },
      });
  });

  it('prod keeps BFF and MCP logs for 90 days', () => {
    const retention = build('prod', 'u').findResources('Custom::LogRetention');
    expect(
      Object.values(retention).map(
        (r) => (r as { Properties: { RetentionInDays: number } }).Properties.RetentionInDays,
      ),
    ).toEqual([90, 90]);
  });

  it('no device user → no finance schedule (the sync still runs on Refresh)', () => {
    const t = build('dev');
    expect(
      Object.keys(
        t.findResources('AWS::Scheduler::Schedule', {
          Properties: { Name: 'aperture-finance-sync-dev' },
        }),
      ),
    ).toEqual([]);
    expect(
      Object.keys(
        t.findResources('AWS::Scheduler::ScheduleGroup', {
          Properties: { Name: 'aperture-finance-dev' },
        }),
      ),
    ).toEqual([]);
    // The reminder poller needs no device user: it ticks over the push registry.
    t.hasResourceProperties('AWS::Scheduler::Schedule', { Name: 'aperture-push-dispatch-dev' });
    t.hasResourceProperties('AWS::Lambda::Function', { FunctionName: 'aperture-finance-sync-dev' });
  });
});

describe('ApertureAppStack coach worker', () => {
  const build = (stage: string) => {
    const app = new App({ context: { ...CDK_FLAGS, 'aws:cdk:bundling-stacks': [] } });
    const env = { account: '111111111111', region: 'us-west-1' };
    const data = new ApertureDataStack(app, `ApertureData-${stage}`, {
      stage,
      env,
      allowedOrigins: ['*'],
    });
    return Template.fromStack(
      new ApertureAppStack(app, `ApertureApp-${stage}`, {
        stage,
        env,
        table: data.table,
        userPool: data.userPool,
        filesBucket: data.filesBucket,
        cognitoDomain: data.cognitoDomain,
        originSecret: 'o',
        deviceToken: 'd',
        agentToken: 'a',
      }),
    );
  };
  const dev = build('dev');
  const prod = build('prod');
  const fnOf = (t: Template, name: string) => {
    const [id, res] = Object.entries(
      t.findResources('AWS::Lambda::Function', { Properties: { FunctionName: name } }),
    )[0]!;
    return { id, props: res.Properties as Record<string, unknown> };
  };
  const statementsOf = (t: Template, fnRole: unknown) =>
    Object.values(t.findResources('AWS::IAM::Policy'))
      .filter((p) =>
        JSON.stringify(p.Properties.Roles).includes(
          JSON.stringify({ Ref: (fnRole as { 'Fn::GetAtt': string[] })['Fn::GetAtt'][0] }),
        ),
      )
      .flatMap(
        (p) => p.Properties.PolicyDocument.Statement as { Action: unknown; Resource: unknown }[],
      );
  const actionsOf = (stmts: { Action: unknown }[]) =>
    stmts.flatMap((st) => (Array.isArray(st.Action) ? st.Action : [st.Action]));
  const worker = fnOf(dev, 'aperture-coach-worker-dev');

  it('runs a fifth function, 90 s / 512 MB on Node 22, with no Function URL and only table/stage env', () => {
    dev.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'aperture-coach-worker-dev',
      Runtime: 'nodejs22.x',
      Timeout: 90,
      MemorySize: 512,
    });
    dev.resourceCountIs('AWS::Lambda::Url', 2); // BFF + MCP only
    const env = (worker.props.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(Object.keys(env).sort()).toEqual(['STAGE', 'TABLE_NAME']); // the key is read from SSM, never env
  });

  it('reserves 1 on dev (devb: the per-slot sum test); prod reserves none', () => {
    expect(worker.props.ReservedConcurrentExecutions).toBe(1);
    expect(
      fnOf(prod, 'aperture-coach-worker-prod').props.ReservedConcurrentExecutions,
    ).toBeUndefined();
  });

  it('is never retried by Lambda, drops an event after a minute, and keeps logs for 30 days', () => {
    const invoke = Object.values(dev.findResources('AWS::Lambda::EventInvokeConfig')).filter(
      (r) => JSON.stringify(r.Properties.FunctionName) === JSON.stringify({ Ref: worker.id }),
    );
    expect(invoke.map((r) => r.Properties)).toEqual([
      expect.objectContaining({ MaximumRetryAttempts: 0, MaximumEventAgeInSeconds: 60 }),
    ]);
    for (const [t, stage] of [
      [dev, 'dev'],
      [prod, 'prod'],
    ] as const)
      t.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: `/aws/lambda/aperture-coach-worker-${stage}`,
        RetentionInDays: 30,
      });
  });

  it('its role gets Get/Put/Query on the table + GSI1 and the Anthropic key only — nothing else', () => {
    const stmts = statementsOf(dev, worker.props.Role);
    const actions = actionsOf(stmts);
    expect(actions.filter((a) => String(a).startsWith('dynamodb:')).sort()).toEqual([
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:Query',
    ]);
    expect(actions.filter((a) => !String(a).startsWith('dynamodb:')).sort()).toEqual([
      'logs:CreateLogStream',
      'logs:PutLogEvents',
      'ssm:GetParameter',
    ]);
    const ddb = stmts.filter((st) => actionsOf([st]).includes('dynamodb:Query'));
    expect(JSON.stringify(ddb.map((st) => st.Resource))).toContain('/index/GSI1');
    const ssm = stmts.filter((st) => actionsOf([st]).includes('ssm:GetParameter'));
    expect(
      JSON.stringify(ssm.map((st) => st.Resource)).match(/parameter\/aperture\/[^"]*/g),
    ).toEqual(['parameter/aperture/dev/anthropic/api_key']);
    expect(JSON.stringify(stmts)).not.toMatch(/\*"|index\/\*|s3:|lambda:|plaid|google|push/);
  });

  it('its role is its own: no managed policy, so it can never re-create its log group outside the stack', () => {
    const roleId = (worker.props.Role as { 'Fn::GetAtt': string[] })['Fn::GetAtt'][0]!;
    expect(
      dev.findResources('AWS::IAM::Role')[roleId]!.Properties.ManagedPolicyArns,
    ).toBeUndefined();
    const stmts = statementsOf(dev, worker.props.Role);
    expect(actionsOf(stmts)).not.toContain('logs:CreateLogGroup');
    const groupId = Object.keys(
      dev.findResources('AWS::Logs::LogGroup', {
        Properties: { LogGroupName: '/aws/lambda/aperture-coach-worker-dev' },
      }),
    )[0]!;
    expect(
      stmts.filter((st) => actionsOf([st]).includes('logs:PutLogEvents')).map((st) => st.Resource),
    ).toEqual([{ 'Fn::GetAtt': [groupId, 'Arn'] }]);
  });

  // On both stages: the MCP function may invoke the worker alone, the BFF the worker and the sync — exact ARNs, and
  // no other lambda: action on either.
  it('the BFF and the MCP function name it and may invoke exactly its ARN (the BFF the sync too)', () => {
    const arn = (id: string) => JSON.stringify({ 'Fn::GetAtt': [id, 'Arn'] });
    for (const [t, stage] of [
      [dev, 'dev'],
      [prod, 'prod'],
    ] as const) {
      const workerId = fnOf(t, `aperture-coach-worker-${stage}`).id;
      const syncId = fnOf(t, `aperture-finance-sync-${stage}`).id;
      for (const [name, want] of [
        [`aperture-bff-${stage}`, [workerId, syncId]],
        [`aperture-mcp-${stage}`, [workerId]],
      ] as const) {
        const fn = fnOf(t, name).props;
        const env = (fn.Environment as { Variables: Record<string, unknown> }).Variables;
        expect(env.COACH_WORKER_FN).toEqual({ Ref: workerId });
        const lambdaStmts = statementsOf(t, fn.Role).filter((st) =>
          JSON.stringify(st.Action).includes('lambda:'),
        );
        expect(actionsOf(lambdaStmts).every((a) => a === 'lambda:InvokeFunction')).toBe(true);
        expect(
          lambdaStmts
            .flatMap((st) => st.Resource)
            .map((r) => JSON.stringify(r))
            .sort(),
        ).toEqual(want.map(arn).sort());
      }
    }
  });

  it('nothing schedules it', () => {
    const targets = JSON.stringify(dev.findResources('AWS::Scheduler::Schedule'));
    expect(targets).not.toContain(worker.id);
  });
});

describe('ApertureAppStack push dispatch (reminders)', () => {
  const build = (stage: string) => {
    const app = new App({ context: { ...CDK_FLAGS, 'aws:cdk:bundling-stacks': [] } });
    const env = { account: '111111111111', region: 'us-west-1' };
    const data = new ApertureDataStack(app, `ApertureData-${stage}`, {
      stage,
      env,
      allowedOrigins: ['*'],
    });
    return Template.fromStack(
      new ApertureAppStack(app, `ApertureApp-${stage}`, {
        stage,
        env,
        table: data.table,
        userPool: data.userPool,
        filesBucket: data.filesBucket,
        cognitoDomain: data.cognitoDomain,
        originSecret: 'o',
        deviceToken: 'd',
        agentToken: 'a',
      }),
    );
  };
  const dev = build('dev');
  const prod = build('prod');
  const fnOf = (t: Template, name: string) => {
    const [id, res] = Object.entries(
      t.findResources('AWS::Lambda::Function', { Properties: { FunctionName: name } }),
    )[0]!;
    return { id, props: res.Properties as Record<string, unknown> };
  };
  const statementsOf = (t: Template, fnRole: unknown) =>
    Object.values(t.findResources('AWS::IAM::Policy'))
      .filter((p) =>
        JSON.stringify(p.Properties.Roles).includes(
          JSON.stringify({ Ref: (fnRole as { 'Fn::GetAtt': string[] })['Fn::GetAtt'][0] }),
        ),
      )
      .flatMap(
        (p) => p.Properties.PolicyDocument.Statement as { Action: unknown; Resource: unknown }[],
      );
  const actionsOf = (stmts: { Action: unknown }[]) =>
    stmts.flatMap((st) => (Array.isArray(st.Action) ? st.Action : [st.Action]));
  const poller = fnOf(dev, 'aperture-push-dispatch-dev');

  it('runs a fourth function, 20 s / 256 MB on Node 22, with no Function URL and only table/stage/app env', () => {
    dev.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'aperture-push-dispatch-dev',
      Runtime: 'nodejs22.x',
      Timeout: 20,
      MemorySize: 256,
    });
    dev.resourceCountIs('AWS::Lambda::Url', 2); // BFF + MCP only
    const env = (poller.props.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(Object.keys(env).sort()).toEqual(['APP_URL', 'STAGE', 'TABLE_NAME']);
    expect(JSON.stringify(env)).not.toMatch(/vapid|ORIGIN|TOKEN/i); // the key is read from SSM, never env
  });

  it('times out well inside its one-minute rate, so two ticks never overlap', () => {
    expect(poller.props.Timeout as number).toBeLessThan(60);
  });

  it('reserves one concurrent tick on prod and on dev; prod reserves nothing else', () => {
    expect(fnOf(prod, 'aperture-push-dispatch-prod').props.ReservedConcurrentExecutions).toBe(1);
    expect(poller.props.ReservedConcurrentExecutions).toBe(1);
    for (const name of [
      'aperture-bff-prod',
      'aperture-mcp-prod',
      'aperture-finance-sync-prod',
      'aperture-coach-worker-prod',
    ])
      expect(fnOf(prod, name).props.ReservedConcurrentExecutions).toBeUndefined();
  });

  it('is never retried by Lambda, and keeps logs two weeks on dev, a month on prod', () => {
    const invoke = Object.values(dev.findResources('AWS::Lambda::EventInvokeConfig')).filter(
      (r) => JSON.stringify(r.Properties.FunctionName) === JSON.stringify({ Ref: poller.id }),
    );
    expect(invoke.map((r) => r.Properties)).toEqual([
      expect.objectContaining({ MaximumRetryAttempts: 0, MaximumEventAgeInSeconds: 60 }),
    ]);
    dev.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/aws/lambda/aperture-push-dispatch-dev',
      RetentionInDays: 14,
    });
    prod.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/aws/lambda/aperture-push-dispatch-prod',
      RetentionInDays: 30,
    });
  });

  it('its role gets Get/Put/Query/Delete on the table + GSI1 and the private key only — nothing else', () => {
    const stmts = statementsOf(dev, poller.props.Role);
    const actions = actionsOf(stmts);
    expect(actions.filter((a) => String(a).startsWith('dynamodb:')).sort()).toEqual([
      'dynamodb:DeleteItem',
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:Query',
    ]);
    expect(actions.filter((a) => !String(a).startsWith('dynamodb:')).sort()).toEqual([
      'logs:CreateLogStream',
      'logs:PutLogEvents',
      'ssm:GetParameter',
    ]);
    const ssm = stmts.filter((st) => actionsOf([st]).includes('ssm:GetParameter'));
    expect(
      JSON.stringify(ssm.map((st) => st.Resource)).match(/parameter\/aperture\/[^"]*/g),
    ).toEqual(['parameter/aperture/dev/push/vapid_private_key']);
    expect(JSON.stringify(stmts)).not.toMatch(/\*"|index\/\*|s3:|lambda:/);
  });

  it('its role is its own: no managed policy, so it can never re-create its log group outside the stack', () => {
    const roleId = (poller.props.Role as { 'Fn::GetAtt': string[] })['Fn::GetAtt'][0]!;
    const role = dev.findResources('AWS::IAM::Role')[roleId]!;
    expect(role.Properties.ManagedPolicyArns).toBeUndefined();
    expect(actionsOf(statementsOf(dev, poller.props.Role))).not.toContain('logs:CreateLogGroup');
    const logs = statementsOf(dev, poller.props.Role).filter((st) =>
      actionsOf([st]).includes('logs:PutLogEvents'),
    );
    const groupId = Object.keys(
      dev.findResources('AWS::Logs::LogGroup', {
        Properties: { LogGroupName: '/aws/lambda/aperture-push-dispatch-dev' },
      }),
    )[0]!;
    expect(logs.map((st) => st.Resource)).toEqual([{ 'Fn::GetAtt': [groupId, 'Arn'] }]); // that one group, nothing wider
  });

  it('the BFF may read the public key and never the private one; the MCP function neither', () => {
    const bff = statementsOf(dev, fnOf(dev, 'aperture-bff-dev').props.Role);
    const mcp = statementsOf(dev, fnOf(dev, 'aperture-mcp-dev').props.Role);
    expect(JSON.stringify(bff)).toContain('parameter/aperture/dev/push/vapid_public_key');
    for (const stmts of [bff, mcp]) {
      expect(JSON.stringify(stmts)).not.toContain('vapid_private_key');
      expect(JSON.stringify(stmts)).not.toMatch(/push\/\*/);
    }
    expect(JSON.stringify(mcp)).not.toContain('/push/');
  });

  it('schedules a tick every minute with no user in its input, never retried, in its own group', () => {
    dev.hasResourceProperties('AWS::Scheduler::Schedule', {
      Name: 'aperture-push-dispatch-dev',
      ScheduleExpression: 'cron(* * * * ? *)',
      FlexibleTimeWindow: { Mode: 'OFF' },
      Target: Match.objectLike({
        Arn: { 'Fn::GetAtt': [poller.id, 'Arn'] },
        Input: Match.serializedJson({ mode: 'tick' }),
        RetryPolicy: { MaximumRetryAttempts: 0, MaximumEventAgeInSeconds: 60 },
      }),
    });
    const schedule = Object.values(
      dev.findResources('AWS::Scheduler::Schedule', {
        Properties: { Name: 'aperture-push-dispatch-dev' },
      }),
    )[0]!;
    const [groupId] = Object.keys(
      dev.findResources('AWS::Scheduler::ScheduleGroup', {
        Properties: { Name: 'aperture-push-dev' },
      }),
    );
    expect((schedule.Properties as { GroupName: unknown }).GroupName).toEqual({ Ref: groupId });
    const roleArn = (schedule.Properties as { Target: { RoleArn: unknown } }).Target.RoleArn;
    expect(statementsOf(dev, roleArn)).toEqual([
      {
        Action: 'lambda:InvokeFunction',
        Effect: 'Allow',
        Resource: { 'Fn::GetAtt': [poller.id, 'Arn'] },
      },
    ]);
    const roleId = (roleArn as { 'Fn::GetAtt': string[] })['Fn::GetAtt'][0]!;
    const [trust] =
      dev.findResources('AWS::IAM::Role')[roleId]!.Properties.AssumeRolePolicyDocument.Statement;
    expect(trust.Principal).toEqual({ Service: 'scheduler.amazonaws.com' });
    expect(trust.Condition.StringEquals['aws:SourceAccount']).toBe('111111111111');
    expect(trust.Condition.StringEquals['aws:SourceArn']).toEqual({
      'Fn::GetAtt': [groupId, 'Arn'],
    });
  });
});

describe('dev stacks in the dev account, under its SCPs (org-stack.ts)', () => {
  // deviceUserId: CI sets it on dev (the schedule, its group and role exist there) and leaves it unset on devb.
  const build = (
    stage: string,
    lane: Lane = '',
    deviceUserId: string | undefined = 'u',
    domain = true,
  ) => {
    const app = new App({ context: { ...CDK_FLAGS, 'aws:cdk:bundling-stacks': [] } });
    const env = { account: '111111111111', region: 'us-west-1' };
    const synth = () => (lane ? { synthesizer: synthesizerFor(lane) } : {});
    const data = new ApertureDataStack(app, `ApertureData-${stage}`, {
      stage,
      env,
      allowedOrigins: ['*'],
      ...synth(),
    });
    const appStack = new ApertureAppStack(app, `ApertureApp-${stage}`, {
      stage,
      env,
      ...synth(),
      table: data.table,
      userPool: data.userPool,
      filesBucket: data.filesBucket,
      cognitoDomain: data.cognitoDomain,
      originSecret: 'o',
      deviceToken: 'd',
      agentToken: 'a',
      deviceUserId,
      ...(domain
        ? {
            domainName: `${stage}.example.com`,
            certificateArn: 'arn:aws:acm:us-east-1:111111111111:certificate/test',
          }
        : {}),
    });
    const assembly = app.synth();
    return {
      artifacts: [data, appStack].map((st) => assembly.getStackByName(st.stackName)),
      templates: [Template.fromStack(data), Template.fromStack(appStack)],
    };
  };
  const dev = build('dev');
  const devb = build('devb', '', undefined);
  const devbFirst = build('devb', '', undefined, false); // devb's first create: no cert yet, so no domain
  // both dev slots — and devb as first created — for the SCP mirrors
  const devSlots = () => [...dev.templates, ...devb.templates, ...devbFirst.templates];
  const prod = build('prod');
  const resources = (ts: Template[]) =>
    ts.flatMap((t) =>
      Object.values(
        t.toJSON().Resources as Record<
          string,
          { Type: string; Properties?: Record<string, unknown> }
        >,
      ),
    );

  it("deploys both stages through their own account's stock bootstrap", () => {
    for (const a of [...dev.artifacts, ...devb.artifacts, ...prod.artifacts]) {
      expect(a.assumeRoleArn).toContain('role/cdk-hnb659fds-deploy-role-');
      expect(a.bootstrapStackVersionSsmParameter).toBe('/cdk-bootstrap/hnb659fds/version');
    }
  });

  // Both dev slots: the freeze keeps a ceiling only if the table was created with one, so devb must be born capped.
  it.each([
    ['dev', dev],
    ['devb', devb],
  ])("caps %s's table and GSI1 on-demand throughput, and leaves prod uncapped", (_, slot) => {
    const cap = {
      MaxReadRequestUnits: DEV_MAX_READ_UNITS,
      MaxWriteRequestUnits: DEV_MAX_WRITE_UNITS,
    };
    const [devTable] = resources(slot.templates).filter((r) => r.Type === 'AWS::DynamoDB::Table');
    expect(devTable?.Properties?.OnDemandThroughput).toEqual(cap);
    expect(
      (devTable?.Properties?.GlobalSecondaryIndexes as { OnDemandThroughput?: unknown }[])[0]
        ?.OnDemandThroughput,
    ).toEqual(cap);
    expect(JSON.stringify(resources(prod.templates))).not.toContain('OnDemandThroughput');
  });

  // Every stage expires on `expiresAt`: the dev slots' tombstones, and (prod's only stamped rows) a LeetCode
  // sitting's raw bulk. Which rows carry it is the Lambda's rule (writes.ts, backend lcSittingEvents).
  it('expires on expiresAt on every stage', () => {
    for (const stage of [dev, devb, prod]) {
      const [table] = resources(stage.templates).filter((r) => r.Type === 'AWS::DynamoDB::Table');
      expect(table?.Properties?.TimeToLiveSpecification).toEqual({
        AttributeName: 'expiresAt',
        Enabled: true,
      });
    }
  });

  it('creates devb with the on-demand ceiling and TTL a dev slot needs', () => {
    const [table] = resources(devb.templates).filter((r) => r.Type === 'AWS::DynamoDB::Table');
    expect(table?.Properties?.OnDemandThroughput).toEqual({
      MaxReadRequestUnits: DEV_MAX_READ_UNITS,
      MaxWriteRequestUnits: DEV_MAX_WRITE_UNITS,
    });
    expect(table?.Properties?.TimeToLiveSpecification).toEqual({
      AttributeName: 'expiresAt',
      Enabled: true,
    });
    expect(table?.Properties?.TableName).toBe('aperture-devb');
  });

  // Slot B is slot A renamed: the same functions (finance-sync too — only its schedule needs DEVICE_USER_ID), so the
  // kill's lists and the reservations cover it the same way.
  it('gives devb the same functions as dev, renamed to -devb', () => {
    const names = (t: Template[]) =>
      resources(t)
        .filter((r) => r.Type === 'AWS::Lambda::Function')
        .map((r) => r.Properties?.FunctionName)
        .filter((n): n is string => typeof n === 'string')
        .sort();
    const devNames = names(dev.templates);
    expect(devNames).toEqual([
      'aperture-bff-dev',
      'aperture-coach-worker-dev',
      'aperture-finance-sync-dev',
      'aperture-mcp-dev',
      'aperture-push-dispatch-dev',
    ]);
    expect(names(devb.templates)).toEqual(devNames.map((n) => n.replace(/-dev$/, '-devb')));
  });

  // Dev's compute cap is the sum of its functions' reservations, not the account quota (CI-BOT.md → What's capped):
  // it holds only if every dev function has one. reservedConcurrency fails synth for a name with no entry, but only
  // where a construct calls it, so this is the guarantee: every deployed dev function (all named — the unnamed-
  // function test below) carries exactly its table value, and the table names nothing that isn't deployed.
  it("reserves each dev function's own share, summing to the slot's ceiling", () => {
    const fns = resources(devSlots()).filter((x) => x.Type === 'AWS::Lambda::Function');
    const deployed = Object.fromEntries(
      fns.map((r) => [
        r.Properties?.FunctionName as string,
        r.Properties?.ReservedConcurrentExecutions,
      ]),
    );
    expect(deployed).toStrictEqual(DEV_RESERVED_CONCURRENCY); // strict: a function with no reservation fails
    // The ceiling is per slot (the maintainer, 2026-11-08): each dev stack's functions sum to it, whatever the slots number.
    const perSlot: Record<string, number> = {};
    for (const [fn, n] of Object.entries(DEV_RESERVED_CONCURRENCY))
      perSlot[slotOf(fn)] = (perSlot[slotOf(fn)] ?? 0) + n;
    expect(Object.keys(perSlot).sort()).toEqual(['dev', 'devb']);
    for (const sum of Object.values(perSlot)) expect(sum).toBe(DEV_CONCURRENCY_CEILING);
    for (const fn of DEV_URL_FUNCTIONS) expect(DEV_RESERVED_CONCURRENCY[fn]).toBeGreaterThan(0);
  });

  it('fails synth for a dev function with no reservation on record', () => {
    expect(() => reservedConcurrency('dev', 'aperture-new-dev')).toThrow(/no reserved concurrency/);
    expect(() => reservedConcurrency('devc', 'aperture-bff-devc')).toThrow(
      /no reserved concurrency/,
    ); // a stage that isn't a dev slot
    expect(reservedConcurrency('prod', 'aperture-bff-prod')).toEqual({});
  });

  // The guardrails SCP denies provisioned concurrency (an Alias or Version's), event-source mappings and destinations
  // to the dev account; a template that sets one fails to deploy there.
  // The SCP mirrors below read both dev slots' templates: a resource only devb carries must fail here, not at its deploy.
  it('asks for no provisioned concurrency, event-source mapping or destination — the guardrails SCP denies them', () => {
    const all = resources(devSlots());
    const types = all.map((r) => r.Type);
    for (const t of [
      'AWS::Lambda::EventSourceMapping',
      'AWS::Lambda::Alias',
      'AWS::Lambda::Version',
    ])
      expect(types).not.toContain(t);
    for (const r of all.filter((x) => x.Type === 'AWS::Lambda::EventInvokeConfig'))
      expect(r.Properties?.DestinationConfig).toBeUndefined();
  });

  // The kill switch locks DEV_URL_FUNCTIONS' URLs; a URL on any other function would stay open through a kill.
  it.each([
    ['dev', dev],
    ['devb', devb],
  ])(
    'gives %s a public Function URL only on the functions the kill switch locks',
    (stage, slot) => {
      const t = slot.templates[1]!.toJSON().Resources as Record<
        string,
        { Type: string; Properties: Record<string, unknown> }
      >;
      const fnName = (ref: unknown) => {
        const id =
          (ref as { 'Fn::GetAtt'?: [string] })['Fn::GetAtt']?.[0] ??
          (ref as { Ref?: string }).Ref ??
          '';
        return t[id]?.Properties.FunctionName;
      };
      const urls = Object.values(t)
        .filter((r) => r.Type === 'AWS::Lambda::Url')
        .map((r) => fnName(r.Properties.TargetFunctionArn));
      expect(urls.sort()).toEqual(DEV_URL_FUNCTIONS.filter((f) => f.endsWith(`-${stage}`)).sort());
    },
  );

  it("locks both slots' URLs in a kill", () => {
    expect([...DEV_URL_FUNCTIONS].sort()).toEqual([
      'aperture-bff-dev',
      'aperture-bff-devb',
      'aperture-mcp-dev',
      'aperture-mcp-devb',
    ]);
  });

  // The standing guardrails deny these creates for good; a template that needs one can never deploy into dev.
  it('creates no resource type the standing guardrails deny', () => {
    const deniedBy: Record<string, string> = {
      'AWS::KMS::Key': 'kms:CreateKey',
      'AWS::Lambda::EventSourceMapping': 'lambda:CreateEventSourceMapping',
      'AWS::IAM::User': 'iam:CreateUser',
      'AWS::IAM::AccessKey': 'iam:CreateAccessKey',
      'AWS::IAM::OIDCProvider': 'iam:*OpenIDConnectProvider*',
      'AWS::DynamoDB::GlobalTable': 'dynamodb:CreateGlobalTable',
      'AWS::Logs::SubscriptionFilter': 'logs:PutSubscriptionFilter',
      'AWS::Logs::MetricFilter': 'logs:PutMetricFilter',
      'AWS::Logs::ResourcePolicy': 'logs:PutResourcePolicy',
      'AWS::CloudFront::RealtimeLogConfig': 'cloudfront:CreateRealtimeLogConfig',
      'AWS::CloudFront::MonitoringSubscription': 'cloudfront:CreateMonitoringSubscription',
    };
    const standing = JSON.stringify(guardrailsPolicy());
    for (const [type, action] of Object.entries(deniedBy))
      expect(standing, `${type} → ${action}`).toContain(action);
    const types = new Set(resources(devSlots()).map((r) => r.Type));
    for (const type of Object.keys(deniedBy))
      expect(types.has(type), `${type}: the guardrails SCP denies it in dev`).toBe(false);
  });

  it('uses only services the dev allowlist SCP admits — a new one means widening it in ApertureOrg first', () => {
    const allowed = (allowlistPolicy().Statement[0] as { NotAction: string[] }).NotAction;
    // The allowlist entry each resource type's service needs (SSM is admitted for Parameter Store only).
    const entry: Record<string, string> = {
      Lambda: 'lambda:*',
      IAM: 'iam:*',
      Logs: 'logs:*',
      S3: 's3:*',
      CloudFront: 'cloudfront:*',
      Cognito: 'cognito-idp:*',
      DynamoDB: 'dynamodb:*',
      Scheduler: 'scheduler:*',
      SSM: 'ssm:*Parameter*',
      KMS: 'kms:*',
    };
    for (const type of new Set(resources(devSlots()).map((r) => r.Type))) {
      if (type.startsWith('Custom::') || type === 'AWS::CDK::Metadata') continue; // CDK providers run as Lambdas
      const needed = entry[type.split('::')[1] ?? ''];
      expect(needed, `${type}: map its service, then check the allowlist`).toBeDefined();
      expect(allowed, `${type}: add ${needed} to the allowlist SCP`).toContain(needed);
    }
  });

  // The freeze denies new code in CDK's 15-minute provider functions by the `Aperture…` name CloudFormation gives an
  // unnamed function (`<stack>-<logicalId>-<suffix>`); the app's own functions must stay outside that pattern.
  // The two lanes publish to different buckets, so a CDK provider's code location would change on every lane switch,
  // and the freeze denies the bot lane new code in one (FrozenProviderCode). Dev carries none; prod keeps its two.
  it('gives the dev slots no CDK provider function, so a lane switch never touches frozen provider code', () => {
    const unnamed = (ts: Template[]) =>
      resources(ts).filter(
        (r) => r.Type === 'AWS::Lambda::Function' && r.Properties?.FunctionName === undefined,
      );
    expect(unnamed(devSlots())).toEqual([]);
    expect(resources(devSlots()).filter((r) => r.Type.startsWith('Custom::'))).toEqual([]);
    expect(unnamed(prod.templates)).toHaveLength(2); // LogRetention and S3 auto-delete
  });

  it("names functions so the freeze's provider-code deny would catch a CDK provider and none of the app's", () => {
    const fns = resources([...devSlots(), ...prod.templates]).filter(
      (r) => r.Type === 'AWS::Lambda::Function',
    );
    for (const f of fns) {
      const name = f.Properties?.FunctionName as string | undefined;
      if (name !== undefined)
        expect(name, 'a named function must not start with Aperture').toMatch(/^aperture-/);
    }
    for (const a of [...dev.artifacts, ...devb.artifacts]) expect(a.stackName).toMatch(/^Aperture/); // so an unnamed function's name does
  });

  // Main's own dev deploy (config/lane.ts, docs/ops/CI-BOT.md → Two lanes).
  describe('deploy lanes', () => {
    const main = build('dev', 'devmain');
    const strip = (t: Template) => {
      const j = structuredClone(t.toJSON()) as { Parameters?: Record<string, unknown> };
      delete j.Parameters?.BootstrapVersion;
      return j;
    };

    it("deploys main's lane through the devmain bootstrap's deploy and exec roles, checking its version", () => {
      for (const a of main.artifacts) {
        expect(a.assumeRoleArn).toContain('cdk-devmain-deploy-role-');
        expect(a.cloudFormationExecutionRoleArn).toContain('cdk-devmain-cfn-exec-role-');
        expect(a.lookupRole?.arn).toContain('cdk-devmain-lookup-role-');
        expect(a.bootstrapStackVersionSsmParameter).toBe('/cdk-bootstrap/devmain/version');
      }
    });

    // The bot lane can write the stock bucket; main's lane must deploy only what it uploaded itself.
    it("publishes to devmain's own bucket, never the stock one", () => {
      const buckets = resources(main.templates)
        .filter((r) => r.Type === 'AWS::Lambda::Function')
        .map((r) => JSON.stringify((r.Properties?.Code as { S3Bucket: unknown }).S3Bucket));
      expect(buckets).toHaveLength(5);
      for (const b of buckets) expect(b).toContain('cdk-devmain-assets-');
      for (const a of main.artifacts) expect(JSON.stringify(a.assets)).not.toContain('hnb659fds');
    });

    it("differs from the frozen lane's templates only in the bootstrap version parameter and the asset bucket", () => {
      const same = (t: Template) =>
        JSON.parse(
          JSON.stringify(strip(t)).replaceAll('cdk-devmain-assets-', 'cdk-hnb659fds-assets-'),
        );
      main.templates.forEach((t, i) =>
        expect(same(t)).toEqual(strip(dev.templates[i] as Template)),
      );
      expect(JSON.stringify(main.templates[0]?.toJSON().Parameters)).toContain(
        '/cdk-bootstrap/devmain/version',
      );
    });

    it('takes a lane only for dev, and only a known one', () => {
      expect(laneFor('dev', '')).toBe('');
      expect(laneFor('dev', ' devmain ')).toBe('devmain');
      expect(laneFor('devb', 'devmain')).toBe('devmain');
      expect(laneFor('prod', '')).toBe('');
      expect(() => laneFor('dev', 'bogus')).toThrow(/APERTURE_DEPLOY_LANE/);
      expect(() => laneFor('prod', 'devmain')).toThrow(/dev-only/);
    });
  });
});

describe('ApertureBillingStack (hand-deployed cost guard)', () => {
  const app = new App();
  const t = Template.fromStack(
    new ApertureBillingStack(app, 'ApertureBilling', { env: { region: 'us-east-1' } }),
  );

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
