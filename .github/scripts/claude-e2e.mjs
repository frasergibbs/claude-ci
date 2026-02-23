import fs from "node:fs";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";

const PASS_SCHEMA_PATH = ".github/schemas/claude-pass-result.schema.json";
const MAX_LOG_CHARS = 16000;
const DEFAULT_TIMEOUT_SECONDS = 600;

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

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

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
      "User-Agent": "ops-control-plane-claude-e2e",
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

function hasWorkingTreeChanges() {
  const result = runShell("git status --porcelain", { quiet: true });
  return result.stdout.trim().length > 0;
}

function commitAndPush(message) {
  runShell('git config user.name "github-actions[bot]"');
  runShell('git config user.email "41898282+github-actions[bot]@users.noreply.github.com"');
  // Exclude pipeline runtime artifacts from being committed
  runShell("echo '.claude-pipeline' >> .git/info/exclude");
  runShell("git add -A");
  // Unstage symlinks created by workflow setup (point to .claude-pipeline)
  runShell("git reset HEAD -- .github/scripts .github/schemas 2>/dev/null || true");
  const diff = runShell("git diff --cached --stat", { allowFailure: true, quiet: true });
  if (!diff.stdout?.trim()) {
    console.log("No changes to commit after excluding pipeline artifacts.");
    return;
  }
  runShell(`git commit -m "${message}"`);
  const branch = process.env.GITHUB_HEAD_REF;
  if (branch) {
    runShell(`git push origin HEAD:refs/heads/${branch}`);
  } else {
    runShell("git push");
  }
}

function isUiFile(filePath) {
  return /(ui|components|pages|views|screens)/i.test(filePath);
}

// ---------------------------------------------------------------------------
// Profile resolution
// ---------------------------------------------------------------------------

function resolveProfile() {
  const highest = process.env.CLAUDE_PROFILE_HIGHEST;
  const high = process.env.CLAUDE_PROFILE_HIGH ?? "claude-sonnet-4-6:high";
  const profileStr = highest || high;
  const [model, effort] = profileStr.split(":");
  return { model, effort: effort || "high", value: profileStr };
}

function resolveUpdateProfile() {
  const high = process.env.CLAUDE_PROFILE_HIGH ?? "claude-sonnet-4-6:high";
  const [model, effort] = high.split(":");
  return { model, effort: effort || "high", value: high };
}

function resolveTimeoutMs() {
  const seconds = Number.parseInt(
    process.env.CLAUDE_E2E_TIMEOUT_SECONDS ?? String(DEFAULT_TIMEOUT_SECONDS),
    10,
  );
  return (Number.isFinite(seconds) ? Math.max(60, seconds) : DEFAULT_TIMEOUT_SECONDS) * 1000;
}

// ---------------------------------------------------------------------------
// Claude output parsing
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Dev server lifecycle
// ---------------------------------------------------------------------------

