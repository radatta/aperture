import { CfnOutput, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import type { Construct } from 'constructs';

// Where cost alerts land. Personal email by design — this is a personal project.
const ALERT_EMAIL = 'rahul3datta@gmail.com';

// Cost guardrails — deployed ONCE BY HAND, never by the pipeline:
//   cdk deploy ApertureBilling -c billing=true
// Creating a budget requires the account-ROOT "IAM access to Billing and Cost Management" toggle to be
// enabled first — a setting the scoped OIDC deploy roles don't (and shouldn't) have, which is exactly why
// this is a one-off like ApertureCicd. Notification-only budgets are free (only auto-remediating "budget
// actions" cost anything). Confirm the email subscription once after the first deploy.
//
// NB: Cost Anomaly Detection is deliberately NOT in this stack. AWS auto-creates a default account-wide
// SERVICE-dimension monitor and allows only one per dimension, so a CfnAnomalyMonitor here fails with
// AlreadyExists. The $1/$5 budget below is the real guard at single-user scale; if an anomaly email is
// ever wanted, attach a (free) alert subscription to the existing default monitor in the console.
export class ApertureBillingStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Fixed tripwire: email at $1 actual spend, and again if the monthly forecast crosses $5. Normal spend
    // is pennies, so these are deliberately low. Absolute dollars, not %, because % of pennies is meaningless.
    new budgets.CfnBudget(this, 'CostBudget', {
      budget: { budgetType: 'COST', timeUnit: 'MONTHLY', budgetLimit: { amount: 5, unit: 'USD' } },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 1,
            thresholdType: 'ABSOLUTE_VALUE',
          },
          subscribers: [{ subscriptionType: 'EMAIL', address: ALERT_EMAIL }],
        },
        {
          notification: {
            notificationType: 'FORECASTED',
            comparisonOperator: 'GREATER_THAN',
            threshold: 5,
            thresholdType: 'ABSOLUTE_VALUE',
          },
          subscribers: [{ subscriptionType: 'EMAIL', address: ALERT_EMAIL }],
        },
      ],
    });

    new CfnOutput(this, 'BillingNote', {
      value:
        'Confirm the budget email once; requires the root billing-access toggle enabled first.',
    });
  }
}
