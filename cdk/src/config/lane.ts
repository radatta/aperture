import { DefaultStackSynthesizer } from 'aws-cdk-lib';
import { DEVMAIN_QUALIFIER, STOCK_QUALIFIER } from './devAccount';

export type Lane = '' | typeof DEVMAIN_QUALIFIER;

// Which CDK bootstrap a dev deploy goes through (INFRA §2, docs/ops/CI-BOT.md → Two lanes). '' is the stock bootstrap
// the freeze binds (bot dispatches, `dev` pushes); 'devmain' is main's own dev deploy, through the second bootstrap
// whose execution role the freeze exempts. deploy-stage.yml sets APERTURE_DEPLOY_LANE; prod never has one.
export function laneFor(stage: string, raw = process.env.APERTURE_DEPLOY_LANE ?? ''): Lane {
  const lane = raw.trim();
  if (lane !== '' && lane !== DEVMAIN_QUALIFIER)
    throw new Error(`APERTURE_DEPLOY_LANE must be empty or '${DEVMAIN_QUALIFIER}', got '${lane}'`);
  if (lane && stage !== 'dev')
    throw new Error(`APERTURE_DEPLOY_LANE is dev-only, but the stage is '${stage}'`);
  return lane;
}

// A fresh synthesizer per stack (one can't be shared). The default lane gets none, so its templates stay exactly as
// CDK's default writes them. The devmain lane deploys through devmain's deploy, exec and lookup roles and checks
// devmain's version parameter (its deploy role may read only that one), but publishes to the stock bootstrap's
// bucket through the stock publishing role: with its own bucket, every function's Code would change on each lane
// switch, and the freeze denies the bot lane new code on CDK's provider functions.
export function synthesizerFor(lane: Lane): DefaultStackSynthesizer | undefined {
  if (!lane) return undefined;
  return new DefaultStackSynthesizer({
    qualifier: lane,
    fileAssetsBucketName: `cdk-${STOCK_QUALIFIER}-assets-\${AWS::AccountId}-\${AWS::Region}`,
    fileAssetPublishingRoleArn: `arn:\${AWS::Partition}:iam::\${AWS::AccountId}:role/cdk-${STOCK_QUALIFIER}-file-publishing-role-\${AWS::AccountId}-\${AWS::Region}`,
  });
}
