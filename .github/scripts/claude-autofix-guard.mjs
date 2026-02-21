import { execSync } from "node:child_process";

function run(command) {
  return execSync(command, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: "/bin/bash",
  });
}

function parseList(value, fallback) {
  const source = value && value.trim().length > 0 ? value : fallback;
  return source
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function loadChangedFiles() {
  const unstaged = run("git diff --name-only").split(/\r?\n/);
  const staged = run("git diff --name-only --cached").split(/\r?\n/);
  const files = new Set([...unstaged, ...staged].map((file) => file.trim()).filter(Boolean));
  return [...files];
}

function normalizePath(path) {
  return path.replace(/\\/g, "/");
}

function startsWithAny(path, prefixes) {
  return prefixes.some((prefix) => {
    const normalizedPrefix = normalizePath(prefix);
    return path === normalizedPrefix || path.startsWith(normalizedPrefix);
  });
}

function main() {
  const files = loadChangedFiles().map((file) => normalizePath(file));
  if (files.length === 0) {
    process.exit(0);
  }

  const allowedPrefixes = parseList(
    process.env.CLAUDE_AUTOFIX_ALLOWED_PATHS,
    "packages/,apps/,services/,src/,lib/,docs/,.github/,README.md",
  );

  const blockedPatterns = parseList(
    process.env.CLAUDE_AUTOFIX_BLOCKED_PATTERNS,
    "(^|/)pnpm-lock\\.yaml$,(^|/)package-lock\\.json$,(^|/)yarn\\.lock$,(^|/)npm-shrinkwrap\\.json$,(^|/)infra/,(^|/)terraform/,(^|/)migrations?/,\\.tf$,\\.tfvars$",
  ).map((pattern) => new RegExp(pattern, "i"));

  const allowBlocked = process.env.CLAUDE_AUTOFIX_ALLOW_BLOCKED === "true";

  const outsideAllowed = files.filter((file) => !startsWithAny(file, allowedPrefixes));
  if (outsideAllowed.length > 0) {
    const message = [
      "Autofix safety rail violation: changed files outside allowed paths",
      ...outsideAllowed.map((file) => `- ${file}`),
      `Allowed prefixes: ${allowedPrefixes.join(", ")}`,
    ].join("\n");
    throw new Error(message);
  }

  if (!allowBlocked) {
    const blockedHits = files.filter((file) => blockedPatterns.some((pattern) => pattern.test(file)));
    if (blockedHits.length > 0) {
      const message = [
        "Autofix safety rail violation: blocked file patterns changed",
        ...blockedHits.map((file) => `- ${file}`),
        `Blocked patterns: ${blockedPatterns.map((pattern) => pattern.source).join(", ")}`,
        "Set CLAUDE_AUTOFIX_ALLOW_BLOCKED=true only for explicit reviewed exceptions.",
      ].join("\n");
      throw new Error(message);
    }
  }

  const lockfilePattern = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|npm-shrinkwrap\.json)$/i;
  const lockfileTouched = files.some((file) => lockfilePattern.test(file));
  if (lockfileTouched && process.env.CLAUDE_AUTOFIX_ALLOW_LOCKFILES !== "true") {
    throw new Error(
      "Autofix safety rail violation: lockfile changes are blocked unless CLAUDE_AUTOFIX_ALLOW_LOCKFILES=true",
    );
  }
}

main();
