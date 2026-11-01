import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { ApertureDevGuardStack, KILL_ALARMS } from './lib/dev-guard-stack';

type Resource = { Type: string; Properties: Record<string, unknown> };

describe('ApertureDevGuardStack (the dev account half of the kill switch)', () => {
  const app = new App();
  const t = Template.fromStack(
    new ApertureDevGuardStack(app, 'ApertureDevGuard', {
      env: { account: '222222222222', region: 'us-west-1' },
      mgmtAccountId: '111111111111',
    }),
  );
  const res = Object.values(t.toJSON().Resources as Record<string, Resource>);
  const of = (type: string) => res.filter((r) => r.Type === type).map((r) => r.Properties);

  // Prod has five alarms; CloudWatch's free tier is ten (shared across the org's consolidated bill), so five is the most.
  it('has five account-wide kill alarms, all named for the prefix the SCPs and the rule match', () => {
    const alarms = of('AWS::CloudWatch::Alarm');
    expect(alarms).toHaveLength(5);
    expect(alarms.map((a) => a.Period)).toEqual([60, 3600, 10800, 60, 60]);
    expect(alarms.map((a) => a.Threshold)).toEqual([600_000, 600_000, 300_000, 3_000, 100 * 1024 * 1024]);
    expect(alarms.map((a) => a.AlarmName)).toEqual(KILL_ALARMS.map((a) => a.name));
    for (const a of alarms) {
      expect(a.AlarmName).toMatch(/^aperture-kill-/);
      expect(a.Dimensions).toBeUndefined(); // across all functions/groups, so nothing escapes by name
      expect(a.AlarmActions).toBeUndefined(); // the state change itself is the signal (EventBridge)
    }
  });

  // A window over a day switches CloudWatch to hourly evaluation; at or under it, every alarm is checked each minute.
  it('keeps every alarm evaluated each minute (window of a day at most)', () => {
    for (const a of of('AWS::CloudWatch::Alarm'))
      expect((a.Period as number) * (a.EvaluationPeriods as number)).toBeLessThanOrEqual(86_400);
  });

  it("forwards only kill-alarm ALARM transitions, to the management account's us-east-1 default bus", () => {
    const [rule] = of('AWS::Events::Rule');
    expect(rule?.EventPattern).toMatchObject({
      source: ['aws.cloudwatch'],
      detail: { alarmName: [{ prefix: 'aperture-kill-' }], state: { value: ['ALARM'] } },
    });
    expect((rule?.Targets as { Arn: string }[]).map((x) => x.Arn)).toEqual([
      'arn:aws:events:us-east-1:111111111111:event-bus/default',
    ]);
  });

  it('forwards through a role named for the prefix the SCPs exempt and protect', () => {
    expect(of('AWS::IAM::Role').map((r) => r.RoleName)).toEqual(['aperture-kill-forwarder']);
  });
});
