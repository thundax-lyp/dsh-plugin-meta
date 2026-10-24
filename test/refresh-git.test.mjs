import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { importGithub, sourceRepositories } from "../scripts/import-git.mjs";
import { refreshGithub } from "../scripts/refresh-git.mjs";
import {
  queryRepositories,
  validateManifest,
} from "../scripts/github-meta.mjs";

const time = new Date("2026-10-24T12:00:00.000Z");
const value = (id, repository, stars = 0) => ({
  databaseId: id,
  id: `R_${id}`,
  nameWithOwner: repository,
  stargazerCount: stars,
  isArchived: false,
});
const catalog = (plugins) => ({
  source: "https://github.com/awesome-dsh-plugin/awesome-dsh-plugin",
  count: plugins.length,
  plugins,
});
const row = (id, repository, npm = []) => ({
  repository_id: id,
  node_id: `R_${id}`,
  repository,
  npm_packages: npm,
  source_repositories: [repository.toLowerCase()],
});
const read = async (directory, file) =>
  (await readFile(join(directory, file), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "dsh-github-"));
  const config = {
    githubInputFile: "manifest.jsonl",
    inputFile: "npm-manifest.jsonl",
    githubOutputFile: "meta.jsonl",
    githubPendingFile: "pending.jsonl",
    githubErrorsFile: "errors.jsonl",
    githubBatchSize: 2,
    githubMaxRetries: 0,
    requestTimeoutMs: 1000,
    defaultMaxCount: 2,
    staleAfterHours: 24,
  };
  await writeFile(join(directory, "package.json"), JSON.stringify({ config }));
  return { directory, config };
}

test("source groups monorepo paths and case variants without inventing npm names", () => {
  const source = catalog([
    { url: "https://github.com/Org/Repo/tree/main/a", npm: "one" },
    { url: "https://github.com/org/repo/tree/main/b", npm: "two" },
    { url: "https://github.com/org/empty", npm: null },
  ]);
  assert.deepEqual(sourceRepositories(source), [
    { repository: "org/empty", npm_packages: [] },
    { repository: "org/repo", npm_packages: ["one", "two"] },
  ]);
  assert.throws(() => sourceRepositories({ ...source, count: 10 }));
  assert.throws(() =>
    sourceRepositories(
      catalog([{ url: "https://evil.test/org/repo", npm: null }]),
    ),
  );
  assert.throws(() =>
    sourceRepositories(
      catalog([{ url: "https://github.com/org/repo", npm: "invalid name" }]),
    ),
  );
});

test("import deduplicates renamed repositories by ID, preserves npm associations and pending failures", async () => {
  const { directory } = await fixture();
  const source = catalog([
    { url: "https://github.com/o/a", npm: "a" },
    { url: "https://github.com/o/b", npm: "b" },
    { url: "https://github.com/o/c", npm: null },
  ]);
  let calls = 0;
  const result = await importGithub({
    directory,
    source,
    token: "test",
    now: time,
    log: () => {},
    fetchImplementation: async () => {
      calls += 1;
      return Response.json(
        calls === 1
          ? { data: { r0: value(10, "o/new"), r1: value(10, "o/new") } }
          : {
              data: { r0: null },
              errors: [{ path: ["r0"], type: "NOT_FOUND" }],
            },
      );
    },
  });
  await assert.rejects(readFile(join(directory, "npm-manifest.jsonl")), {
    code: "ENOENT",
  });
  assert.equal(result.repositories, 1);
  assert.equal(result.unresolved, 1);
  const [manifest] = await read(directory, "manifest.jsonl");
  assert.equal(manifest.repository_id, 10);
  assert.deepEqual(manifest.npm_packages, ["a", "b"]);
  assert.deepEqual(manifest.source_repositories, ["o/a", "o/b"]);
  assert.equal((await read(directory, "meta.jsonl"))[0].stars, 0);
  assert.equal(
    (await read(directory, "pending.jsonl"))[0].error.code,
    "NOT_FOUND_OR_INACCESSIBLE",
  );
  await importGithub({
    directory,
    source,
    token: "test",
    now: time,
    log: () => {},
    fetchImplementation: async () =>
      Response.json({ data: { r0: value(20, "o/c", 2) } }),
  });
  assert.equal((await read(directory, "manifest.jsonl")).length, 2);
  assert.deepEqual(await read(directory, "pending.jsonl"), []);
});

