export function parseArguments(arguments_, defaultMaxCount) {
  let full = false;
  let maxCount = defaultMaxCount;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--full") {
      full = true;
      continue;
    }
    if (argument === "--max-count") {
      const value = arguments_[index + 1];
      if (value === undefined) throw new Error("--max-count requires a value");
      index += 1;
      if (value === "all") {
        maxCount = Number.POSITIVE_INFINITY;
      } else if (/^[1-9]\d*$/.test(value)) {
        maxCount = Number(value);
      } else {
        throw new Error("--max-count must be a positive integer or all");
      }
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return { full, maxCount };
}

export function selectPackages(
  packageNames,
  existingPackages,
  { full, maxCount, staleAfterHours, now },
) {
  const staleBefore = now.getTime() - staleAfterHours * 60 * 60 * 1000;
  return packageNames
    .filter((packageName) => {
      if (full) return true;
      const record = existingPackages[packageName];
      const checkedTimes = [record?.checked_at, record?.error?.checked_at]
        .map((value) => (typeof value === "string" ? Date.parse(value) : NaN))
        .filter(Number.isFinite);
      return (
        checkedTimes.length === 0 || Math.max(...checkedTimes) <= staleBefore
      );
    })
    .slice(0, maxCount);
}
