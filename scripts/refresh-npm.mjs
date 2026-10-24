import { parseArguments, selectPackages } from "./refresh-options.mjs";
export { parseArguments, selectPackages } from "./refresh-options.mjs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageNamePattern =
  /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

export function validateManifest(value) {
  if (!Array.isArray(value)) {
    throw new Error("Manifest must contain one JSON object per line");
  }

  const packages = value.map((record) => {
    if (
      !record ||
      typeof record !== "object" ||
      Array.isArray(record) ||
      Object.keys(record).length !== 1
    ) {
      throw new Error("Each manifest line must contain only package");
    }
    return record.package;
  });
  for (const packageName of packages) {
    if (
      typeof packageName !== "string" ||
      packageName.length > 214 ||
      !packageNamePattern.test(packageName)
    ) {
      throw new Error(
        `Invalid npm package name: ${JSON.stringify(packageName)}`,
      );
    }
  }

  const normalized = [...new Set(packages)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  if (
    normalized.length !== packages.length ||
    normalized.some((name, index) => name !== packages[index])
  ) {
    throw new Error(
      "Manifest package names must be unique and byte-order sorted",
    );
  }
  return packages;
}

export function completedUtcWindow(now = new Date()) {
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1),
  );
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 29);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

function normalizeError(error, attemptedAt) {
  const code = typeof error?.code === "string" ? error.code : "REQUEST_FAILED";
  const message = error instanceof Error ? error.message : String(error);
  return { checked_at: attemptedAt, code, message: message.slice(0, 500) };
}

function blankRecord(error) {
  return {
    checked_at: null,
    window_start: null,
    window_end: null,
    downloads_30d: null,
    first_published_at: null,
    latest_version: null,
    latest_published_at: null,
    error,
  };
}

const sleep = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

function createStartLimiter(intervalMs) {
  let nextStart = 0;
  return async () => {
    const currentTime = Date.now();
    const wait = Math.max(0, nextStart - currentTime);
    nextStart = Math.max(nextStart, currentTime) + intervalMs;
    if (wait > 0) await sleep(wait);
  };
}

async function requestJson(
  url,
  {
    fetchImplementation,
    timeoutMs,
    maxRetries,
    beforeRequest = async () => {},
  },
) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      await beforeRequest();
      const response = await fetchImplementation(url, {
        headers: {
          accept: "application/json",
          "user-agent": "dsh-plugin-meta/0.1.0",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        const error = new Error(
          `HTTP ${response.status} from ${new URL(url).host}`,
        );
        error.code = `HTTP_${response.status}`;
        if (response.status !== 429 && response.status < 500) throw error;
        lastError = error;
      } else {
        return await response.json();
      }
    } catch (error) {
      lastError = error;
      const status =
        typeof error?.code === "string" &&
        error.code.match(/^HTTP_(\d+)$/)?.[1];
      if (status && Number(status) !== 429 && Number(status) < 500) throw error;
    }
    if (attempt < maxRetries) await sleep(1000 * 2 ** attempt);
  }
  throw lastError;
}

export async function collectPackage(
  packageName,
  {
    now,
    window,
    fetchImplementation = fetch,
    timeoutMs,
    maxRetries,
    beforeDownloadRequest,
  },
) {
  const encodedName = encodeURIComponent(packageName);
  const registry = await requestJson(
    `https://registry.npmjs.org/${encodedName}`,
    {
      fetchImplementation,
      timeoutMs,
      maxRetries,
    },
  );
  const downloads = await requestJson(
    `https://api.npmjs.org/downloads/point/${window.start}:${window.end}/${encodedName}`,
    {
      fetchImplementation,
      timeoutMs,
      maxRetries,
      beforeRequest: beforeDownloadRequest,
    },
  );
  const latestVersion = registry?.["dist-tags"]?.latest;
  const latestPublishedAt =
    typeof latestVersion === "string" ? registry?.time?.[latestVersion] : null;
  if (!Number.isSafeInteger(downloads?.downloads) || downloads.downloads < 0) {
    const error = new Error(
      "npm downloads response has no valid downloads count",
    );
    error.code = "INVALID_DOWNLOADS_RESPONSE";
    throw error;
  }

  return {
    checked_at: now.toISOString(),
    window_start: window.start,
    window_end: window.end,
    downloads_30d: downloads.downloads,
    first_published_at:
      typeof registry?.time?.created === "string"
        ? registry.time.created
        : null,
    latest_version: typeof latestVersion === "string" ? latestVersion : null,
    latest_published_at:
      typeof latestPublishedAt === "string" ? latestPublishedAt : null,
    error: null,
  };
}

