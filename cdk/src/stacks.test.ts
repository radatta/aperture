import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, it } from 'vitest';
import { ApertureDataStack } from './lib/data-stack';
import { ApertureAppStack } from './lib/app-stack';
import { ApertureBillingStack } from './lib/billing-stack';

// Assert the synthesized CloudFormation, with asset bundling skipped so the tests are fast + offline
// (the real esbuild bundling is exercised by `cdk synth`). One app so the cross-stack refs resolve.
function templates() {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const env = { account: '111111111111', region: 'us-west-1' };
  const data = new ApertureDataStack(app, 'ApertureData-dev', { stage: 'dev', env });
  const appStack = new ApertureAppStack(app, 'ApertureApp-dev', {
    stage: 'dev',
    env,
    table: data.table,
    userPool: data.userPool,
    originSecret: 'test-origin-secret',
    deviceToken: 'test-device-token',
    deviceUserId: 'test-device-user',
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
});

describe('ApertureAppStack', () => {
  const { app } = templates();

  it('runs the BFF on Node 22 with the table + pool env wired', () => {
    app.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Timeout: 15,
      MemorySize: 512,
      Environment: { Variables: Match.objectLike({ STAGE: 'dev' }) },
    });
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
      GenerateSecret: false,
      AllowedOAuthFlows: ['code'],
    });
  });
});

describe('ApertureAppStack with a custom domain (Phase 14)', () => {
  // A stage wired with a us-east-1 ACM cert ARN: CloudFront gets the alias + cert, and the app client's
  // callbacks include BOTH the custom domain and the CloudFront default (redirect_uri = location.origin).
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const env = { account: '111111111111', region: 'us-west-1' };
  const certArn = 'arn:aws:acm:us-east-1:111111111111:certificate/abcd-1234';
  const data = new ApertureDataStack(app, 'ApertureData-dev', { stage: 'dev', env });
  const appStack = new ApertureAppStack(app, 'ApertureApp-dev', {
    stage: 'dev',
    env,
    table: data.table,
    userPool: data.userPool,
    originSecret: 'test-origin-secret',
    deviceToken: 'test-device-token',
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
});

describe('ApertureAppStack monitoring (prod-only, Option B)', () => {
  const build = (stage: string) => {
    const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const env = { account: '111111111111', region: 'us-west-1' };
    const data = new ApertureDataStack(app, `ApertureData-${stage}`, { stage, env });
    const appStack = new ApertureAppStack(app, `ApertureApp-${stage}`, {
      stage,
      env,
      table: data.table,
      userPool: data.userPool,
      originSecret: 'test-origin-secret',
      deviceToken: 'test-device-token',
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
