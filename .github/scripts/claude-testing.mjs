import fs from "node:fs";
import process from "node:process";
import { spawnSync } from "node:child_process";

const PASS_SCHEMA_PATH = ".github/schemas/claude-pass-result.schema.json";
const MAX_LOG_CHARS = 16000;
const DEFAULT_TIMEOUT_SECONDS = 300;

const token = process.env.GITHUB_TOKEN;
if (!token) {
  throw new Error("GITHUB_TOKEN is required");
}

const eventPath = process.env.GITHUB_EVENT_PATH;
if (!eventPath) {
  throw new Error("GITHUB_EVENT_PATH is required");
}

const payload = JSON.parse(fs.readFileSync(eventPath, "utf8"));
const workflowRun = payload.workflow_run;

if (!workflowRun) {
  throw new Error("workflow_run payload is required");
}

const repositoryFullName = payload.repository?.full_name ?? process.env.GITHUB_REPOSITORY;
if (!repositoryFullName || !repositoryFullName.includes("/")) {
  throw new Error("Unable to resolve repository name");
}

const [owner, repo] = repositoryFullName.split("/");

function appendSummary(lines) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  fs.appendFileSync(summaryPath, `${lines.join("\n")}\n`);
}

function clip(value, maxChars = MAX_LOG_CHARS) {
  const text = String(value ?? "");
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n...[truncated]...`;
}

function runShell(command, options = {}) {
  const { quiet = false, allowFailure = false } = options;
  const result = spawnSync(command, {
    shell: "/bin/bash",
    encoding: "utf8",
    stdio: quiet ? ["pipe", "pipe", "pipe"] : undefined,
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`Command failed: ${command}\n${result.stderr || ""}`);
  }
  return result;
}

function runCommand(command, args, options = {}) {
  const { timeoutMs, quiet = false, allowFailure = false } = options;
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: quiet ? ["pipe", "pipe", "pipe"] : undefined,
    maxBuffer: 50 * 1024 * 1024,
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(
      `Command failed: ${command} ${args.join(" ")}\n${result.stderr || ""}`,
    );
  }
  return result;
}

async function githubRequest(path, { method = "GET", body, allow404 = false } = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "ops-control-plane-claude-testing",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (allow404 && response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(`GitHub API ${method} ${path} failed: ${response.status} ${responseText}`);
  }

  if (response.status === 204) {
    return {};
  }

  return response.json();
}

function isTestFile(filePath) {
  return /(^|\/)(__tests__|test|tests)\//i.test(filePath) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(filePath);
}

function isSourceFile(filePath) {
  if (isTestFile(filePath)) {
    return false;
  }
  if (/^docs\//i.test(filePath) || /^\.github\//i.test(filePath)) {
    return false;
  }
  if (/\.(md|mdx|txt|png|jpg|jpeg|gif|svg|json|ya?ml)$/i.test(filePath)) {
    return false;
  }
  return /\.(tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|swift|php|rb)$/i.test(filePath);
}

function isDocsFile(filePath) {
  return /^docs\//i.test(filePath) || /README\.md$/i.test(filePath) || /\.(md|mdx)$/i.test(filePath);
}

function isUiFile(filePath) {
  return /(ui|components|pages|views|screens)/i.test(filePath);
}

function detectPlaywrightDependency() {
  const pkgPaths = ["package.json"];
  try {
    const entries = fs.readdirSync("packages", { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        pkgPaths.push(`packages/${entry.name}/package.json`);
      }
    }
  } catch {
    // no packages directory
  }
  try {
    const entries = fs.readdirSync("apps", { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        pkgPaths.push(`apps/${entry.name}/package.json`);
      }
    }
  } catch {
    // no apps directory
  }
  for (const pkgPath of pkgPaths) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      if ("@playwright/test" in allDeps) {
        return true;
      }
    } catch {
      // skip unreadable package.json
    }
  }
  return false;
}

function writeJobOutput(key, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    fs.appendFileSync(outputPath, `${key}=${value}\n`);
  }
}

function resolveProfile() {
  const medium = process.env.CLAUDE_PROFILE_MEDIUM ?? "claude-sonnet-4-6:medium";
  const high = process.env.CLAUDE_PROFILE_HIGH ?? "claude-sonnet-4-6:high";
  // Test generation benefits from higher reasoning
  const profileStr = high || medium;
  const [model, effort] = profileStr.split(":");
  return { model, effort: effort || "medium", value: profileStr };
}

function resolveTimeoutMs() {
  const seconds = Number.parseInt(
    process.env.CLAUDE_TESTING_TIMEOUT_SECONDS ?? String(DEFAULT_TIMEOUT_SECONDS),
    10,
  );
  return (Number.isFinite(seconds) ? Math.max(60, seconds) : DEFAULT_TIMEOUT_SECONDS) * 1000;
}

function resolveQualityBaselineCommand() {
  return process.env.CLAUDE_QUALITY_BASELINE_COMMAND?.trim() || "npx turbo typecheck test";
}

function parseClaudePassOutput(passName, stdout) {
  if (!stdout || stdout.trim().length === 0) {
    throw new Error(`Claude output empty for ${passName}`);
  }

  let conversation;
  try {
    conversation = JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `Invalid JSON output from Claude for ${passName}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let resultText = "";
  if (Array.isArray(conversation)) {
    for (let i = conversation.length - 1; i >= 0; i -= 1) {
      const msg = conversation[i];
      if (msg.role === "assistant" && typeof msg.content === "string") {
        resultText = msg.content;
        break;
      }
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const textBlock = msg.content.find((block) => block.type === "text" && block.text);
        if (textBlock) {
          resultText = textBlock.text;
          break;
        }
      }
    }
  } else if (typeof conversation === "object" && conversation.content) {
    resultText = typeof conversation.content === "string"
      ? conversation.content
      : JSON.stringify(conversation.content);
  }

  if (!resultText) {
    throw new Error(`No assistant content found in Claude output for ${passName}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(resultText);
  } catch (error) {
    throw new Error(
      `Claude output is not valid JSON for ${passName}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed.pass || !parsed.status || !Array.isArray(parsed.blockingFindings) || !parsed.summary) {
    throw new Error(`Claude output missing required schema fields for ${passName}`);
  }

  return parsed;
}

