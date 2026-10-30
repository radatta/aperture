import { readFileSync } from 'node:fs';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { ApertureDataStack } from './lib/data-stack';
import { ApertureAppStack } from './lib/app-stack';
import { ApertureBillingStack } from './lib/billing-stack';

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

  it('gives the BFF and MCP log groups a two-week retention on dev (Lambda-created, never expired before)', () => {
    // logRetention → one Custom::LogRetention per function, setting the policy on the existing group.
    const retention = app.findResources('Custom::LogRetention');
    expect(Object.values(retention).map((r) => (r as { Properties: { RetentionInDays: number } }).Properties.RetentionInDays)).toEqual([14, 14]);
    const groupRefs = Object.values(retention).map((r) => JSON.stringify((r as { Properties: { LogGroupName: unknown } }).Properties.LogGroupName));
    expect(groupRefs.some((g) => g.includes('Bff'))).toBe(true);
    expect(groupRefs.some((g) => g.includes('Mcp'))).toBe(true);
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
    // PutObject/GetObject only, scoped to the u/* object prefix — no bucket-level or List permission.
    app.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: ['s3:GetObject', 's3:PutObject'] }), // sorted by minimizePolicies
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

  it('adds three alarms per Lambda (BFF + finance sync) on one SNS email topic in prod', () => {
    const t = build('prod');
    t.resourceCountIs('AWS::CloudWatch::Alarm', 6);
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Threshold: 295000,
      Statistic: 'Maximum',
      MetricName: 'Duration',
    });
    t.resourceCountIs('AWS::SNS::Topic', 1);
    t.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email' });
  });

  it('adds no alarms or SNS topic in dev (prod-only)', () => {
    const t = build('dev');
    t.resourceCountIs('AWS::CloudWatch::Alarm', 0);
    t.resourceCountIs('AWS::SNS::Topic', 0);
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
    expect(syncFn().props.ReservedConcurrentExecutions).toBeUndefined();
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

  it('the BFF gets Plaid env, the sync function name, token writes, and invoke on exactly that ARN', () => {
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
    const invoke = stmts.filter((st) => st.Action === 'lambda:InvokeFunction');
    expect(invoke).toHaveLength(1);
    expect(invoke[0]!.Resource).toEqual({ 'Fn::GetAtt': [syncFn().id, 'Arn'] }); // never `arn:*`
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
        expect(JSON.stringify(st.Resource).match(/parameter\/aperture\/dev\/anthropic[^"]*/g)).toEqual([
          'parameter/aperture/dev/anthropic/api_key',
        ]);
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
    expect(JSON.stringify(policiesOfRole(mcp.Role))).not.toMatch(/plaid|InvokeFunction/);
    expect(JSON.stringify(mcp.Environment)).not.toMatch(/PLAID|FINANCE_SYNC/);
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
    const schedule = Object.values(app.findResources('AWS::Scheduler::Schedule'))[0]!;
    const [groupId] = Object.keys(app.findResources('AWS::Scheduler::ScheduleGroup'));
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
    expect(trust.Condition.StringEquals['aws:SourceArn']).toEqual({ 'Fn::GetAtt': [groupId, 'Arn'] });
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
    expect(Object.values(retention).map((r) => (r as { Properties: { RetentionInDays: number } }).Properties.RetentionInDays)).toEqual([90, 90]);
  });

  it('no device user → no schedule (the sync still runs on Refresh)', () => {
    const t = build('dev');
    t.resourceCountIs('AWS::Scheduler::Schedule', 0);
    t.resourceCountIs('AWS::Scheduler::ScheduleGroup', 0);
    t.hasResourceProperties('AWS::Lambda::Function', { FunctionName: 'aperture-finance-sync-dev' });
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
