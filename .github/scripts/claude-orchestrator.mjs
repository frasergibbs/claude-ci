import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const PASS_SCHEMA_PATH = ".github/schemas/claude-pass-result.schema.json";
const MAX_LOG_CHARS = 16000;
const DEFAULT_CLAUDE_PASS_TIMEOUT_SECONDS = 300;

let blockedCommentPosted = false;

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

function runCommand(command, args, options = {}) {
  const {
    env,
    input,
    cwd = process.cwd(),
    allowFailure = false,
    quiet = false,
    timeoutMs,
  } = options;

  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    input,
    maxBuffer: 20 * 1024 * 1024,
    timeout: timeoutMs,
  });

  const status = result.status ?? 1;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.error) {
    const details =
      result.error.code === "ETIMEDOUT" && timeoutMs
        ? `Command timed out after ${timeoutMs}ms`
        : `Command execution error: ${result.error.message}`;
    if (!allowFailure) {
      throw new Error(`${details}: ${command} ${args.join(" ")}`);
    }
    return { status, stdout, stderr: `${stderr}\n${details}`.trim() };
  }

  if (!quiet) {
    if (stdout) {
      process.stdout.write(stdout);
    }
    if (stderr) {
      process.stderr.write(stderr);
    }
  }

  if (status !== 0 && !allowFailure) {
    const output = clip(`${stdout}\n${stderr}`.trim());
    throw new Error(
      `Command failed (${status}): ${command} ${args.join(" ")}\n${output}`,
    );
  }

  return { status, stdout, stderr };
}

function runShell(command, options = {}) {
  return runCommand("/bin/bash", ["-lc", command], options);
}

function readEventPayload() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error("GITHUB_EVENT_PATH is required");
  }

  const payload = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  const pr = payload.pull_request;
  if (!pr) {
    throw new Error("This workflow expects a pull_request event payload");
  }
  return { payload, pr };
}

function parseGithubOutputFile(outputPath) {
  const map = {};
  if (!fs.existsSync(outputPath)) {
    return map;
  }

  const lines = fs.readFileSync(outputPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line || !line.includes("=")) {
      continue;
    }
    const index = line.indexOf("=");
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1);
    if (!key) {
      continue;
    }
    map[key] = value;
  }
  return map;
}

function runReviewAction(action, args = [], options = {}) {
  const { captureOutputs = false, allowFailure = false } = options;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-review-action-"));
  const outputPath = path.join(tempDir, "github_output.txt");
  const env = captureOutputs ? { GITHUB_OUTPUT: outputPath } : {};

  const result = runCommand(
    "node",
    [".github/scripts/claude-review.mjs", action, ...args.map(String)],
    { env, allowFailure },
  );

  return {
    ...result,
    outputs: captureOutputs ? parseGithubOutputFile(outputPath) : {},
  };
}

function parseEstimate(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 5) {
    return parsed;
  }
  return null;
}

function decodeBase64(value) {
  if (!value) {
    return "";
  }
  try {
    return Buffer.from(String(value), "base64").toString("utf8");
  } catch {
    return "";
  }
}

function parseProfile(rawValue, envName) {
  const value = String(rawValue ?? "").trim();
  if (!value) {
    throw new Error(`Missing required workflow variable: ${envName}`);
  }

  const firstColonIndex = value.indexOf(":");
  if (firstColonIndex <= 0 || firstColonIndex === value.length - 1) {
    throw new Error(
      `${envName} must match <model>:<reasoning_effort> (received: ${value})`,
    );
  }

  const model = value.slice(0, firstColonIndex).trim();
  const effort = value.slice(firstColonIndex + 1).trim();
  if (!model || !effort) {
    throw new Error(
      `${envName} must match <model>:<reasoning_effort> (received: ${value})`,
    );
  }

  return { model, effort, value };
}

function resolveScopeProfile() {
  const value = process.env.CLAUDE_PROFILE_LOW;
  if (value) {
    return parseProfile(value, "CLAUDE_PROFILE_LOW");
  }
  return parseProfile(process.env.CLAUDE_PROFILE_MEDIUM, "CLAUDE_PROFILE_MEDIUM");
}