async function runPool(items, concurrency, worker) {
  let nextIndex = 0;
  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, runWorker),
  );
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" && fallback !== undefined) return fallback;
    throw error;
  }
}

async function readJsonLines(path, fallback) {
  try {
    const text = await readFile(path, "utf8");
    const lines = text.endsWith("\n")
      ? text.slice(0, -1).split("\n")
      : text.split("\n");
    if (lines.length === 1 && lines[0] === "") return [];
    return lines.map((line, index) => {
      if (line.trim() === "")
        throw new Error(`Blank JSONL line at ${index + 1} in ${path}`);
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(
          `Invalid JSON at line ${index + 1} in ${path}: ${error.message}`,
        );
      }
    });
  } catch (error) {
    if (error?.code === "ENOENT" && fallback !== undefined) return fallback;
    throw error;
  }
}

function indexMetaRecords(records) {
  const packages = {};
  let previousName = null;
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error("Each META line must be a JSON object");
    }
    const { package: packageName, ...value } = record;
    if (
      typeof packageName !== "string" ||
      !packageNamePattern.test(packageName)
    ) {
      throw new Error(`Invalid META package: ${JSON.stringify(packageName)}`);
    }
    if (previousName !== null && packageName <= previousName) {
      throw new Error(
        "META package names must be unique and byte-order sorted",
      );
    }
    previousName = packageName;
    packages[packageName] = value;
  }
  return packages;
}

async function writeJsonLinesAtomically(path, records) {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const text = records
    .map((record) =>
      JSON.stringify(
        Object.fromEntries(
          Object.entries(record).filter(([, value]) => value !== null),
        ),
      ),
    )
    .join("\n");
  await writeFile(temporaryPath, text === "" ? "" : `${text}\n`, "utf8");
  await rename(temporaryPath, path);
}

export async function refresh({
  root = repositoryRoot,
  arguments_ = process.argv.slice(2),
  fetchImplementation = fetch,
  now = new Date(),
  log = console.log,
} = {}) {
  const packageJson = await readJson(resolve(root, "package.json"));
  const config = packageJson.config;
  const options = parseArguments(arguments_, config.defaultMaxCount);
  const inputPath = resolve(root, config.inputFile);
  const outputPath = resolve(root, config.outputFile);
  const packageNames = validateManifest(await readJsonLines(inputPath));
  const existingPackages = indexMetaRecords(
    await readJsonLines(outputPath, []),
  );

  const selected = selectPackages(packageNames, existingPackages, {
    ...options,
    staleAfterHours: config.staleAfterHours,
    now,
  });
  const outputPackages = Object.fromEntries(
    packageNames.map((packageName) => [
      packageName,
      existingPackages[packageName] ?? blankRecord(null),
    ]),
  );
  const window = completedUtcWindow(now);
  const beforeDownloadRequest = createStartLimiter(
    config.downloadRequestIntervalMs,
  );
  let succeeded = 0;
  let failed = 0;
  let processed = 0;

  await runPool(selected, config.concurrency, async (packageName) => {
    try {
      outputPackages[packageName] = await collectPackage(packageName, {
        now,
        window,
        fetchImplementation,
        timeoutMs: config.requestTimeoutMs,
        maxRetries: config.maxRetries,
        beforeDownloadRequest,
      });
      succeeded += 1;
    } catch (error) {
      const failure = normalizeError(error, now.toISOString());
      const previous = existingPackages[packageName];
      outputPackages[packageName] = previous
        ? { ...previous, error: failure }
        : blankRecord(failure);
      failed += 1;
    }
    processed += 1;
    if (processed % 50 === 0 || processed === selected.length) {
      log(
        `processed=${processed}/${selected.length} succeeded=${succeeded} failed=${failed}`,
      );
    }
  });

  await writeJsonLinesAtomically(
    outputPath,
    packageNames.map((packageName) => ({
      package: packageName,
      ...outputPackages[packageName],
    })),
  );
  log(
    `selected=${selected.length} succeeded=${succeeded} failed=${failed} output=${config.outputFile}`,
  );
  return {
    selected: selected.length,
    succeeded,
    failed,
    packages: outputPackages,
  };
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  refresh().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