function detectBaseUrl() {
  for (const configFile of ["playwright.config.ts", "playwright.config.js", "playwright.config.mjs"]) {
    try {
      const content = fs.readFileSync(configFile, "utf8");
      const urlMatch = content.match(/baseURL\s*:\s*['"`]([^'"`]+)['"`]/);
      if (urlMatch?.[1]) {
        return urlMatch[1];
      }
      const portMatch = content.match(/webServer[\s\S]*?port\s*:\s*(\d+)/);
      if (portMatch?.[1]) {
        return `http://localhost:${portMatch[1]}`;
      }
    } catch {
      // config file doesn't exist
    }
  }
  return "http://localhost:3000";
}

function detectPlaywrightManagesServer() {
  for (const configFile of ["playwright.config.ts", "playwright.config.js", "playwright.config.mjs"]) {
    try {
      const content = fs.readFileSync(configFile, "utf8");
      if (/webServer\s*[:{]/.test(content)) {
        return true;
      }
    } catch {
      // config file doesn't exist
    }
  }
  return false;
}

function startDevServer() {
  if (detectPlaywrightManagesServer()) {
    return { managed: false, process: null };
  }

  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const startCmd = pkg.scripts?.dev
    ? "npm run dev"
    : pkg.scripts?.start
      ? "npm start"
      : null;

  if (!startCmd) {
    throw new Error("No dev server command found (expected 'dev' or 'start' script in package.json)");
  }

  const child = spawn("/bin/bash", ["-c", startCmd], {
    stdio: "pipe",
    detached: true,
  });

  child.unref();

  return { managed: true, process: child };
}

async function waitForServer(baseUrl, timeoutMs = 30000) {
  const start = Date.now();
  const interval = 1000;

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(baseUrl, { signal: AbortSignal.timeout(3000) });
      if (response.ok || response.status < 500) {
        return true;
      }
    } catch {
      // server not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return false;
}

function stopDevServer(server) {
  if (!server.managed || !server.process) {
    return;
  }
  try {
    process.kill(-server.process.pid, "SIGTERM");
  } catch {
    try {
      server.process.kill("SIGTERM");
    } catch {
      // already exited
    }
  }
}

// ---------------------------------------------------------------------------
// E2E test file detection
// ---------------------------------------------------------------------------

function findExistingE2ETests(uiFiles) {
  const e2eDirs = ["e2e", "tests/e2e", "test/e2e", "__tests__/e2e"];
  const existing = [];

  for (const dir of e2eDirs) {
    try {
      const files = fs.readdirSync(dir, { recursive: true });
      for (const file of files) {
        const filePath = `${dir}/${file}`;
        if (/\.(test|spec)\.[cm]?[jt]sx?$/i.test(String(file))) {
          existing.push(filePath);
        }
      }
    } catch {
      // directory doesn't exist
    }
  }

  return existing;
}

// ---------------------------------------------------------------------------
// Phase 1: E2E Test Generation (SYS-622)
// ---------------------------------------------------------------------------

function buildE2EGenPrompt(input) {
  return [
    // Static preamble (cacheable)
    "You are a senior QA engineer who writes thorough, idiomatic Playwright end-to-end tests. You browse the live application to discover real selectors from the accessibility tree rather than guessing from source code. You prioritize critical user flows, form interactions, and navigation paths.",
    "",
    "BEFORE writing any tests, use Playwright MCP to:",
    "- Navigate to the pages affected by this PR",
    "- Interact with the UI elements that were changed",
    "- Observe the accessibility tree to discover real selectors",
    "- Identify the critical user flows that need coverage",
    "",
    "THEN reason about:",
    "- What user-facing behavior changed? What flows would a QA engineer test?",
    "- What selectors did you discover from the accessibility tree?",
    "- What are the setup requirements (auth state, test data, route configuration)?",
    "- Are there existing E2E tests that need updating, or is this a new untested flow?",
    "",
    "THEN write Playwright test files using ONLY selectors verified against the live app:",
    "- Use `page.getByRole()`, `page.getByText()`, `page.getByLabel()` — accessibility-first selectors",
    "- Follow existing test patterns in the repo (file location, fixtures, helpers, naming)",
    "- Cover happy paths, error states, and critical edge cases",
    "- Use `test.describe()` blocks for logical grouping",
    "",
    // PR-specific context (not cached)
    `Pass: e2e`,
    `Issue key: ${input.issueKey}`,
    `Base URL: ${input.baseUrl}`,
    "",
    "UI files changed:",
    input.uiFiles.join("\n") || "(none)",
    "",
    "All changed files (name-status):",
    input.diff.nameStatus || "(none)",
    "",
    "Diff stat:",
    input.diff.stat || "(none)",
    "",
    "Existing E2E test files:",
    input.existingTests.length > 0 ? input.existingTests.join("\n") : "(none — this repo has no E2E tests yet)",
    "",
    "Return JSON only and match the schema exactly.",
    "Output rules:",
    "- status=pass when you have generated adequate E2E test coverage for the changed UI flows.",
    "- status=fail only when you could not browse the app or write meaningful tests.",
    "- Use blockingFindings=[] when status=pass.",
    "- Include actionsTaken entries listing each test file created.",
  ].join("\n");
}

function buildE2EUpdatePrompt(input) {
  return [
    // Static preamble (cacheable)
    "You are a senior QA engineer updating existing Playwright E2E tests after source code changes. You read the existing tests and the PR diff to understand what selectors or assertions need updating. You make minimal, targeted changes — do not rewrite tests from scratch.",
    "",
    "BEFORE making changes, reason about:",
    "- What UI components changed in this PR?",
    "- Which existing E2E tests cover those components?",
    "- What selectors or assertions might be stale due to the changes?",
    "- Can you infer the new selectors from the source diff?",
    "",
    "THEN update the existing test files:",
    "- Update stale selectors based on the component changes",
    "- Add new test cases if the PR adds new user-facing behavior",
    "- Remove test cases if the PR removes functionality",
    "- Keep changes minimal and targeted",
    "",
    // PR-specific context
    `Pass: e2e`,
    `Issue key: ${input.issueKey}`,
    "",
    "UI files changed:",
    input.uiFiles.join("\n") || "(none)",
    "",
    "Diff stat:",
    input.diff.stat || "(none)",
    "",
    "Existing E2E test files to review/update:",
    input.existingTests.join("\n"),
    "",
    "Return JSON only and match the schema exactly.",
    "Output rules:",
    "- status=pass when you have updated tests to match the changed UI.",
    "- status=fail only when tests could not be meaningfully updated.",
    "- Use blockingFindings=[] when status=pass.",
    "- Include actionsTaken entries listing each test file updated.",
  ].join("\n");
}

function runE2EGeneration(prompt, profile, useMcp) {
  const schema = fs.readFileSync(PASS_SCHEMA_PATH, "utf8");
  const timeoutMs = resolveTimeoutMs();

  const args = [
    "-p", prompt,
    "--output-format", "json",
    "--json-schema", schema,
    "--model", profile.model,
    "--effort", profile.effort,
    "--permission-mode", "bypassPermissions",
    "--no-session-persistence",
  ];

  if (useMcp) {
    const mcpConfig = JSON.stringify({
      mcpServers: {
        playwright: {
          command: "npx",
          args: ["@playwright/mcp@latest", "--headless"],
        },
      },
    });
    args.push("--allowedTools", "Read,Glob,Grep,Edit,Write,mcp__playwright__*");
    args.push("--mcp-config", mcpConfig);
  } else {
    args.push("--allowedTools", "Read,Glob,Grep,Edit,Write");
  }

  const result = runCommand("claude", args, { timeoutMs, quiet: true });
  return parseClaudePassOutput("e2e", result.stdout);
}

// ---------------------------------------------------------------------------
// Phase 2: E2E Test Execution (SYS-623)
// ---------------------------------------------------------------------------

function runPlaywrightTests() {
  const resultsFile = "playwright-results.json";
  const result = runCommand("npx", [
    "playwright", "test",
    "--reporter=json,list",
  ], {
    quiet: true,
    allowFailure: true,
    timeoutMs: resolveTimeoutMs(),
  });

  // Try to read JSON results from file or stdout
  let jsonResults = null;
  try {
    if (fs.existsSync(resultsFile)) {
      jsonResults = JSON.parse(fs.readFileSync(resultsFile, "utf8"));
    }
  } catch {
    // fallback to parsing stdout
  }

  if (!jsonResults) {
    try {
      // JSON reporter writes to stdout when no file specified
      const jsonStart = result.stdout.indexOf("{");
      if (jsonStart >= 0) {
        jsonResults = JSON.parse(result.stdout.slice(jsonStart));
      }
    } catch {
      // couldn't parse JSON from output
    }
  }

  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
    jsonResults,
  };
}

function parseTestResults(executionResult) {
  const results = { total: 0, passed: 0, failed: 0, skipped: 0, tests: [] };

  if (executionResult.jsonResults?.suites) {
    const walk = (suites) => {
      for (const suite of suites) {
        if (suite.specs) {
          for (const spec of suite.specs) {
            for (const test of spec.tests || []) {
              for (const result of test.results || []) {
                results.total += 1;
                const status = result.status || "unknown";
                if (status === "passed" || status === "expected") {
                  results.passed += 1;
                } else if (status === "skipped") {
                  results.skipped += 1;
                } else {
                  results.failed += 1;
                }
                results.tests.push({
                  name: `${spec.title}`,
                  status,
                  duration: result.duration || 0,
                  error: result.error?.message,
                });
              }
            }
          }
        }
        if (suite.suites) {
          walk(suite.suites);
        }
      }
    };
    walk(executionResult.jsonResults.suites);
  }

  // Fallback: use exit code if no structured results
  if (results.total === 0) {
    results.total = 1;
    if (executionResult.exitCode === 0) {
      results.passed = 1;
    } else {
      results.failed = 1;
      results.tests.push({
        name: "E2E tests",
        status: "failed",
        duration: 0,
        error: clip(executionResult.stderr || executionResult.stdout, 2000),
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Phase 3: Self-healing (SYS-623)
// ---------------------------------------------------------------------------

function buildSelfHealingPrompt(testResults, failedTests) {
  return [
    "You are a senior QA engineer fixing failing Playwright E2E tests. The tests were just generated or updated and some are failing. Focus on the most common E2E failure modes:",
    "",
    "BEFORE making changes, reason about each failure:",
    "- Is this a selector issue? (element not found, wrong role/text)",
    "- Is this a timing issue? (element not yet visible, animation in progress)",
    "- Is this a test setup issue? (missing auth, wrong URL, missing test data)",
    "- What is the minimal change to make the test pass WITHOUT weakening assertions?",
    "",
    "THEN fix the test files. Rules:",
    "- Only modify test files — NEVER modify application source code",
    "- Make minimal, targeted fixes",
    "- Do not weaken assertions (e.g., don't change exact text match to contains)",
    "- Add `await` for timing issues, use `waitFor` for visibility issues",
    "- If a test is fundamentally broken, delete it rather than leaving it failing",
    "",
    "Failing tests:",
    ...failedTests.map((t) => `- ${t.name}: ${t.error || "unknown error"}`),
    "",
    `Total: ${testResults.total} tests, ${testResults.passed} passed, ${testResults.failed} failed`,
  ].join("\n");
}

function runSelfHealingFix(prompt, profile) {
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

function validateFixChanges() {
  // Restrict autofix-guard to test directories only
  const originalAllowedPaths = process.env.CLAUDE_AUTOFIX_ALLOWED_PATHS;
  process.env.CLAUDE_AUTOFIX_ALLOWED_PATHS = "e2e/,tests/,__tests__/,test/,*.test.*,*.spec.*";
  try {
    runCommand("node", [".github/scripts/claude-autofix-guard.mjs"]);
  } finally {
    if (originalAllowedPaths !== undefined) {
      process.env.CLAUDE_AUTOFIX_ALLOWED_PATHS = originalAllowedPaths;
    } else {
      delete process.env.CLAUDE_AUTOFIX_ALLOWED_PATHS;
    }
  }
}

// ---------------------------------------------------------------------------
// PR comment formatting
// ---------------------------------------------------------------------------

function formatE2EComment(testResults, status) {
  const rows = testResults.tests
    .slice(0, 20) // cap at 20 rows
    .map((t) => `| ${t.name} | ${t.status === "passed" || t.status === "expected" ? "Pass" : "Fail"} | ${(t.duration / 1000).toFixed(1)}s |`);

  const failedTests = testResults.tests.filter((t) => t.status !== "passed" && t.status !== "expected" && t.status !== "skipped");

  const lines = [
    "<!-- claude-e2e:results -->",
    "### E2E Test Results",
    "",
    `**Status**: ${status}`,
    "",
    `| Test | Status | Duration |`,
    `|------|--------|----------|`,
    ...rows,
    "",
  ];

  if (failedTests.length > 0) {
    lines.push(
      "<details><summary>Failure details</summary>",
      "",
      ...failedTests.slice(0, 5).map((t) => `**${t.name}**:\n\`\`\`\n${clip(t.error || "No error details", 500)}\n\`\`\``),
      "",
      "</details>",
      "",
    );
  }

  lines.push("*Non-blocking — E2E results are advisory only.*");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

async function main() {
  appendSummary(["### Claude E2E", "Starting E2E test pipeline."]);

  const pullRequestRef = workflowRun.pull_requests?.[0];
  if (!pullRequestRef?.number) {
    appendSummary(["### Claude E2E", "No pull request attached to this workflow run. Skipping."]);
    return;
  }

  const pullNumber = pullRequestRef.number;
  const pr = await githubRequest(`/repos/${owner}/${repo}/pulls/${pullNumber}`);

  if (pr.state !== "open") {
    appendSummary(["### Claude E2E", `PR #${pullNumber} is not open. Skipping.`]);
    return;
  }

  // Get changed files
  const prFiles = await githubRequest(`/repos/${owner}/${repo}/pulls/${pullNumber}/files?per_page=100`);
  const changedFiles = prFiles.map((file) => file.filename);
  const uiFiles = changedFiles.filter((file) => isUiFile(file));

  if (uiFiles.length === 0) {
    appendSummary(["### Claude E2E", "No UI files changed. Skipping."]);
    return;
  }

  // Extract issue key
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

  const baseUrl = detectBaseUrl();
  const existingTests = findExistingE2ETests(uiFiles);
  const needsMcp = existingTests.length === 0;
  const genProfile = needsMcp ? resolveProfile() : resolveUpdateProfile();

  appendSummary([
    "### Claude E2E Routing",
    `- PR: #${pullNumber}`,
    `- Issue key: ${issueKey || "none"}`,
    `- UI files changed: ${uiFiles.length}`,
    `- Existing E2E tests: ${existingTests.length}`,
    `- Mode: ${needsMcp ? "generate (Playwright MCP)" : "update (no MCP)"}`,
    `- Base URL: ${baseUrl}`,
    `- Profile: ${genProfile.value}`,
  ]);

  // Start dev server (if not Playwright-managed)
  let server = { managed: false, process: null };
  try {
    // Phase 1: Generate or update E2E tests
    if (needsMcp) {
      server = startDevServer();
      if (server.managed) {
        const serverReady = await waitForServer(baseUrl);
        if (!serverReady) {
          appendSummary(["### Claude E2E", "Dev server did not become healthy. Posting advisory."]);
          await githubRequest(`/repos/${owner}/${repo}/issues/${pullNumber}/comments`, {
            method: "POST",
            body: {
              body: [
                "<!-- claude-e2e:advisory -->",
                "### Claude E2E — Advisory",
                "",
                "E2E test generation skipped: dev server did not start within timeout.",
              ].join("\n"),
            },
          });
          return;
        }
      }
    }

    const prompt = needsMcp
      ? buildE2EGenPrompt({ issueKey, diff, uiFiles, baseUrl, existingTests })
      : buildE2EUpdatePrompt({ issueKey, diff, uiFiles, existingTests });

    const genResult = runE2EGeneration(prompt, genProfile, needsMcp);

    appendSummary([
      "### Claude E2E Pass: generation",
      `- Status: ${genResult.status}`,
      `- Summary: ${genResult.summary}`,
      `- Actions taken: ${genResult.actionsTaken.length}`,
    ]);

    if (genResult.actionsTaken.length === 0 || !hasWorkingTreeChanges()) {
      appendSummary(["### Claude E2E", "No E2E test changes generated."]);
      return;
    }

    // Compile validation
    const compileCheck = runShell("npx tsc --noEmit 2>&1 || true", { quiet: true, allowFailure: true });
    if (compileCheck.status !== 0) {
      appendSummary(["### Claude E2E", "Generated tests have TypeScript errors. Attempting to proceed anyway."]);
    }

    // Phase 2: Execute tests deterministically
    // Start dev server for execution if Playwright manages it (already running otherwise)
    if (!server.managed && !detectPlaywrightManagesServer()) {
      server = startDevServer();
      if (server.managed) {
        await waitForServer(baseUrl);
      }
    }

    const executionResult = runPlaywrightTests();
    const testResults = parseTestResults(executionResult);

    appendSummary([
      "### Claude E2E Pass: execution",
      `- Total: ${testResults.total}`,
      `- Passed: ${testResults.passed}`,
      `- Failed: ${testResults.failed}`,
      `- Skipped: ${testResults.skipped}`,
    ]);

    if (testResults.failed === 0) {
      // All tests pass — commit and report success
      commitAndPush("test(claude): add E2E tests for PR changes");
      await githubRequest(`/repos/${owner}/${repo}/issues/${pullNumber}/comments`, {
        method: "POST",
        body: { body: formatE2EComment(testResults, `Pass (${testResults.passed}/${testResults.total})`) },
      });
      appendSummary(["### Claude E2E", "E2E tests generated, verified, and committed."]);
      return;
    }

    // Phase 3: Self-healing (one shot only)
    const failedTests = testResults.tests.filter((t) => t.status !== "passed" && t.status !== "expected" && t.status !== "skipped");
    const healingPrompt = buildSelfHealingPrompt(testResults, failedTests);
    const healingProfile = resolveUpdateProfile();

    appendSummary(["### Claude E2E", `Attempting self-healing for ${failedTests.length} failing tests.`]);
    runSelfHealingFix(healingPrompt, healingProfile);

    if (hasWorkingTreeChanges()) {
      validateFixChanges();
    }

    // Re-run tests after fix
    const rerunResult = runPlaywrightTests();
    const rerunResults = parseTestResults(rerunResult);

    appendSummary([
      "### Claude E2E Pass: self-healing rerun",
      `- Total: ${rerunResults.total}`,
      `- Passed: ${rerunResults.passed}`,
      `- Failed: ${rerunResults.failed}`,
    ]);

    if (rerunResults.failed === 0) {
      commitAndPush("test(claude): add E2E tests with self-healing fixes");
      await githubRequest(`/repos/${owner}/${repo}/issues/${pullNumber}/comments`, {
        method: "POST",
        body: { body: formatE2EComment(rerunResults, `Pass after self-healing (${rerunResults.passed}/${rerunResults.total})`) },
      });
      appendSummary(["### Claude E2E", "E2E tests passed after self-healing. Committed."]);
    } else {
      // Discard all changes
      runShell("git checkout -- .", { quiet: true });
      runShell("git clean -fd", { quiet: true });
      await githubRequest(`/repos/${owner}/${repo}/issues/${pullNumber}/comments`, {
        method: "POST",
        body: { body: formatE2EComment(rerunResults, `Advisory — ${rerunResults.failed} failures after self-healing`) },
      });
      appendSummary(["### Claude E2E", "E2E tests still failing after self-healing. Discarded."]);
    }
  } finally {
    stopDevServer(server);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  appendSummary(["### Claude E2E Failed", message]);

  // Post advisory comment — don't fail the workflow
  const pullNumber = workflowRun.pull_requests?.[0]?.number;
  if (pullNumber) {
    githubRequest(`/repos/${owner}/${repo}/issues/${pullNumber}/comments`, {
      method: "POST",
      body: {
        body: [
          "<!-- claude-e2e:advisory -->",
          "### Claude E2E — Advisory",
          "",
          `E2E pipeline was unable to complete: ${message}`,
        ].join("\n"),
      },
    }).catch(() => {});
  }

  console.error("claude-e2e failed", error);
  // Non-blocking — exit 0 so the workflow doesn't fail
  process.exit(0);
});