function resolveProfileForEstimate(estimate) {
  if (estimate === 1 || estimate === 2) {
    return parseProfile(process.env.CLAUDE_PROFILE_MEDIUM, "CLAUDE_PROFILE_MEDIUM");
  }
  if (estimate === 3) {
    return parseProfile(process.env.CLAUDE_PROFILE_HIGH, "CLAUDE_PROFILE_HIGH");
  }
  if (estimate === 4) {
    return parseProfile(process.env.CLAUDE_PROFILE_HIGHEST, "CLAUDE_PROFILE_HIGHEST");
  }
  throw new Error(`Unsupported estimate for profile routing: ${estimate}`);
}

function normalizeIssueKey(value) {
  return value.toUpperCase().trim();
}

function extractIssueKey(...values) {
  const regex = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/i;
  for (const value of values) {
    if (!value) {
      continue;
    }
    const match = String(value).match(regex);
    if (match?.[1]) {
      return normalizeIssueKey(match[1]);
    }
  }
  return null;
}

function getManager() {
  if (fs.existsSync("pnpm-lock.yaml")) {
    return "pnpm";
  }
  if (fs.existsSync("yarn.lock")) {
    return "yarn";
  }
  return "npm";
}

function hasTurbo() {
  return fs.existsSync("turbo.json");
}

function resolveQualityBaselineCommand() {
  const override = process.env.CLAUDE_QUALITY_BASELINE_COMMAND?.trim();
  if (override) {
    return override;
  }
  if (hasTurbo()) {
    return "npx turbo typecheck test";
  }

  const manager = getManager();
  if (manager === "pnpm") {
    return "pnpm lint && pnpm build";
  }
  if (manager === "yarn") {
    return "yarn lint && yarn build";
  }
  return "npm run lint && npm run build";
}

function resolveDependencyAuditCommand() {
  const manager = getManager();
  if (manager === "pnpm") {
    return "pnpm audit --prod --audit-level high";
  }
  if (manager === "yarn") {
    return "yarn audit --level high";
  }
  return "npm audit --omit=dev --audit-level high";
}

function commandExists(command) {
  const result = runShell(`command -v ${command}`, { allowFailure: true, quiet: true });
  return result.status === 0;
}

function runCheck(command, label) {
  const result = runShell(command, { allowFailure: true });
  const combined = clip(
    [`$ ${command}`, result.stdout, result.stderr].filter(Boolean).join("\n"),
  );
  return {
    label,
    command,
    status: result.status,
    output: combined,
  };
}

function getGitDiffSummary(baseRef) {
  runShell(`git fetch --no-tags --prune origin ${baseRef}`, {
    allowFailure: true,
    quiet: true,
  });
  const range = `origin/${baseRef}...HEAD`;

  const nameStatus = runShell(`git diff --name-status --find-renames ${range}`, {
    allowFailure: true,
    quiet: true,
  }).stdout;
  const stat = runShell(`git diff --stat ${range}`, {
    allowFailure: true,
    quiet: true,
  }).stdout;

  return {
    range,
    nameStatus: clip(nameStatus, 12000),
    stat: clip(stat, 12000),
  };
}

function buildScopePrompt(input) {
  const issueDescription = clip(input.issueDescription, 10000);
  return [
    "You are a principal engineer validating that a pull request delivers what was promised in the linked Linear issue. You catch scope gaps that surface-level file matching misses — incomplete acceptance criteria, missing migrations, untested edge cases that the issue explicitly requires.",
    "",
    "BEFORE checking any specific criterion, reason about:",
    "- What does this issue actually require? What is the real definition of done beyond the title?",
    "- Looking at the changed files and diff, does this PR address the core intent or just the surface?",
    "- Are there acceptance criteria that require evidence (tests, docs, migrations, config) that is absent from the changeset?",
    "- Could this PR introduce scope that the issue did NOT request, creating unnecessary risk?",
    "",
    "THEN evaluate against the issue spec below.",
    "",
    `Pass: scope`,
    `Issue key: ${input.issueKey}`,
    `Issue title: ${input.issueTitle || "unknown"}`,
    `Issue URL: ${input.issueUrl || "unknown"}`,
    "",
    "Issue description and task packet:",
    issueDescription || "(empty)",
    "",
    "Changed files (name-status):",
    input.diff.nameStatus || "(none)",
    "",
    "Diff stat:",
    input.diff.stat || "(none)",
    "",
    "Return JSON only and match the schema exactly.",
    "Output rules:",
    "- status=pass only when there are zero blocking scope concerns.",
    "- Include concrete file/line references where possible.",
    "- Use blockingFindings=[] when status=pass.",
  ].join("\n");
}

