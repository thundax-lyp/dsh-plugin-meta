import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readSourceCatalog, validateSourceCatalog } from "./source-catalog.mjs";
import {
  root,
  configuration,
  jsonLines,
  writeLines,
  repositoryName,
  sorted,
  byId,
  validateManifest,
  validateMetrics,
  queryRepositories,
  metadata,
  failure,
} from "./github-meta.mjs";

export function sourceRepositories(source) {
  validateSourceCatalog(source);
  const repositories = new Map();
  for (const plugin of source.plugins) {
    const repository = repositoryName(plugin.url);
    const record = repositories.get(repository) ?? {
      repository,
      npm_packages: [],
    };
    if (
      plugin.npm !== null &&
      (typeof plugin.npm !== "string" ||
        !/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(
          plugin.npm,
        ) ||
        plugin.npm.length > 214)
    )
      throw Error(`Invalid source npm package for ${repository}`);
    if (plugin.npm)
      record.npm_packages = sorted([...record.npm_packages, plugin.npm]);
    repositories.set(repository, record);
  }
  return [...repositories.values()].sort((a, b) =>
    a.repository < b.repository ? -1 : a.repository > b.repository ? 1 : 0,
  );
}
export async function importGithub({
  directory = root,
  source,
  token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
  fetchImplementation = fetch,
  now = new Date(),
  log = console.log,
} = {}) {
  const config = await configuration(directory);
  const candidates = sourceRepositories(source);
  const manifest = validateManifest(
    await jsonLines(resolve(directory, config.githubInputFile), []),
  );
  const metrics = validateMetrics(
    await jsonLines(resolve(directory, config.githubOutputFile), []),
  );
  const records = new Map(manifest.map((row) => [row.repository_id, row]));
  const meta = new Map(metrics.map((row) => [row.repository_id, row]));
  const pending = new Map(
    (await jsonLines(resolve(directory, config.githubPendingFile), [])).map(
      (row) => [row.repository, row],
    ),
  );
  const aliases = new Map(
    manifest.flatMap((row) =>
      row.source_repositories.map((name) => [name, row.repository_id]),
    ),
  );
  const queue = [];
  for (const item of candidates) {
    const id = aliases.get(item.repository);
    if (id) {
      const record = records.get(id);
      record.npm_packages = sorted([
        ...record.npm_packages,
        ...item.npm_packages,
      ]);
      pending.delete(item.repository);
    } else {
      queue.push(item);
      pending.set(item.repository, {
        ...item,
        error: failure("NOT_YET_RESOLVED", now.toISOString()),
      });
    }
  }
  // Preserve unresolved historical locators and retry them even if absent upstream.
  for (const row of pending.values())
    if (!queue.some((item) => item.repository === row.repository))
      queue.push({
        repository: row.repository,
        npm_packages: row.npm_packages,
      });
  const save = async () => {
    await writeLines(
      resolve(directory, config.githubOutputFile),
      validateMetrics(byId([...meta.values()])),
    );
    await writeLines(
      resolve(directory, config.githubInputFile),
      validateManifest(byId([...records.values()])),
    );
    await writeLines(
      resolve(directory, config.githubPendingFile),
      [...pending.values()].sort((a, b) =>
        a.repository < b.repository ? -1 : 1,
      ),
    );
  };
  await save();
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
      for (const item of batch)
        pending.set(item.repository, {
          ...item,
          error: failure(error.code ?? "REQUEST_FAILED", now.toISOString()),
        });
      await save();
      throw error;
    }
    for (const { item, value, error } of results) {
      if (error) {
        pending.set(item.repository, {
          ...item,
          error: failure(error, now.toISOString()),
        });
        continue;
      }
      const old = records.get(value.databaseId);
      records.set(value.databaseId, {
        repository_id: value.databaseId,
        node_id: value.id,
        repository: value.nameWithOwner,
        npm_packages: sorted([
          ...(old?.npm_packages ?? []),
          ...item.npm_packages,
        ]),
        source_repositories: sorted([
          ...(old?.source_repositories ?? []),
          item.repository,
        ]),
      });
      meta.set(value.databaseId, metadata(value, now.toISOString()));
      pending.delete(item.repository);
    }
    await save();
    log(
      `resolved=${Math.min(offset + batch.length, queue.length)}/${queue.length} repositories=${records.size} pending=${pending.size}`,
    );
  }
  const result = {
    source_components: source.plugins.length,
    source_repositories: candidates.length,
    repositories: records.size,
    unresolved: pending.size,
  };
  log(JSON.stringify(result));
  return result;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({ options: { source: { type: "string" } } });
  const config = await configuration();
  const source = await readSourceCatalog(values.source, config);
  await importGithub({ source });
}
