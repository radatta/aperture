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
import { DEV_REGION, DEV_URL_FUNCTIONS, KILL_ALARM_PREFIX } from '../config/devAccount';

// Where kill-switch and dev-budget alerts land. Personal email by design — this is a personal project.
const ALERT_EMAIL = 'rahul3datta@gmail.com';
// The dev budget: email at $1 of actual dev-account spend in a month, kill at $3.
export const DEV_BUDGET_EMAIL_USD = 1;
export const DEV_BUDGET_KILL_USD = 3;
const KILL_ENTRY = fileURLToPath(new URL('../../../lambdas/src/kill/index.ts', import.meta.url));

// The break-glass role Organizations creates in every member account. Every deny below exempts it, so the user's
// hand steps (`--profile aperture-dev`) and the kill Lambda's URL lock always work — and nothing else can touch it.
export const BREAK_GLASS_ROLE = 'OrganizationAccountAccessRole';
const breakGlass = `arn:aws:iam::*:role/${BREAK_GLASS_ROLE}`;
// The standing SCPs also exempt the kill switch's own roles (ApertureDevGuard's forwarder, which EventBridge assumes to
// carry an alarm to the management account — the allowlist would otherwise deny its events:PutEvents). Nothing else
// can use or change them: their trust names a service, and NoGuardTampering denies iam:* (PassRole included) on them.
const killRoles = `arn:aws:iam::*:role/${KILL_ALARM_PREFIX}*`;
const exempt = { ArnNotLike: { 'aws:PrincipalARN': [breakGlass, killRoles] } };
const deny = (Sid: string, Action: string[], Resource: string | string[] = '*') => ({ Sid, Effect: 'Deny', Action, Resource, Condition: exempt });
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
        'ssm:*',
        'kms:*',
        'iam:*',
        'sts:*',
        'cloudformation:*',
        'acm:*',
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
      'ssm:UpdateServiceSetting',
    ]),
  ]);

// SCP 3 — the freeze: what a dev deploy needs only the first time, or when it changes a function's shape. Without
// it, branch code could raise memory 20× and the timeout to 15 min (in-flight calls run to their timeout even after
// a kill), add Function URLs or self-invoking destinations, or switch the table to provisioned capacity. Attached
// after the first deploy into the account; a branch that changes any of these is a hand step: detach, deploy,
// reattach (docs/ops/CI-BOT.md → Kill switch).
export const freezePolicy = () =>
  policy([
    deny('FrozenFunctionShape', [
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
    deny('FrozenTable', [
      'dynamodb:CreateTable',
      'dynamodb:UpdateTable',
      'dynamodb:DeleteTable',
      'dynamodb:UpdateContinuousBackups',
    ]),
    deny('FrozenSchedules', ['scheduler:CreateSchedule', 'scheduler:UpdateSchedule', 'scheduler:CreateScheduleGroup']),
  ]);

// SCP 4 — the kill: deny-all, attached only by the kill Lambda (or the budget). The break-glass role stays exempt so
// the unkill and any inspection still work.
export const killPolicy = () =>
  policy([{ Sid: 'Killed', Effect: 'Deny', Action: '*', Resource: '*', Condition: { ArnNotLike: { 'aws:PrincipalARN': breakGlass } } }]);

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

    const scp = (cid: string, name: string, content: object, description: string, attach: boolean) =>
      new organizations.CfnPolicy(this, cid, {
        name,
        type: 'SERVICE_CONTROL_POLICY',
        description,
        content,
        ...(attach ? { targetIds: [devOuId] } : {}),
      });
    scp('Allowlist', 'aperture-dev-allowlist', allowlistPolicy(), 'Dev account: only the services the dev stacks use.', true);
    scp('Guardrails', 'aperture-dev-guardrails', guardrailsPolicy(), 'Dev account: standing denies on cost levers.', true);
    scp('Freeze', 'aperture-dev-freeze', freezePolicy(), 'Dev account: function shape, table and schedules frozen.', true);
    const killScp = scp('Kill', 'aperture-dev-kill', killPolicy(), 'Dev account: deny-all, attached by the kill switch.', false);

    // Email for every trip, independent of the Lambda: the raw alarm event, the budget notice, and the Lambda's own
    // failure (its async-failure destination) — so a broken kill can't fail silently.
    const alerts = new sns.Topic(this, 'KillAlerts', { topicName: 'aperture-dev-kill-alerts', enforceSSL: true });
    alerts.addSubscription(new subscriptions.EmailSubscription(ALERT_EMAIL));

    const killFn = new NodejsFunction(this, 'KillFn', {
      functionName: 'aperture-dev-kill',
      entry: KILL_ENTRY,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(60),
      memorySize: 256,
      logGroup: new logs.LogGroup(this, 'KillLogs', { retention: logs.RetentionDays.ONE_MONTH }),
      environment: {
        KILL_POLICY_ID: killScp.attrId,
        DEV_ACCOUNT_ID: devAccountId,
        DEV_REGION,
        URL_FUNCTIONS: DEV_URL_FUNCTIONS.join(','),
      },
      onFailure: new destinations.SnsDestination(alerts),
      retryAttempts: 2,
      bundling: { format: OutputFormat.ESM, minify: true, externalModules: ['@aws-sdk/*'] }, // v3 SDK is in the runtime
    });
    killFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['organizations:AttachPolicy'],
        resources: [killScp.attrArn, `arn:aws:organizations::${this.account}:account/*/${devAccountId}`],
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
        Principal: { AWS: `arn:aws:iam::${devAccountId}:root` },
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
    const budgetTopic = new sns.Topic(this, 'BudgetKill', { topicName: 'aperture-dev-budget-kill', enforceSSL: true });
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
        { notification: actual(DEV_BUDGET_EMAIL_USD), subscribers: [{ subscriptionType: 'EMAIL', address: ALERT_EMAIL }] },
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
    Validations.of(this).acknowledge({ id: 'AwsSolutions-L1', reason: 'Node 22 is the current LTS target, the same pin as the app functions.' });

    new CfnOutput(this, 'KillPolicyId', { value: killScp.attrId }); // the unkill detaches this
    new CfnOutput(this, 'KillFunction', { value: killFn.functionName });
  }
}
