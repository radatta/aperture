import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, Stack, Validations } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as destinations from 'aws-cdk-lib/aws-lambda-destinations';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as organizations from 'aws-cdk-lib/aws-organizations';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Construct } from 'constructs';
import {
  DEV_MAIN_GITHUB_ROLE,
  DEV_REGION,
  DEV_URL_FUNCTIONS,
  DEVMAIN_QUALIFIER,
  GITHUB_ROLE_PREFIX,
  KILL_ALARM_PREFIX,
  KILL_FORWARDER_ROLE,
} from '../config/devAccount';

// Where kill-switch and dev-budget alerts land. Personal email by design — this is a personal project.
const ALERT_EMAIL = 'rahul3datta@gmail.com';
// The dev budget: email at $1 of actual dev-account spend in a month, kill at $3.
export const DEV_BUDGET_EMAIL_USD = 1;
export const DEV_BUDGET_KILL_USD = 3;
const KILL_ENTRY = fileURLToPath(new URL('../../../lambdas/src/kill/index.ts', import.meta.url));

// The break-glass role Organizations creates in every member account. Every deny below exempts it, so the user's
// hand steps (`--profile aperture-dev`) and the kill Lambda's moves always work — and nothing else can touch it.
export const BREAK_GLASS_ROLE = 'OrganizationAccountAccessRole';
const breakGlass = `arn:aws:iam::*:role/${BREAK_GLASS_ROLE}`;
// The standing SCPs (bar the lane guardrails) also exempt the kill switch's own roles (ApertureDevGuard's forwarder,
// which EventBridge assumes to carry an alarm to the management account — the allowlist would otherwise deny its
// events:PutEvents). Nothing else can use or change them: their trust names a service, and NoGuardTampering denies iam:* (PassRole included) on them.
const killRoles = `arn:aws:iam::*:role/${KILL_ALARM_PREFIX}*`;
const exempt = { ArnNotLike: { 'aws:PrincipalARN': [breakGlass, killRoles] } };
// Main's own dev deploy (docs/ops/CI-BOT.md → Two lanes): CloudFormation runs it as the `devmain` bootstrap's
// execution role, which the freeze alone exempts — merged code has had the user's review, so it may change a
// function's shape. Only the dev-main GitHub role can reach that role, and nothing but break-glass can change either
// (OnlyMainAssumesItsLane, NoLaneTampering).
const devMainExec = `arn:aws:iam::*:role/cdk-${DEVMAIN_QUALIFIER}-cfn-exec-role-*`;
const devMainDeploy = `arn:aws:iam::*:role/cdk-${DEVMAIN_QUALIFIER}-deploy-role-*`;
const devMainRoles = `arn:aws:iam::*:role/cdk-${DEVMAIN_QUALIFIER}-*`;
const devMainPublish = `arn:aws:iam::*:role/cdk-${DEVMAIN_QUALIFIER}-file-publishing-role-*`;
const githubRoles = `arn:aws:iam::*:role/${GITHUB_ROLE_PREFIX}*`;
// Every CloudFormation call that can run a template, or roll one back, as a stack's role.
const stackMutations = [
  'cloudformation:CreateStack',
  'cloudformation:UpdateStack',
  'cloudformation:CreateChangeSet',
  'cloudformation:DeleteStack',
  'cloudformation:RollbackStack',
  'cloudformation:ContinueUpdateRollback',
];
const freezeExempt = { ArnNotLike: { 'aws:PrincipalARN': [breakGlass, killRoles, devMainExec] } };
const deny = (
  Sid: string,
  Action: string[],
  Resource: string | string[] = '*',
  Condition: object = exempt,
) => ({
  Sid,
  Effect: 'Deny',
  Action,
  Resource,
  Condition,
});
const freeze = (Sid: string, Action: string[], Resource: string | string[] = '*') =>
  deny(Sid, Action, Resource, freezeExempt);
const policy = (Statement: object[]) => ({ Version: '2012-10-17', Statement });

