/**
 * Download a pinned Strands Decider checkpoint and the base model it loads, laid out for a
 * SageMaker real-time endpoint that runs with network isolation.
 *
 *     npx tsx fetch-model.ts MODEL MODEL_REVISION BASE_REVISION OUT_DIR
 *
 * MODEL is a Hugging Face Hub id. Both revisions must be full 40-character commit SHAs, so a
 * redeploy next month loads exactly the same weights. The script writes:
 *
 *     OUT_DIR/<model name>/  the checkpoint, its config rewritten to load the base from BASE_DIR
 *     OUT_DIR/base           the base model at BASE_REVISION (a link to the Hub cache snapshot,
 *                            which `aws s3 sync` follows)
 *
 * SageMaker copies OUT_DIR to /opt/ml/model before the container starts, and the container loads
 * both folders with HF_HUB_OFFLINE=1, so the endpoint needs no internet access.
 *
 * Integrity: every checkpoint file is checked against the checkpoint's MANIFEST.sha256, and the
 * base revision must equal the one the checkpoint's provenance.json records. Any mismatch stops
 * the build before anything reaches S3.
 *
 * Adapted from strands-labs/strands-decider deploy/sagemaker/scripts/fetch-model.ts
 * (Apache-2.0, https://github.com/strands-labs/strands-decider).
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { snapshotDownload } from "@huggingface/hub";

/** Where the container sees the base model. Overridable only for a local test run. */
const BASE_DIR = process.env.DECIDER_BASE_DIR ?? "/opt/ml/model/base";
const CONFIG_NAMES = ["strands_decider_config.json", "hobson_config.json"];
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

interface DeciderConfig {
  base_model: string;
  base_revision?: string | null;
  [key: string]: unknown;
}

function fail(message: string): never {
  throw new Error(message);
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Check every file the manifest lists. The manifest itself is not listed in it. */
async function verifyManifest(checkpointDir: string): Promise<number> {
  const manifestPath = path.join(checkpointDir, "MANIFEST.sha256");
  if (!existsSync(manifestPath)) fail("checkpoint has no MANIFEST.sha256; refusing an unverifiable model");
  const lines = (await readFile(manifestPath, "utf8")).split("\n").filter((line) => line.trim());
  if (lines.length === 0) fail("MANIFEST.sha256 is empty");
  for (const line of lines) {
    const match = line.match(/^([0-9a-f]{64}) {2}(.+)$/);
    if (!match) fail(`MANIFEST.sha256 has a malformed line: ${line.slice(0, 120)}`);
    const [, expected, relative] = match;
    const resolved = path.resolve(checkpointDir, relative);
    if (!resolved.startsWith(path.resolve(checkpointDir) + path.sep)) {
      fail(`MANIFEST.sha256 names a path outside the checkpoint: ${relative}`);
    }
    if (!existsSync(resolved)) fail(`checkpoint file missing: ${relative}`);
    const actual = await sha256(resolved);
    if (actual !== expected) fail(`checksum mismatch for ${relative}`);
  }
  return lines.length;
}

async function main(model: string, revision: string, baseRevision: string, outDir: string): Promise<void> {
  if (!MODEL_ID.test(model)) fail(`not a Hugging Face model id: ${model}`);
  if (!COMMIT_SHA.test(revision)) fail("MODEL_REVISION must be a full 40-character commit SHA");
  if (!COMMIT_SHA.test(baseRevision)) fail("BASE_REVISION must be a full 40-character commit SHA");

  // snapshotDownload returns <cache>/models--<org>--<name>/snapshots/<commit>.
  const snapshot = await snapshotDownload({ repo: model, revision });
  if (path.basename(snapshot) !== revision) {
    fail(`Hub returned snapshot ${path.basename(snapshot)}, expected ${revision}`);
  }
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const checkpointDir = path.join(outDir, model.split("/").pop()!);
  await cp(snapshot, checkpointDir, { recursive: true, dereference: true });
  const verified = await verifyManifest(checkpointDir);

  const configPath =
    CONFIG_NAMES.map((name) => path.join(checkpointDir, name)).find((p) => existsSync(p)) ??
    fail(`${model}: no ${CONFIG_NAMES.join(" or ")}`);
  const config: DeciderConfig = JSON.parse(await readFile(configPath, "utf8"));
  const provenancePath = path.join(checkpointDir, "provenance.json");
  const provenance = existsSync(provenancePath)
    ? (JSON.parse(await readFile(provenancePath, "utf8")) as Record<string, unknown>)
    : {};
  const recorded =
    config.base_revision ??
    (provenance.base_model === config.base_model ? provenance.base_model_revision : undefined);
  if (recorded !== baseRevision) {
    fail(
      `base revision ${baseRevision} does not match the revision the checkpoint records (${String(recorded)})`
    );
  }

  const base = config.base_model;
  if (!MODEL_ID.test(base)) fail(`checkpoint names an unexpected base model: ${base}`);
  const baseSnapshot = await snapshotDownload({ repo: base, revision: baseRevision });
  if (path.basename(baseSnapshot) !== baseRevision) {
    fail(`Hub returned base snapshot ${path.basename(baseSnapshot)}, expected ${baseRevision}`);
  }
  await symlink(baseSnapshot, path.join(outDir, "base"), "dir");

  // The loader reads the base from BASE_DIR. Clearing base_revision (and, through the base_model
  // change, the provenance fallback) means nothing asks the Hub for a revision while offline.
  config.base_model = BASE_DIR;
  config.base_revision = null;
  await writeFile(configPath, JSON.stringify(config, null, 2));

  console.error(
    `fetched ${model}@${revision} (${verified} files verified) and ${base}@${baseRevision} into ${outDir}`
  );
}

const [model, revision, baseRevision, outDir] = process.argv.slice(2);
if (!model || !revision || !baseRevision || !outDir) {
  console.error("usage: tsx fetch-model.ts MODEL MODEL_REVISION BASE_REVISION OUT_DIR");
  process.exit(2);
}
main(model, revision, baseRevision, outDir).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
