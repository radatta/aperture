import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, RemovalPolicy, Stack, Validations } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import { AGENT_TOKEN_HEADER, AUTH_HEADER, ORIGIN_SECRET_HEADER } from '@aperture/shared';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import { FINANCE_SYNC_TIMEOUT, FinanceSync } from './finance-sync';
import { Monitoring } from './monitoring';
import { CLAUDE_CONNECTOR_CALLBACK_URLS } from '../config/claudeConnector';

export interface AppStackProps extends StackProps {
  stage: string;
  table: dynamodb.Table;
  userPool: cognito.UserPool;
  filesBucket: s3.IBucket; // precious user-uploads bucket from the data stack (attachments live here)
  cognitoDomain: string; // hosted-UI host from the data stack — the MCP OAuth façade's /oauth2 base (phase 2)
  originSecret: string; // CloudFront→Lambda origin-lockdown token (anti-abuse; JWT is the real gate)
  domainName?: string; // custom-domain alias for CloudFront (Phase 14). Unset → CloudFront default domain only.
  certificateArn?: string; // us-east-1 ACM cert ARN for domainName; required whenever domainName is set.
  deviceToken: string; // device-token auth for the extension's ingest endpoint (same class as originSecret)
  deviceUserId?: string; // Cognito sub device-token writes attribute to; unset → handler 'local' fallback
  agentToken: string; // static agent-token auth for the MCP server (Claude Code); same class as deviceToken
}

const LAMBDA_ENTRY = fileURLToPath(new URL('../../../lambdas/src/index.ts', import.meta.url));
const MCP_ENTRY = fileURLToPath(new URL('../../../lambdas/src/mcp/index.ts', import.meta.url));

// cdk-nag granular IAM acks, written as the raw metadata cdk-nag reads (isAcknowledged) — the workaround
// for cdk-nag v3 bug cdklabs/cdk-nag#2359/#2351; see #2 in docs/arch/CICD_HARDENING.md. Rules: ids MUST
// match synth's "Acknowledge with '...'" hint verbatim; the IAM5 ids embed the cross-stack table/bucket
// exports (their logical-id hashes), so if the data stack's Table/Files construct ids change, synth re-flags
// and these must be updated from the hint. Both the BFF and the MCP function carry the SAME per-resource
// ids (the id embeds the resource, not the function), so one helper serves both; only the token-WRITE ack
// differs — the BFF connects/disconnects Google accounts, the MCP function never writes SSM. Reason text
// is free; only the id (the key) must match.
function ackLambdaIam(fn: NodejsFunction, stage: string, region: string, opts: { ssmWrite: boolean; plaid?: boolean }): void {
  const acks: Record<string, string> = {
    'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]':
      'AWSLambdaBasicExecutionRole is the standard CloudWatch Logs managed policy.',
    [`AwsSolutions-IAM5[Resource::ApertureData-${stage}:ExportsOutputFnGetAttTableCD117FA1ArnE2C8C204/index/*]`]:
      'grantReadWriteData needs index/* to query the single-table GSI; the table itself is scoped.',
    [`AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:ssm:${region}:<AWS::AccountId>:parameter/aperture/${stage}/google/*]`]:
      'Reads Google client creds + per-account refresh tokens under /aperture/<stage>/google/*; the dynamic <sub> segment needs a path-scoped wildcard.',
    [`AwsSolutions-IAM5[Resource::ApertureData-${stage}:ExportsOutputFnGetAttFiles8E6940B8ArnD8EE6C03/u/*]`]:
      'Attachments need object read/write under the per-user u/ prefix; the bucket itself is not granted.',
  };
  if (opts.ssmWrite) {
    acks[
      `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:ssm:${region}:<AWS::AccountId>:parameter/aperture/${stage}/google/tokens/*]`
    ] =
      'Per-account refresh tokens are written/deleted at connect/disconnect under .../google/tokens/<sub>; the dynamic <sub> requires the trailing wildcard.';
  }
  if (opts.plaid) {
    acks[
      `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:ssm:${region}:<AWS::AccountId>:parameter/aperture/${stage}/plaid/items/*]`
    ] =
      'Per-item Plaid access tokens are written at link and deleted at remove under .../plaid/items/<itemId>; the dynamic <itemId> needs the trailing wildcard.';
  }
  fn.node.addMetadata(Validations.ACKNOWLEDGED_RULES_METADATA_KEY, acks);
}