// SCP 1 — everything outside the services the dev stacks, CDK and the CI roles use is denied: EC2, Bedrock,
// SageMaker, SNS, EventBridge, CloudWatch writes, and every service AWS adds later. CloudWatch and EventBridge are
// out on purpose: the kill switch's alarms and forwarding rule live in the dev account (ApertureDevGuard) and only
// the break-glass role may create or change them.
export const allowlistPolicy = () =>
  policy([
    {
      Sid: 'OnlyDevServices',
      Effect: 'Deny',
      NotAction: [
        'lambda:*',
        'dynamodb:*',
        's3:*',
        'cloudfront:*',
        'cognito-idp:*',
        'logs:*',
        'scheduler:*',
        'ssm:*Parameter*', // Parameter Store only — not OpsCenter or Automation, which bill per item or step
        'ssm:AddTagsToResource',
        'ssm:RemoveTagsFromResource',
        'ssm:ListTagsForResource',
        'kms:*',
        'iam:*',
        'sts:*',
        'cloudformation:*',
        'acm:Describe*', // reads only: the cert is requested by the break-glass role, and exportable public certs bill per name
        'acm:Get*',
        'acm:List*',
        'tag:*',
        'cloudwatch:Describe*',
        'cloudwatch:Get*',
        'cloudwatch:List*',
        'servicequotas:Get*',
        'servicequotas:List*',
        'organizations:Describe*',
        'organizations:List*',
        'account:Get*',
      ],
      Resource: '*',
      Condition: exempt,
    },
  ]);

