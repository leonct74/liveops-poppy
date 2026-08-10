#!/usr/bin/env node
/**
 * Validate extension.json against the REAL AgentsPoppy SDK validator — the same
 * structural check the host runs at install (AGENTS.md §6), reporting every problem
 * at once — and additionally assert the permission RATING with the real assessor.
 *
 *   npm run validate-manifest [-- path/to/extension.json]
 *
 * We bundle the SDK from its TypeScript SOURCE rather than importing its dist/, so
 * this never depends on the sibling checkout's build state. Override the checkout
 * location with AGENTSPOPPY_REPO. Exit 1 on failure, so it's CI-friendly.
 */
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(process.argv[2] ?? join(root, "extension.json"));
const sdkRepo = resolve(process.env.AGENTSPOPPY_REPO ?? join(root, "..", "agentspoppy"));

/**
 * Bundle a module from the agentspoppy checkout's TypeScript source and import it.
 * `parseManifest` lives in the extension SDK; `assessPermissionSet` — the real rating
 * assessor the host UI uses — lives in @agentspoppy/core, which the SDK does not
 * re-export, so we load both.
 */
async function loadFromSource(relEntry, label) {
  const entry = join(sdkRepo, relEntry);
  if (!existsSync(entry)) {
    console.error(
      `validate-manifest: can't find the AgentsPoppy ${label} at ${entry}.\n` +
        `  Point AGENTSPOPPY_REPO at your agentspoppy checkout.`,
    );
    process.exit(1);
  }
  const dir = mkdtempSync(join(tmpdir(), "lop-sdk-"));
  const outfile = join(dir, "mod.mjs");
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    logLevel: "warning",
  });
  const mod = await import(pathToFileURL(outfile).href);
  rmSync(dir, { recursive: true, force: true });
  return mod;
}

const { parseManifest } = await loadFromSource("packages/extension-sdk/src/index.ts", "extension SDK");
const { assessPermissionSet } = await loadFromSource("packages/core/src/permissions.ts", "permission assessor");

let manifest;
try {
  manifest = parseManifest(readFileSync(manifestPath, "utf8"));
} catch (e) {
  console.error(`✗ ${manifestPath}\n  ${e.message}`);
  process.exit(1);
}
console.log(`✅ ${manifestPath} — structure OK`);

// The rating the user will see (AGENTS.md §3 acceptance: amber/green AND no findings
// that reach beyond our own resources). Assert it here so a careless grant fails the
// build instead of surfacing as a scary badge in the host.
/**
 * The one permitted exception to "every grant names the resources we own".
 *
 * A handful of AWS APIs have no customer resources to scope to: they read AWS's own public
 * catalogue, which is identical in every account and contains nothing of the customer's.
 * `pricing` is the case we need — the dashboard's cost figures must come from AWS's real
 * prices for the customer's region rather than numbers baked into this app, and
 * `pricing:GetProducts` accepts no resource ARN.
 *
 * The exception is keyed on the EXACT action set, not the service, so it cannot quietly
 * widen: add an action and this check fails until someone justifies it here.
 */
const PUBLIC_CATALOGUE_READS = {
  pricing: new Set(["GetProducts", "DescribeServices", "GetAttributeValues", "ListPriceLists", "GetPriceListFileUrl"]),
};

const isPublicCatalogueRead = (grant) => {
  const allowed = PUBLIC_CATALOGUE_READS[grant.service];
  return Boolean(allowed) && grant.actions.every((a) => allowed.has(a));
};

const risk = assessPermissionSet(manifest.permissionSet);
const unjustified = [];
for (const { grant, risk: gr } of risk.grants) {
  const excused = !gr.scoped && isPublicCatalogueRead(grant);
  const mark = gr.scoped ? "·" : excused ? "◦" : "!";
  console.log(`   ${mark} ${grant.service}: ${gr.level.padEnd(6)} ${gr.reason}`);
  if (excused) console.log(`     ↳ allowed: AWS's own public catalogue, read-only, none of the customer's data.`);
  if (!gr.scoped && !excused) unjustified.push(grant.service);
}
for (const w of risk.warnings) console.log(`   ! ${w}`);

if (risk.level === "high" || unjustified.length || risk.warnings.length) {
  console.error(
    `\n✗ rating: ${risk.level}${unjustified.length ? ` with unscoped grants: ${unjustified.join(", ")}` : ""}.\n` +
      `  Every mutate-existing grant must be tagged-as-self or a concrete name/ARN we own.`,
  );
  process.exit(1);
}
console.log(`\n✅ rating: ${risk.level} — no risks to other resources identified.`);