test("refresh preserves last good stars on partial failure, follows node IDs across rename and keeps npm separate", async () => {
  const { directory } = await fixture();
  await writeFile(
    join(directory, "manifest.jsonl"),
    [row(10, "o/old"), row(20, "o/b"), row(30, "o/c")]
      .map(JSON.stringify)
      .join("\n") + "\n",
  );
  await writeFile(
    join(directory, "meta.jsonl"),
    JSON.stringify({
      repository_id: 20,
      repository: "o/b",
      stars: 7,
      archived: false,
      checked_at: "2026-01-01T00:00:00.000Z",
    }) + "\n",
  );
  await writeFile(join(directory, "npm-meta.jsonl"), "keep npm untouched\n");
  let calls = 0;
  const fetchImplementation = async (_, options) => {
    calls += 1;
    assert.match(JSON.parse(options.body).query, /node\(id:"R_10"\)/);
    return Response.json({
      data: { r0: value(10, "o/new", 0), r1: null },
      errors: [{ path: ["r1"], type: "NOT_FOUND" }],
    });
  };
  const result = await refreshGithub({
    directory,
    arguments_: [],
    token: "test",
    now: time,
    fetchImplementation,
    log: () => {},
  });
  assert.deepEqual(result, { selected: 2, succeeded: 1, failed: 1 });
  const records = await read(directory, "meta.jsonl");
  assert.equal(records[0].repository, "o/new");
  assert.equal(records[0].stars, 0);
  assert.equal(records[1].stars, 7);
  assert.equal(records[1].checked_at, "2026-01-01T00:00:00.000Z");
  const second = await refreshGithub({
    directory,
    arguments_: [],
    token: "test",
    now: time,
    log: () => {},
    fetchImplementation: async () =>
      Response.json({ data: { r0: value(30, "o/c", 4) } }),
  });
  assert.equal(second.selected, 1);
  assert.equal(calls, 1);
  assert.equal(
    await readFile(join(directory, "npm-meta.jsonl"), "utf8"),
    "keep npm untouched\n",
  );
});

test("rejects identity mismatch and malformed stars; retries are bounded without exposing credentials", async () => {
  const { config } = await fixture();
  const results = await queryRepositories([row(1, "o/a"), row(2, "o/b")], {
    token: "secret",
    config,
    fetchImplementation: async () =>
      Response.json({ data: { r0: value(3, "o/a"), r1: value(2, "o/b", -1) } }),
  });
  assert.equal(results[0].error, "REPOSITORY_ID_MISMATCH");
  assert.equal(results[1].error, "INVALID_RESPONSE");
  let calls = 0;
  await assert.rejects(
    queryRepositories([row(1, "o/a")], {
      token: "secret",
      config: { ...config, githubMaxRetries: 2 },
      sleep: async () => {},
      fetchImplementation: async () => {
        calls += 1;
        return new Response("", { status: 503 });
      },
    }),
    /GitHub HTTP 503/,
  );
  assert.equal(calls, 3);
  assert.throws(() => validateManifest([row(1, "o/a"), row(1, "o/b")]));
});

test("fatal request failures checkpoint errors and retain successful previous data", async () => {
  const { directory } = await fixture();
  await writeFile(
    join(directory, "manifest.jsonl"),
    JSON.stringify(row(1, "o/a")) + "\n",
  );
  const previous = {
    repository_id: 1,
    repository: "o/a",
    stars: 9,
    archived: false,
    checked_at: "2026-01-01T00:00:00.000Z",
  };
  await writeFile(
    join(directory, "meta.jsonl"),
    JSON.stringify(previous) + "\n",
  );
  await assert.rejects(
    refreshGithub({
      directory,
      arguments_: ["--full"],
      token: "test",
      now: time,
      log: () => {},
      fetchImplementation: async () => new Response("", { status: 403 }),
    }),
  );
  assert.deepEqual(await read(directory, "meta.jsonl"), [previous]);
  assert.equal(
    (await read(directory, "errors.jsonl"))[0].error.code,
    "HTTP_403",
  );
});