// SCP 2 — standing denies: actions dev never needs, each a cost lever or a way around the other guardrails.
export const guardrailsPolicy = () =>
  policy([
    // us-west-1 only. The NotAction list is the global services (Control Tower's region-deny set, trimmed to what the
    // allowlist leaves): ACM and CloudFront live in us-east-1 for the custom-domain cert. Also closes Lambda@Edge.
    {
      Sid: 'OnlyDevRegion',
      Effect: 'Deny',
      NotAction: [
        'iam:*',
        'sts:*',
        'cloudfront:*',
        'acm:*',
        'organizations:*',
        'account:*',
        'servicequotas:*',
        'support:*',
        'tag:*',
        's3:GetAccountPublicAccessBlock',
        's3:ListAllMyBuckets',
        's3:GetBucketLocation',
      ],
      Resource: '*',
      Condition: { ...exempt, StringNotEquals: { 'aws:RequestedRegion': DEV_REGION } },
    },
    // The Lambda concurrency quota is dev's hard compute cap — nothing in dev may ask for more, or leave.
    deny('NoQuotaOrAccountChanges', [
      'servicequotas:Request*',
      'servicequotas:Put*',
      'servicequotas:Associate*',
      'servicequotas:Delete*',
      'support:*',
      'account:EnableRegion',
      'account:DisableRegion',
      'account:Put*',
      'account:Delete*',
      'account:CloseAccount',
      'organizations:LeaveOrganization',
    ]),
    // Capacity outside the concurrency quota, and the ways to re-trigger a function without a caller.
    deny('NoLambdaCapacity', [
      'lambda:PutFunctionConcurrency',
      'lambda:DeleteFunctionConcurrency',
      'lambda:PutProvisionedConcurrencyConfig',
      'lambda:DeleteProvisionedConcurrencyConfig',
      'lambda:PutFunctionRecursionConfig',
      'lambda:CreateEventSourceMapping',
      'lambda:UpdateEventSourceMapping',
      'lambda:EnableReplication*',
      'lambda:*CapacityProvider*',
    ]),
    deny('NoDynamoDbExtras', [
      'dynamodb:RestoreTable*',
      'dynamodb:ImportTable',
      'dynamodb:ExportTableToPointInTime',
      'dynamodb:CreateBackup',
      'dynamodb:CreateGlobalTable',
      'dynamodb:UpdateGlobalTable*',
      'dynamodb:CreateTableReplica',
      'dynamodb:UpdateTableReplicaAutoScaling',
      'dynamodb:PurchaseReservedCapacityOfferings',
      'dynamodb:*KinesisStreamingDestination',
    ]),
    // Invalidations bill per path past 1,000 a month and nothing needs one (publish-frontend.mjs); the rest are paid
    // add-ons or a way to take over another distribution's domain.
    deny('NoCloudFrontExtras', [
      'cloudfront:CreateInvalidation*',
      'cloudfront:AssociateAlias',
      'cloudfront:UpdateDomainAssociation',
      'cloudfront:CreateRealtimeLogConfig',
      'cloudfront:CreateMonitoringSubscription',
      'cloudfront:CreateAnycastIpList',
      'cloudfront:CreateVpcOrigin',
      'cloudfront:CreateStreamingDistribution*',
      // Flat-rate pricing plans (2025) are a monthly commitment a disabled distribution doesn't cancel; the action
      // names weren't confirmed against the Service Authorization Reference, so these match by pattern.
      'cloudfront:*PricingPlan*',
      'cloudfront:*Subscription*',
    ]),
    // No long-lived credentials, no new federation, and the OIDC trust GitHub deploys through stays as deployed.
    deny('NoIamIdentities', [
      'iam:CreateUser',
      'iam:CreateAccessKey',
      'iam:CreateLoginProfile',
      'iam:UpdateLoginProfile',
      'iam:CreateVirtualMFADevice',
      'iam:CreateServiceSpecificCredential',
      'iam:*OpenIDConnectProvider*',
      'iam:*SAMLProvider*',
    ]),
    // The kill switch's own roles (ApertureDevGuard) and the break-glass role are untouchable from dev.
    deny('NoGuardTampering', ['iam:*'], [breakGlass, killRoles]),
    // The devmain bootstrap's roles trust the whole account, so without this the bot lane's execution role could step
    // into main's freeze-exempt lane; the GitHub roles are federated (AssumeRoleWithWebIdentity), never assumed.
    // CloudFormation assuming the exec role is the service, which no SCP binds.
    deny('OnlyMainAssumesItsLane', ['sts:AssumeRole'], [devMainRoles, githubRoles], {
      ArnNotLike: {
        'aws:PrincipalARN': [breakGlass, `arn:aws:iam::*:role/${DEV_MAIN_GITHUB_ROLE}`],
      },
    }),
    // Nothing may change, or pass, the devmain roles or a GitHub role — not even the bot lane's admin execution role
    // (a PassRole of the exempt exec role would run any stack freeze-exempt). The devmain deploy role is the one
    // exception: it passes its exec role to CloudFormation on every deploy, and only the dev-main role can become it.
    // (The deploy role's own policy holds no other iam: action, and NoLaneTampering keeps it that way.)
    deny('NoLaneTampering', ['iam:*'], [devMainRoles, githubRoles], {
      ArnNotLike: { 'aws:PrincipalARN': [breakGlass, devMainDeploy] },
    }),
    // CloudFormation remembers a stack's last role and reuses it for a call that names none — so after main's deploy,
    // a bot-lane UpdateStack with no role would run as the freeze-exempt exec role, no PassRole needed. Every stack
    // call must name its role (the CDK CLI always does); naming the exempt one needs PassRole, which only the devmain
    // deploy role has.
    {
      Sid: 'NameTheStackRole',
      Effect: 'Deny',
      Action: stackMutations,
      Resource: '*',
      Condition: { ...exempt, Null: { 'cloudformation:RoleArn': 'true' } },
    },
    // Main's lane trusts its own bootstrap: its bucket (the templates and code it deploys — cdk-assets skips a key that
    // already exists, so a planted object would deploy), its version parameter and its stack. Only devmain's publishing
    // role writes the bucket.
    deny(
      'DevMainBootstrapIntact',
      [
        's3:PutObject*',
        's3:DeleteObject*',
        's3:PutBucket*',
        's3:DeleteBucket*',
        's3:RestoreObject',
        'ssm:PutParameter',
        'ssm:DeleteParameter*',
        'ssm:LabelParameterVersion',
        ...stackMutations,
        'cloudformation:ExecuteChangeSet',
        'cloudformation:SetStackPolicy',
        'cloudformation:UpdateTerminationProtection',
      ],
      [
        `arn:aws:s3:::cdk-${DEVMAIN_QUALIFIER}-*`,
        `arn:aws:s3:::cdk-${DEVMAIN_QUALIFIER}-*/*`,
        `arn:aws:ssm:*:*:parameter/cdk-bootstrap/${DEVMAIN_QUALIFIER}/*`,
        `arn:aws:cloudformation:*:*:stack/CDKToolkit-${DEVMAIN_QUALIFIER}/*`,
      ],
      { ArnNotLike: { 'aws:PrincipalARN': [breakGlass, devMainPublish] } },
    ),
    // Archive storage classes bill 10× Standard per PUT; an upload that sends no class header is Standard and passes.
    {
      Sid: 'StandardStorageOnly',
      Effect: 'Deny',
      Action: ['s3:PutObject'],
      Resource: '*',
      Condition: {
        ...exempt,
        StringNotEquals: { 's3:x-amz-storage-class': 'STANDARD' },
        Null: { 's3:x-amz-storage-class': 'false' },
      },
    },
    deny('NoCostSinks', [
      'kms:CreateKey',
      'kms:CreateCustomKeyStore',
      'logs:PutSubscriptionFilter',
      'logs:CreateExportTask',
      'logs:PutDataProtectionPolicy',
      'logs:PutAccountPolicy',
      'logs:CreateLogAnomalyDetector',
      'logs:StartLiveTail',
      'logs:PutDeliveryDestination',
      's3:PutAccountPublicAccessBlock',
      's3:PutReplicationConfiguration',
      's3:PutAccelerateConfiguration',
      's3:PutInventoryConfiguration',
      's3:PutAnalyticsConfiguration',
      's3:PutStorageLensConfiguration',
      's3:CreateJob',
      's3:PutMetricsConfiguration', // paid request metrics, billed on CloudFront→S3 traffic even after a kill
      's3:PutBucketObjectLockConfiguration', // compliance-mode storage nobody can delete for years
      's3:PutObjectRetention',
      's3:PutObjectLegalHold',
      'logs:PutMetricFilter', // custom metrics, a way around the CloudWatch write deny
      'logs:PutResourcePolicy', // lets another account's principals write (and bill) dev's logs
      'logs:PutDestination*',
      'dynamodb:UpdateContributorInsights',
      'ssm:UpdateServiceSetting',
      // An access point is a second address for a bucket that a bucket-ARN deny may not cover (DevMainBootstrapIntact);
      // nothing in dev uses one.
      's3:CreateAccessPoint*',
      's3:CreateMultiRegionAccessPoint*',
    ]),
  ]);

