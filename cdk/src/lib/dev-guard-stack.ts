import { Duration, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { KILL_ALARM_PREFIX, KILL_FORWARDER_ROLE } from '../config/devAccount';

export interface DevGuardStackProps extends StackProps {
  mgmtAccountId: string; // where ApertureOrg's kill Lambda listens (us-east-1 default bus)
}

// One alarm per lever the SCPs can't cap, account-wide (no function dimension), so a function the freeze let through
// is still counted. Thresholds sit well above a full devcheck; re-tune from a measured run (docs/ops/CI-BOT.md →
// Kill switch). Four alarms keep the account inside CloudWatch's free 10 together with prod's six.
export const KILL_ALARMS = [
  // Busy environments: the account-wide Duration sum. 600,000 ms a minute is ten environments busy for the whole
  // minute — a pinger or a loop, never a page load.
  {
    name: `${KILL_ALARM_PREFIX}duration`,
    namespace: 'AWS/Lambda',
    metricName: 'Duration',
    threshold: 600_000,
    minutes: 1,
    periods: 2,
  },
  // The slow drain the per-minute alarm misses: one environment kept busy, or a sparse loop holding the table at its
  // cap. 600,000 ms an hour is ten minutes of compute — far past a dev session's.
  {
    name: `${KILL_ALARM_PREFIX}duration-hour`,
    namespace: 'AWS/Lambda',
    metricName: 'Duration',
    threshold: 600_000,
    minutes: 60,
    periods: 1,
  },
  // Call rate: a loop of short calls the Duration alarms would miss.
  {
    name: `${KILL_ALARM_PREFIX}invocations`,
    namespace: 'AWS/Lambda',
    metricName: 'Invocations',
    threshold: 3_000,
    minutes: 1,
    periods: 1,
  },
  // Log ingest is $0.50/GB with no cap anywhere in AWS: 100 MB in a minute is far past any real dev log volume.
  {
    name: `${KILL_ALARM_PREFIX}log-bytes`,
    namespace: 'AWS/Logs',
    metricName: 'IncomingBytes',
    threshold: 100 * 1024 * 1024,
    minutes: 1,
    periods: 1,
  },
] as const;

// The dev account's half of the kill switch (docs/ops/CI-BOT.md → Kill switch): the alarms, and a rule forwarding
// their ALARM transitions to the management account, where ApertureOrg's Lambda attaches the deny-all SCP. Nothing
// here acts on dev itself, so nothing here is worth tampering with to dodge a kill — and the SCPs keep CloudWatch and
// EventBridge writes, and the forwarder role, to the break-glass role anyway. Hand-deployed before ApertureOrg attaches
// the SCPs, and after that only with all three standing SCPs detached (the allowlist denies the CloudFormation
// execution role CloudWatch and EventBridge writes, the guardrails deny it the forwarder role, the freeze CreateRole):
// `cdk deploy ApertureDevGuard -c devGuard=true -c devAccountId=… -c mgmtAccountId=… --profile aperture-dev`.
export class ApertureDevGuardStack extends Stack {
  constructor(scope: Construct, id: string, props: DevGuardStackProps) {
    super(scope, id, props);

    for (const a of KILL_ALARMS)
      new cloudwatch.Alarm(this, a.name, {
        alarmName: a.name,
        metric: new cloudwatch.Metric({
          namespace: a.namespace,
          metricName: a.metricName,
          statistic: 'Sum',
          period: Duration.minutes(a.minutes),
        }),
        threshold: a.threshold,
        evaluationPeriods: a.periods,
        datapointsToAlarm: a.periods,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING, // single-user traffic leaves long gaps
        alarmDescription: 'Trips the dev kill switch (ApertureOrg) on ALARM.',
      });

    const forwarder = new iam.Role(this, 'Forwarder', {
      roleName: KILL_FORWARDER_ROLE,
      assumedBy: new iam.ServicePrincipal('events.amazonaws.com'),
    });
    new events.Rule(this, 'Forward', {
      ruleName: `${KILL_ALARM_PREFIX}forward`,
      eventPattern: {
        source: ['aws.cloudwatch'],
        detailType: ['CloudWatch Alarm State Change'],
        detail: { alarmName: [{ prefix: KILL_ALARM_PREFIX }], state: { value: ['ALARM'] } },
      },
      targets: [
        new targets.EventBus(
          events.EventBus.fromEventBusArn(
            this,
            'MgmtBus',
            `arn:aws:events:us-east-1:${props.mgmtAccountId}:event-bus/default`,
          ),
          { role: forwarder },
        ),
      ],
    });
  }
}
