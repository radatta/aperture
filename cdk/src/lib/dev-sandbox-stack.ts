import { CfnOutput, Duration, RemovalPolicy, Stack, Validations } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { DEV_BOUNDARY_NAME, DEV_EXEC_POLICY_NAME, DEV_QUALIFIER } from './dev-stage';

export interface DevSandboxStackProps extends StackProps {
  // dev's Cognito pool and CloudFront distribution have random ids, so the execution role is pinned to them (passed
  // at deploy time with -c, never committed — they're account-specific, like githubSubject).
  devUserPoolId: string;
  devDistributionId: string;
}

// Every dev-scoped ARN the sandbox grants on. Built twice: once with the real tokens, once with cdk-nag's placeholders,
// so the IAM5 acknowledgements below name exactly the wildcards granted (ids must match synth's hint verbatim).
const devArns = (partition: string, account: string, region: string) => ({
  stacks: ['ApertureData-dev', 'ApertureApp-dev'].map(
    (s) => `arn:${partition}:cloudformation:${region}:${account}:stack/${s}/*`,
  ),
  devRoles: ['ApertureApp-dev-*', 'ApertureData-dev-*'].map(
    (r) => `arn:${partition}:iam::${account}:role/${r}`,
  ),
  boundary: `arn:${partition}:iam::${account}:policy/${DEV_BOUNDARY_NAME}`,
  table: [
    `arn:${partition}:dynamodb:${region}:${account}:table/aperture-dev`,
    `arn:${partition}:dynamodb:${region}:${account}:table/aperture-dev/*`,
  ],
  buckets: ['aperturedata-dev-*', 'apertureapp-dev-*'].flatMap((b) => [
    `arn:${partition}:s3:::${b}`,
    `arn:${partition}:s3:::${b}/*`,
  ]),
  devFunctions: `arn:${partition}:lambda:${region}:${account}:function:aperture-*-dev`,
  functions: ['aperture-*-dev', 'ApertureApp-dev-*', 'ApertureData-dev-*'].flatMap((f) => {
    const fn = `arn:${partition}:lambda:${region}:${account}:function:${f}`;
    return [fn, `${fn}:*`]; // a function and its versions/aliases
  }),
  // Groups and their `:*` streams; `aperture-*-dev` is spelled out so no `-dev…` prod name can match.
  logGroups: ['aperture-*-dev', 'aperture-*-dev:*', 'ApertureApp-dev-*', 'ApertureData-dev-*'].map(
    (g) => `arn:${partition}:logs:${region}:${account}:log-group:/aws/lambda/${g}`,
  ),
  devParams: `arn:${partition}:ssm:${region}:${account}:parameter/aperture/dev/*`,
  edgePolicies: ['origin-access-control', 'cache-policy', 'origin-request-policy'].map(
    (r) => `arn:${partition}:cloudfront::${account}:${r}/*`,
  ),
  schedules: [
    `arn:${partition}:scheduler:${region}:${account}:schedule-group/aperture-finance-dev`,
    `arn:${partition}:scheduler:${region}:${account}:schedule/aperture-finance-dev/*`,
  ],
});

// The resource types in the dev stacks that the execution policy below was written for. A dev stack gaining a type
// fails stacks.test.ts: grant it here, and the user redeploys this stack BEFORE the change reaches dev.
export const DEV_STACK_RESOURCE_TYPES = [
  'AWS::CDK::Metadata',
  'AWS::CloudFront::CachePolicy',
  'AWS::CloudFront::Distribution',
  'AWS::CloudFront::OriginAccessControl',
  'AWS::CloudFront::OriginRequestPolicy',
  'AWS::Cognito::UserPool',
  'AWS::Cognito::UserPoolClient',
  'AWS::Cognito::UserPoolDomain',
  'AWS::Cognito::UserPoolResourceServer',
  'AWS::DynamoDB::Table',
  'AWS::IAM::Policy',
  'AWS::IAM::Role',
  'AWS::Lambda::EventInvokeConfig',
  'AWS::Lambda::Function',
  'AWS::Lambda::Permission',
  'AWS::Lambda::Url',
  'AWS::Logs::LogGroup',
  'AWS::S3::Bucket',
  'AWS::S3::BucketPolicy',
  'AWS::Scheduler::Schedule',
  'AWS::Scheduler::ScheduleGroup',
  'Custom::LogRetention',
  'Custom::S3AutoDeleteObjects',
];

