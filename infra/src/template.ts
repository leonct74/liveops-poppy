// LiveOpsPoppy's CloudFormation template, authored as typed TypeScript.
//
// WHY NOT CDK (TrafficPoppy's P0 decision, inherited): the whole footprint is one table
// + one Lambda + a Function URL + its role — small enough to author directly, which
// removes the cdk dependency and the synth step from the build. The output is an
// asset-free template JSON that scripts/build-backend-bundle.mjs embeds into the backend.
//
// EVERYTHING LIVES IN THIS ONE STACK (AGENTS.md §4 "the easy path"): deleting the stack
// removes the whole footprint, so teardown can't leak. Nothing gets DeletionPolicy:
// Retain, and deletion protection stays off — both would make our own teardown fail.

/** The one stack we deploy. The manifest's cloudformation grant is scoped to this exact name. */
export const STACK_NAME = "LiveOpsPoppyStack";

/**
 * The game-data table. A fixed name (rather than a CloudFormation-generated one) because
 * the schema is a documented, stable, public surface — the studio's own BI tools query
 * this table by name (DESIGN.md §1.3). It matches the manifest's `LiveOpsPoppy*` scope.
 */
export const TABLE_NAME = "LiveOpsPoppyData";

/** The attribute holding a row's expiry — uniq rows (~40 d) and player rows (~13 months). */
export const TTL_ATTRIBUTE = "expiresAt";

/** Fixed names, all under the `LiveOpsPoppy*` prefix the manifest's grants are scoped to. */
export const FUNCTION_NAME = "LiveOpsPoppyCollector";
export const ROLE_NAME = "LiveOpsPoppyCollectorRole";
/** The Lambda runtime's handler entrypoint: <bundled-file>.<export>. */
export const LAMBDA_HANDLER = "collector.handler";
export const LAMBDA_RUNTIME = "nodejs20.x";

/**
 * Monotonic template revision. Bump on EVERY template change that must reach deployed
 * stacks. Exposed as a stack Output so "update available" can be ORDERING-AWARE: an older
 * app sees deployed-revision > embedded-revision and must never offer a downgrade
 * (MailPoppy's 2026-07-29 plain-inequality footgun, designed out from day one).
 */
export const TEMPLATE_REVISION = 1;

export interface CfnTemplate {
  AWSTemplateFormatVersion: string;
  Description: string;
  Parameters?: Record<string, unknown>;
  Resources: Record<string, unknown>;
  Outputs: Record<string, unknown>;
}

/**
 * Build the template. Pure — same input, same bytes — so the content-addressed hash the
 * build script derives from it is stable across machines.
 *
 * Single-table design (IMPLEMENTATION.md §3 — those key literals are the public contract):
 *   config, daily counters, DAU uniques (TTL'd), player first/last-seen (TTL'd), cohorts.
 * The TTL attribute is declared from day one so expiry is part of the table from the
 * moment it exists, not bolted on by a later stack update that could silently fail.
 */
