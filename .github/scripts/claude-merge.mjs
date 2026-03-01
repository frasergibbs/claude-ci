import fs from "node:fs";
import process from "node:process";
import { execSync } from "node:child_process";

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

function parsePeerBots() {
  const value = process.env.CLAUDE_PEER_REVIEW_BOTS ?? "github-copilot[bot],copilot-pull-request-reviewer[bot]";
  return new Set(
    value
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

function parseRequiredChecks() {
  const configured = process.env.CLAUDE_REQUIRED_CHECKS?.trim();
  const codeqlEnabled = (process.env.CLAUDE_ENABLE_CODEQL ?? "false").toLowerCase() === "true";
  const value = configured && configured.length > 0
    ? configured
    : codeqlEnabled
      ? "build,claude-review,codeql"
      : "build,claude-review";
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveTargetBranch() {
  const configured = process.env.CLAUDE_MERGE_TARGET_BRANCH?.trim();
  if (configured && configured.length > 0) {
    return configured;
  }
  const defaultBranch = payload.repository?.default_branch;
  if (typeof defaultBranch === "string" && defaultBranch.length > 0) {
    return defaultBranch;
  }
  return "main";
}

function parseHealthEndpoints() {
  const urls = [];
  const single = process.env.CLAUDE_POST_MERGE_HEALTHCHECK_URL;
  if (single && single.trim().length > 0) {
    urls.push(single.trim());
  }

  const multiple = process.env.CLAUDE_POST_MERGE_HEALTHCHECK_URLS;
  if (multiple && multiple.trim().length > 0) {
    for (const item of multiple.split(",").map((entry) => entry.trim()).filter(Boolean)) {
      urls.push(item);
    }
  }

  return [...new Set(urls)];
}

function parseEstimateNumber(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return null;
}

function isSensitivePath(path) {
  return /(auth|billing|payment|invoice|checkout|permission|rbac|security|secret|token|infra|terraform|helm|k8s|migration|database|schema)/i.test(path);
}

function computeRiskAssessment({ estimate, files }) {
  let score = 0;
  const reasons = [];

  if (estimate === 1) score += 1;
  if (estimate === 2) score += 2;
  if (estimate === 3) score += 3;
  if (estimate === 4) score += 4;
  if (estimate === 5) score += 6;
  if (estimate && estimate >= 1) {
    reasons.push(`Estimate=${estimate}`);
  }

  const fileList = Array.isArray(files) ? files : [];
  const fileCount = fileList.length;
  const changedLines = fileList.reduce((sum, file) => {
    return sum + Number(file?.additions ?? 0) + Number(file?.deletions ?? 0);
  }, 0);

  if (fileCount > 20) {
    score += 1;
    reasons.push(`Large file count (${fileCount})`);
  }

  if (changedLines > 500) {
    score += 1;
    reasons.push(`Large diff (${changedLines} lines)`);
  }

  if (changedLines > 1500) {
    score += 2;
    reasons.push(`Very large diff (${changedLines} lines)`);
  }

  const sensitiveTouches = fileList.filter((file) => isSensitivePath(String(file?.filename ?? "")));
  if (sensitiveTouches.length > 0) {
    score += 2;
    reasons.push(`Sensitive paths touched (${sensitiveTouches.length})`);
  }

  const dependencyFiles = fileList.filter((file) =>
    /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|requirements\.txt|poetry\.lock|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock)$/i.test(
      String(file?.filename ?? ""),
    ),
  );
  if (dependencyFiles.length > 0) {
    score += 1;
    reasons.push("Dependency manifest/lock changes");
  }

  let level = "low";
  if (score >= 4 && score <= 6) {
    level = "medium";
  } else if (score >= 7 && score <= 8) {
    level = "high";
  } else if (score >= 9) {
    level = "highest";
  }

  return { score, level, reasons, changedLines, fileCount };
}

function runShellCommand(command) {
  return execSync(command, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: "/bin/bash",
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function githubRequest(path, { method = "GET", body, allow404 = false } = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "ops-control-plane-claude-merge",
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

async function githubGraphql(query, variables) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "ops-control-plane-claude-merge",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const payload = await response.json();
  if (!response.ok || (Array.isArray(payload.errors) && payload.errors.length > 0)) {
    const message = Array.isArray(payload.errors)
      ? payload.errors.map((error) => error?.message).filter(Boolean).join("; ")
      : `GitHub GraphQL failed with status ${response.status}`;
    throw new Error(message || "GitHub GraphQL request failed");
  }

  return payload.data ?? {};
}

async function branchExists(branchName) {
  const branch = await githubRequest(
    `/repos/${owner}/${repo}/branches/${encodeURIComponent(branchName)}`,
    { allow404: true },
  );
  return branch !== null;
}

async function getPullRequest(pullNumber) {
  return githubRequest(`/repos/${owner}/${repo}/pulls/${pullNumber}`);
}

async function getPullRequestFiles(pullNumber) {
  const files = [];
  let page = 1;

  while (page <= 10) {
    const batch = await githubRequest(
      `/repos/${owner}/${repo}/pulls/${pullNumber}/files?per_page=100&page=${page}`,
    );

    if (!Array.isArray(batch) || batch.length === 0) {
      break;
    }

    files.push(...batch);

    if (batch.length < 100) {
      break;
    }

    page += 1;
  }

  return files;
}

async function getPullRequestCommits(pullNumber) {
  const commits = await githubRequest(`/repos/${owner}/${repo}/pulls/${pullNumber}/commits?per_page=100`);
  return Array.isArray(commits) ? commits : [];
}

async function extractIssueKeyFromPullRequestCommits(pullNumber) {
  const commits = await getPullRequestCommits(pullNumber);

  for (const commit of commits) {
    const key = extractIssueKey(commit?.commit?.message, commit?.sha);
    if (key) {
      return key;
    }
  }

  return null;
}

async function getLatestCommitTimestamp(pullNumber) {
  const commits = await getPullRequestCommits(pullNumber);
  if (commits.length === 0) {
    return null;
  }

  let latest = null;
  for (const commit of commits) {
    const ts = Date.parse(String(commit?.commit?.committer?.date ?? commit?.commit?.author?.date ?? ""));
    if (!Number.isFinite(ts)) {
      continue;
    }
    if (latest === null || ts > latest) {
      latest = ts;
    }
  }

  return latest;
}

async function getCheckRuns(sha) {
  return githubRequest(`/repos/${owner}/${repo}/commits/${sha}/check-runs`);
}

function checkMatcherPassed(checkRuns, matcher) {
  const matcherLower = matcher.toLowerCase();
  const matches = checkRuns.filter((check) => String(check?.name ?? "").toLowerCase().includes(matcherLower));
  if (matches.length === 0) {
    return { found: false, passed: false, matchNames: [] };
  }

  const passed = matches.some((check) => check.conclusion === "success");
  return {
    found: true,
    passed,
    matchNames: matches.map((check) => String(check.name)),
  };
}

function evaluateRequiredChecks(checkRuns) {
  const requirements = parseRequiredChecks();
  const results = requirements.map((matcher) => {
    const result = checkMatcherPassed(checkRuns, matcher);
    return {
      matcher,
      ...result,
    };
  });

  const allPassed = results.every((result) => result.found && result.passed);
  return { allPassed, results };
}

async function getPullRequestReviews(pullNumber) {
  const reviews = await githubRequest(`/repos/${owner}/${repo}/pulls/${pullNumber}/reviews?per_page=100`);
  return Array.isArray(reviews) ? reviews : [];
}

async function listReviewThreads(pullNumber) {
  const query = `
    query PullRequestThreads(
      $owner: String!
      $repo: String!
      $number: Int!
      $after: String
    ) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 50, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              isResolved
              comments(first: 50) {
                nodes {
                  body
                  author { login }
                  path
                  line
                  originalLine
                }
              }
            }
          }
        }
      }
    }
  `;

  const threads = [];
  let after = null;

  while (true) {
    const data = await githubGraphql(query, {
      owner,
      repo,
      number: Number(pullNumber),
      after,
    });

    const connection = data?.repository?.pullRequest?.reviewThreads;
    const nodes = Array.isArray(connection?.nodes) ? connection.nodes : [];
    threads.push(...nodes);

    if (!connection?.pageInfo?.hasNextPage) {
      break;
    }

    after = connection.pageInfo.endCursor;
    if (!after) {
      break;
    }
  }

  return threads;
}

function filterUnresolvedPeerThreads(threads, peerBots) {
  const unresolved = [];

  for (const thread of threads) {
    if (thread?.isResolved) {
      continue;
    }

    const comments = Array.isArray(thread?.comments?.nodes) ? thread.comments.nodes : [];
    if (comments.length === 0) {
      continue;
    }

    const peerComment = [...comments]
      .reverse()
      .find((comment) => peerBots.has(String(comment?.author?.login ?? "").toLowerCase()));

    if (!peerComment) {
      continue;
    }

    unresolved.push({
      path: String(peerComment.path ?? ""),
      line:
        typeof peerComment.line === "number"
          ? peerComment.line
          : typeof peerComment.originalLine === "number"
            ? peerComment.originalLine
            : null,
    });
  }

  return unresolved;
}

async function verifyPeerReviewGate(pullNumber) {
  const peerBots = parsePeerBots();
  const requirePeerReview = process.env.CLAUDE_REQUIRE_PEER_REVIEW !== "false";

  const latestCommitTs = await getLatestCommitTimestamp(pullNumber);
  const reviews = await getPullRequestReviews(pullNumber);

  const peerReviews = reviews.filter((review) => {
    const login = String(review?.user?.login ?? "").toLowerCase();
    const state = String(review?.state ?? "").toUpperCase();
    return peerBots.has(login) && state !== "PENDING";
  });

  const recentPeerReviews = latestCommitTs === null
    ? peerReviews
    : peerReviews.filter((review) => {
        const submitted = Date.parse(String(review?.submitted_at ?? review?.submittedAt ?? ""));
        return Number.isFinite(submitted) && submitted >= latestCommitTs;
      });

  if (requirePeerReview && recentPeerReviews.length === 0) {
    return {
      ok: false,
      reason: "No recent peer review from configured bot(s) after the latest commit",
      unresolvedThreads: [],
    };
  }

  const threads = await listReviewThreads(pullNumber);
  const unresolvedThreads = filterUnresolvedPeerThreads(threads, peerBots);
  if (unresolvedThreads.length > 0) {
    return {
      ok: false,
      reason: `${unresolvedThreads.length} unresolved peer review thread(s) remain`,
      unresolvedThreads,
    };
  }

  return {
    ok: true,
    reason: "",
    unresolvedThreads: [],
  };
}

async function upsertIssueComment(prNumber, marker, body) {
  const comments = await githubRequest(`/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`);

  const existing = Array.isArray(comments)
    ? comments.find(
        (comment) =>
          typeof comment?.body === "string" &&
          comment.body.includes(marker) &&
          comment.user?.login === "github-actions[bot]",
      )
    : null;

  const nextBody = `${marker}\n${body}`;

  if (existing?.id) {
    await githubRequest(`/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
      method: "PATCH",
      body: { body: nextBody },
    });
    return;
  }

  await githubRequest(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
    method: "POST",
    body: { body: nextBody },
  });
}

async function markReadyForReview(prNumber) {
  await githubRequest(`/repos/${owner}/${repo}/pulls/${prNumber}/ready_for_review`, {
    method: "POST",
  });
}

async function getGitHubOidcToken(audience) {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

  if (!requestUrl || !requestToken) {
    throw new Error(
      "GitHub OIDC token env vars are missing. Ensure workflow has id-token: write permission.",
    );
  }

  const url = new URL(requestUrl);
  url.searchParams.set("audience", audience);

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${requestToken}`,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to mint OIDC token: ${response.status} ${body}`);
  }

  const payload = await response.json();
  if (typeof payload.value !== "string" || payload.value.length === 0) {
    throw new Error("OIDC token response did not include a token value");
  }

  return payload.value;
}

async function fetchReviewContext(issueKey, oidcToken) {
  const baseUrl = process.env.OPS_BRIDGE_INTERNAL_URL;
  if (!baseUrl) {
    throw new Error("OPS_BRIDGE_INTERNAL_URL is not set");
  }

  const url = new URL("/internal/review-context", baseUrl);
  url.searchParams.set("issueKey", issueKey);

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${oidcToken}`,
      Accept: "application/json",
    },
  });

  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  if (!response.ok) {
    const detail = json?.detail ?? json?.error ?? text;
    throw new Error(`ops-bridge review-context failed: ${response.status} ${detail}`);
  }

  if (!json || typeof json !== "object") {
    throw new Error("ops-bridge review-context returned invalid JSON");
  }

  return json;
}

async function postPullRequestLifecycle(oidcToken, body) {
  const baseUrl = process.env.OPS_BRIDGE_INTERNAL_URL;
  if (!baseUrl) {
    throw new Error("OPS_BRIDGE_INTERNAL_URL is not set");
  }

  const url = new URL("/internal/pr-lifecycle", baseUrl);
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${oidcToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  if (!response.ok) {
    const detail = json?.detail ?? json?.error ?? text;
    throw new Error(`ops-bridge pr-lifecycle failed: ${response.status} ${detail}`);
  }

  return json;
}

async function notifyPullRequestLifecycle(stage, pr, baseRef, summary) {
  let issueKey = extractIssueKey(pr.title, pr.body, pr.head?.ref, pr.base?.ref);
  if (!issueKey) {
    issueKey = await extractIssueKeyFromPullRequestCommits(pr.number);
  }

  if (!issueKey) {
    return false;
  }

  const audience = process.env.OPS_BRIDGE_GITHUB_AUDIENCE ?? "ops-bridge-review";
  const oidcToken = await getGitHubOidcToken(audience);

  await postPullRequestLifecycle(oidcToken, {
    issueKey,
    stage,
    pr: {
      number: pr.number,
      url: pr.html_url,
      title: pr.title,
      repository: `${owner}/${repo}`,
      headRef: pr.head?.ref,
      baseRef,
    },
    summary,
  });

  return true;
}

async function evaluateRiskGate(pr) {
  let issueKey = extractIssueKey(pr.title, pr.body, pr.head?.ref, pr.base?.ref);
  if (!issueKey) {
    issueKey = await extractIssueKeyFromPullRequestCommits(pr.number);
  }

  const files = await getPullRequestFiles(pr.number);
  let estimate = null;

  if (issueKey) {
    try {
      const audience = process.env.OPS_BRIDGE_GITHUB_AUDIENCE ?? "ops-bridge-review";
      const oidcToken = await getGitHubOidcToken(audience);
      const routing = await fetchReviewContext(issueKey, oidcToken);
      estimate = parseEstimateNumber(routing.estimate);
    } catch {
      estimate = null;
    }
  }

  const risk = computeRiskAssessment({ estimate, files });
  const blocked = risk.level === "high" || risk.level === "highest";

  return { blocked, issueKey, risk };
}

async function checkEndpointHealth(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json,text/plain,*/*" },
      signal: controller.signal,
    });

    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (!response.ok) {
      return { ok: false, detail: `${url} returned ${response.status}` };
    }

    const status = String(json?.status ?? "").toLowerCase();
    const healthy = json?.healthy;

    if (status && !["ok", "healthy", "up", "pass"].includes(status)) {
      return { ok: false, detail: `${url} status=${status}` };
    }

    if (typeof healthy === "boolean" && !healthy) {
      return { ok: false, detail: `${url} healthy=false` };
    }

    return { ok: true, detail: `${url} healthy` };
  } catch (error) {
    return {
      ok: false,
      detail: `${url} request failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function createRollbackPr(targetBase, mergeSha, originalPrNumber) {
  const suffix = String(Date.now()).slice(-8);
  const rollbackBranch = `claude/rollback-pr-${originalPrNumber}-${suffix}`;

  runShellCommand(`git config user.name "github-actions[bot]"`);
  runShellCommand(`git config user.email "41898282+github-actions[bot]@users.noreply.github.com"`);
  runShellCommand(`git fetch origin ${targetBase}`);
  runShellCommand(`git checkout -B ${rollbackBranch} origin/${targetBase}`);
  runShellCommand(`git revert --no-edit ${mergeSha}`);
  runShellCommand(`git push origin ${rollbackBranch}`);

  const rollbackPr = await githubRequest(`/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    body: {
      title: `rollback: revert PR #${originalPrNumber} (post-merge health failure)`,
      head: rollbackBranch,
      base: targetBase,
      body: [
        `Automated rollback PR for #${originalPrNumber}.`,
        "",
        "Triggered by Claude post-merge health gate failure.",
      ].join("\n"),
    },
  });

  return rollbackPr?.html_url ?? "";
}

async function runPostMergeHealthGate(pr, targetBase, mergeSha) {
  const endpoints = parseHealthEndpoints();
  if (endpoints.length === 0) {
    appendSummary([
      "### Post-Merge Health Gate",
      "No healthcheck endpoints configured. Skipping post-merge runtime validation.",
    ]);
    return true;
  }

  const timeoutSeconds = Number.parseInt(process.env.CLAUDE_POST_MERGE_HEALTHCHECK_SECONDS ?? "600", 10);
  const intervalSeconds = Number.parseInt(process.env.CLAUDE_POST_MERGE_HEALTHCHECK_INTERVAL_SECONDS ?? "30", 10);
  const requiredSuccesses = Number.parseInt(process.env.CLAUDE_POST_MERGE_HEALTHCHECK_SUCCESS_STREAK ?? "2", 10);

  const timeoutAt = Date.now() + Math.max(60, timeoutSeconds) * 1000;
  let successStreak = 0;
  let lastFailure = "Health checks did not pass";

  while (Date.now() < timeoutAt) {
    const checks = [];
    for (const endpoint of endpoints) {
      checks.push(await checkEndpointHealth(endpoint));
    }

    const failed = checks.filter((result) => !result.ok);
    if (failed.length === 0) {
      successStreak += 1;
      if (successStreak >= Math.max(1, requiredSuccesses)) {
        appendSummary([
          "### Post-Merge Health Gate",
          `All configured health endpoints passed (${endpoints.length} endpoint(s), streak=${successStreak}).`,
        ]);
        return true;
      }
    } else {
      successStreak = 0;
      lastFailure = failed.map((result) => result.detail).join("; ");
    }

    await sleep(Math.max(10, intervalSeconds) * 1000);
  }

  await upsertIssueComment(
    pr.number,
    "<!-- claude-merge:health-failed -->",
    [
      "Post-merge health gate failed.",
      "",
      `- Target branch: ${targetBase}`,
      `- Failure: ${lastFailure}`,
      "",
      "Claude will move the linked Linear issue back to In Review and trigger rollback handling if configured.",
    ].join("\n"),
  );

  try {
    await notifyPullRequestLifecycle(
      "post_merge_regression",
      pr,
      targetBase,
      `Post-merge health gate failed: ${lastFailure}`,
    );
  } catch (error) {
    appendSummary([
      "### Post-Merge Health Gate",
      `Failed to notify Linear regression lifecycle: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }

  const rollbackMode = process.env.CLAUDE_POST_MERGE_ROLLBACK_MODE ?? "revert-pr";
  if (rollbackMode === "revert-pr" && mergeSha) {
    try {
      const rollbackPrUrl = await createRollbackPr(targetBase, mergeSha, pr.number);
      await upsertIssueComment(
        pr.number,
        "<!-- claude-merge:rollback -->",
        rollbackPrUrl
          ? `Created automated rollback PR: ${rollbackPrUrl}`
          : "Attempted rollback PR creation but URL was unavailable.",
      );
    } catch (error) {
      await upsertIssueComment(
        pr.number,
        "<!-- claude-merge:rollback -->",
        `Rollback PR creation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  appendSummary([
    "### Post-Merge Health Gate",
    `Health gate failed: ${lastFailure}`,
    `Rollback mode: ${rollbackMode}`,
  ]);

  return false;
}

async function main() {
  const pullRequestRef = workflowRun.pull_requests?.[0];
  if (!pullRequestRef?.number) {
    appendSummary([
      "### Claude Merge",
      "No pull request attached to this workflow run. Nothing to merge.",
    ]);
    return;
  }

  const pullNumber = pullRequestRef.number;
  let pr = await getPullRequest(pullNumber);

  if (pr.state !== "open") {
    appendSummary([
      "### Claude Merge",
      `PR #${pullNumber} is not open. Skipping merge.`,
    ]);
    return;
  }

  if (pr.draft && process.env.CLAUDE_AUTO_READY_DRAFTS !== "false") {
    await markReadyForReview(pullNumber);
    pr = await getPullRequest(pullNumber);
  }

  if (pr.draft) {
    appendSummary([
      "### Claude Merge",
      `PR #${pullNumber} is still draft. Skipping merge.`,
    ]);
    return;
  }

  const targetBase = resolveTargetBranch();

  if (pr.base.ref !== targetBase) {
    await githubRequest(`/repos/${owner}/${repo}/pulls/${pullNumber}`, {
      method: "PATCH",
      body: { base: targetBase },
    });

    appendSummary([
      "### Claude Merge",
      `Retargeted PR #${pullNumber} from ${pr.base.ref} to ${targetBase}.`,
      "Merge skipped for this run so checks can re-evaluate against the target branch.",
    ]);
    return;
  }

  const checksResponse = await getCheckRuns(pr.head.sha);
  const checkRuns = checksResponse.check_runs ?? [];
  const requiredChecks = evaluateRequiredChecks(checkRuns);

  if (!requiredChecks.allPassed) {
    appendSummary([
      "### Claude Merge",
      `PR #${pullNumber} is waiting for required checks.`,
      ...requiredChecks.results.map((result) => {
        if (!result.found) {
          return `- ${result.matcher}: missing`;
        }
        return `- ${result.matcher}: ${result.passed ? "pass" : "pending/fail"}`;
      }),
    ]);
    return;
  }

  const peerGate = await verifyPeerReviewGate(pullNumber);
  if (!peerGate.ok) {
    appendSummary([
      "### Claude Merge",
      `PR #${pullNumber} is blocked by peer-review gate.`,
      `- Reason: ${peerGate.reason}`,
      ...peerGate.unresolvedThreads
        .slice(0, 10)
        .map((thread) => `- Thread: ${thread.path}${thread.line ? `:${thread.line}` : ""}`),
    ]);
    return;
  }

  const riskGate = await evaluateRiskGate(pr);
  if (riskGate.blocked) {
    await upsertIssueComment(
      pullNumber,
      "<!-- claude-merge:risk-block -->",
      [
        "Claude merge blocked due to elevated risk score.",
        "",
        `- Risk level: ${riskGate.risk.level}`,
        `- Risk score: ${riskGate.risk.score}`,
        ...riskGate.risk.reasons.map((reason) => `- ${reason}`),
        "",
        "Human review is required for this change set.",
      ].join("\n"),
    );

    appendSummary([
      "### Claude Merge",
      `PR #${pullNumber} blocked by risk gate (${riskGate.risk.level}, score=${riskGate.risk.score}).`,
    ]);
    return;
  }

  await upsertIssueComment(
    pullNumber,
    "<!-- claude-merge:final -->",
    [
      "Claude merge conditions are satisfied.",
      "",
      "- Required checks: pass",
      "- Peer review: pass and recent",
      `- Risk level: ${riskGate.risk.level}`,
      `- Risk score: ${riskGate.risk.score}`,
      `- Target branch: ${targetBase}`,
      "- Merge strategy: squash + delete branch",
      "",
      "Proceeding with merge now.",
    ].join("\n"),
  );

  const mergeResult = await githubRequest(`/repos/${owner}/${repo}/pulls/${pullNumber}/merge`, {
    method: "PUT",
    body: {
      merge_method: "squash",
      sha: pr.head.sha,
      commit_title: pr.title,
    },
  });

  const branchIsLocalToRepo = pr.head.repo?.full_name === `${owner}/${repo}`;
  if (branchIsLocalToRepo) {
    const encodedRef = encodeURIComponent(`heads/${pr.head.ref}`);
    await githubRequest(`/repos/${owner}/${repo}/git/refs/${encodedRef}`, {
      method: "DELETE",
      allow404: true,
    });
  }

  await notifyPullRequestLifecycle("merged", pr, targetBase, `PR merged via claude-merge into ${targetBase}.`);

  const mergeSha = typeof mergeResult?.sha === "string" ? mergeResult.sha : "";
  const postMergeHealthy = await runPostMergeHealthGate(pr, targetBase, mergeSha);

  appendSummary([
    "### Claude Merge",
    `Merged PR #${pullNumber} into ${targetBase} with squash merge.`,
    `Merge response: ${mergeResult.message ?? "merged"}`,
    branchIsLocalToRepo ? `Deleted branch ${pr.head.ref}.` : "Head branch belongs to a fork; not deleted.",
    `Post-merge health: ${postMergeHealthy ? "pass" : "fail"}`,
  ]);

  if (!postMergeHealthy) {
    throw new Error("Post-merge health gate failed");
  }
}

main().catch((error) => {
  console.error("claude-merge failed", error);
  process.exit(1);
});
