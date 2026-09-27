import { fileURLToPath } from 'node:url';
import { Duration, RemovalPolicy, Stack, Validations } from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import { Construct } from 'constructs';

const SYNC_ENTRY = fileURLToPath(new URL('../../../lambdas/src/financeSync.ts', import.meta.url));

// 300 s. The handler's deadline is this minus RUN_SAFETY_MS (10 s) = 290 s = RUN_BUDGET_MS, under the
// 300 s FINANCE_SYNC_LOCK_MS, so a run can't outlive its lock. Never below ~180 s: claiming a refresh
// needs 160 s of room (2 × PASS_RESERVE_MS + one poll), so a shorter timeout would never refresh.
export const FINANCE_SYNC_TIMEOUT = Duration.seconds(300);

export interface FinanceSyncProps {
  stage: string;
  table: dynamodb.Table;
  plaidEnv: 'sandbox' | 'production';
  plaidSsmBase: string; // arn:…:parameter/aperture/<stage>/plaid
  deviceUserId?: string; // the Cognito sub the schedule syncs; unset → no schedule
}

// The finance sync Lambda (lambdas/src/financeSync.ts): invoked async by the BFF (Refresh / connect /
// reconnect) and by EventBridge Scheduler 4×/day. No Function URL — it never serves HTTP. Cost at
// single-user: ≤ 4 × 300 s × 0.5 GB/day, well inside the free tier (INFRA §11).
export class FinanceSync extends Construct {
  readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: FinanceSyncProps) {
    super(scope, id);
    const { stage, table, plaidEnv, plaidSsmBase, deviceUserId } = props;
    const { partition, region, account } = Stack.of(this);

    // Created here (not left to Lambda) so it gets a retention; safe because the group is new.
    const logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: `/aws/lambda/aperture-finance-sync-${stage}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.fn = new NodejsFunction(this, 'Fn', {
      functionName: `aperture-finance-sync-${stage}`,
      entry: SYNC_ENTRY,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: FINANCE_SYNC_TIMEOUT,
      memorySize: 512,
      logGroup,
      environment: { TABLE_NAME: table.tableName, STAGE: stage, PLAID_ENV: plaidEnv },
      bundling: { format: OutputFormat.ESM, minify: true, externalModules: ['@aws-sdk/*'] },
    });
    // Never retried by Lambda: a failed run is already stamped for the page, and a retry would re-spend
    // a refresh. A dropped event is harmless — the stored request waits for the next run. No reserved
    // concurrency: the per-item CAS lock is the concurrency control (a second run exits "locked").
    this.fn.configureAsyncInvoke({ retryAttempts: 0, maxEventAge: Duration.minutes(1) });

    // Exactly what the sync does: consistent point reads, conditional puts, begin_with queries. No
    // UpdateItem / DeleteItem / BatchWrite. GSI1 is named, not index/*.
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query'],
        resources: [table.tableArn, `${table.tableArn}/index/GSI1`],
      }),
    );
    // Plaid credentials + each item's access token: read only (the BFF writes/deletes the tokens).
    // SecureString under the default aws/ssm key needs no KMS statement.
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          `${plaidSsmBase}/client_id`,
          `${plaidSsmBase}/secret`,
          `${plaidSsmBase}/items/*`,
        ],
      }),
    );
    // cdk-nag matches acks by id across the whole app, so this duplicates the BFF's; kept so each
    // function states its own wildcard. The IAM statements, not the acks, do the scoping.
    this.fn.node.addMetadata(Validations.ACKNOWLEDGED_RULES_METADATA_KEY, {
      'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]':
        'AWSLambdaBasicExecutionRole is the standard CloudWatch Logs managed policy.',
      [`AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:ssm:${region}:<AWS::AccountId>:parameter/aperture/${stage}/plaid/items/*]`]:
        'Per-item Plaid access tokens live at .../plaid/items/<itemId>/access_token; the dynamic <itemId> needs the trailing wildcard.',
    });

    // The scheduled sync: 6:15a / 11:15a / 4:15p / 9:15p LA. L1 with its own role so the invoke grant is
    // the exact function ARN (the L2 target grants `arn:*`, another hash-embedded cdk-nag ack). Gated on
    // deviceUserId, like DEVICE_USER_ID: without it there's no user to sync.
    if (!deviceUserId) return;
    const role = new iam.Role(this, 'ScheduleRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com', {
        // Only this schedule may assume it (confused-deputy guard), not any schedule in the account.
        conditions: {
          StringEquals: { 'aws:SourceAccount': account },
          ArnLike: {
            'aws:SourceArn': `arn:${partition}:scheduler:${region}:${account}:schedule/default/aperture-finance-sync-${stage}`,
          },
        },
      }),
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [this.fn.functionArn],
      }),
    );
    new scheduler.CfnSchedule(this, 'Schedule', {
      name: `aperture-finance-sync-${stage}`,
      scheduleExpression: 'cron(15 6,11,16,21 * * ? *)',
      scheduleExpressionTimezone: 'America/Los_Angeles',
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: this.fn.functionArn,
        roleArn: role.roleArn,
        input: JSON.stringify({ userId: deviceUserId, mode: 'scheduled' }),
        retryPolicy: { maximumRetryAttempts: 0, maximumEventAgeInSeconds: 60 },
      },
    });
  }
}
