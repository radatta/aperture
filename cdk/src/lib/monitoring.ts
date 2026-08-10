import { Duration } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

// Where prod alarms land. Personal email by design — this is a personal project.
const ALERT_EMAIL = 'rahul3datta@gmail.com';

export interface MonitoringProps {
  fn: lambda.IFunction;
  timeout: Duration; // the BFF's configured timeout — the duration alarm fires at 80% of it
}

// Prod-only runtime watch on the BFF Lambda (INFRA §9) — the only thing watching prod between deploys.
// Three alarms → one SNS topic → email. Everything here is in the stack's own region (us-west-1): the
// Lambda's AWS/Lambda metrics, the alarms, and the SNS topic all co-locate, so there's no cross-region
// wiring. CloudFront 5xx is intentionally NOT alarmed (Option B) — those metrics publish only in
// us-east-1, and the post-deploy synthetic check already proves the edge path at deploy time.
// treatMissingData = NOT_BREACHING because single-user traffic leaves long gaps with no datapoints.
export class Monitoring extends Construct {
  constructor(scope: Construct, id: string, props: MonitoringProps) {
    super(scope, id);
    const { fn, timeout } = props;

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
    alarm('Errors', fn.metricErrors({ period }), 1, 'BFF Lambda returned an error');
    alarm('Throttles', fn.metricThrottles({ period }), 1, 'BFF Lambda was throttled');
    alarm(
      'DurationNearTimeout',
      fn.metricDuration({ period, statistic: 'p99' }),
      timeout.toMilliseconds() * 0.8,
      'BFF Lambda p99 duration approaching the configured timeout',
    );
  }
}