function runClaudePass(passName, prompt, profile) {
  const schema = fs.readFileSync(PASS_SCHEMA_PATH, "utf8");
  const timeoutMs = resolveTimeoutMs();
  const result = runCommand("claude", [
    "-p", prompt,
    "--output-format", "json",
    "--json-schema", schema,
    "--model", profile.model,
    "--effort", profile.effort,
    "--permission-mode", "bypassPermissions",
    "--allowedTools", "Read,Glob,Grep",
    "--no-session-persistence",
  ], { timeoutMs, quiet: true });
  return parseClaudePassOutput(passName, result.stdout);
}

function runClaudeFix(passName, prompt, profile) {
  const timeoutMs = resolveTimeoutMs();
  runCommand("claude", [
    "-p", prompt,
    "--output-format", "text",
    "--model", profile.model,
    "--effort", profile.effort,
    "--permission-mode", "bypassPermissions",
    "--allowedTools", "Read,Glob,Grep,Edit,Write",
    "--no-session-persistence",
  ], { timeoutMs });
}

function hasWorkingTreeChanges() {
  const result = runShell("git status --porcelain", { quiet: true });
  return result.stdout.trim().length > 0;
}

function commitAndPush(message) {
  runShell('git config user.name "github-actions[bot]"');
  runShell('git config user.email "41898282+github-actions[bot]@users.noreply.github.com"');
  runShell("git add -A");
  runShell(`git commit -m "${message}"`);
  runShell("git push");
}

function buildTestGenPrompt(input) {
  return [
    "You are a senior test engineer who writes thorough, idiomatic tests. You study the existing test patterns in the repo (framework, assertion style, file naming, mocking patterns) and follow them exactly. You focus on behavior coverage — happy paths, error cases, and edge conditions — not on achieving line count.",
    "",
    "BEFORE writing any tests, reason about:",
    "- What source files were changed and what behaviors do they implement?",
    "- What existing test files cover these components? Are there gaps?",
    "- What test framework and patterns does this repo use? (Look at existing test files.)",
    "- What are the most important behaviors to test — failure modes, edge cases, or integration points?",
    "- Which source files have NO corresponding test file at all?",
    "",
    "THEN generate or extend test files. Follow the repo's existing test conventions exactly.",
    "",
    `Pass: testing`,
    `Issue key: ${input.issueKey}`,
    "",
    "Source files changed (without tests):",
    input.untestedFiles.length > 0 ? input.untestedFiles.join("\n") : "(all changed files have tests)",
    "",
    "All changed files (name-status):",
    input.diff.nameStatus || "(none)",
    "",
    "Diff stat:",
    input.diff.stat || "(none)",
    "",
    "Return JSON only and match the schema exactly.",
    "Output rules:",
    "- status=pass when you have generated or verified adequate test coverage.",
    "- status=fail only when critical test gaps remain that you cannot address.",
    "- Use blockingFindings=[] when status=pass.",
    "- Include actionsTaken entries listing each test file created or extended.",
  ].join("\n");
}