function buildQualityPrompt(input) {
  return [
    "You are a staff engineer reviewing code quality with a focus on long-term maintainability. You think about what breaks six months from now — regressions, untested paths, implicit coupling, and technical debt that compounds. You use tool outputs as evidence, not as the final verdict.",
    "",
    "BEFORE evaluating specific check outputs, reason about:",
    "- What is the regression risk profile of these changes? Which files are high-traffic or critical-path?",
    "- Are there test coverage gaps for the new or modified code paths? Would a reasonable developer trust these changes without additional tests?",
    "- Do the changes introduce maintainability concerns — implicit dependencies, unclear naming, duplicated logic, or patterns that diverge from the existing codebase?",
    "- Could the baseline check failures be false positives, or do they indicate real issues?",
    "",
    "THEN evaluate the check outputs and codebase evidence.",
    "",
    `Pass: quality`,
    `Issue key: ${input.issueKey}`,
    `Estimate: ${input.estimate}`,
    "",
    "Changed files (name-status):",
    input.diff.nameStatus || "(none)",
    "",
    "Diff stat:",
    input.diff.stat || "(none)",
    "",
    "Baseline quality checks:",
    input.qualityCommand.output,
    "",
    "Diff guardrails result:",
    input.guardrails.output,
    "",
    "Return JSON only and match the schema exactly.",
    "Output rules:",
    "- status=pass only when blocking quality issues are resolved.",
    "- Include actionable, specific findings with file paths.",
    "- Use blockingFindings=[] when status=pass.",
  ].join("\n");
}

