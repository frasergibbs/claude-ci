import fs from "node:fs";
import process from "node:process";
import { spawnSync } from "node:child_process";

const PASS_SCHEMA_PATH = ".github/schemas/claude-pass-result.schema.json";
const MAX_LOG_CHARS = 16000;
const DEFAULT_TIMEOUT_SECONDS = 300;
const AUTOFIX_LABEL = "autofix-attempted";

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
      "User-Agent": "ops-control-plane-claude-autofix",
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

function resolveProfile() {
  const high = process.env.CLAUDE_PROFILE_HIGH ?? "claude-sonnet-4-6:high";
  const [model, effort] = high.split(":");
  return { model, effort: effort || "high", value: high };
}

function resolveTimeoutMs() {
  const seconds = Number.parseInt(
    process.env.CLAUDE_AUTOFIX_TIMEOUT_SECONDS ?? String(DEFAULT_TIMEOUT_SECONDS),
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

function runClaudeFix(prompt, profile) {
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

async function downloadRunLogs(runId) {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/logs`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "ops-control-plane-claude-autofix",
      },
      redirect: "follow",
    },
  );

  if (!response.ok) {
    return `(Unable to download CI logs: ${response.status})`;
  }

  // The logs endpoint returns a zip, but we can get plain text from the jobs endpoint
  const jobs = await githubRequest(`/repos/${owner}/${repo}/actions/runs/${runId}/jobs`);
  const failedJobs = (jobs.jobs ?? []).filter((job) => job.conclusion === "failure");

  if (failedJobs.length === 0) {
    return "(No failed jobs found in this run)";
  }

  const logParts = [];
  for (const job of failedJobs) {
    const failedSteps = (job.steps ?? []).filter((step) => step.conclusion === "failure");
    logParts.push(`Job: ${job.name} (${job.conclusion})`);
    for (const step of failedSteps) {
      logParts.push(`  Step: ${step.name} — ${step.conclusion}`);
    }

    // Fetch detailed log for this job
    try {
      const jobLogResponse = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/actions/jobs/${job.id}/logs`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "User-Agent": "ops-control-plane-claude-autofix",
          },
          redirect: "follow",
        },
      );
      if (jobLogResponse.ok) {
        const logText = await jobLogResponse.text();
        logParts.push(clip(logText, 12000));
      }
    } catch {
      logParts.push("  (Unable to fetch detailed job logs)");
    }
  }

  return logParts.join("\n");
}

function buildDiagnosisPrompt(input) {
  return [
    "You are a senior engineer diagnosing a CI pipeline failure. You read build logs precisely, distinguishing real errors from noise. You identify the root cause category: type error, test failure, lint error, build configuration issue, dependency problem, or environment issue.",
    "",
    "BEFORE suggesting any fix, reason about:",
    "- What is the actual error message vs log noise? Find the first real failure.",
    "- Is this a code error that can be fixed, or an infrastructure/environment issue?",
    "- Is this a flaky test, a legitimate regression, or a missing dependency?",
    "- What is the minimal change that would resolve this failure?",
    "",
    "THEN produce your diagnosis.",
    "",
    `Pass: autofix`,
    `Issue key: ${input.issueKey}`,
    `PR: #${input.pullNumber}`,
    `Failed workflow run: ${input.runId}`,
    "",
    "CI failure logs:",
    input.logs,
    "",
    "Return JSON only and match the schema exactly.",
    "Output rules:",
    "- status=pass when the failure is diagnosable and a code fix can resolve it.",
    "- status=fail when the failure is an environment/infra issue or cannot be auto-fixed.",
    "- blockingFindings should contain one entry per distinct error with the root cause as reason.",
    "- summary should describe the root cause and recommended fix approach.",
    "- actionsTaken should describe what was diagnosed.",
  ].join("\n");
}

function buildFixFromDiagnosisPrompt(input) {
  return [
    "You are a senior engineer applying a minimal, surgical fix to resolve a CI failure. You have just diagnosed the root cause. Apply the smallest correct change to make CI pass again.",
    "",
    "BEFORE editing, reason about:",
    "- Is the fix safe? Could it introduce new failures?",
    "- Is there a simpler approach than what you initially considered?",
    "",
    "THEN apply the fix.",
    "",
    `Issue key: ${input.issueKey}`,
    `PR: #${input.pullNumber}`,
    "",
    "Diagnosis:",
    input.diagnosis,
    "",
    "Blocking findings:",
    ...input.findings.map((finding) =>
      `- [${finding.severity}] ${finding.title}: ${finding.reason} (${finding.file}:${finding.line})`,
    ),
    "",
    "After edits, stop and return a concise change summary.",
  ].join("\n");
}

