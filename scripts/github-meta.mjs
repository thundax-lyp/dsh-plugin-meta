import { compare, sorted } from "./snapshot-files.mjs";
export {
  root,
  compare,
  sorted,
  jsonLines,
  writeLines,
  configuration,
} from "./snapshot-files.mjs";
export function repositoryName(url) {
  const parsed = new URL(url);
  const match = parsed.pathname.match(
    /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/|$)/,
  );
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "github.com" ||
    !match ||
    parsed.username ||
    parsed.password ||
    parsed.port
  )
    throw Error(`Invalid GitHub repository URL: ${url}`);
  return `${match[1]}/${match[2].replace(/\.git$/, "")}`.toLowerCase();
}
export function validateManifest(records) {
  let previous = 0;
  const nodes = new Set();
  const aliases = new Set();
  const packagePattern = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
  for (const row of records) {
    if (
      !Number.isSafeInteger(row.repository_id) ||
      row.repository_id <= previous
    )
      throw Error(
        "GitHub manifest IDs must be positive, unique and numerically sorted",
      );
    if (
      typeof row.node_id !== "string" ||
      !row.node_id ||
      nodes.has(row.node_id)
    )
      throw Error("Invalid or duplicate GitHub node ID");
    nodes.add(row.node_id);
    if (
      repositoryName(`https://github.com/${row.repository}`) !==
        row.repository.toLowerCase() ||
      row.repository.split("/").length !== 2
    )
      throw Error("Invalid repository name");
    for (const field of ["npm_packages", "source_repositories"]) {
      if (
        !Array.isArray(row[field]) ||
        JSON.stringify(row[field]) !== JSON.stringify(sorted(row[field]))
      )
        throw Error(`Invalid ${field}`);
    }
    for (const name of row.npm_packages)
      if (
        typeof name !== "string" ||
        name.length > 214 ||
        !packagePattern.test(name)
      )
        throw Error("Invalid npm package name");
    for (const name of row.source_repositories) {
      if (
        repositoryName(`https://github.com/${name}`) !== name ||
        name.split("/").length !== 2 ||
        aliases.has(name)
      )
        throw Error("Invalid or ambiguous source repository");
      aliases.add(name);
    }
    previous = row.repository_id;
  }
  return records;
}
export function failure(code, checkedAt) {
  return { code, checked_at: checkedAt };
}
export async function queryRepositories(
  items,
  {
    token,
    config,
    fetchImplementation = fetch,
    sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  },
) {
  if (!token)
    throw Error("GH_TOKEN or GITHUB_TOKEN is required for GitHub collection");
  const fields = "databaseId id nameWithOwner stargazerCount isArchived";
  const query = `query { ${items
    .map((item, index) => {
      if (item.node_id)
        return `r${index}: node(id:${JSON.stringify(item.node_id)}) { ... on Repository { ${fields} } }`;
      const [owner, name] = item.repository.split("/");
      return `r${index}: repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}) { ${fields} }`;
    })
    .join(" ")} rateLimit { remaining resetAt } }`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetchImplementation(
        "https://api.github.com/graphql",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "user-agent": "dsh-plugin-meta",
          },
          body: JSON.stringify({ query }),
          signal: AbortSignal.timeout(config.requestTimeoutMs),
        },
      );
      if (!response.ok) {
        const error = Error(`GitHub HTTP ${response.status}`);
        error.code = `HTTP_${response.status}`;
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      const body = await response.json();
      if (!body.data || body.errors?.some((e) => !Array.isArray(e.path))) {
        const error = Error("GitHub GraphQL request failed");
        error.code = body.errors?.some((e) => e.type === "RATE_LIMITED")
          ? "RATE_LIMITED"
          : "GRAPHQL_FAILED";
        error.retryable = false;
        throw error;
      }
      return items.map((item, index) => {
        const value = body.data[`r${index}`];
        const errors =
          body.errors?.filter((e) => e.path?.[0] === `r${index}`) ?? [];
        if (!value || errors.length)
          return {
            item,
            error:
              errors.some((e) => e.type === "NOT_FOUND") || !value
                ? "NOT_FOUND_OR_INACCESSIBLE"
                : "GRAPHQL_FIELD_ERROR",
          };
        if (
          !Number.isSafeInteger(value.databaseId) ||
          value.databaseId <= 0 ||
          typeof value.id !== "string" ||
          !Number.isSafeInteger(value.stargazerCount) ||
          value.stargazerCount < 0 ||
          typeof value.isArchived !== "boolean" ||
          typeof value.nameWithOwner !== "string"
        )
          return { item, error: "INVALID_RESPONSE" };
        if (
          (item.repository_id && item.repository_id !== value.databaseId) ||
          (item.node_id && item.node_id !== value.id)
        )
          return { item, error: "REPOSITORY_ID_MISMATCH" };
        return { item, value };
      });
    } catch (error) {
      if (error.retryable === false || attempt >= config.githubMaxRetries)
        throw error;
      await sleep(1000 * 2 ** attempt);
    }
  }
}
export function metadata(value, checkedAt) {
  return {
    repository_id: value.databaseId,
    repository: value.nameWithOwner,
    stars: value.stargazerCount,
    archived: value.isArchived,
    checked_at: checkedAt,
  };
}
export function validateMetrics(records) {
  let previous = 0;
  for (const row of records) {
    if (
      !Number.isSafeInteger(row.repository_id) ||
      row.repository_id <= previous ||
      !Number.isSafeInteger(row.stars) ||
      row.stars < 0 ||
      typeof row.archived !== "boolean" ||
      !Number.isFinite(Date.parse(row.checked_at)) ||
      typeof row.repository !== "string"
    )
      throw Error("Invalid GitHub META record");
    previous = row.repository_id;
  }
  return records;
}
export const byId = (rows) =>
  rows.sort((a, b) => a.repository_id - b.repository_id);
