import { DefaultStackSynthesizer } from 'aws-cdk-lib';
import { isDevSlot } from '@aperture/shared';
import { DEVMAIN_QUALIFIER } from './devAccount';

export type Lane = '' | typeof DEVMAIN_QUALIFIER;

// Which CDK bootstrap a dev deploy goes through (INFRA §2, docs/ops/CI-BOT.md → Two lanes). '' is the stock bootstrap
// the freeze binds (bot dispatches); 'devmain' is main's own dev deploy, through the second bootstrap
// whose execution role the freeze exempts. deploy-stage.yml sets APERTURE_DEPLOY_LANE; prod never has one.
export function laneFor(stage: string, raw = process.env.APERTURE_DEPLOY_LANE ?? ''): Lane {
  const lane = raw.trim();
  if (lane !== '' && lane !== DEVMAIN_QUALIFIER)
    throw new Error(`APERTURE_DEPLOY_LANE must be empty or '${DEVMAIN_QUALIFIER}', got '${lane}'`);
  if (lane && !isDevSlot(stage))
    throw new Error(`APERTURE_DEPLOY_LANE is dev-only, but the stage is '${stage}'`);
  return lane;
}

// A fresh synthesizer per stack (one can't be shared). The default lane gets none, so its templates stay exactly as
// CDK's default writes them. The devmain lane is wholly its own bootstrap — roles, version parameter and asset bucket:
// the bot lane can write the stock bucket, so a shared one would let it plant the template or code main's lane deploys
// (cdk-assets skips a key that already exists). The guardrails keep everything but break-glass and devmain's
// publishing role off devmain's bucket (org-stack.ts → DevMainBootstrapIntact).
export function synthesizerFor(lane: Lane): DefaultStackSynthesizer | undefined {
  return lane ? new DefaultStackSynthesizer({ qualifier: lane }) : undefined;
}
