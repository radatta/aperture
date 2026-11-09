import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

export const DEV_MAX_READ_UNITS = 100;
export const DEV_MAX_WRITE_UNITS = 50;

export interface DataStackProps extends StackProps {
  stage: string;
  // Origins allowed to PUT/GET the files bucket directly (presigned uploads/downloads bypass CloudFront).
  // The custom domain when the stage has one, else '*' (the presigned URL is the real credential; CORS is
  // a browser courtesy). Lives here, not the app stack, because app depends on data — the reverse edge
  // would be a stack cycle.
  allowedOrigins: string[];
}

// The PRECIOUS stack (INFRA §3): your data + your identity. RETAIN on everything, PITR on, deployed
// rarely — an app redeploy can never touch it. The app stack references the table + pool + files bucket
// from here.
export class ApertureDataStack extends Stack {
  readonly table: dynamodb.Table;
  readonly userPool: cognito.UserPool;
  readonly filesBucket: s3.Bucket;
  // The hosted-UI host (no scheme), e.g. aperture-dev-<acct>.auth.us-west-1.amazoncognito.com. The app
  // stack's MCP OAuth façade builds Cognito's /oauth2 endpoints from it. `<acct>` is a token when the
  // account isn't pinned — fine as a Lambda env value (CloudFormation resolves it at deploy).
  readonly cognitoDomain: string;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { stage, allowedOrigins } = props;

    // dev's on-demand ceiling (INFRA §11): caps what branch code in the dev account can spend on the table, and
    // the dev account's SCP denies UpdateTable, so it can't lift the cap. Prod stays uncapped — no agent reaches
    // it, and a cap there would only throttle a large finance sync.
    const devThroughput =
      stage === 'dev'
        ? { maxReadRequestUnits: DEV_MAX_READ_UNITS, maxWriteRequestUnits: DEV_MAX_WRITE_UNITS }
        : {};
    // Single table (TECH §2.4): PK/SK strings, on-demand, PITR (35-day backup), RETAIN.
    this.table = new dynamodb.Table(this, 'Table', {
      tableName: `aperture-${stage}`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
      ...devThroughput,
      // TTL on `expiresAt`, both stages (TECH §2.3). Dev's Lambda stamps it on tombstones; on prod the only
      // rows that ever carry it are a LeetCode sitting's raw bulk — snapshots, replay, submit details —
      // 14 days past the sitting's ingest window (docs/areas/recruiting). Enabling TTL is free, and so are
      // its deletes.
      timeToLiveAttribute: 'expiresAt',
    });
    // GSI1 — done tasks by completion time (calibration window read). GSI1SK is numeric epoch-ms.
    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
      ...devThroughput,
    });

    // Cognito pool (INFRA §6): invite-only (self-signup OFF — you admin-create your user), email login.
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `aperture-${stage}`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // Hosted UI domain (free Cognito prefix; the login page). Account-suffixed for global uniqueness —
    // override via `-c cognitoPrefix=...` if the default is taken.
    const prefix =
      (this.node.tryGetContext('cognitoPrefix') as string | undefined) ??
      `aperture-${stage}-${this.account}`;
    this.userPool.addDomain('HostedUi', { cognitoDomain: { domainPrefix: prefix } });
    this.cognitoDomain = `${prefix}.auth.${this.region}.amazoncognito.com`;

    // User-uploaded task attachments. Unlike the app stack's Site bucket (DESTROY, re-syncable assets),
    // this is precious: RETAIN + versioned (the undo for an overwritten/deleted object), fully private —
    // the browser only ever reaches it through short-lived presigned URLs. CORS is required because those
    // presigned PUT/GET go straight to S3, not through CloudFront.
    this.filesBucket = new s3.Bucket(this, 'Files', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: RemovalPolicy.RETAIN, // and deliberately NO autoDeleteObjects
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins,
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 3600,
        },
      ],
      lifecycleRules: [
        { abortIncompleteMultipartUploadAfter: Duration.days(1) },
        { noncurrentVersionExpiration: Duration.days(30) }, // bound the cost of versioning
      ],
    });

    new CfnOutput(this, 'FilesBucket', { value: this.filesBucket.bucketName });
    new CfnOutput(this, 'TableName', { value: this.table.tableName });
    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new CfnOutput(this, 'Region', { value: this.region });
    new CfnOutput(this, 'CognitoAuthority', {
      value: `https://cognito-idp.${this.region}.amazonaws.com/${this.userPool.userPoolId}`,
    });
  }
}
