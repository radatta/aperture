import { Duration } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

// Where prod alarms land. Personal email by design — this is a personal project.
const ALERT_EMAIL = 'rahul3datta@gmail.com';

export interface MonitoredFunction {
  id: string; // alarm-id prefix; '' for the BFF keeps its original ids (Errors, Throttles, …)
  label: string;
  fn: lambda.IFunction;
  durationAlarm: { statistic: string; thresholdMs: number };
}

export interface MonitoringProps {
  functions: MonitoredFunction[];
}

// Prod-only runtime watch on the Lambdas (INFRA §9) — the only thing watching prod between deploys.
// Two alarms per function plus one account-wide throttle alarm → one SNS topic (one email confirmation)
// → email. Everything here is in the stack's own region (us-west-1): the Lambda's AWS/Lambda metrics, the alarms, and the SNS topic
// all co-locate, so there's no cross-region wiring. CloudFront 5xx is intentionally NOT alarmed
// (Option B) — those metrics publish only in us-east-1, and the post-deploy synthetic check already
// proves the edge path at deploy time.
// treatMissingData = NOT_BREACHING because single-user traffic leaves long gaps with no datapoints.
export class Monitoring extends Construct {
  constructor(scope: Construct, id: string, props: MonitoringProps) {
    super(scope, id);

    const topic = new sns.Topic(this, 'AlarmTopic', { displayName: 'Aperture prod alarms', enforceSSL: true });
    topic.addSubscription(new subscriptions.EmailSubscription(ALERT_EMAIL));
    const action = new cw_actions.SnsAction(topic);

    const alarm = (id: string, metric: cloudwatch.IMetric, threshold: number, alarmDescription: string) => {
      const a = new cloudwatch.Alarm(this, id, {
        metric,
        threshold,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription,
      });
      a.addAlarmAction(action);
    };

    const period = Duration.minutes(5);
    for (const { id: p, label, fn, durationAlarm } of props.functions) {
      alarm(`${p}Errors`, fn.metricErrors({ period }), 1, `${label} Lambda returned an error`);
      alarm(
        p ? `${p}DurationOverBudget` : 'DurationNearTimeout',
        fn.metricDuration({ period, statistic: durationAlarm.statistic }),
        durationAlarm.thresholdMs,
        `${label} Lambda ${durationAlarm.statistic} duration near its timeout`,
      );
    }
    // One account-wide throttle alarm, not one per function: with dev in its own account nothing else shares prod's
    // concurrency, so a throttle anywhere is the signal, and the freed slot keeps the org inside the free ten alarms
    // (dev-guard-stack.ts). The id is the BFF's old one, so that alarm updates in place.
    alarm(
      'Throttles',
      new cloudwatch.Metric({ namespace: 'AWS/Lambda', metricName: 'Throttles', statistic: 'Sum', period }),
      1,
      'A Lambda in this account was throttled',
    );
  }
}
