import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArguments, selectPackages } from "./refresh-options.mjs";
import {
  root,
  configuration,
  jsonLines,
  writeLines,
  byId,
  validateManifest,
  validateMetrics,
  queryRepositories,
  metadata,
  failure,
} from "./github-meta.mjs";

export async function refreshGithub({
  directory = root,
  arguments_ = process.argv.slice(2),
  token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
  fetchImplementation = fetch,
  now = new Date(),
  log = console.log,
} = {}) {
  const config = await configuration(directory);
  const options = parseArguments(arguments_, config.defaultMaxCount);
  const manifest = validateManifest(
    await jsonLines(resolve(directory, config.githubInputFile)),
  );
  const existing = validateMetrics(
    await jsonLines(resolve(directory, config.githubOutputFile), []),
  );
  const records = new Map(existing.map((row) => [row.repository_id, row]));
  const errors = new Map(
    (await jsonLines(resolve(directory, config.githubErrorsFile), [])).map(
      (row) => [row.repository_id, row],
    ),
  );
  const freshness = Object.fromEntries(
    manifest.map((row) => [
      row.repository_id,
      {
        checked_at: records.get(row.repository_id)?.checked_at,
        error: errors.get(row.repository_id)?.error,
      },
    ]),
  );
  const selected = new Set(
    selectPackages(
      manifest.map((row) => String(row.repository_id)),
      freshness,
      { ...options, now, staleAfterHours: config.staleAfterHours },
    ),
  );
  const queue = manifest.filter((row) =>
    selected.has(String(row.repository_id)),
  );
  const save = async () => {
    await writeLines(
      resolve(directory, config.githubOutputFile),
      validateMetrics(byId([...records.values()])),
    );
    await writeLines(
      resolve(directory, config.githubErrorsFile),
      byId([...errors.values()]),
    );
  };
  let succeeded = 0;
  let failed = 0;
  for (
    let offset = 0;
    offset < queue.length;
    offset += config.githubBatchSize
  ) {
    const batch = queue.slice(offset, offset + config.githubBatchSize);
    let results;
    try {
      results = await queryRepositories(batch, {
        token,
        config,
        fetchImplementation,
      });
    } catch (error) {
      for (const row of batch)
        errors.set(row.repository_id, {
          repository_id: row.repository_id,
          error: failure(error.code ?? "REQUEST_FAILED", now.toISOString()),
        });
      await save();
      throw error;
    }
    for (const { item, value, error } of results) {
      if (error) {
        errors.set(item.repository_id, {
          repository_id: item.repository_id,
          error: failure(error, now.toISOString()),
        });
        failed += 1;
      } else {
        records.set(item.repository_id, metadata(value, now.toISOString()));
        errors.delete(item.repository_id);
        succeeded += 1;
      }
    }
    await save();
    log(
      `processed=${Math.min(offset + batch.length, queue.length)}/${queue.length} succeeded=${succeeded} failed=${failed}`,
    );
  }
  if (!queue.length) await save();
  const result = { selected: queue.length, succeeded, failed };
  log(JSON.stringify(result));
  return result;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await refreshGithub();
