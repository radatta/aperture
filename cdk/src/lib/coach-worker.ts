import { fileURLToPath } from 'node:url';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { reservedConcurrency } from '../config/devAccount';

const WORKER_ENTRY = fileURLToPath(new URL('../../../lambdas/src/coachWorker.ts', import.meta.url));

// 90 s: up to ~20 s queued before the run, a 60 s model call, then the writes. The caller's stale-claim read is
// 120 s, above it, so a claim is never taken over while its run can still finish. The freeze holds a deployed
// timeout still (docs/ops/CI-BOT.md → What's capped), so a branch can't retune it — main can.
export const COACH_WORKER_TIMEOUT = Duration.seconds(90);

export interface CoachWorkerProps {
  stage: string;
  table: dynamodb.Table;
  anthropicKeyArn: string; // arn:…:parameter/aperture/<stage>/anthropic/api_key — nothing wider
}

// The LeetCode coach's worker (lambdas/src/coachWorker.ts): the AI pick runs here, invoked async by the BFF and the
// MCP function, at most once a day a user. Its own function so the model call stays out of the request path and
// away from finance-sync's Plaid grants. No Function URL, no schedule. Cost at single-user: ≤ 1 × 90 s × 0.5 GB a
// day, inside the free tier (INFRA §11). No alarm of its own: the org's free ten are full, so the account-wide
// Lambda Errors alarm covers it, a timeout included (app-stack.ts → Monitoring).
export class CoachWorker extends Construct {
  readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: CoachWorkerProps) {
    super(scope, id);
    const { stage, table, anthropicKeyArn } = props;
    const name = `aperture-coach-worker-${stage}`;

    // Created here (not left to Lambda) so it gets a retention; safe because the group is new.
    const logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: `/aws/lambda/${name}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    // Its own role, without AWSLambdaBasicExecutionRole, for push-dispatch.ts's reason: that policy's
    // logs:CreateLogGroup lets a run still going as a deploy deletes the function re-create the group outside the
    // stack, and the orphan fails every later deploy by name. The stack owns the group; the function only writes.
    const fnRole = new iam.Role(this, 'FnRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    logGroup.grantWrite(fnRole);
    this.fn = new NodejsFunction(this, 'Fn', {
      functionName: name,
      role: fnRole,
      entry: WORKER_ENTRY,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: COACH_WORKER_TIMEOUT,
      memorySize: 512,
      logGroup,
      ...reservedConcurrency(stage, name),
      environment: { TABLE_NAME: table.tableName, STAGE: stage },
      bundling: { format: OutputFormat.ESM, minify: true, externalModules: ['@aws-sdk/*'] },
    });
    // One call a day, never retried by Lambda: a retry would re-spend a model call. A dropped or failed run leaves
    // its claim to go stale, and the caller's stale-claim read takes it over.
    this.fn.configureAsyncInvoke({ retryAttempts: 0, maxEventAge: Duration.minutes(1) });

    // Consistent point reads, conditional puts, begins_with queries — writes only via conditional puts. No
    // UpdateItem / DeleteItem / BatchWrite. GSI1 is named, not index/*.
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query'],
        resources: [table.tableArn, `${table.tableArn}/index/GSI1`],
      }),
    );
    // The Claude API key, read only (the operator writes it). SecureString under the default aws/ssm key needs no
    // KMS statement.
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [anthropicKeyArn] }),
    );
  }
}
