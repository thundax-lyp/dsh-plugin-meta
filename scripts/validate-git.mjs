import { resolve } from "node:path";
import {
  configuration,
  jsonLines,
  root,
  validateManifest,
  validateMetrics,
} from "./github-meta.mjs";
const config = await configuration();
const manifest = validateManifest(
  await jsonLines(resolve(root, config.githubInputFile)),
);
const metrics = validateMetrics(
  await jsonLines(resolve(root, config.githubOutputFile)),
);
const pending = await jsonLines(resolve(root, config.githubPendingFile));
const errors = await jsonLines(resolve(root, config.githubErrorsFile), []);
const ids = new Set(manifest.map((row) => row.repository_id));
const names = new Set(manifest.flatMap((row) => row.source_repositories));
for (const row of metrics)
  if (!ids.has(row.repository_id))
    throw Error("Git META has an unknown repository ID");
let previousId = 0;
for (const row of errors) {
  if (
    !ids.has(row.repository_id) ||
    row.repository_id <= previousId ||
    !row.error?.code ||
    !Number.isFinite(Date.parse(row.error.checked_at))
  )
    throw Error("Invalid Git refresh error");
  previousId = row.repository_id;
}
let previousName = "";
for (const row of pending) {
  if (
    typeof row.repository !== "string" ||
    row.repository <= previousName ||
    names.has(row.repository) ||
    !Array.isArray(row.npm_packages) ||
    !row.error?.code ||
    !Number.isFinite(Date.parse(row.error.checked_at))
  )
    throw Error("Invalid unresolved repository");
  previousName = row.repository;
}
console.log(
  `repositories=${manifest.length} metrics=${metrics.length} unresolved=${pending.length} refresh_errors=${errors.length}`,
);