async function main() {
  appendSummary(["### Claude Autofix", "Starting CI failure diagnosis."]);

  // Extract PR context
  const pullRequestRef = workflowRun.pull_requests?.[0];
  if (!pullRequestRef?.number) {
    appendSummary(["### Claude Autofix", "No pull request attached to this workflow run. Skipping."]);
    return;
  }

  const pullNumber = pullRequestRef.number;
  const runId = workflowRun.id;

  // Skip if conclusion is not failure (redundant with workflow_run filter, but defensive)
  if (workflowRun.conclusion !== "failure") {
    appendSummary(["### Claude Autofix", `Workflow conclusion is ${workflowRun.conclusion}, not failure. Skipping.`]);
    return;
  }

  const pr = await githubRequest(`/repos/${owner}/${repo}/pulls/${pullNumber}`);

  if (pr.state !== "open") {
    appendSummary(["### Claude Autofix", `PR #${pullNumber} is not open. Skipping.`]);
    return;
  }

  // Loop prevention: check if last commit is from github-actions[bot]
  const commits = await githubRequest(`/repos/${owner}/${repo}/pulls/${pullNumber}/commits?per_page=1`);
  if (commits.length > 0) {
    const lastCommitAuthor = commits[commits.length - 1]?.commit?.author?.name ?? "";
    if (lastCommitAuthor.includes("github-actions")) {
      appendSummary(["### Claude Autofix", "Last commit is from github-actions[bot]. Skipping to prevent loops."]);
      return;
    }
  }

  // Loop prevention: check for autofix-attempted label
  const labels = (pr.labels ?? []).map((label) => label.name);
  if (labels.includes(AUTOFIX_LABEL)) {
    appendSummary(["### Claude Autofix", `PR already has '${AUTOFIX_LABEL}' label. Skipping.`]);
    return;
  }

  // Add autofix-attempted label
  await githubRequest(`/repos/${owner}/${repo}/issues/${pullNumber}/labels`, {
    method: "POST",
    body: { labels: [AUTOFIX_LABEL] },
  });

  // Extract issue key from PR
  const issueKeyRegex = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/i;
  const issueKeyMatch = (pr.title || "").match(issueKeyRegex) || (pr.body || "").match(issueKeyRegex);
  const issueKey = issueKeyMatch?.[1]?.toUpperCase() ?? "";

  // Download CI logs
  const logs = await downloadRunLogs(runId);

  // Checkout PR branch
  runShell(`git checkout ${pr.head.ref}`);

  const profile = resolveProfile();

  appendSummary([
    "### Claude Autofix Routing",
    `- PR: #${pullNumber}`,
    `- Issue key: ${issueKey || "none"}`,
    `- Failed run: ${runId}`,
    `- Profile: ${profile.value}`,
  ]);

  // Step 1: Diagnose
  const diagnosisResult = runClaudePass("autofix", buildDiagnosisPrompt({
    issueKey,
    pullNumber,
    runId,
    logs,
  }), profile);

  appendSummary([
    "### Claude Pass: autofix (diagnosis)",
    `- Status: ${diagnosisResult.status}`,
    `- Summary: ${diagnosisResult.summary}`,
    `- Findings: ${diagnosisResult.blockingFindings.length}`,
  ]);

  // If not fixable, post diagnostic comment and exit
  if (diagnosisResult.status === "fail" || diagnosisResult.blockingFindings.length === 0) {
    await githubRequest(`/repos/${owner}/${repo}/issues/${pullNumber}/comments`, {
      method: "POST",
      body: {
        body: [
          "<!-- claude-autofix:diagnostic -->",
          "### Claude Autofix — Diagnostic",
          "",
          `CI workflow run [#${runId}](https://github.com/${owner}/${repo}/actions/runs/${runId}) failed.`,
          "",
          `**Diagnosis:** ${diagnosisResult.summary}`,
          "",
          "This failure requires manual intervention — Claude was unable to produce an automated fix.",
          ...(diagnosisResult.blockingFindings.length > 0
            ? [
                "",
                "**Root causes:**",
                ...diagnosisResult.blockingFindings.map((f) => `- \`${f.file}:${f.line}\` — ${f.reason}`),
              ]
            : []),
        ].join("\n"),
      },
    });

    appendSummary(["### Claude Autofix", "Posted diagnostic comment. Fix requires manual intervention."]);
    return;
  }

  // Step 2: Apply fix
  try {
    runClaudeFix(buildFixFromDiagnosisPrompt({
      issueKey,
      pullNumber,
      diagnosis: diagnosisResult.summary,
      findings: diagnosisResult.blockingFindings,
    }), profile);

    if (!hasWorkingTreeChanges()) {
      appendSummary(["### Claude Autofix", "Fix attempt made no file changes."]);
      return;
    }

    // Validate fix
    runCommand("node", [".github/scripts/claude-autofix-guard.mjs"]);

    const qualityCmd = resolveQualityBaselineCommand();
    const verification = runShell(qualityCmd, { quiet: true, allowFailure: true });

    if (verification.status === 0) {
      commitAndPush(`fix(ci): ${diagnosisResult.summary.slice(0, 72)}`);
      appendSummary(["### Claude Autofix", "Fix applied, verified, and committed."]);

      await githubRequest(`/repos/${owner}/${repo}/issues/${pullNumber}/comments`, {
        method: "POST",
        body: {
          body: [
            "<!-- claude-autofix:fixed -->",
            "### Claude Autofix — Fix Applied",
            "",
            `CI failure from run [#${runId}](https://github.com/${owner}/${repo}/actions/runs/${runId}) has been diagnosed and fixed.`,
            "",
            `**Fix:** ${diagnosisResult.summary}`,
          ].join("\n"),
        },
      });
    } else {
      // Discard failing fix
      runShell("git checkout -- .", { quiet: true });
      appendSummary([
        "### Claude Autofix",
        "Fix failed verification. Discarded.",
        `Verification output: ${clip(verification.stderr || verification.stdout, 2000)}`,
      ]);

      await githubRequest(`/repos/${owner}/${repo}/issues/${pullNumber}/comments`, {
        method: "POST",
        body: {
          body: [
            "<!-- claude-autofix:diagnostic -->",
            "### Claude Autofix — Diagnostic",
            "",
            `CI failure from run [#${runId}](https://github.com/${owner}/${repo}/actions/runs/${runId}) was diagnosed but the automated fix did not pass verification.`,
            "",
            `**Diagnosis:** ${diagnosisResult.summary}`,
            "",
            "Manual intervention is required.",
          ].join("\n"),
        },
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runShell("git checkout -- .", { quiet: true, allowFailure: true });
    appendSummary(["### Claude Autofix", `Fix attempt failed: ${message}`]);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  appendSummary(["### Claude Autofix Failed", message]);
  console.error("claude-autofix failed", error);
  process.exit(1);
});