export function buildTemplate(): CfnTemplate {
  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Description: "LiveOpsPoppy — your game's remote config + telemetry, running entirely in your own AWS.",
    // The Lambda code lives in the per-account deploy bucket the backend uploads to before
    // deploying. Passed as parameters so the content-addressed key changes whenever the
    // collector changes — CloudFormation then sees a real update instead of NO_CHANGE.
    Parameters: {
      LambdaCodeBucket: { Type: "String", Description: "S3 bucket holding the collector code zip." },
      LambdaCodeKey: { Type: "String", Description: "S3 key of the collector code zip (content-addressed)." },
    },
    Resources: {
      DataTable: {
        Type: "AWS::DynamoDB::Table",
        Properties: {
          TableName: TABLE_NAME,
          // On-demand: nothing provisioned, so an idle game bills ~$0 (DESIGN.md §1.1).
          BillingMode: "PAY_PER_REQUEST",
          AttributeDefinitions: [
            { AttributeName: "pk", AttributeType: "S" },
            { AttributeName: "sk", AttributeType: "S" },
          ],
          KeySchema: [
            { AttributeName: "pk", KeyType: "HASH" },
            { AttributeName: "sk", KeyType: "RANGE" },
          ],
          // CloudFormation enables TTL with a SEPARATE dynamodb:UpdateTimeToLive call after
          // CreateTable (and reads it back with DescribeTimeToLive) — so the manifest MUST
          // grant both, or the stack creates the table then rolls back on AccessDenied.
          // This only shows up on a live deploy; keep these two in lockstep with
          // extension.json. (TrafficPoppy live-deploy lesson.)
          TimeToLiveSpecification: { AttributeName: TTL_ATTRIBUTE, Enabled: true },
          // Deliberately absent: DeletionProtectionEnabled. CloudFormation cannot delete a
          // protected table, which would break leaves-no-trace (AGENTS.md §4).
        },
      },

      // The collector's execution role — a NAMED role (LiveOpsPoppyCollectorRole) so the
      // manifest's iam grant can be scoped to role/LiveOpsPoppy* rather than "*". It grants
      // the LEAST: write its own log group, and read/write ONLY the data table. No Query,
      // no Scan, no Delete — the collector only ever GetItem/PutItem/UpdateItem
      // (IMPLEMENTATION.md §4); the admin plane runs on broker-vended creds instead.
      CollectorRole: {
        Type: "AWS::IAM::Role",
        Properties: {
          RoleName: ROLE_NAME,
          AssumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [
              { Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" },
            ],
          },
          Policies: [
            {
              PolicyName: "collector",
              PolicyDocument: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
                    Resource: { "Fn::GetAtt": ["DataTable", "Arn"] },
                  },
                  {
                    Effect: "Allow",
                    Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
                    // Construct the log-group ARN by name rather than Fn::GetAtt on the
                    // LogGroup: resolving a LogGroup's Arn attribute makes CloudFormation
                    // call logs:DescribeLogGroups, which can't be scoped to a single group
                    // in a session policy — so the deploy is denied. Fn::Sub needs no
                    // read-back. (TrafficPoppy live-deploy lesson.)
                    Resource: {
                      "Fn::Sub": `arn:aws:logs:\${AWS::Region}:\${AWS::AccountId}:log-group:/aws/lambda/${FUNCTION_NAME}:*`,
                    },
                  },
                ],
              },
            },
          ],
        },
      },

      // Declared in-stack (rather than left for Lambda to auto-create) so it carries a
      // retention policy AND is removed on teardown — an auto-created log group would orphan.
      CollectorLogGroup: {
        Type: "AWS::Logs::LogGroup",
        Properties: {
          LogGroupName: { "Fn::Sub": `/aws/lambda/${FUNCTION_NAME}` },
          RetentionInDays: 14,
        },
      },

      Collector: {
        Type: "AWS::Lambda::Function",
        // The log group must exist before the function that writes to it by name.
        DependsOn: ["CollectorLogGroup"],
        Properties: {
          FunctionName: FUNCTION_NAME,
          Runtime: LAMBDA_RUNTIME,
          Handler: LAMBDA_HANDLER,
          Role: { "Fn::GetAtt": ["CollectorRole", "Arn"] },
          Code: { S3Bucket: { Ref: "LambdaCodeBucket" }, S3Key: { Ref: "LambdaCodeKey" } },
          Timeout: 10,
          // 256 MB (not TrafficPoppy's 128): config responses parse + serialise JSON docs
          // up to 64 KB on the hot path, and the price of the headroom is ~nothing at
          // per-request billing.
          MemorySize: 256,
          Environment: { Variables: { TABLE_NAME: { Ref: "DataTable" } } },
        },
      },

      // The public HTTPS endpoint — no API Gateway (DESIGN.md §3). AuthType NONE because
      // game clients hold no AWS identity; the title key + the per-title daily event cap
      // bound abuse (DESIGN.md §5), not auth. CORS is for WebGL builds; native engines
      // (UnityWebRequest et al.) ignore it. `if-none-match` is allowed through because the
      // config GET revalidates by ETag and that header is NOT CORS-safelisted.
      CollectorUrl: {
        Type: "AWS::Lambda::Url",
        Properties: {
          TargetFunctionArn: { "Fn::GetAtt": ["Collector", "Arn"] },
          AuthType: "NONE",
          Cors: {
            AllowOrigins: ["*"],
            AllowMethods: ["GET", "POST"],
            AllowHeaders: ["content-type", "if-none-match"],
            // Without ExposeHeaders a browser client can't READ these cross-origin:
            // ETag drives config revalidation, Retry-After the 429 backoff. (Both are
            // also derivable from response bodies — "v" and "retryAfter" — so native
            // clients lose nothing either way.)
            ExposeHeaders: ["etag", "retry-after"],
            MaxAge: 86400,
          },
        },
      },

      // A public Function URL needs TWO resource-based permission statements since the
      // October 2025 Lambda change: InvokeFunctionUrl (gated to auth-type NONE) AND
      // InvokeFunction (gated to calls made via the URL). With only the first, every
      // anonymous request gets 403 — which cost TrafficPoppy a full live-debugging day.
      // Locked by template tests; do not "simplify".
      CollectorUrlPermission: {
        Type: "AWS::Lambda::Permission",
        Properties: {
          FunctionName: { Ref: "Collector" },
          Action: "lambda:InvokeFunctionUrl",
          Principal: "*",
          FunctionUrlAuthType: "NONE",
        },
      },
      CollectorUrlInvokePermission: {
        Type: "AWS::Lambda::Permission",
        Properties: {
          FunctionName: { Ref: "Collector" },
          Action: "lambda:InvokeFunction",
          Principal: "*",
          // Only when invoked through the Function URL — never direct SDK invocation.
          InvokedViaFunctionUrl: true,
        },
      },
    },
    Outputs: {
      TableName: {
        Description: "The DynamoDB table holding this deployment's game data.",
        Value: { Ref: "DataTable" },
      },
      TableArn: {
        Description: "ARN of the data table — for the studio's own BI tools.",
        Value: { "Fn::GetAtt": ["DataTable", "Arn"] },
      },
      CollectorUrl: {
        Description: "The public endpoint games talk to — GET /config/…, POST /e.",
        Value: { "Fn::GetAtt": ["CollectorUrl", "FunctionUrl"] },
      },
      TemplateRevision: {
        Description: "Monotonic template revision — lets the app detect (and refuse) downgrades.",
        Value: String(TEMPLATE_REVISION),
      },
    },
  };
}
