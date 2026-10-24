import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  completedUtcWindow,
  parseArguments,
  refresh,
  selectPackages,
  validateManifest,
} from "../scripts/refresh-meta.mjs";

test("parses defaults and full all arguments", () => {
  assert.deepEqual(parseArguments([], 2000), { full: false, maxCount: 2000 });
  assert.deepEqual(parseArguments(["--full", "--max-count", "all"], 2000), {
    full: true,
    maxCount: Number.POSITIVE_INFINITY,
  });
  assert.throws(() => parseArguments(["--max-count", "0"], 2000));
});

test("validates deterministic npm package names", () => {
  assert.deepEqual(
    validateManifest([{ package: "@scope/a" }, { package: "plain" }]),
    ["@scope/a", "plain"],
  );
  assert.throws(() =>
    validateManifest([{ package: "plain" }, { package: "@scope/a" }]),
  );
  assert.throws(() =>
    validateManifest([{ package: "plain" }, { package: "plain" }]),
  );
  assert.throws(() => validateManifest([{ package: "not a package" }]));
  assert.throws(() => validateManifest([{ package: "plain", extra: true }]));
});

test("uses the last 30 complete UTC days", () => {
  assert.deepEqual(completedUtcWindow(new Date("2026-10-24T18:00:00.000Z")), {
    start: "2026-09-24",
    end: "2026-10-23",
  });
});

test("incremental selection uses last successful checked_at", () => {
  const now = new Date("2026-10-24T12:00:00.000Z");
  const selected = selectPackages(
    ["a", "b", "c"],
    {
      a: { checked_at: "2026-10-24T11:00:00.000Z" },
      b: { checked_at: "2026-10-23T11:59:59.000Z" },
    },
    { full: false, maxCount: 2, staleAfterHours: 24, now },
  );
  assert.deepEqual(selected, ["b", "c"]);
});

test("refresh writes successful data and preserves prior values on failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-plugin-meta-"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      config: {
        inputFile: "./manifest.jsonl",
        outputFile: "./meta.jsonl",
        defaultMaxCount: 2000,
        staleAfterHours: 24,
        concurrency: 2,
        downloadRequestIntervalMs: 0,
        requestTimeoutMs: 100,
        maxRetries: 0,
      },
    }),
  );
  await writeFile(
    join(root, "manifest.jsonl"),
    '{"package":"bad"}\n{"package":"good"}\n',
  );
  await writeFile(
    join(root, "meta.jsonl"),
    `${JSON.stringify({
      package: "bad",
      checked_at: "2026-01-01T00:00:00.000Z",
      window_start: "2025-12-01",
      window_end: "2025-12-30",
      downloads_30d: 7,
      first_published_at: null,
      latest_version: "1.0.0",
      latest_published_at: null,
      error: null,
    })}\n`,
  );

  const fakeFetch = async (url) => {
    if (url.includes("bad")) return new Response("missing", { status: 404 });
    if (url.includes("api.npmjs.org")) {
      return Response.json({ downloads: 42 });
    }
    return Response.json({
      "dist-tags": { latest: "2.0.0" },
      time: {
        created: "2025-01-01T00:00:00.000Z",
        "2.0.0": "2026-10-20T00:00:00.000Z",
      },
    });
  };

  const result = await refresh({
    root,
    arguments_: ["--full", "--max-count", "all"],
    fetchImplementation: fakeFetch,
    now: new Date("2026-10-24T12:00:00.000Z"),
    log: () => {},
  });
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 1);

  const written = (await readFile(join(root, "meta.jsonl"), "utf8"))
    .trimEnd()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(
    written.map((record) => record.package),
    ["bad", "good"],
  );
  assert.equal(written[1].downloads_30d, 42);
  assert.equal(written[1].latest_version, "2.0.0");
  assert.equal("error" in written[1], false);
  assert.equal("first_published_at" in written[0], false);
  assert.equal(written[0].downloads_30d, 7);
  assert.equal(written[0].checked_at, "2026-01-01T00:00:00.000Z");
  assert.equal(written[0].error.code, "HTTP_404");
});

test("does not query downloads when registry lookup fails", async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    return new Response("missing", { status: 404 });
  };
  const root = await mkdtemp(join(tmpdir(), "dsh-plugin-meta-"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      config: {
        inputFile: "./manifest.jsonl",
        outputFile: "./meta.jsonl",
        defaultMaxCount: 2000,
        staleAfterHours: 24,
        concurrency: 1,
        downloadRequestIntervalMs: 0,
        requestTimeoutMs: 100,
        maxRetries: 0,
      },
    }),
  );
  await writeFile(join(root, "manifest.jsonl"), '{"package":"missing"}\n');
  await refresh({
    root,
    arguments_: ["--full"],
    fetchImplementation: fakeFetch,
    now: new Date("2026-10-24T12:00:00.000Z"),
    log: () => {},
  });
  assert.equal(calls, 1);
});