// The stock bootstrap template's version this stack stands in for (`cdk bootstrap --show-template`, CLI 2.1135.0).
// The dev stacks' CheckBootstrapVersion rule needs ≥ 6.
export const DEV_BOOTSTRAP_VERSION = '32';

// dev's own CDK bootstrap — the same four roles, bucket and version parameter as `cdk bootstrap`, with qualifier
// `devsandbox`, but every role reaches only dev (docs/ops/CI-BOT.md → Dev deploy blast radius). The stock template is
// unfit as is: its deploy role may Create/Update/Delete ANY stack (an UpdateStack without RoleARN reuses a prod stack's
// stored admin role), its lookup role holds ReadOnlyAccess (prod's table included), and its execution role is admin.
// Deployed ONCE, by hand, like ApertureCicd; re-run when a dev stack gains a resource type (stacks.test.ts guards it).
// Within dev the grants are service-wide on dev-named resources — the wall is dev vs prod, not least privilege
// inside dev. IAM is the exception: the escalation path, so it stays tight.
export class ApertureDevSandboxStack extends Stack {
  constructor(scope: Construct, id: string, props: DevSandboxStackProps) {
    super(scope, id, props);
    const { devUserPoolId, devDistributionId } = props;
    const { account, region, partition } = this;
    const q = DEV_QUALIFIER;
    const roleName = (kind: string) => `cdk-${q}-${kind}-role-${account}-${region}`;
    // The trust the stock bootstrap uses: any principal in this account whose own policy allows the assume (the dev
    // GitHub role; the user's admin creds for a stuck stack). The dev boundary allows no sts:, so dev Lambdas can't.
    const accountPrincipal = new iam.SessionTagsPrincipal(new iam.AccountPrincipal(account));
    // The stock bootstrap's guard against bucket sniping: the sandbox bucket must be in this account.
    const inAccount = { StringEquals: { 'aws:ResourceAccount': account } };

    const assets = new s3.Bucket(this, 'Assets', {
      bucketName: `cdk-${q}-assets-${account}-${region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED, // stock uses aws:kms; SSE-S3 needs no KMS grants
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [
        { noncurrentVersionExpiration: Duration.days(30) },
        { abortIncompleteMultipartUploadAfter: Duration.days(1) },
      ],
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const version = new ssm.StringParameter(this, 'Version', {
      parameterName: `/cdk-bootstrap/${q}/version`,
      stringValue: DEV_BOOTSTRAP_VERSION,
    });

    const arn = devArns(partition, account, region);

    // ---- The ceiling on every role a dev stack creates (applied by dev-stage.ts applyDevBoundary). It grants nothing
    // by itself; a role's own policy still has to. No sts:, no iam:, nothing named for prod.
    const boundary = new iam.ManagedPolicy(this, 'Boundary', {
      managedPolicyName: DEV_BOUNDARY_NAME,
      statements: [
        new iam.PolicyStatement({ actions: ['dynamodb:*'], resources: arn.table }),
        new iam.PolicyStatement({ actions: ['s3:*'], resources: arn.buckets }),
        new iam.PolicyStatement({
          actions: [
            'ssm:GetParameter',
            'ssm:GetParameters',
            'ssm:PutParameter',
            'ssm:DeleteParameter',
          ],
          resources: [arn.devParams],
        }),
        // SecureStrings under the aws/ssm key: its key policy does the granting, and a boundary filters that too.
        new iam.PolicyStatement({
          actions: ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey'],
          resources: ['*'],
          conditions: { StringEquals: { 'kms:ViaService': `ssm.${region}.amazonaws.com` } },
        }),
        new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [arn.devFunctions],
        }),
        new iam.PolicyStatement({
          actions: [
            'logs:CreateLogGroup',
            'logs:CreateLogStream',
            'logs:PutLogEvents',
            'logs:PutRetentionPolicy',
            'logs:DeleteRetentionPolicy',
          ],
          resources: arn.logGroups,
        }),
      ],
    });

    // ---- CloudFormation execution role: what the dev stacks' resources need, on dev-named or pinned resources only.
    const execRole = new iam.Role(this, 'CfnExecRole', {
      roleName: roleName('cfn-exec'),
      assumedBy: new iam.ServicePrincipal('cloudformation.amazonaws.com'),
    });
    const execPolicy = new iam.Policy(this, 'CfnExecPolicy', {
      policyName: DEV_EXEC_POLICY_NAME,
      roles: [execRole],
      statements: [
        // Lambda code: CreateFunction/UpdateFunctionCode read the asset with the caller's credentials. Never the
        // default bootstrap bucket — it holds prod's templates.
        new iam.PolicyStatement({
          actions: ['s3:GetObject', 's3:GetObjectVersion'],
          resources: [assets.arnForObjects('*')],
          conditions: inAccount,
        }),
        new iam.PolicyStatement({
          actions: ['ssm:GetParameter', 'ssm:GetParameters'],
          resources: [version.parameterArn],
        }),
        new iam.PolicyStatement({ actions: ['dynamodb:*'], resources: arn.table }),
        new iam.PolicyStatement({ actions: ['s3:*'], resources: arn.buckets }),
        new iam.PolicyStatement({ actions: ['lambda:*'], resources: arn.functions }),
        new iam.PolicyStatement({ actions: ['logs:*'], resources: arn.logGroups }),
        new iam.PolicyStatement({ actions: ['logs:DescribeLogGroups'], resources: ['*'] }),
        // IAM: dev-prefixed roles only (CDK leaves them unnamed, so CloudFormation names them `<stack>-…`). A role is
        // created — or re-bounded — only with the dev boundary, and its policies change only while it carries it (a role
        // left unbounded by an older admin-bootstrap deploy can't be granted `*:*`); the only managed policy it may
        // attach is basic logging; it may be passed only to Lambda or Scheduler. The boundary and this policy are out
        // of reach (no managed-policy actions).
        new iam.PolicyStatement({
          actions: [
            'iam:GetRole',
            'iam:GetRolePolicy',
            'iam:ListRolePolicies',
            'iam:ListAttachedRolePolicies',
            'iam:ListRoleTags',
            'iam:ListInstanceProfilesForRole',
            'iam:DeleteRole',
            'iam:UpdateRole',
            'iam:UpdateRoleDescription',
            'iam:UpdateAssumeRolePolicy',
            'iam:TagRole',
            'iam:UntagRole',
          ],
          resources: arn.devRoles,
        }),
        new iam.PolicyStatement({
          actions: [
            'iam:CreateRole',
            'iam:PutRolePermissionsBoundary',
            'iam:PutRolePolicy',
            'iam:DeleteRolePolicy',
          ],
          resources: arn.devRoles,
          conditions: { StringEquals: { 'iam:PermissionsBoundary': arn.boundary } },
        }),
        new iam.PolicyStatement({
          actions: ['iam:AttachRolePolicy', 'iam:DetachRolePolicy'],
          resources: arn.devRoles,
          conditions: {
            StringEquals: { 'iam:PermissionsBoundary': arn.boundary },
            ArnEquals: {
              'iam:PolicyARN': `arn:${partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole`,
            },
          },
        }),
        new iam.PolicyStatement({
          actions: ['iam:PassRole'],
          resources: arn.devRoles,
          conditions: {
            StringEquals: {
              'iam:PassedToService': ['lambda.amazonaws.com', 'scheduler.amazonaws.com'],
            },
          },
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.DENY,
          actions: ['iam:DeleteRolePermissionsBoundary'],
          resources: ['*'],
        }),
        // Cognito: the pinned dev pool (its clients, domain and resource server are sub-resources of it).
        new iam.PolicyStatement({
          actions: ['cognito-idp:*'],
          resources: [
            `arn:${partition}:cognito-idp:${region}:${account}:userpool/${devUserPoolId}`,
          ],
        }),
        new iam.PolicyStatement({
          actions: ['cognito-idp:DescribeUserPoolDomain'],
          resources: ['*'],
        }),
        // CloudFront: the pinned dev distribution. Cache/origin-request policies and OACs have random ids and no tags
        // in our stacks, so they sit on `*` — the accepted residual: disrupting prod's edge config, never repointing
        // prod's origins or reading data (the distribution is pinned). Decided 2026-10-30.
        new iam.PolicyStatement({
          actions: ['cloudfront:*'],
          resources: [`arn:${partition}:cloudfront::${account}:distribution/${devDistributionId}`],
        }),
        // These move an alternate domain name onto the target distribution — dev's, so prod's hostname could be pulled
        // onto branch code. CloudFront likely demands DNS proof too (unverified); the deny costs nothing.
        new iam.PolicyStatement({
          effect: iam.Effect.DENY,
          actions: ['cloudfront:AssociateAlias', 'cloudfront:UpdateDomainAssociation'],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          actions: ['OriginAccessControl', 'CachePolicy', 'OriginRequestPolicy'].flatMap((r) =>
            ['Create', 'Get', 'Update', 'Delete']
              .map((verb) => `cloudfront:${verb}${r}`)
              .concat(`cloudfront:Get${r}Config`),
          ),
          resources: arn.edgePolicies,
        }),
        new iam.PolicyStatement({
          actions: ['scheduler:*'],
          resources: arn.schedules,
        }),
        // The distribution's custom-domain cert (us-east-1, referenced by ARN). Read-only.
        new iam.PolicyStatement({
          actions: ['acm:DescribeCertificate', 'acm:ListCertificates'],
          resources: ['*'],
        }),
      ],
    });

    // ---- Deploy role (the CLI's): the two dev stacks only, and only with the sandbox execution role named — an
    // UpdateStack without RoleARN would reuse whatever role the stack last ran with. No change sets: `--method=direct`
    // and `diff --method=template` use none, and executing one left over from a default-bootstrap run would apply it
    // with that run's admin role.
    const deployRole = new iam.Role(this, 'DeployRole', {
      roleName: roleName('deploy'),
      assumedBy: accountPrincipal,
    });
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'cloudformation:CreateStack',
          'cloudformation:UpdateStack',
          'cloudformation:RollbackStack',
          'cloudformation:ContinueUpdateRollback',
        ],
        resources: arn.stacks,
        conditions: { StringEquals: { 'cloudformation:RoleArn': execRole.roleArn } },
      }),
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'cloudformation:DescribeStacks',
          'cloudformation:DescribeStackEvents',
          'cloudformation:DescribeStackResource',
          'cloudformation:DescribeStackResources',
          'cloudformation:ListStackResources',
          'cloudformation:GetTemplate',
          'cloudformation:GetTemplateSummary',
        ],
        resources: arn.stacks,
      }),
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({ actions: ['iam:PassRole'], resources: [execRole.roleArn] }),
    );
    // CloudFormation fetches the TemplateURL and resolves the BootstrapVersion parameter with the caller's credentials.
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject*', 's3:GetBucket*', 's3:List*'],
        resources: [assets.bucketArn, assets.arnForObjects('*')],
        conditions: inAccount,
      }),
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter', 'ssm:GetParameters'],
        resources: [version.parameterArn],
      }),
    );

    // ---- Lookup role: what `cdk diff --method=template` reads — the two dev stacks' templates. No ReadOnlyAccess.
    const lookupRole = new iam.Role(this, 'LookupRole', {
      roleName: roleName('lookup'),
      assumedBy: accountPrincipal,
    });
    lookupRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'cloudformation:DescribeStacks',
          'cloudformation:GetTemplate',
          'cloudformation:GetTemplateSummary',
        ],
        resources: arn.stacks,
      }),
    );
    lookupRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter', 'ssm:GetParameters'],
        resources: [version.parameterArn],
      }),
    );

    // ---- File publishing role: the stock grants on the sandbox bucket, minus KMS (SSE-S3). No image role or ECR
    // repository — the dev stacks have no Docker assets; one would fail the publish loudly.
    const publishRole = new iam.Role(this, 'FilePublishingRole', {
      roleName: roleName('file-publishing'),
      assumedBy: accountPrincipal,
    });
    publishRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          's3:GetObject*',
          's3:GetBucket*',
          's3:GetEncryptionConfiguration',
          's3:List*',
          's3:DeleteObject*',
          's3:PutObject*',
          's3:Abort*',
        ],
        resources: [assets.bucketArn, assets.arnForObjects('*')],
        conditions: inAccount,
      }),
    );

    // cdk-nag IAM5: every wildcard here is a dev-named pattern or a stock bootstrap grant (the cicd-stack.ts raw-metadata
    // workaround for cdk-nag#2359). One map on each policy holder; an id that doesn't fire there is ignored.
    const nag = devArns('<AWS::Partition>', '<AWS::AccountId>', region);
    const acks: Record<string, string> = {};
    const because = (reason: string, findings: string[]) => {
      for (const f of findings) acks[`AwsSolutions-IAM5[${f}]`] = reason;
    };
    because(
      'Service-wide on dev-named or pinned resources only: the wall is dev vs prod, not least privilege inside dev.',
      [
        ...['cloudfront', 'cognito-idp', 'dynamodb', 'lambda', 'logs', 's3', 'scheduler'].map(
          (svc) => `Action::${svc}:*`,
        ),
      ],
    );
    because(
      'The stock CDK bootstrap grants for asset publishing and the CLI, on the sandbox bucket only.',
      [
        ...['Abort*', 'DeleteObject*', 'GetBucket*', 'GetObject*', 'List*', 'PutObject*'].map(
          (a) => `Action::s3:${a}`,
        ),
        'Resource::<Assets9A31D427.Arn>/*',
      ],
    );
    because(
      'The two dev stacks; CloudFormation stack ARNs end in a generated id.',
      nag.stacks.map((r) => `Resource::${r}`),
    );
    because(
      'CDK leaves dev roles and provider functions unnamed, so CloudFormation names them `<stack>-…`; dev-prefixed only.',
      [...nag.devRoles, ...nag.functions].map((r) => `Resource::${r}`),
    );
    because(
      'dev-named resources: the table and its indexes, the stage buckets and objects, log groups, SSM params, schedules.',
      [
        ...nag.table.slice(1),
        ...nag.buckets,
        ...nag.logGroups,
        nag.devParams,
        nag.devFunctions,
        ...nag.schedules.slice(1),
      ].map((r) => `Resource::${r}`),
    );
    because(
      'CloudFront cache/origin-request policies and OACs: random ids, untagged — the accepted residual (class comment).',
      nag.edgePolicies.map((r) => `Resource::${r}`),
    );
    because(
      'Read-only or unscopable: logs:DescribeLogGroups, cognito DescribeUserPoolDomain, ACM reads; kms only via SSM; an explicit Deny.',
      ['Resource::*'],
    );
    for (const holder of [boundary, execPolicy, deployRole, lookupRole, publishRole])
      holder.node.addMetadata(Validations.ACKNOWLEDGED_RULES_METADATA_KEY, acks);

    new CfnOutput(this, 'BucketName', { value: assets.bucketName });
    new CfnOutput(this, 'BootstrapVersion', { value: DEV_BOOTSTRAP_VERSION });
  }
}
