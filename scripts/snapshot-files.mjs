import { readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const sorted = (values) => [...new Set(values)].sort(compare);
export async function jsonLines(path, fallback) {
  try {
    const text = await readFile(path, "utf8");
    return text === "" ? [] : text.trimEnd().split("\n").map(JSON.parse);
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) return fallback;
    throw error;
  }
}
export async function writeLines(path, records) {
  const temporary = `${path}.tmp-${randomUUID()}`;
  await writeFile(
    temporary,
    records.map((record) => JSON.stringify(record)).join("\n") +
      (records.length ? "\n" : ""),
  );
  await rename(temporary, path);
}
export async function configuration(directory = root) {
  return JSON.parse(await readFile(resolve(directory, "package.json"), "utf8"))
    .config;
}
