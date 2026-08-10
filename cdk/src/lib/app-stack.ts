import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, RemovalPolicy, Stack, Validations } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import { AUTH_HEADER, ORIGIN_SECRET_HEADER } from '@aperture/shared';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import { Monitoring } from './monitoring';

export interface AppStackProps extends StackProps {
  stage: string;
  table: dynamodb.Table;
  userPool: cognito.UserPool;
  originSecret: string; // CloudFront→Lambda origin-lockdown token (anti-abuse; JWT is the real gate)
  domainName?: string; // custom-domain alias for CloudFront (Phase 14). Unset → CloudFront default domain only.
  certificateArn?: string; // us-east-1 ACM cert ARN for domainName; required whenever domainName is set.
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
    const { stage, table, userPool, originSecret, domainName, certificateArn } = props;
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
        USER_POOL_ID: userPool.userPoolId,
        STAGE: stage,
        ORIGIN_SECRET: originSecret, // must match the header CloudFront stamps below
      },
      bundling: { format: OutputFormat.ESM, minify: true, externalModules: ['@aws-sdk/*'] }, // v3 SDK is in the runtime
    });
    table.grantReadWriteData(fn);
    // cdk-nag granular IAM suppressions (IAM4: the standard CloudWatch Logs managed exec policy; IAM5:
    // grantReadWriteData's index/* wildcard, which the single-table GSI query needs — the table is scoped).
    // WORKAROUND for an open cdk-nag v3 bug (cdklabs/cdk-nag#2359/#2351): `Validations.of(x).acknowledge()`
    // splits the rule id on `::` and rejects the granular finding ids, which embed ARNs containing `::`.
    // Until that's fixed upstream, write the acknowledgment metadata cdk-nag itself reads (isAcknowledged)
    // directly. The ids must match synth's "Acknowledge with '...'" hint verbatim; the IAM5 id embeds the
    // cross-stack table export (hence `ApertureData-${stage}` + the table's logical-id hash) — if the data
    // stack's table construct id changes, synth re-flags IAM5 and this must be updated. Revisit when #2359
    // lands a real fix. See docs/CICD_HARDENING.md #2.
    fn.node.addMetadata(Validations.ACKNOWLEDGED_RULES_METADATA_KEY, {
      'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]':
        'AWSLambdaBasicExecutionRole is the standard CloudWatch Logs managed policy for the BFF.',
      [`AwsSolutions-IAM5[Resource::ApertureData-${stage}:ExportsOutputFnGetAttTableCD117FA1ArnE2C8C204/index/*]`]:
        'grantReadWriteData needs index/* to query the single-table GSI; the table itself is scoped.',
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
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.none(),
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
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.seconds(0) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.seconds(0) },
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
