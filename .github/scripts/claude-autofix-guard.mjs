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

function loadChangedFiles() {
  const unstaged = run("git diff --name-only").split(/\r?\n/);
  const staged = run("git diff --name-only --cached").split(/\r?\n/);
  const files = new Set([...unstaged, ...staged].map((file) => file.trim()).filter(Boolean));
  return [...files];
}

function loadDeletedFiles() {
  const unstaged = run("git diff --diff-filter=D --name-only").split(/\r?\n/);
  const staged = run("git diff --diff-filter=D --name-only --cached").split(/\r?\n/);
  const files = new Set([...unstaged, ...staged].map((file) => file.trim()).filter(Boolean));
  return [...files];
}

function loadDiffStats() {
  const statLine = run("git diff --shortstat 2>/dev/null || true").trim();
  const stagedLine = run("git diff --cached --shortstat 2>/dev/null || true").trim();

  let insertions = 0;
  let deletions = 0;

  for (const line of [statLine, stagedLine]) {
    const insMatch = line.match(/(\d+) insertion/);
    const delMatch = line.match(/(\d+) deletion/);
    if (insMatch) insertions += Number(insMatch[1]);
    if (delMatch) deletions += Number(delMatch[1]);
  }

  return { insertions, deletions, net: insertions - deletions };
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

  // --- Path prefix check ---
  const outsideAllowed = files.filter((file) => !startsWithAny(file, allowedPrefixes));
  if (outsideAllowed.length > 0) {
    const message = [
      "Autofix guard: changed files outside allowed paths",
      ...outsideAllowed.map((file) => `- ${file}`),
      `Allowed prefixes: ${allowedPrefixes.join(", ")}`,
    ].join("\n");
    throw new Error(message);
  }

  // --- Blocked pattern check ---
  if (!allowBlocked) {
    const blockedHits = files.filter((file) => blockedPatterns.some((pattern) => pattern.test(file)));
    if (blockedHits.length > 0) {
      const message = [
        "Autofix guard: blocked file patterns changed",
        ...blockedHits.map((file) => `- ${file}`),
        `Blocked patterns: ${blockedPatterns.map((pattern) => pattern.source).join(", ")}`,
        "Set CLAUDE_AUTOFIX_ALLOW_BLOCKED=true only for explicit reviewed exceptions.",
      ].join("\n");
      throw new Error(message);
    }
  }

  // --- Lockfile check ---
  const lockfilePattern = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|npm-shrinkwrap\.json)$/i;
  const lockfileTouched = files.some((file) => lockfilePattern.test(file));
  if (lockfileTouched && process.env.CLAUDE_AUTOFIX_ALLOW_LOCKFILES !== "true") {
    throw new Error(
      "Autofix guard: lockfile changes are blocked unless CLAUDE_AUTOFIX_ALLOW_LOCKFILES=true",
    );
  }

  // --- File deletion check ---
  if (process.env.CLAUDE_AUTOFIX_ALLOW_DELETIONS !== "true") {
    const deletedFiles = loadDeletedFiles().map((file) => normalizePath(file));
    if (deletedFiles.length > 0) {
      const message = [
        "Autofix guard: file deletions are not permitted",
        ...deletedFiles.map((file) => `- ${file}`),
        "Autofixes should be additive (add deps, fix config, patch code) not destructive (delete files).",
        "Set CLAUDE_AUTOFIX_ALLOW_DELETIONS=true only for explicit reviewed exceptions.",
      ].join("\n");
      for (const file of deletedFiles) {
        try { run(`git checkout HEAD -- "${file}"`); } catch { /* file may not exist in HEAD */ }
      }
      throw new Error(message);
    }
  }

  // --- Net deletion threshold ---
  const maxNetDeletions = Number.parseInt(process.env.CLAUDE_AUTOFIX_MAX_NET_DELETIONS ?? "100", 10);
  if (maxNetDeletions > 0) {
    const stats = loadDiffStats();
    if (stats.net < -maxNetDeletions) {
      const message = [
        `Autofix guard: net deletion of ${Math.abs(stats.net)} lines exceeds threshold of ${maxNetDeletions}`,
        `  Insertions: +${stats.insertions}`,
        `  Deletions:  -${stats.deletions}`,
        `  Net:        ${stats.net}`,
        "Autofixes that remove more code than they add are likely reverting intentional changes.",
        "This change requires human review. Restoring working tree.",
      ].join("\n");
      run("git checkout HEAD -- . 2>/dev/null || true");
      throw new Error(message);
    }
  }
}

main();
