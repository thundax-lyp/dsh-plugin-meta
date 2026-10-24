import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { importNpm } from "../scripts/import-npm.mjs";

const catalog = (plugins) => ({
  source: "https://github.com/awesome-dsh-plugin/awesome-dsh-plugin",
  count: plugins.length,
  plugins,
});

test("npm import appends exact package names without GitHub access or Git file writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-import-npm-"));
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ config: { inputFile: "npm.jsonl" } }),
  );
  await writeFile(join(directory, "npm.jsonl"), '{"package":"historical"}\n');
  await writeFile(join(directory, "GIT-META.jsonl"), "unchanged\n");
  const result = await importNpm({
    directory,
    source: catalog([{ npm: "new" }, { npm: "new" }, { npm: null }]),
    log: () => {},
  });
  assert.deepEqual(result, {
    source_components: 3,
    source_packages: 1,
    added: 1,
    packages: 2,
  });
  assert.equal(
    await readFile(join(directory, "npm.jsonl"), "utf8"),
    '{"package":"historical"}\n{"package":"new"}\n',
  );
  assert.equal(
    await readFile(join(directory, "GIT-META.jsonl"), "utf8"),
    "unchanged\n",
  );
  await assert.rejects(
    importNpm({
      directory,
      source: catalog([{ npm: "invalid name" }]),
      log: () => {},
    }),
  );
  assert.equal(
    await readFile(join(directory, "npm.jsonl"), "utf8"),
    '{"package":"historical"}\n{"package":"new"}\n',
  );
});
