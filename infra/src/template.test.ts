import { describe, expect, it } from "vitest";
import {
  buildTemplate,
  FUNCTION_NAME,
  ROLE_NAME,
  STACK_NAME,
  TABLE_NAME,
  TEMPLATE_REVISION,
  TTL_ATTRIBUTE,
} from "./template";

const tpl = buildTemplate();
const resources = tpl.Resources as Record<string, { Type: string; Properties: any; DependsOn?: string[] }>;

describe("buildTemplate", () => {
  it("is pure — two calls produce identical JSON (content-addressing depends on it)", () => {
    expect(JSON.stringify(buildTemplate())).toBe(JSON.stringify(buildTemplate()));
  });

  it("names every named resource under the LiveOpsPoppy* manifest scope", () => {
    // The manifest's grants are scoped to LiveOpsPoppy* — a resource named outside the
    // prefix would deploy-fail (or worse, demand a broader grant).
    expect(STACK_NAME.startsWith("LiveOpsPoppy")).toBe(true);
    expect(resources.DataTable!.Properties.TableName).toBe(TABLE_NAME);
    expect(TABLE_NAME.startsWith("LiveOpsPoppy")).toBe(true);
    expect(resources.Collector!.Properties.FunctionName).toBe(FUNCTION_NAME);
    expect(FUNCTION_NAME.startsWith("LiveOpsPoppy")).toBe(true);
    expect(resources.CollectorRole!.Properties.RoleName).toBe(ROLE_NAME);
    expect(ROLE_NAME.startsWith("LiveOpsPoppy")).toBe(true);
  });

  it("keeps the table deletable and TTL'd from birth", () => {
    const p = resources.DataTable!.Properties;
    expect(p.BillingMode).toBe("PAY_PER_REQUEST");
    expect(p.TimeToLiveSpecification).toEqual({ AttributeName: TTL_ATTRIBUTE, Enabled: true });
    expect(p.DeletionProtectionEnabled).toBeUndefined();
  });

  it("never marks anything Retain — teardown must leave no trace", () => {
    for (const [name, r] of Object.entries(resources)) {
      expect((r as any).DeletionPolicy, `${name} must not Retain`).toBeUndefined();
    }
  });

  it("grants the collector role the least: 3 dynamodb actions on the one table, logs by Fn::Sub", () => {
    const statements = resources.CollectorRole!.Properties.Policies[0].PolicyDocument.Statement;
    expect(statements).toHaveLength(2);
    const [db, logs] = statements;
    expect(db.Action).toEqual(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]);
    expect(db.Resource).toEqual({ "Fn::GetAtt": ["DataTable", "Arn"] });
    // Fn::Sub, NOT Fn::GetAtt on the LogGroup — GetAtt forces logs:DescribeLogGroups,
    // which a session policy can't scope, and the deploy is denied (TrafficPoppy lesson).
    expect(logs.Resource["Fn::Sub"]).toContain(`/aws/lambda/${FUNCTION_NAME}`);
    expect(JSON.stringify(logs.Resource)).not.toContain("Fn::GetAtt");
  });

  it("declares BOTH Function-URL permission statements (anonymous 403 with only one)", () => {
    const urlPerm = resources.CollectorUrlPermission!.Properties;
    expect(urlPerm.Action).toBe("lambda:InvokeFunctionUrl");
    expect(urlPerm.FunctionUrlAuthType).toBe("NONE");
    const invokePerm = resources.CollectorUrlInvokePermission!.Properties;
    expect(invokePerm.Action).toBe("lambda:InvokeFunction");
    expect(invokePerm.InvokedViaFunctionUrl).toBe(true);
  });

  it("allows if-none-match through CORS — the config GET revalidates by ETag", () => {
    expect(resources.CollectorUrl!.Properties.Cors.AllowHeaders).toContain("if-none-match");
    // Browser clients can't read these cross-origin unless exposed — ETag drives config
    // revalidation, Retry-After the 429 backoff (the sample game runs in a browser).
    expect(resources.CollectorUrl!.Properties.Cors.ExposeHeaders).toEqual(["etag", "retry-after"]);
  });

  it("takes Lambda code from content-addressed parameters (real updates, never NO_CHANGE)", () => {
    expect(tpl.Parameters).toHaveProperty("LambdaCodeBucket");
    expect(tpl.Parameters).toHaveProperty("LambdaCodeKey");
    expect(resources.Collector!.Properties.Code).toEqual({
      S3Bucket: { Ref: "LambdaCodeBucket" },
      S3Key: { Ref: "LambdaCodeKey" },
    });
  });

  it("orders the log group before the function and caps retention at 14 days", () => {
    expect(resources.Collector!.DependsOn).toContain("CollectorLogGroup");
    expect(resources.CollectorLogGroup!.Properties.RetentionInDays).toBe(14);
  });

  it("exposes the ordering-aware TemplateRevision output", () => {
    expect(TEMPLATE_REVISION).toBeGreaterThanOrEqual(1);
    expect((tpl.Outputs as any).TemplateRevision.Value).toBe(String(TEMPLATE_REVISION));
    for (const key of ["TableName", "TableArn", "CollectorUrl"]) {
      expect(tpl.Outputs).toHaveProperty(key);
    }
  });
});
