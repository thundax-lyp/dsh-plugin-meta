import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  root,
  configuration,
  jsonLines,
  writeLines,
  sorted,
} from "./snapshot-files.mjs";
import { validateManifest } from "./refresh-npm.mjs";
import { readSourceCatalog, validateSourceCatalog } from "./source-catalog.mjs";

export async function importNpm({
  directory = root,
  source,
  log = console.log,
} = {}) {
  validateSourceCatalog(source);
  const config = await configuration(directory);
  const sourceNames = sorted(
    source.plugins.map((row) => row.npm).filter((name) => name !== null),
  );
  validateManifest(sourceNames.map((name) => ({ package: name })));
  const path = resolve(directory, config.inputFile);
  const existing = validateManifest(await jsonLines(path, []));
  const names = sorted([...existing, ...sourceNames]);
  await writeLines(
    path,
    names.map((name) => ({ package: name })),
  );
  const result = {
    source_components: source.plugins.length,
    source_packages: sourceNames.length,
    added: names.length - existing.length,
    packages: names.length,
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
  await importNpm({ source });
}
