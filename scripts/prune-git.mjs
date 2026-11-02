import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  root,
  configuration,
  jsonLines,
  writeLines,
  validateManifest,
  validateMetrics,
} from "./github-meta.mjs";

// Only explicit manifest removals authorize deleting cached repository records.
export async function pruneGithub({ directory = root } = {}) {
  const config = await configuration(directory);
  const manifest = validateManifest(
    await jsonLines(resolve(directory, config.githubInputFile)),
  );
  const metrics = validateMetrics(
    await jsonLines(resolve(directory, config.githubOutputFile)),
  );
  const errors = await jsonLines(
    resolve(directory, config.githubErrorsFile),
    [],
  );
  const ids = new Set(manifest.map((row) => row.repository_id));
  const retainedMetrics = metrics.filter((row) => ids.has(row.repository_id));
  const retainedErrors = errors.filter((row) => ids.has(row.repository_id));
  if (retainedMetrics.length !== metrics.length)
    await writeLines(
      resolve(directory, config.githubOutputFile),
      retainedMetrics,
    );
  if (retainedErrors.length !== errors.length)
    await writeLines(
      resolve(directory, config.githubErrorsFile),
      retainedErrors,
    );
  return {
    removed_metrics: metrics.length - retainedMetrics.length,
    removed_errors: errors.length - retainedErrors.length,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  console.log(JSON.stringify(await pruneGithub()));
