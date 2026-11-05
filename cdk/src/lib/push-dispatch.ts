import { fileURLToPath } from 'node:url';
import { Duration, RemovalPolicy, Stack, Validations } from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import { Construct } from 'constructs';

const DISPATCH_ENTRY = fileURLToPath(
  new URL('../../../lambdas/src/pushDispatch.ts', import.meta.url),
);

// 20 s, under the schedule's 60 s rate, so two ticks never overlap — on dev, where no concurrency can be
// reserved, that is the structural cap. The handler starts no send in its last 7 s (TICK_SAFETY_MS), and
// each send is capped at 5 s (livePush.ts).
export const PUSH_DISPATCH_TIMEOUT = Duration.seconds(20);

export interface PushDispatchProps {
  stage: string;
  table: dynamodb.Table;
  appUrl: string; // the stage's app origin: every tap-through link, and the VAPID `sub` (D13)
  vapidPrivateKeyArn: string; // arn:…:parameter/aperture/<stage>/push/vapid_private_key — nothing wider
}

// The reminder poller (lambdas/src/pushDispatch.ts, reminders.md): every minute, EventBridge Scheduler
// invokes it to send what's due as Web Push. No Function URL — it never serves HTTP — and no user id in
// its input: it ticks over the push registry. The only holder of the VAPID private key. Cost bound
// (INFRA §11): steady ≈ 43,200 × ~0.3 s × 0.25 GB a month; a tick stuck at its timeout every minute ≈
// $0.12/day of compute, sends capped by the per-user daily guard.
export class PushDispatch extends Construct {
  readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: PushDispatchProps) {
    super(scope, id);
    const { stage, table, appUrl, vapidPrivateKeyArn } = props;
    const { account } = Stack.of(this);

    // Created here (not left to Lambda) so it gets a retention; safe because the group is new.
    const logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: `/aws/lambda/aperture-push-dispatch-${stage}`,
      retention: stage === 'prod' ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.fn = new NodejsFunction(this, 'Fn', {
      functionName: `aperture-push-dispatch-${stage}`,
      entry: DISPATCH_ENTRY,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: PUSH_DISPATCH_TIMEOUT,
      memorySize: 256,
      logGroup,
      // Prod: one tick at a time, whatever happens. Dev can't reserve any (its quota leaves no room, and the
      // guardrails SCP denies it — org-stack.ts); there timeout < rate is the cap.
      ...(stage === 'prod' ? { reservedConcurrentExecutions: 1 } : {}),
      environment: { TABLE_NAME: table.tableName, STAGE: stage, APP_URL: appUrl },
      bundling: { format: OutputFormat.ESM, minify: true, externalModules: ['@aws-sdk/*'] },
    });
    // Never retried by Lambda: fail-closed by design (D3) — a reminder's dedup row is written before its
    // send, so a retry would only re-spend a tick; a missed tick is caught up by the next one's window.
    this.fn.configureAsyncInvoke({ retryAttempts: 0, maxEventAge: Duration.minutes(1) });

    // Exactly what a tick does: point reads (consistent), conditional puts, begins_with + GSI1 queries, and
    // deletes (a gone device, swept dedup rows, a sent test). No UpdateItem / BatchWrite. GSI1 is named.
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:DeleteItem'],
        resources: [table.tableArn, `${table.tableArn}/index/GSI1`],
      }),
    );
    // The private key, read only (the operator writes it). SecureString under the default aws/ssm key
    // needs no KMS statement.
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [vapidPrivateKeyArn] }),
    );
    // cdk-nag matches acks by id across the app, so this duplicates the BFF's; kept so the function states
    // its own. No IAM5: every resource above is exact.
    this.fn.node.addMetadata(Validations.ACKNOWLEDGED_RULES_METADATA_KEY, {
      'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]':
        'AWSLambdaBasicExecutionRole is the standard CloudWatch Logs managed policy.',
    });

    // Every minute, never retried. L1 with its own role so the invoke grant is the exact function ARN, in
    // its own one-schedule group: Scheduler checks the trust policy's SourceArn against the group's ARN,
    // so only this schedule may assume the role (confused-deputy guard, as finance-sync.ts).
    const group = new scheduler.CfnScheduleGroup(this, 'ScheduleGroup', {
      name: `aperture-push-${stage}`,
    });
    const role = new iam.Role(this, 'ScheduleRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com', {
        conditions: {
          StringEquals: {
            'aws:SourceAccount': account,
            'aws:SourceArn': group.attrArn,
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
      name: `aperture-push-dispatch-${stage}`,
      groupName: group.ref,
      scheduleExpression: 'rate(1 minute)',
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: this.fn.functionArn,
        roleArn: role.roleArn,
        input: JSON.stringify({ mode: 'tick' }),
        retryPolicy: { maximumRetryAttempts: 0, maximumEventAgeInSeconds: 60 },
      },
    });
  }
}