// SCP 3 — the freeze: what a dev deploy needs only the first time, or when it changes a function's shape. Without
// it, branch code could raise memory 20× and the timeout to 15 min (in-flight calls run to their timeout even after
// a kill), add Function URLs or self-invoking destinations, or switch the table to provisioned capacity. Attached
// after the first deploy into the account. Main's own dev deploy is exempt (devMainExec above); a bot dispatch or
// `dev` push that changes any of these is a hand step: detach, deploy, reattach (docs/ops/CI-BOT.md → Kill switch).
export const freezePolicy = () =>
  policy([
    // CDK's own provider functions (LogRetention, S3 auto-delete, the OIDC provider) run for up to 15 min, so new code
    // there would outlast a kill's tail; CloudFormation names them `Aperture…` (the app functions are `aperture-…`).
    freeze(
      'FrozenProviderCode',
      ['lambda:UpdateFunctionCode'],
      'arn:aws:lambda:*:*:function:Aperture*',
    ),
    freeze('FrozenFunctionShape', [
      'lambda:CreateFunction',
      'lambda:UpdateFunctionConfiguration',
      'lambda:CreateFunctionUrlConfig',
      'lambda:UpdateFunctionUrlConfig',
      'lambda:DeleteFunctionUrlConfig',
      'lambda:AddPermission',
      'lambda:RemovePermission',
      'lambda:PutFunctionEventInvokeConfig',
      'lambda:UpdateFunctionEventInvokeConfig',
    ]),
    freeze('FrozenTable', [
      'dynamodb:CreateTable',
      'dynamodb:UpdateTable',
      'dynamodb:DeleteTable',
      'dynamodb:UpdateContinuousBackups',
      'dynamodb:PutResourcePolicy', // a resource policy could let another account read (and bill) the table
    ]),
    // Grants that outlive a kill: a resource policy, an ACL or a role trust naming another account acts through
    // that account's principals, which no dev SCP binds; a new distribution or bucket keeps serving as a service.
    freeze('FrozenGrants', [
      's3:CreateBucket',
      's3:PutBucketPolicy',
      's3:PutBucketAcl',
      's3:PutBucketOwnershipControls',
      's3:PutLifecycleConfiguration', // S3 runs a rule itself, so a transition to an archive class bills after a kill
      's3:PutIntelligentTieringConfiguration',
      'cloudfront:CreateDistribution*',
      'cloudfront:CopyDistribution',
      'cloudfront:CreateContinuousDeploymentPolicy',
      'iam:CreateRole',
      'iam:UpdateAssumeRolePolicy',
    ]),
    // The user pool: opening self-sign-up (UpdateUserPool), a new client or resource server, or created users would let
    // unauthenticated callers run up monthly active users — no SCP binds them. The two dev users are created by the
    // break-glass role.
    freeze('FrozenUserPool', [
      'cognito-idp:CreateUserPool*',
      'cognito-idp:UpdateUserPool*',
      'cognito-idp:CreateResourceServer',
      'cognito-idp:UpdateResourceServer',
      'cognito-idp:AdminCreateUser',
      'cognito-idp:*UserImportJob',
    ]),
    freeze('FrozenSchedules', [
      'scheduler:CreateSchedule',
      'scheduler:UpdateSchedule',
      'scheduler:CreateScheduleGroup',
    ]),
  ]);

