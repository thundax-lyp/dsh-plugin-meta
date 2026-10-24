import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export function validateSourceCatalog(source) {
  if (
    source?.source !==
      "https://github.com/awesome-dsh-plugin/awesome-dsh-plugin" ||
    !Array.isArray(source.plugins) ||
    source.count !== source.plugins.length ||
    !source.count
  )
    throw Error("Source catalog identity or count mismatch");
  return source;
}
export async function readSourceCatalog(path, config) {
  if (path)
    return validateSourceCatalog(
      JSON.parse(await readFile(resolve(path), "utf8")),
    );
  const response = await fetch(config.catalogSourceUrl, {
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });
  if (!response.ok) throw Error(`Catalog HTTP ${response.status}`);
  return validateSourceCatalog(await response.json());
}