// The DynamoDB + SSM(read) + S3(object) grants shared by the BFF and the MCP function. The MCP function
// deliberately gets the READ ssm grant only (no PutParameter/DeleteParameter): it never connects or
// disconnects a Google account (that's the browser-only OAuth callback), so a write grant would be dead
// permission. This is the ceiling on what the agent token can reach — DynamoDB + calendar events + the
// user's own attachments — plus the Claude API key for parse_task (granted at the call site below).
function grantBackendData(
  fn: NodejsFunction,
  table: dynamodb.Table,
  filesBucket: s3.IBucket,
  ssmBase: string,
  opts: { ssmWrite: boolean },
): void {
  table.grantReadWriteData(fn);
  fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [`${ssmBase}/*`] }));
  if (opts.ssmWrite) {
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:PutParameter', 'ssm:DeleteParameter'],
        resources: [`${ssmBase}/tokens/*`],
      }),
    );
  }
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      // Delete: attachment bytes go when the attachment or its task does (s3/objects.ts). A plain delete
      // on the versioned bucket leaves a 30-day noncurrent version, so no DeleteObjectVersion.
      actions: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject'],
      resources: [filesBucket.arnForObjects('u/*')],
    }),
  );
}

// The REPLACEABLE stack (INFRA §3/§4/§7): Lambda BFF + Function URL, S3 + CloudFront. Redeploys freely;
// nothing precious lives here. CloudFront OAC keeps the S3 bucket private. The Lambda Function URL is
// public (auth NONE — CloudFront OAC can't SigV4-sign POST bodies to a Function URL), locked down instead
// by a shared secret header CloudFront stamps on every origin request; the handler rejects requests
// without it. Defense-in-depth only — the Cognito JWT the handler validates is the real auth gate.
export class ApertureAppStack extends Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    const { stage, table, userPool, filesBucket, cognitoDomain, originSecret, domainName, certificateArn, deviceToken, deviceUserId, agentToken } =
      props;
    // Custom domain (Phase 14): reference an EXISTING us-east-1 ACM cert by ARN — CDK never creates it,
    // so deploys never touch DNS/certs. Absent until the domain step is done → CloudFront default domain.
    const certificate =
      domainName && certificateArn
        ? acm.Certificate.fromCertificateArn(this, 'SiteCert', certificateArn)
        : undefined;

    // claude.ai MCP OAuth client + its resource server (phase 2). Declared HERE — ahead of both Lambdas —
    // because their env carries MCP_CLIENT_ID (the MCP fn BINDS its verifier to it; the BFF DENIES it, D14).
    // It has NO CloudFront dependency: callbacks are committed constants and the resource identifier is
    // gated on domainName (a literal), not the distribution domain (a token) — so a Lambda referencing the
    // client id forms no deploy cycle. The identifier matches what the /mcp façade computes from APP_URL.
    const mcpResourceIdentifier = domainName ? `https://${domainName}/mcp` : `aperture-mcp-${stage}`;
    const mcpScope = new cognito.ResourceServerScope({ scopeName: 'access', scopeDescription: 'Full MCP access (act as the user)' });
    const mcpResourceServer = new cognito.UserPoolResourceServer(this, 'McpResourceServer', {
      userPool,
      // Explicit name: CDK defaults Name to the identifier, but Name must match [\w\s+=,.@-]+ (no `:` or
      // `/`), so a URL identifier fails at deploy time. The identifier itself may be a URL.
      userPoolResourceServerName: `aperture-mcp-${stage}`,
      identifier: mcpResourceIdentifier,
      scopes: [mcpScope],
    });
    const claudeClient = new cognito.UserPoolClient(this, 'ClaudeClient', {
      userPool,
      userPoolClientName: `aperture-claude-${stage}`,
      generateSecret: false,
      authFlows: {}, // none requested → Cognito's defaults (refresh/SRP/custom); claude.ai only uses the hosted-UI code flow
      preventUserExistenceErrors: true,
      // 30 days (D13, docs/areas/mcp/index.md): this refresh token lives in claude.ai's server-side store,
      // so the SPA client's 7-day localStorage reasoning doesn't apply.
      refreshTokenValidity: Duration.days(30),
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.resourceServer(mcpResourceServer, mcpScope)],
        callbackUrls: CLAUDE_CONNECTOR_CALLBACK_URLS,
      },
    });

    // Plaid (docs/areas/finances): Production on prod, Sandbox elsewhere. Credentials are SSM
    // SecureStrings the operator writes once; item tokens are written by the BFF at link.
    const plaidEnv = stage === 'prod' ? 'production' : 'sandbox';
    const plaidSsmBase = `arn:${Stack.of(this).partition}:ssm:${Stack.of(this).region}:${Stack.of(this).account}:parameter/aperture/${stage}/plaid`;
    // Quick add's Claude API key (docs/areas/tasks/quick-add.md): one SecureString the operator writes
    // once. Both functions read exactly this parameter — the BFF for the app, the MCP function for
    // Raycast's parse_task. Absent → every parse returns "unavailable" and the line saves raw.
    const anthropicKeyArn = `arn:${Stack.of(this).partition}:ssm:${Stack.of(this).region}:${Stack.of(this).account}:parameter/aperture/${stage}/anthropic/api_key`;
    // The finance sync Lambda — declared before the BFF, whose env names it (no reverse edge, no cycle).
    const financeSync = new FinanceSync(this, 'FinanceSync', {
      stage,
      table,
      plaidEnv,
      plaidSsmBase,
      deviceUserId,
    });

    // BFF Lambda — esbuild-bundled TS, Node 22, no warming (cold starts are fine at single-user).
    const fnTimeout = Duration.seconds(15); // shared with the Monitoring duration alarm below
    // Log retention for the BFF + MCP groups, which Lambda created on first invoke and which never expired.
    // `logRetention` (deprecated, still supported in this aws-cdk-lib) sets it through a custom resource that
    // tolerates the existing group; `logGroup` would try to CREATE it and fail (AlreadyExists), and the
    // useCdkManagedLogGroup flag says the same. Moving to `logGroup` needs a `cdk import` — a follow-up.
    // finance-sync owns its group already (30 d, finance-sync.ts).
    // Dev, in its own account since dev-account, has no pre-existing groups, so it owns them outright and carries no
    // CDK provider function at all: the dev account's two deploy lanes publish to different asset buckets, so a
    // provider's code location would change on every lane switch, and the freeze denies the bot lane new code on
    // CDK's providers (org-stack.ts → FrozenProviderCode; docs/ops/CI-BOT.md → Two lanes).
    const ownGroup = (id: string, fnName: string) =>
      new logs.LogGroup(this, id, {
        logGroupName: `/aws/lambda/${fnName}`,
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: RemovalPolicy.DESTROY,
      });
    const logging = (id: string, fnName: string) =>
      stage === 'prod'
        ? { logRetention: logs.RetentionDays.THREE_MONTHS }
        : { logGroup: ownGroup(id, fnName) };
    const fn = new NodejsFunction(this, 'Bff', {
      functionName: `aperture-bff-${stage}`,
      entry: LAMBDA_ENTRY,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: fnTimeout,
      memorySize: 512,
      ...logging('BffLogs', `aperture-bff-${stage}`),
      environment: {
        TABLE_NAME: table.tableName,
        FILES_BUCKET: filesBucket.bucketName,
        USER_POOL_ID: userPool.userPoolId,
        MCP_CLIENT_ID: claudeClient.userPoolClientId, // D14: the BFF verifier DENIES tokens from this client
        STAGE: stage,
        ORIGIN_SECRET: originSecret, // must match the header CloudFront stamps below
        DEVICE_TOKEN: deviceToken, // extension ingest auth (resolveDeviceUserId), scoped to recordLeetcodeAttempt
        ...(deviceUserId ? { DEVICE_USER_ID: deviceUserId } : {}),
        PLAID_ENV: plaidEnv,
        FINANCE_SYNC_FN: financeSync.fn.functionName, // async-invoked after Refresh / connect / reconnect
        // Google OAuth redirect/return base. Only a static custom-domain URL — the CloudFront domain is a
        // token that would create a Lambda→distribution→FunctionURL→Lambda cycle. Unset without a domain.
        ...(domainName ? { APP_URL: `https://${domainName}` } : {}),
      },
      bundling: { format: OutputFormat.ESM, minify: true, externalModules: ['@aws-sdk/*'] }, // v3 SDK is in the runtime
    });
    // DynamoDB + Google-SSM(read+write) + S3(object) grants and their cdk-nag acks (see the helpers). The
    // BFF gets the SSM write grant (it connects/disconnects Google accounts via the browser callback).
    const ssmBase = `arn:${Stack.of(this).partition}:ssm:${Stack.of(this).region}:${Stack.of(this).account}:parameter/aperture/${stage}/google`;
    grantBackendData(fn, table, filesBucket, ssmBase, { ssmWrite: true });
    // Plaid: the BFF only (never the MCP function) — read creds + tokens, write/delete item tokens at
    // link/remove, and invoke the sync function (its exact ARN, not `:*`).
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          `${plaidSsmBase}/client_id`,
          `${plaidSsmBase}/secret`,
          `${plaidSsmBase}/items/*`,
        ],
      }),
    );
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:PutParameter', 'ssm:DeleteParameter'],
        resources: [`${plaidSsmBase}/items/*`],
      }),
    );
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [financeSync.fn.functionArn],
      }),
    );
    fn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [anthropicKeyArn] }),
    );
    ackLambdaIam(fn, stage, Stack.of(this).region, { ssmWrite: true, plaid: true });

    // Public Function URL (auth NONE) — the origin-secret header, not IAM, is what gates it (see class doc).
    const fnUrl = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

    // MCP server Lambda (aperture-mcp-<stage>) — a SECOND function so the agent token's blast radius is
    // this function's IAM (full parity with the BFF: DynamoDB + calendar events + the user's attachments,
    // but SSM read-only — the agent never connects/disconnects an account). Same bundling as the BFF.
    const mcpFn = new NodejsFunction(this, 'Mcp', {
      functionName: `aperture-mcp-${stage}`,
      entry: MCP_ENTRY,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: fnTimeout,
      memorySize: 512,
      ...logging('McpLogs', `aperture-mcp-${stage}`),
      environment: {
        TABLE_NAME: table.tableName,
        FILES_BUCKET: filesBucket.bucketName,
        STAGE: stage,
        ORIGIN_SECRET: originSecret,
        AGENT_TOKEN: agentToken, // static agent-token auth (resolveAgentUserId), any method
        // Phase 2 (claude.ai): the Cognito bearer path + the OAuth metadata façade. The façade only serves
        // when APP_URL is set (a stage with a custom domain), so on a domain-less stage /mcp stays agent-only.
        USER_POOL_ID: userPool.userPoolId,
        MCP_CLIENT_ID: claudeClient.userPoolClientId, // the bearer verifier binds to this claude client
        COGNITO_DOMAIN: cognitoDomain, // the façade's /oauth2 authorize+token base
        ...(deviceUserId ? { DEVICE_USER_ID: deviceUserId } : {}), // same Cognito sub the ingest writes attribute to
        ...(domainName ? { APP_URL: `https://${domainName}` } : {}),
      },
      bundling: { format: OutputFormat.ESM, minify: true, externalModules: ['@aws-sdk/*'] },
    });
    grantBackendData(mcpFn, table, filesBucket, ssmBase, { ssmWrite: false });
    mcpFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [anthropicKeyArn] }),
    );
    ackLambdaIam(mcpFn, stage, Stack.of(this).region, { ssmWrite: false });
    const mcpUrl = mcpFn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
    // The logRetention custom resource's singleton provider (one per stack, shared by both functions): its role
    // carries the basic-execution managed policy + Put/DeleteRetentionPolicy on `*` (CDK's own grant). The
    // construct id is CDK's fixed singleton id; ack ids copied from synth's hint, like ackLambdaIam.
    const retentionProvider = Stack.of(this).node.tryFindChild('LogRetentionaae0aa3c5b4d4f87b02d85b201efdd8a');
    retentionProvider?.node.tryFindChild('ServiceRole')?.node.addMetadata(Validations.ACKNOWLEDGED_RULES_METADATA_KEY, {
      'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]':
        'CDK-managed logRetention provider; AWSLambdaBasicExecutionRole is the standard CloudWatch Logs managed policy.',
      'AwsSolutions-IAM5[Resource::*]':
        'CDK-managed logRetention provider: PutRetentionPolicy/DeleteRetentionPolicy are granted on * by CDK itself.',
    });

    // Private site bucket — assets are synced post-build (not by CDK), so infra ≠ app deploy.
    const bucket = new s3.Bucket(this, 'Site', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true, // deny non-TLS requests (adds the aws:SecureTransport bucket policy)
      removalPolicy: RemovalPolicy.DESTROY, // just built assets — re-syncable
      // Prod only: auto-delete is a CDK provider function, which dev carries none of (see the log groups above), so
      // deleting dev's app stack means emptying this bucket first (`aws s3 rm --recursive`).
      autoDeleteObjects: stage === 'prod',
    });

    // /api/* forwards ONLY the custom auth header + content-type — never Authorization (OAC owns it).
    const apiOrp = new cloudfront.OriginRequestPolicy(this, 'ApiOriginPolicy', {
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(AUTH_HEADER, 'content-type'),
      // Forward the OAuth callback params — without this CloudFront strips the query string on /api/*,
      // and /api/google/callback arrives with no code/state (invisible locally, breaks connect on deploy).
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.allowList('code', 'state', 'error'),
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
    });

    // /mcp forwards the agent-token header + the MCP content/negotiation headers. CloudFront STRIPS any
    // header not on this list, so a missing entry here is an invisible 401 that only shows on a deployed
    // stage. NB: phase 2's `authorization` is NOT here — CDK's origin-request-policy L2 refuses it (throws
    // at synth); it rides via the cache policy on the /mcp behavior instead (AWS's documented path).
    const mcpOrp = new cloudfront.OriginRequestPolicy(this, 'McpOriginPolicy', {
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(
        AGENT_TOKEN_HEADER,
        'content-type',
        'accept',
        'mcp-protocol-version',
      ),
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.none(),
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
    });

    // Shared MCP origin — reused by /mcp AND the phase-2 well-known metadata behaviors, so all carry the
    // same origin-secret stamp (the façade routes sit behind the same gate).
    const mcpOrigin = new origins.FunctionUrlOrigin(mcpUrl, {
      customHeaders: { [ORIGIN_SECRET_HEADER]: originSecret },
    });
    // CloudFront strips Authorization from origin requests by default, and CDK's origin-request-policy L2
    // refuses it — so /mcp forwards it via the CACHE key instead (the documented mechanism). maxTtl is 1s,
    // NOT 0: an all-zero-TTL policy counts as "caching disabled", and CloudFront rejects a HeaderBehavior on
    // a disabled policy (a deploy-time 400, invisible to synth/cdk-nag). POST is never cached regardless, so
    // /mcp still effectively doesn't cache; the header in the key means a response is never shared across
    // credentials.
    const mcpCachePolicy = new cloudfront.CachePolicy(this, 'McpCachePolicy', {
      minTtl: Duration.seconds(0),
      maxTtl: Duration.seconds(1),
      defaultTtl: Duration.seconds(0),
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList('authorization'),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    });
    // The OAuth metadata façade (phase 2): public GET/HEAD, never cached, no header forwarding needed (the
    // Lambda builds the doc from env). Scoped NARROWLY — never `/.well-known/*` (the PWA may want that).
    const wellKnownBehavior = {
      origin: mcpOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
    };

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
        // The MCP server (exact path — Claude Code / claude.ai use the URL verbatim). Its own Function URL
        // origin, the same origin-secret stamp, POST-only in practice, never cached. The cache policy
        // forwards Authorization (phase-2 Cognito bearer); mcpOrp forwards the agent-token + MCP headers.
        '/mcp': {
          origin: mcpOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: mcpCachePolicy,
          originRequestPolicy: mcpOrp,
        },
        // Phase-2 OAuth discovery — claude.ai fetches these to learn the (façade) authorization server.
        // `*` on the first two serves both the root and the RFC 9728 `/mcp`-suffixed path forms.
        '/.well-known/oauth-protected-resource*': wellKnownBehavior,
        '/.well-known/oauth-authorization-server*': wellKnownBehavior,
        '/.well-known/openid-configuration': wellKnownBehavior,
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
      // 7 days (Cognito allows up to 3650): the refresh token sits in browser localStorage, so a leaked one
      // stays useful for at most a week, at the cost of a weekly sign-in. Access/ID stay at the 1-hour
      // default (they cross the network on every request and are cheap to renew). Why: TECH §3.
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
    new CfnOutput(this, 'McpUrl', { value: `${appUrl}/mcp` }); // the URL to register in Claude Code / claude.ai
    new CfnOutput(this, 'McpClientId', { value: claudeClient.userPoolClientId }); // paste into claude.ai's connector OAuth Client ID

    // Runtime watch on the BFF, prod only (see monitoring.ts). Option B: Lambda alarms only — CloudFront
    // 5xx is deliberately not alarmed (its metrics live only in us-east-1; a cross-region topic isn't
    // worth it, and the synthetic check already proves the edge wiring at deploy time).
    if (stage === 'prod')
      new Monitoring(this, 'Monitoring', {
        functions: [
          {
            id: '',
            label: 'BFF',
            fn,
            durationAlarm: { statistic: 'p99', thresholdMs: fnTimeout.toMilliseconds() * 0.8 },
          },
          // Maximum ≥ 295 s: a run that ate most of its 10 s safety margin (a real timeout also lands in
          // Errors).
          // Not p99-at-80%: a legitimate refresh poll runs for minutes. Errors here are infra faults
          // only — a bank's failure is a per-item report, not a throw.
          {
            id: 'FinanceSync',
            label: 'Finance sync',
            fn: financeSync.fn,
            durationAlarm: {
              statistic: 'Maximum',
              thresholdMs: FINANCE_SYNC_TIMEOUT.toMilliseconds() - 5_000,
            },
          },
        ],
      });
  }
}