async function main() {
  appendSummary(["### Claude Testing", "Starting test generation for PR changes."]);

  const pullRequestRef = workflowRun.pull_requests?.[0];
  if (!pullRequestRef?.number) {
    appendSummary(["### Claude Testing", "No pull request attached to this workflow run. Skipping."]);
    return;
  }

  const pullNumber = pullRequestRef.number;
  const pr = await githubRequest(`/repos/${owner}/${repo}/pulls/${pullNumber}`);

  if (pr.state !== "open") {
    appendSummary(["### Claude Testing", `PR #${pullNumber} is not open. Skipping.`]);
    return;
  }

  // Get changed files
  const prFiles = await githubRequest(`/repos/${owner}/${repo}/pulls/${pullNumber}/files?per_page=100`);
  const changedFiles = prFiles.map((file) => file.filename);

  // Skip if only docs or test files changed
  const hasSourceFiles = changedFiles.some((file) => isSourceFile(file));
  if (!hasSourceFiles) {
    appendSummary(["### Claude Testing", "No source files changed. Skipping test generation."]);
    return;
  }

  // Identify source files without corresponding test files
  const sourceFiles = changedFiles.filter((file) => isSourceFile(file));
  const testFiles = new Set(changedFiles.filter((file) => isTestFile(file)));
  const untestedFiles = sourceFiles.filter((file) => {
    const testVariants = [
      file.replace(/\.([cm]?[jt]sx?)$/, ".test.$1"),
      file.replace(/\.([cm]?[jt]sx?)$/, ".spec.$1"),
      file.replace(/\/src\//, "/__tests__/").replace(/\.([cm]?[jt]sx?)$/, ".test.$1"),
    ];
    return !testVariants.some((variant) => testFiles.has(variant));
  });

  // Extract issue key from PR
  const issueKeyRegex = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/i;
  const issueKeyMatch = (pr.title || "").match(issueKeyRegex) || (pr.body || "").match(issueKeyRegex);
  const issueKey = issueKeyMatch?.[1]?.toUpperCase() ?? "";

  // Checkout PR branch
  runShell(`git checkout ${pr.head.ref}`);

  // Get diff summary
  const nameStatusResult = runShell(`git diff --name-status ${pr.base.ref}...HEAD`, { quiet: true });
  const statResult = runShell(`git diff --stat ${pr.base.ref}...HEAD`, { quiet: true });
  const diff = {
    nameStatus: clip(nameStatusResult.stdout),
    stat: clip(statResult.stdout),
  };

  const profile = resolveProfile();

  appendSummary([
    "### Claude Testing Routing",
    `- PR: #${pullNumber}`,
    `- Issue key: ${issueKey || "none"}`,
    `- Source files changed: ${sourceFiles.length}`,
    `- Files without tests: ${untestedFiles.length}`,
    `- Profile: ${profile.value}`,
  ]);

  try {
    const testPrompt = buildTestGenPrompt({ issueKey, diff, untestedFiles });
    const testResult = runClaudePass("testing", testPrompt, profile);

    appendSummary([
      "### Claude Pass: testing",
      `- Status: ${testResult.status}`,
      `- Summary: ${testResult.summary}`,
      `- Actions taken: ${testResult.actionsTaken.length}`,
    ]);

    if (testResult.actionsTaken.length > 0 && hasWorkingTreeChanges()) {
      // Validate generated tests compile and pass
      runCommand("node", [".github/scripts/claude-autofix-guard.mjs"]);

      const qualityCmd = resolveQualityBaselineCommand();
      const verification = runShell(qualityCmd, { quiet: true, allowFailure: true });

      if (verification.status === 0) {
        commitAndPush("test(claude): add generated tests for PR changes");
        appendSummary(["### Claude Testing", "Tests generated, verified, and committed."]);
      } else {
        // Discard failing tests
        runShell("git checkout -- .", { quiet: true });
        appendSummary([
          "### Claude Testing",
          "Generated tests failed verification. Discarded.",
          `Verification output: ${clip(verification.stderr || verification.stdout, 2000)}`,
        ]);

        await githubRequest(`/repos/${owner}/${repo}/issues/${pullNumber}/comments`, {
          method: "POST",
          body: {
            body: [
              "<!-- claude-testing:advisory -->",
              "### Claude Testing — Advisory",
              "",
              "Test generation completed but generated tests did not pass verification.",
              `Files attempted: ${untestedFiles.join(", ") || "various"}`,
              "",
              `Summary: ${testResult.summary}`,
            ].join("\n"),
          },
        });
      }
    } else {
      appendSummary(["### Claude Testing", "No test changes generated."]);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendSummary(["### Claude Testing", `Advisory only — skipped: ${message}`]);

    await githubRequest(`/repos/${owner}/${repo}/issues/${pullNumber}/comments`, {
      method: "POST",
      body: {
        body: [
          "<!-- claude-testing:advisory -->",
          "### Claude Testing — Advisory",
          "",
          `Test generation was unable to complete: ${message}`,
        ].join("\n"),
      },
    });
  }

  // Detect E2E eligibility for downstream e2e job
  const hasUiChanges = changedFiles.some((file) => isUiFile(file));
  const hasPlaywright = detectPlaywrightDependency();
  writeJobOutput("has-ui-changes", String(hasUiChanges));
  writeJobOutput("has-playwright", String(hasPlaywright));
  appendSummary([
    "### E2E Eligibility",
    `- UI changes detected: ${hasUiChanges}`,
    `- Playwright installed: ${hasPlaywright}`,
    `- E2E eligible: ${hasUiChanges && hasPlaywright}`,
  ]);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  appendSummary(["### Claude Testing Failed", message]);
  console.error("claude-testing failed", error);
  process.exit(1);
});
