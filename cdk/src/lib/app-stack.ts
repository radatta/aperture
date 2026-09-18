import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, RemovalPolicy, Stack, Validations } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import { AUTH_HEADER, ORIGIN_SECRET_HEADER } from '@aperture/shared';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import { Monitoring } from './monitoring';

export interface AppStackProps extends StackProps {
  stage: string;
  table: dynamodb.Table;
  userPool: cognito.UserPool;
  filesBucket: s3.IBucket; // precious user-uploads bucket from the data stack (attachments live here)
  originSecret: string; // CloudFront→Lambda origin-lockdown token (anti-abuse; JWT is the real gate)
  domainName?: string; // custom-domain alias for CloudFront (Phase 14). Unset → CloudFront default domain only.
  certificateArn?: string; // us-east-1 ACM cert ARN for domainName; required whenever domainName is set.
  deviceToken: string; // device-token auth for the extension's ingest endpoint (same class as originSecret)
  deviceUserId?: string; // Cognito sub device-token writes attribute to; unset → handler 'local' fallback
}

const LAMBDA_ENTRY = fileURLToPath(new URL('../../../lambdas/src/index.ts', import.meta.url));

// The REPLACEABLE stack (INFRA §3/§4/§7): Lambda BFF + Function URL, S3 + CloudFront. Redeploys freely;
// nothing precious lives here. CloudFront OAC keeps the S3 bucket private. The Lambda Function URL is
// public (auth NONE — CloudFront OAC can't SigV4-sign POST bodies to a Function URL), locked down instead
// by a shared secret header CloudFront stamps on every origin request; the handler rejects requests
// without it. Defense-in-depth only — the Cognito JWT the handler validates is the real auth gate.
export class ApertureAppStack extends Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    const { stage, table, userPool, filesBucket, originSecret, domainName, certificateArn, deviceToken, deviceUserId } =
      props;
    // Custom domain (Phase 14): reference an EXISTING us-east-1 ACM cert by ARN — CDK never creates it,
    // so deploys never touch DNS/certs. Absent until the domain step is done → CloudFront default domain.
    const certificate =
      domainName && certificateArn
        ? acm.Certificate.fromCertificateArn(this, 'SiteCert', certificateArn)
        : undefined;

    // BFF Lambda — esbuild-bundled TS, Node 22, no warming (cold starts are fine at single-user).
    const fnTimeout = Duration.seconds(15); // shared with the Monitoring duration alarm below
    const fn = new NodejsFunction(this, 'Bff', {
      functionName: `aperture-bff-${stage}`,
      entry: LAMBDA_ENTRY,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: fnTimeout,
      memorySize: 512,
      environment: {
        TABLE_NAME: table.tableName,
        FILES_BUCKET: filesBucket.bucketName,
        USER_POOL_ID: userPool.userPoolId,
        STAGE: stage,
        ORIGIN_SECRET: originSecret, // must match the header CloudFront stamps below
        DEVICE_TOKEN: deviceToken, // extension ingest auth (resolveDeviceUserId), scoped to recordLeetcodeAttempt
        ...(deviceUserId ? { DEVICE_USER_ID: deviceUserId } : {}),
        // Google OAuth redirect/return base. Only a static custom-domain URL — the CloudFront domain is a
        // token that would create a Lambda→distribution→FunctionURL→Lambda cycle. Unset without a domain.
        ...(domainName ? { APP_URL: `https://${domainName}` } : {}),
      },
      bundling: { format: OutputFormat.ESM, minify: true, externalModules: ['@aws-sdk/*'] }, // v3 SDK is in the runtime
    });
    table.grantReadWriteData(fn);

    // Google Calendar SSM access, path-scoped: READ client creds + per-account refresh tokens under
    // /aperture/<stage>/google/*; WRITE (+ delete) only the per-account tokens under .../tokens/* (the
    // connect/disconnect path). The <sub> segment is dynamic, so the token path needs a trailing wildcard.
    const ssmBase = `arn:${Stack.of(this).partition}:ssm:${Stack.of(this).region}:${Stack.of(this).account}:parameter/aperture/${stage}/google`;
    fn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [`${ssmBase}/*`] }),
    );
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:PutParameter', 'ssm:DeleteParameter'],
        resources: [`${ssmBase}/tokens/*`],
      }),
    );
    // Attachments: object-level read/write under the per-user `u/` prefix ONLY (never bucket-level list or
    // config). A presigned URL acts with this function's permissions, so this is also the ceiling on what a
    // leaked URL can touch. Explicit statement rather than grantRead/grantPut — those add s3:List*/GetBucket*.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject', 's3:GetObject'],
        resources: [filesBucket.arnForObjects('u/*')],
      }),
    );
    // cdk-nag granular IAM suppressions (IAM4: the standard CloudWatch Logs managed exec policy; IAM5:
    // grantReadWriteData's index/* wildcard, which the single-table GSI query needs — the table is scoped).
    // WORKAROUND for an open cdk-nag v3 bug (cdklabs/cdk-nag#2359/#2351): `Validations.of(x).acknowledge()`
    // splits the rule id on `::` and rejects the granular finding ids, which embed ARNs containing `::`.
    // Until that's fixed upstream, write the acknowledgment metadata cdk-nag itself reads (isAcknowledged)
    // directly. The ids must match synth's "Acknowledge with '...'" hint verbatim; the IAM5 id embeds the
    // cross-stack table export (hence `ApertureData-${stage}` + the table's logical-id hash) — if the data
    // stack's table construct id changes, synth re-flags IAM5 and this must be updated. Revisit when #2359
    // lands a real fix. See docs/arch/CICD_HARDENING.md #2.
    fn.node.addMetadata(Validations.ACKNOWLEDGED_RULES_METADATA_KEY, {
      'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]':
        'AWSLambdaBasicExecutionRole is the standard CloudWatch Logs managed policy for the BFF.',
      [`AwsSolutions-IAM5[Resource::ApertureData-${stage}:ExportsOutputFnGetAttTableCD117FA1ArnE2C8C204/index/*]`]:
        'grantReadWriteData needs index/* to query the single-table GSI; the table itself is scoped.',
      // Google Calendar SSM access is path-scoped to /aperture/<stage>/google/*; the per-account <sub>
      // segment is dynamic, so a trailing wildcard is unavoidable. Region resolves per-stack; partition
      // + account render as pseudo-tokens (must match synth's "Acknowledge with '...'" hint verbatim).
      [`AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:ssm:${Stack.of(this).region}:<AWS::AccountId>:parameter/aperture/${stage}/google/*]`]:
        'The BFF reads Google client creds + per-account refresh tokens under /aperture/<stage>/google/*; the <sub> segment is dynamic, so the read is path-scoped with a wildcard.',
      [`AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:ssm:${Stack.of(this).region}:<AWS::AccountId>:parameter/aperture/${stage}/google/tokens/*]`]:
        'Per-account refresh tokens are written/deleted at connect/disconnect under .../google/tokens/<sub>; the dynamic <sub> requires the trailing wildcard.',
      // The attachments grant is object-scoped to the per-user `u/` prefix; the `/*` is over object keys
      // within that prefix (one user's files), never bucket-level. Same brittleness as the table id above:
      // if the data stack's Files bucket construct id changes, synth re-flags this and the hash must be
      // updated from the "Acknowledge with '...'" hint.
      [`AwsSolutions-IAM5[Resource::ApertureData-${stage}:ExportsOutputFnGetAttFiles8E6940B8ArnD8EE6C03/u/*]`]:
        'Attachments need object read/write under the per-user u/ prefix; the bucket itself is not granted.',
    });
    // Public Function URL (auth NONE) — the origin-secret header, not IAM, is what gates it (see class doc).
    const fnUrl = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

    // Private site bucket — assets are synced post-build (not by CDK), so infra ≠ app deploy.
    const bucket = new s3.Bucket(this, 'Site', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true, // deny non-TLS requests (adds the aws:SecureTransport bucket policy)
      removalPolicy: RemovalPolicy.DESTROY, // just built assets — re-syncable
      autoDeleteObjects: true,
    });

    // /api/* forwards ONLY the custom auth header + content-type — never Authorization (OAC owns it).
    const apiOrp = new cloudfront.OriginRequestPolicy(this, 'ApiOriginPolicy', {
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(AUTH_HEADER, 'content-type'),
      // Forward the OAuth callback params — without this CloudFront strips the query string on /api/*,
      // and /api/google/callback arrives with no code/state (invisible locally, breaks connect on deploy).
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.allowList('code', 'state', 'error'),
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
    });

    const distribution = new cloudfront.Distribution(this, 'Cdn', {
      defaultRootObject: 'index.html',
      ...(certificate && domainName ? { domainNames: [domainName], certificate } : {}),
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      additionalBehaviors: {
        '/api/*': {
          // No OAC: CloudFront stamps the origin-secret header (always overwrites any viewer-sent value)
          // so only requests through this distribution reach the Lambda.
          origin: new origins.FunctionUrlOrigin(fnUrl, {
            customHeaders: { [ORIGIN_SECRET_HEADER]: originSecret },
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL, // POST for RPC
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED, // data is network-only (TECH §1)
          originRequestPolicy: apiOrp,
        },
      },
      // SPA fallback: client-side routes 403/404 from S3 → serve index.html (INFRA §7).
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: Duration.seconds(0),
        },
      ],
    });

    // SPA app client (PKCE, no secret). redirect_uri is window.location.origin (AuthProvider), so EVERY
    // origin the app can be served from must be a registered callback: the custom domain (when set) AND
    // the CloudFront default (still directly reachable). appUrl — the CfnOutput / CI's canonical URL — is
    // the custom domain when present, else CloudFront.
    const cfUrl = `https://${distribution.distributionDomainName}`;
    const appUrl = domainName ? `https://${domainName}` : cfUrl;
    const oauthUrls = domainName ? [appUrl, cfUrl] : [cfUrl];
    const client = new cognito.UserPoolClient(this, 'AppClient', {
      userPool,
      userPoolClientName: `aperture-app-${stage}`,
      generateSecret: false,
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
      // The refresh token is what carries the session across app relaunches, so it — not the access
      // token — sets how often you actually retype a password. Cognito allows up to 3650 days, but the
      // token sits in browser localStorage, so the ceiling is deliberately short: a week caps how long
      // a leaked one stays useful, at the cost of a weekly sign-in. Access/ID stay at the 1-hour
      // default — they cross the network on every request and are cheap to renew.
      refreshTokenValidity: Duration.days(7),
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: oauthUrls,
        logoutUrls: oauthUrls,
      },
    });
    // NB: the Lambda deliberately does NOT take the client id — verifying against the pool is enough
    // for a single-client pool, and consuming it here would form a client→CloudFront→Lambda→client cycle.

    new CfnOutput(this, 'AppUrl', { value: appUrl }); // custom domain if set, else CloudFront; also the API base (/api/* same origin)
    new CfnOutput(this, 'CloudFrontDomain', { value: distribution.distributionDomainName }); // alias-CNAME target for the custom domain
    new CfnOutput(this, 'SiteBucket', { value: bucket.bucketName });
    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new CfnOutput(this, 'UserPoolClientId', { value: client.userPoolClientId });
    // Direct Function URL — the post-deploy synthetic check hits this to prove the origin-secret gate
    // rejects a headerless request (through CloudFront the viewer can't set/unset that header).
    new CfnOutput(this, 'FunctionUrl', { value: fnUrl.url });

    // Runtime watch on the BFF, prod only (see monitoring.ts). Option B: Lambda alarms only — CloudFront
    // 5xx is deliberately not alarmed (its metrics live only in us-east-1; a cross-region topic isn't
    // worth it, and the synthetic check already proves the edge wiring at deploy time).
    if (stage === 'prod') new Monitoring(this, 'Monitoring', { fn, timeout: fnTimeout });
  }
}