function buildSecurityPrompt(input) {
  return [
    "You are a senior security engineer reviewing this PR for vulnerabilities, unsafe patterns, and high-impact performance risks. You think in terms of attack surfaces, trust boundaries, and data flow — not just pattern matching. Static scan outputs are starting evidence, not the complete picture.",
    "",
    "BEFORE evaluating scan outputs, reason about:",
    "- What is the attack surface of these changes? Do they handle user input, authentication, authorization, or external data?",
    "- Are there trust boundary crossings — data moving between client/server, internal/external, privileged/unprivileged contexts?",
    "- Could the changes introduce injection vectors (SQL, command, XSS, template), broken access control, or secrets exposure?",
    "- Are there performance implications that could become denial-of-service vectors (unbounded loops, missing pagination, expensive queries)?",
    "",
    "THEN evaluate the static analysis evidence and inspect relevant source files.",
    "",
    `Pass: security`,
    `Issue key: ${input.issueKey}`,
    `Estimate: ${input.estimate}`,
    "",
    "Changed files (name-status):",
    input.diff.nameStatus || "(none)",
    "",
    "Diff stat:",
    input.diff.stat || "(none)",
    "",
    "Heuristic security scan output:",
    input.securityHeuristics.output,
    "",
    "Dependency audit output:",
    input.dependencyAudit.output,
    "",
    "Semgrep output:",
    input.semgrep.output,
    "",
    "Return JSON only and match the schema exactly.",
    "Output rules:",
    "- status=pass only when there are zero blocking security/performance issues.",
    "- Use severity critical/high/medium/low.",
    "- Use blockingFindings=[] when status=pass.",
  ].join("\n");
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

  // Claude Code CLI --output-format json returns different shapes:
  //   1. Conversation array: [{role: "assistant", content: [{type: "text", text: "..."}]}]
  //   2. CLI wrapper object: {type: "result", structured_output: {...}, result: "", ...}
  //   3. Direct schema-conformant object: {pass: "scope", status: "pass", ...}
  let resultText = "";
  if (Array.isArray(conversation)) {
    for (let i = conversation.length - 1; i >= 0; i -= 1) {
      const msg = conversation[i];
      if (msg.role === "assistant" && typeof msg.content === "string") {
        resultText = msg.content;
        break;
      }
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const textBlock = msg.content.find((b) => b.type === "text");
        if (textBlock?.text) {
          resultText = textBlock.text;
          break;
        }
      }
    }
  } else if (typeof conversation === "object" && conversation !== null) {
    if (conversation.structured_output != null) {
      // CLI wrapper with --json-schema: schema-conformant result is in structured_output
      const so = conversation.structured_output;
      resultText = typeof so === "string" ? so : JSON.stringify(so);
    } else if ("result" in conversation && conversation.result) {
      // CLI wrapper without --json-schema: text result is in result field
      const inner = conversation.result;
      resultText = typeof inner === "string" ? inner : JSON.stringify(inner);
    } else if ("pass" in conversation) {
      // Direct schema-conformant object
      resultText = stdout;
    } else {
      const keys = Object.keys(conversation).join(", ");
      console.error(`[parseClaudePassOutput] Unknown output shape for ${passName}. Keys: ${keys}. First 500 chars: ${stdout.slice(0, 500)}`);
      resultText = stdout;
    }
  }

  if (!resultText) {
    const shape = typeof conversation === "object" && conversation !== null
      ? `keys: ${Object.keys(conversation).join(", ")}`
      : `type: ${typeof conversation}`;
    throw new Error(`No assistant message found in Claude output for ${passName}. ${shape}. First 300 chars: ${stdout.slice(0, 300)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(resultText);
  } catch (error) {
    throw new Error(
      `Invalid JSON in Claude assistant message for ${passName}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid Claude output shape for ${passName}`);
  }

  if (parsed.pass !== passName) {
    throw new Error(`Claude output pass mismatch for ${passName}: ${parsed.pass}`);
  }

  if (!["pass", "fail"].includes(parsed.status)) {
    throw new Error(`Claude output status invalid for ${passName}`);
  }

  if (!Array.isArray(parsed.blockingFindings)) {
    throw new Error(`Claude output blockingFindings must be an array for ${passName}`);
  }

  if (typeof parsed.summary !== "string" || parsed.summary.trim().length === 0) {
    throw new Error(`Claude output summary missing for ${passName}`);
  }

  if (!Array.isArray(parsed.actionsTaken)) {
    throw new Error(`Claude output actionsTaken must be an array for ${passName}`);
  }

  return parsed;
}

function resolveClaudePassTimeoutMs() {
  const raw = Number.parseInt(process.env.CLAUDE_PASS_TIMEOUT_SECONDS ?? "", 10);
  const seconds = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CLAUDE_PASS_TIMEOUT_SECONDS;
  return seconds * 1000;
}

function runClaudePass(passName, prompt, profile) {
  const schema = fs.readFileSync(PASS_SCHEMA_PATH, "utf8");
  const timeoutMs = resolveClaudePassTimeoutMs();

  const result = runCommand(
    "claude",
    [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--json-schema",
      schema,
      "--model",
      profile.model,
      "--effort",
      profile.effort,
      "--permission-mode",
      "bypassPermissions",
      "--allowedTools",
      "Read,Glob,Grep",
      "--no-session-persistence",
    ],
    { timeoutMs, quiet: true },
  );

  return parseClaudePassOutput(passName, result.stdout);
}

function runClaudeFix(passName, prompt, profile) {
  const timeoutMs = resolveClaudePassTimeoutMs();
  runCommand(
    "claude",
    [
      "-p",
      prompt,
      "--output-format",
      "text",
      "--model",
      profile.model,
      "--effort",
      profile.effort,
      "--permission-mode",
      "bypassPermissions",
      "--allowedTools",
      "Read,Glob,Grep,Edit,Write",
      "--no-session-persistence",
    ],
    { timeoutMs },
  );
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

async function postBlocked(reason, findings = []) {
  if (blockedCommentPosted) {
    return;
  }
  blockedCommentPosted = true;

  const logPath = path.join(os.tmpdir(), `claude-orchestrator-blocked-${Date.now()}.log`);
  const lines = [
    reason,
    ...findings.map((item) => `${item.title}: ${item.reason} (${item.file}:${item.line})`),
  ];
  fs.writeFileSync(logPath, `${lines.join("\n")}\n`);

  try {
    runReviewAction("review-blocked", ["--log-file", logPath, "--reason", reason]);
  } catch (error) {
    appendSummary([
      "### Claude Orchestrator",
      `Failed to post review-blocked update: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
}

function buildFixPrompt(passName, passResult, context) {
  const scopeConstraints = passName === "scope"
    ? [
        "",
        "SCOPE FIX CONSTRAINTS — read carefully before touching any file:",
        "- Scope fixes are SUBTRACTIVE ONLY. Your only permitted actions are removing or reverting out-of-scope changes.",
        "- NEVER add new files, documentation, comments, or code — even to satisfy an acceptance-criteria finding.",
        "- NEVER generate documentation, README updates, changelog entries, or inline comments to address a finding.",
        "- If a finding says evidence is missing or documentation is absent, DO NOT attempt to create that evidence. That finding cannot be resolved through code changes; leave it unfixed and note it in your summary.",
        "- A scope fix that adds content will itself be flagged as out-of-scope and create an infinite loop. When in doubt, revert rather than add.",
      ]
    : [];

  return [
    `You are a senior engineer applying minimal, surgical fixes to resolve blocking findings from the ${passName} review pass. You understand the codebase context and make the smallest correct change — no drive-by refactors, no style changes, no unrelated improvements.`,
    "",
    "BEFORE editing, reason about each finding:",
    "- What is the root cause? Is the finding valid or a false positive from the review pass?",
    "- What is the minimal fix that resolves the issue without introducing new risk?",
    "- Could the fix break other code paths or tests?",
    ...scopeConstraints,
    "",
    "THEN apply fixes.",
    "",
    `Issue key: ${context.issueKey}`,
    `Pass: ${passName}`,
    "",
    "Blocking findings:",
    ...passResult.blockingFindings.map((finding) =>
      `- [${finding.severity}] ${finding.title}: ${finding.reason} (${finding.file}:${finding.line})`,
    ),
    "",
    "After edits, stop and return a concise change summary.",
  ].join("\n");
}

function isDocsOnlyDiff(nameStatus) {
  if (!nameStatus) {
    return false;
  }
  const files = nameStatus
    .split("\n")
    .map((line) => line.replace(/^[A-Z]\t/, "").trim())
    .filter(Boolean);
  return files.length > 0 && files.every((file) =>
    /^docs\//i.test(file) || /README\.md$/i.test(file) || /\.(md|mdx)$/i.test(file),
  );
}

function buildDocsPrompt(input) {
  const issueDescription = clip(input.issueDescription, 8000);
  return [
    "You are a technical writer embedded in a senior engineering team. You ensure that every meaningful code change has accurate, up-to-date documentation. You focus on what a new developer would need to understand — public APIs, configuration options, architectural decisions, and non-obvious behavior.",
    "",
    "BEFORE making any documentation changes, reason about:",
    "- What components were changed and do they have existing documentation?",
    "- Are there public APIs, exported types, or configuration options that are undocumented or stale?",
    "- Would a developer unfamiliar with this code understand the change from existing docs alone?",
    "- Is there a README, JSDoc, or inline comment that references behavior that this PR changes?",
    "",
    "THEN generate or update documentation as needed. Prefer updating existing files over creating new ones. Keep documentation concise and factual.",
    "",
    `Pass: docs`,
    `Issue key: ${input.issueKey}`,
    "",
    "Issue description:",
    issueDescription || "(empty)",
    "",
    "Changed files (name-status):",
    input.diff.nameStatus || "(none)",
    "",
    "Diff stat:",
    input.diff.stat || "(none)",
    "",
    "Return JSON only and match the schema exactly.",
    "Output rules:",
    "- status=pass when documentation is already adequate or has been updated.",
    "- status=fail only when critical documentation gaps remain that you cannot fix.",
    "- Use blockingFindings=[] when status=pass.",
    "- Include actionsTaken entries describing each documentation change made.",
  ].join("\n");
}

async function main() {
  appendSummary(["### Claude Orchestrator", "Starting mandatory Claude-led review."]);

  const { pr } = readEventPayload();
  const contextAction = runReviewAction("context", [], { captureOutputs: true });
  const context = contextAction.outputs;
  const issueKey =
    context.issue_key?.trim() || extractIssueKey(pr.title, pr.body, pr.head?.ref) || "";

  runReviewAction("review-started");

  if (context.block_human === "true") {
    const reason = context.block_reason?.trim() || "Review routing blocked by policy.";
    await postBlocked(reason);
    throw new Error(reason);
  }

  if (!issueKey) {
    const reason = "No linked Linear issue key detected for this PR.";
    await postBlocked(reason);
    throw new Error(reason);
  }

  const estimate = parseEstimate(context.estimate);
  if (!estimate) {
    const reason = `Linear estimate must be set to 1-5 for Claude review routing (received: ${context.estimate ?? "unset"}).`;
    await postBlocked(reason);
    throw new Error(reason);
  }

  if (estimate === 5) {
    const reason = "Estimate 5 requires mandatory human review. Claude auto-review is blocked.";
    await postBlocked(reason);
    throw new Error(reason);
  }

  const profile = resolveProfileForEstimate(estimate);
  const scopeProfile = resolveScopeProfile();

  appendSummary([
    "### Claude Routing",
    `- Issue key: ${issueKey}`,
    `- Estimate: ${estimate}`,
    `- Profile: ${profile.value}`,
    `- Scope profile: ${scopeProfile.value}`,
  ]);

  const issueDescription = decodeBase64(context.issue_description_b64);
  const issueTitle = context.issue_title ?? "";
  const issueUrl = context.issue_url ?? "";
  const diff = getGitDiffSummary(pr.base.ref);
  const parsedFixRounds = Number.parseInt(process.env.CLAUDE_MAX_FIX_ROUNDS ?? "1", 10);
  const maxFixRounds = Number.isFinite(parsedFixRounds) ? Math.max(0, parsedFixRounds) : 1;

  const passResults = [];
  const passOrder = ["scope", "quality", "security"];

  for (const passName of passOrder) {
    let finalResult = null;

    for (let round = 0; round <= maxFixRounds; round += 1) {
      let prompt = "";

      if (passName === "scope") {
        prompt = buildScopePrompt({
          issueKey,
          issueTitle,
          issueUrl,
          issueDescription,
          diff,
        });
      }

      if (passName === "quality") {
        const qualityCommand = runCheck(
          resolveQualityBaselineCommand(),
          "quality-baseline",
        );
        const guardrailsCmd = runCommand(
          "node",
          [".github/scripts/claude-review.mjs", "quality-guardrails"],
          { allowFailure: true },
        );
        const guardrails = {
          label: "quality-guardrails",
          command: "node .github/scripts/claude-review.mjs quality-guardrails",
          status: guardrailsCmd.status,
          output: clip(
            [
              "$ node .github/scripts/claude-review.mjs quality-guardrails",
              guardrailsCmd.stdout,
              guardrailsCmd.stderr,
            ]
              .filter(Boolean)
              .join("\n"),
          ),
        };

        prompt = buildQualityPrompt({
          issueKey,
          estimate,
          diff,
          qualityCommand,
          guardrails,
        });
      }

      if (passName === "security") {
        const securityHeuristicsCmd = runCommand(
          "node",
          [".github/scripts/claude-review.mjs", "security-check"],
          { allowFailure: true },
        );
        const securityHeuristics = {
          label: "security-heuristics",
          command: "node .github/scripts/claude-review.mjs security-check",
          status: securityHeuristicsCmd.status,
          output: clip(
            [
              "$ node .github/scripts/claude-review.mjs security-check",
              securityHeuristicsCmd.stdout,
              securityHeuristicsCmd.stderr,
            ]
              .filter(Boolean)
              .join("\n"),
          ),
        };

        const dependencyAudit = runCheck(
          resolveDependencyAuditCommand(),
          "dependency-audit",
        );
        const semgrep = commandExists("semgrep")
          ? runCheck(
              "semgrep --config p/security-audit --error --exclude node_modules .",
              "semgrep",
            )
          : {
              label: "semgrep",
              command: "semgrep --config p/security-audit --error --exclude node_modules .",
              status: 127,
              output:
                "Semgrep binary is missing. This is a blocking tooling error for fail-closed security review.",
            };

        prompt = buildSecurityPrompt({
          issueKey,
          estimate,
          diff,
          securityHeuristics,
          dependencyAudit,
          semgrep,
        });
      }

      const passProfile = passName === "scope" ? scopeProfile : profile;
      const passResult = runClaudePass(passName, prompt, passProfile);
      finalResult = passResult;

      appendSummary([
        `### Claude Pass: ${passName}`,
        `- Round: ${round + 1}`,
        `- Status: ${passResult.status}`,
        `- Summary: ${passResult.summary}`,
        `- Blocking findings: ${passResult.blockingFindings.length}`,
      ]);

      if (passResult.status === "pass") {
        break;
      }

      if (round >= maxFixRounds) {
        break;
      }

      const fixPrompt = buildFixPrompt(passName, passResult, { issueKey });
      runClaudeFix(passName, fixPrompt, passProfile);
      runCommand("node", [".github/scripts/claude-autofix-guard.mjs"]);

      if (!hasWorkingTreeChanges()) {
        appendSummary([
          `### Claude Pass: ${passName}`,
          "Claude fix attempt made no file changes. Stopping fix loop.",
        ]);
        break;
      }

      commitAndPush(`chore(claude): orchestrator-autofix-${passName}`);
      appendSummary([
        `### Claude Pass: ${passName}`,
        "Applied Claude autofix changes and pushed branch updates.",
      ]);
    }

    if (!finalResult || finalResult.status !== "pass") {
      const reason = `Claude ${passName} pass failed with blocking findings.`;
      await postBlocked(reason, finalResult?.blockingFindings ?? []);
      throw new Error(reason);
    }

    passResults.push(finalResult);
  }

  // Non-blocking docs pass — runs only after all mandatory passes succeed
  // Disabled by default; opt-in via CLAUDE_ENABLE_DOCS_PASS=true
  if (process.env.CLAUDE_ENABLE_DOCS_PASS === "true" && !isDocsOnlyDiff(diff.nameStatus)) {
    try {
      const docsPrompt = buildDocsPrompt({ issueKey, issueDescription, diff });
      const docsResult = runClaudePass("docs", docsPrompt, profile);

      appendSummary([
        "### Claude Pass: docs",
        `- Status: ${docsResult.status}`,
        `- Summary: ${docsResult.summary}`,
        `- Actions taken: ${docsResult.actionsTaken.length}`,
      ]);

      if (docsResult.actionsTaken.length > 0 && hasWorkingTreeChanges()) {
        runCommand("node", [".github/scripts/claude-autofix-guard.mjs"]);
        commitAndPush("docs(claude): update documentation for PR changes");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendSummary(["### Claude Pass: docs", `Advisory only — skipped: ${message}`]);
    }
  } else {
    appendSummary(["### Claude Pass: docs", "Skipped — PR only touches documentation files."]);
  }

  runReviewAction("review-resolved", ["--mark-ready"]);

  const peerTimeout = process.env.CLAUDE_PEER_REVIEW_TIMEOUT_SECONDS ?? "900";
  const peerInterval = process.env.CLAUDE_PEER_REVIEW_INTERVAL_SECONDS ?? "20";
  const peerFinalTimeout = process.env.CLAUDE_PEER_REVIEW_FINAL_TIMEOUT_SECONDS ?? "240";

  const peerCheckArgs = [
    "--timeout-seconds",
    peerTimeout,
    "--interval-seconds",
    peerInterval,
  ];

  const firstPeerCheck = runReviewAction("peer-review-check", peerCheckArgs, {
    allowFailure: true,
  });

  if (firstPeerCheck.status !== 0) {
    const peerFixPrompt = [
      "You must address unresolved peer-review bot comments.",
      "Inspect the PR review conversations and make code changes required to resolve legitimate findings.",
      "Keep edits focused and minimal.",
      `Issue key: ${issueKey}`,
      `Repository: ${process.env.GITHUB_REPOSITORY ?? "unknown"}`,
      `PR number: ${pr.number}`,
    ].join("\n");

    runClaudeFix("quality", peerFixPrompt, profile);
    runCommand("node", [".github/scripts/claude-autofix-guard.mjs"]);
    if (hasWorkingTreeChanges()) {
      commitAndPush("chore(claude): orchestrator-peer-review-fixes");
    }

    runReviewAction("peer-review-resolve");
    const secondPeerCheck = runReviewAction(
      "peer-review-check",
      [
        "--timeout-seconds",
        peerFinalTimeout,
        "--interval-seconds",
        peerInterval,
      ],
      { allowFailure: true },
    );

    if (secondPeerCheck.status !== 0) {
      const reason = "Peer review cross-check has unresolved findings after Claude remediation.";
      await postBlocked(reason);
      throw new Error(reason);
    }
  }

  appendSummary([
    "### Claude Orchestrator",
    "Claude orchestrator completed all passes successfully.",
    `- Issue key: ${issueKey}`,
    `- Estimate: ${estimate}`,
    `- Completed passes: ${passResults.map((result) => result.pass).join(", ")}`,
  ]);
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  appendSummary([
    "### Claude Orchestrator Failed",
    message,
  ]);

  if (!blockedCommentPosted) {
    await postBlocked(`Claude orchestrator failed: ${message}`);
  }

  console.error("claude-orchestrator failed", error);
  process.exit(1);
});