// SCP 4 — the kill: deny-all, attached only by the kill Lambda (or the budget). The break-glass role stays exempt so
// the unkill and any inspection still work.
export const killPolicy = () =>
  policy([
    {
      Sid: 'Killed',
      Effect: 'Deny',
      Action: '*',
      Resource: '*',
      Condition: { ArnNotLike: { 'aws:PrincipalARN': breakGlass } },
    },
  ]);

export interface OrgStackProps extends StackProps {
  devAccountId: string;
  devOuId: string; // the `Dev` OU holding the dev account; the standing SCPs attach here
}

// The management account's half of the dev-account guardrails (INFRA §3, docs/ops/CI-BOT.md → Kill switch). Deployed
// by hand in us-east-1 (Organizations, the EventBridge bus the dev alarms forward to, and Budgets are all served
// there): `cdk deploy ApertureOrg -c org=true -c mgmtAccountId=… -c devAccountId=… -c devOuId=…`. SCPs never apply to
// the management account itself — prod's protection is that no dev credential exists here.
export class ApertureOrgStack extends Stack {
  constructor(scope: Construct, id: string, props: OrgStackProps) {
    super(scope, id, props);
    const { devAccountId, devOuId } = props;

    const scp = (
      cid: string,
      name: string,
      content: object,
      description: string,
      attach: boolean,
    ) =>
      new organizations.CfnPolicy(this, cid, {
        name,
        type: 'SERVICE_CONTROL_POLICY',
        description,
        content,
        ...(attach ? { targetIds: [devOuId] } : {}),
      });
    scp(
      'Allowlist',
      'aperture-dev-allowlist',
      allowlistPolicy(),
      'Dev account: only the services the dev stacks use.',
      true,
    );
    scp(
      'Guardrails',
      'aperture-dev-guardrails',
      guardrailsPolicy(),
      'Dev account: standing denies on cost levers.',
      true,
    );
    scp(
      'Freeze',
      'aperture-dev-freeze',
      freezePolicy(),
      'Dev account: function shape, table and schedules frozen.',
      true,
    );
    const killScp = scp(
      'Kill',
      'aperture-dev-kill',
      killPolicy(),
      'Dev account: deny-all, attached by the kill switch.',
      false,
    );

    // Email for every trip, independent of the Lambda: the raw alarm event, the budget notice, and the Lambda's own
    // failure (its async-failure destination) — so a broken kill can't fail silently.
    const alerts = new sns.Topic(this, 'KillAlerts', {
      topicName: 'aperture-dev-kill-alerts',
      enforceSSL: true,
    });
    alerts.addSubscription(new subscriptions.EmailSubscription(ALERT_EMAIL));

    const killFn = new NodejsFunction(this, 'KillFn', {
      functionName: 'aperture-dev-kill',
      entry: KILL_ENTRY,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(120), // lists and updates every dev function and distribution
      memorySize: 256,
      logGroup: new logs.LogGroup(this, 'KillLogs', { retention: logs.RetentionDays.ONE_MONTH }),
      environment: {
        KILL_POLICY_ID: killScp.attrId,
        DEV_ACCOUNT_ID: devAccountId,
        DEV_REGION,
        BREAK_GLASS_ROLE_ARN: `arn:aws:iam::${devAccountId}:role/${BREAK_GLASS_ROLE}`,
        URL_FUNCTIONS: DEV_URL_FUNCTIONS.join(','),
      },
      onFailure: new destinations.SnsDestination(alerts),
      retryAttempts: 2,
      bundling: { format: OutputFormat.ESM, minify: true, externalModules: ['@aws-sdk/*'] }, // v3 SDK is in the runtime
    });
    killFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['organizations:AttachPolicy'],
        resources: [
          killScp.attrArn,
          `arn:aws:organizations::${this.account}:account/*/${devAccountId}`,
        ],
      }),
    );
    killFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [`arn:aws:iam::${devAccountId}:role/${BREAK_GLASS_ROLE}`],
      }),
    );

    // Trigger 1: the dev account's kill alarms, forwarded by ApertureDevGuard onto this account's default bus.
    new events.CfnEventBusPolicy(this, 'DevForwardPolicy', {
      statementId: 'aperture-dev-kill-forward',
      eventBusName: 'default',
      statement: {
        Effect: 'Allow',
        Principal: { AWS: `arn:aws:iam::${devAccountId}:role/${KILL_FORWARDER_ROLE}` }, // only the forwarder
        Action: 'events:PutEvents',
        Resource: `arn:aws:events:${this.region}:${this.account}:event-bus/default`,
      },
    });
    new events.Rule(this, 'DevAlarmRule', {
      ruleName: 'aperture-dev-kill',
      eventPattern: {
        source: ['aws.cloudwatch'],
        account: [devAccountId],
        detailType: ['CloudWatch Alarm State Change'],
        detail: { alarmName: [{ prefix: KILL_ALARM_PREFIX }], state: { value: ['ALARM'] } },
      },
      targets: [new targets.LambdaFunction(killFn), new targets.SnsTopic(alerts)],
    });

    // Trigger 2, the slow backstop: the dev account's own spend. Budgets data lags 8–24 h, so this only bounds a kill
    // switch that failed silently to about a day. Email at $1; at $3 the topic below fires the kill Lambda too.
    const budgetTopic = new sns.Topic(this, 'BudgetKill', {
      topicName: 'aperture-dev-budget-kill',
      enforceSSL: true,
    });
    budgetTopic.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('budgets.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [budgetTopic.topicArn],
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
    );
    budgetTopic.addSubscription(new subscriptions.LambdaSubscription(killFn));
    const actual = (threshold: number) => ({
      notificationType: 'ACTUAL',
      comparisonOperator: 'GREATER_THAN',
      threshold,
      thresholdType: 'ABSOLUTE_VALUE',
    });
    new budgets.CfnBudget(this, 'DevBudget', {
      budget: {
        budgetName: 'aperture-dev-account',
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: DEV_BUDGET_KILL_USD, unit: 'USD' },
        costFilters: { LinkedAccount: [devAccountId] },
      },
      notificationsWithSubscribers: [
        {
          notification: actual(DEV_BUDGET_EMAIL_USD),
          subscribers: [{ subscriptionType: 'EMAIL', address: ALERT_EMAIL }],
        },
        {
          notification: actual(DEV_BUDGET_KILL_USD),
          subscribers: [
            { subscriptionType: 'EMAIL', address: ALERT_EMAIL },
            { subscriptionType: 'SNS', address: budgetTopic.topicArn },
          ],
        },
      ],
    });

    // cdk-nag: the kill role's one resource wildcard is the org id, unknown until the org exists. The stack is
    // pinned to the management account, so the finding prints the account literally.
    killFn.role?.node.addMetadata(Validations.ACKNOWLEDGED_RULES_METADATA_KEY, {
      'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]':
        'AWSLambdaBasicExecutionRole is the standard CloudWatch Logs managed policy.',
      [`AwsSolutions-IAM5[Resource::arn:aws:organizations::${this.account}:account/*/${devAccountId}]`]:
        'The account ARN embeds the organization id, unknown until the org exists; the account id itself is exact.',
    });
    Validations.of(this).acknowledge({
      id: 'AwsSolutions-L1',
      reason: 'Node 22 is the current LTS target, the same pin as the app functions.',
    });

    new CfnOutput(this, 'KillPolicyId', { value: killScp.attrId }); // the unkill detaches this
    new CfnOutput(this, 'KillFunction', { value: killFn.functionName });
  }
}
