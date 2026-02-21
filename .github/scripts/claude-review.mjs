import fs from "node:fs";
import process from "node:process";
import { execSync } from "node:child_process";

function appendOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }
  fs.appendFileSync(outputPath, `${name}=${String(value)}\n`);
}

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

function parseArgs(argv) {
  const options = {
    logFile: "",
    reason: "",
    markReady: false,
    timeoutSeconds: 900,
    intervalSeconds: 20,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--log-file") {
      options.logFile = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (token === "--reason") {
      options.reason = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (token === "--mark-ready") {
      options.markReady = true;
      continue;
    }
    if (token === "--timeout-seconds") {
      const parsed = Number.parseInt(argv[index + 1] ?? "", 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        options.timeoutSeconds = parsed;
      }
      index += 1;
      continue;
    }
    if (token === "--interval-seconds") {
      const parsed = Number.parseInt(argv[index + 1] ?? "", 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        options.intervalSeconds = parsed;
      }
      index += 1;
    }
  }

  return options;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

function resolveRepo(payload) {
  const repositoryFullName = payload.repository?.full_name ?? process.env.GITHUB_REPOSITORY;
  if (!repositoryFullName || !repositoryFullName.includes("/")) {
    throw new Error("Unable to resolve repository name");
  }
  const [owner, repo] = repositoryFullName.split("/");
  return { owner, repo, fullName: `${owner}/${repo}` };
}

function toStringValue(value, fallback) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : fallback;
  }
  return fallback;
}

function getGitHubToken() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN is required");
  }
  return token;
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

async function githubRequest(token, path, { method = "GET", body } = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "ops-control-plane-claude-review",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(`GitHub API ${method} ${path} failed: ${response.status} ${responseText}`);
  }

  if (response.status === 204) {
    return {};
  }

  return response.json();
}

async function githubGraphql(token, query, variables) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "ops-control-plane-claude-review",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const payload = await response.json();
  if (!response.ok || (Array.isArray(payload.errors) && payload.errors.length > 0)) {
    const message = Array.isArray(payload.errors)
      ? payload.errors.map((error) => error?.message).filter(Boolean).join("; ")
      : "GraphQL request failed";
    throw new Error(message || `GitHub GraphQL failed with status ${response.status}`);
  }

  return payload.data ?? {};
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
    throw new Error("ops-bridge returned invalid JSON");
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

async function getPullRequestFiles(token, repoContext, prNumber) {
  const files = [];
  let page = 1;

  while (page <= 10) {
    const batch = await githubRequest(
      token,
      `/repos/${repoContext.owner}/${repoContext.repo}/pulls/${prNumber}/files?per_page=100&page=${page}`,
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

async function getPullRequestReviews(token, repoContext, prNumber) {
  const reviews = await githubRequest(
    token,
    `/repos/${repoContext.owner}/${repoContext.repo}/pulls/${prNumber}/reviews?per_page=100`,
  );

  return Array.isArray(reviews) ? reviews : [];
}

async function getLatestPullRequestCommitTimestamp(token, repoContext, prNumber) {
  const commits = await githubRequest(
    token,
    `/repos/${repoContext.owner}/${repoContext.repo}/pulls/${prNumber}/commits?per_page=100`,
  );

  if (!Array.isArray(commits) || commits.length === 0) {
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

async function listReviewThreads(token, repoContext, prNumber) {
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
                  databaseId
                  body
                  path
                  line
                  originalLine
                  url
                  author { login }
                  createdAt
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
    const data = await githubGraphql(token, query, {
      owner: repoContext.owner,
      repo: repoContext.repo,
      number: Number(prNumber),
      after,
    });

    const threadConnection = data?.repository?.pullRequest?.reviewThreads;
    const nodes = Array.isArray(threadConnection?.nodes) ? threadConnection.nodes : [];
    threads.push(...nodes);

    if (!threadConnection?.pageInfo?.hasNextPage) {
      break;
    }

    after = threadConnection.pageInfo.endCursor;
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
      threadId: thread.id,
      commentId: peerComment.databaseId,
      body: String(peerComment.body ?? "").trim(),
      path: String(peerComment.path ?? ""),
      line:
        typeof peerComment.line === "number"
          ? peerComment.line
          : typeof peerComment.originalLine === "number"
            ? peerComment.originalLine
            : null,
      url: String(peerComment.url ?? ""),
      author: String(peerComment.author?.login ?? ""),
    });
  }

  return unresolved;
}

async function resolveReviewThread(token, threadId) {
  const mutation = `
    mutation ResolveThread($threadId: ID!) {
      resolveReviewThread(input: { threadId: $threadId }) {
        thread { id isResolved }
      }
    }
  `;

  await githubGraphql(token, mutation, { threadId });
}

function buildMarkerComment(marker, body) {
  return `${marker}\n${body}`;
}

async function upsertIssueComment(token, repoContext, prNumber, marker, body) {
  const comments = await githubRequest(
    token,
    `/repos/${repoContext.owner}/${repoContext.repo}/issues/${prNumber}/comments?per_page=100`,
  );

  const existing = Array.isArray(comments)
    ? comments.find(
        (comment) =>
          typeof comment?.body === "string" &&
          comment.body.includes(marker) &&
          comment.user?.login === "github-actions[bot]",
      )
    : null;

  const nextBody = buildMarkerComment(marker, body);

  if (existing?.id) {
    await githubRequest(
      token,
      `/repos/${repoContext.owner}/${repoContext.repo}/issues/comments/${existing.id}`,
      { method: "PATCH", body: { body: nextBody } },
    );
    return;
  }

  await githubRequest(token, `/repos/${repoContext.owner}/${repoContext.repo}/issues/${prNumber}/comments`, {
    method: "POST",
    body: { body: nextBody },
  });
}

function extractFindings(logFile) {
  if (!logFile || !fs.existsSync(logFile)) {
    return [];
  }

  const lines = fs
    .readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const fileRefPattern = /(^|[ (])([A-Za-z0-9_./-]+\.[A-Za-z0-9]+:\d+)([),]|$)/;
  const errorPattern = /(error|failed|fail|exception|not found|cannot|✖|✕)/i;
  const selected = [];
  const seen = new Set();

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!fileRefPattern.test(line) && !errorPattern.test(line)) {
      continue;
    }
    const key = line.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    selected.push(line);
    if (selected.length >= 12) {
      break;
    }
  }

  if (selected.length === 0) {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      const key = line.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      selected.push(line);
      if (selected.length >= 12) {
        break;
      }
    }
  }

  return selected.reverse();
}

async function ensureLinearLinkInPrBody(token, repoContext, pr, issueKey) {
  if (!issueKey) {
    return false;
  }

  const currentBody = typeof pr.body === "string" ? pr.body : "";
  const issuePattern = new RegExp(`\\b(ref|refs|fixes|closes|resolves)\\s+${issueKey}\\b`, "i");
  const hasLink = issuePattern.test(currentBody) || currentBody.includes(issueKey);
  if (hasLink) {
    return false;
  }

  const section = `\n\n<!-- claude-linear-link -->\nRefs ${issueKey}`;
  await githubRequest(token, `/repos/${repoContext.owner}/${repoContext.repo}/pulls/${pr.number}`, {
    method: "PATCH",
    body: {
      body: `${currentBody}${section}`.trim(),
    },
  });

  return true;
}

async function markReadyForReview(token, repoContext, prNumber) {
  await githubRequest(
    token,
    `/repos/${repoContext.owner}/${repoContext.repo}/pulls/${prNumber}/ready_for_review`,
    { method: "POST" },
  );
}

function createPrContext(pr, repoFullName) {
  return {
    number: pr.number,
    url: pr.html_url,
    title: pr.title,
    repository: repoFullName,
    headRef: pr.head?.ref,
    baseRef: pr.base?.ref,
  };
}

async function loadRoutingForIssue(issueKey) {
  const audience = process.env.OPS_BRIDGE_GITHUB_AUDIENCE ?? "ops-bridge-review";
  const oidcToken = await getGitHubOidcToken(audience);
  const routing = await fetchReviewContext(issueKey, oidcToken);
  return { routing, oidcToken };
}

function extractKeywords(text) {
  const stopwords = new Set([
    "this", "that", "with", "from", "have", "will", "into", "also", "when", "then", "than",
    "your", "about", "after", "before", "issue", "pull", "request", "review", "ready", "should",
    "would", "could", "there", "their", "while", "where", "which", "what", "been", "were", "they",
    "them", "because", "under", "over", "more", "less", "only", "must", "need", "needs", "done",
  ]);

  const words = String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !stopwords.has(word));

  const counts = new Map();
  for (const word of words) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([word]) => word);
}

function parseEstimateNumber(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return null;
}

function isTestFile(path) {
  return /(^|\/)(__tests__|test|tests)\//i.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(path);
}

function isSourceFile(path) {
  if (isTestFile(path)) {
    return false;
  }
  if (/^docs\//i.test(path) || /^\.github\//i.test(path)) {
    return false;
  }
  if (/\.(md|mdx|txt|png|jpg|jpeg|gif|svg|json|ya?ml)$/i.test(path)) {
    return false;
  }
  return /\.(tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|swift|php|rb)$/i.test(path);
}

function isDocsFile(path) {
  return /^docs\//i.test(path) || /README\.md$/i.test(path) || /\.(md|mdx)$/i.test(path);
}

function isDbFile(path) {
  return /(migration|schema|database|db|sql|prisma|drizzle)/i.test(path);
}

function isApiFile(path) {
  return /(api|route|routes|controller|handler|endpoint)/i.test(path);
}

function isUiFile(path) {
  return /(ui|components|pages|views|screens)/i.test(path);
}

function isPerfFile(path) {
  return /(perf|benchmark|profil|load|k6|locust|artillery)/i.test(path);
}

function isSensitivePath(path) {
  return /(auth|billing|payment|invoice|checkout|permission|rbac|security|secret|token|infra|terraform|helm|k8s|migration|database|schema)/i.test(path);
}

function computeRiskAssessment({ estimate, files, findingsCount = 0 }) {
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

  if (findingsCount > 0) {
    score += Math.min(3, findingsCount);
    reasons.push(`Review findings present (${findingsCount})`);
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

function decodeIssueDescriptionB64(value) {
  if (typeof value !== "string" || value.length === 0) {
    return "";
  }

  try {
    return Buffer.from(value, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function parseAcceptanceCriteria(description) {
  const lines = String(description ?? "").split(/\r?\n/);
  const criteria = [];
  let inCriteriaSection = false;
  let sawCriteriaHeading = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (/^#{1,6}\s*(acceptance criteria|done when|definition of done)\b/i.test(line)) {
      inCriteriaSection = true;
      sawCriteriaHeading = true;
      continue;
    }

    if (/^#{1,6}\s+/.test(line) && inCriteriaSection) {
      inCriteriaSection = false;
    }

    if (!line) {
      continue;
    }

    const bulletMatch = line.match(/^\s*[-*]\s*(?:\[[ xX]\]\s*)?(.+)$/);
    if (inCriteriaSection && bulletMatch?.[1]) {
      criteria.push(bulletMatch[1].trim());
      continue;
    }

    const inlineMatch = line.match(/(?:acceptance criteria|done when)\s*:\s*(.+)$/i);
    if (inlineMatch?.[1]) {
      criteria.push(inlineMatch[1].trim());
    }
  }

  if (!sawCriteriaHeading) {
    return [];
  }

  return [...new Set(criteria.filter(Boolean))];
}

function evaluateCriterion(criterion, context) {
  const text = criterion.toLowerCase();
  const { testFiles, docsFiles, dbFiles, apiFiles, uiFiles, perfFiles, prBody } = context;
  const hasImage = /!\[[^\]]*\]\([^)]+\)/.test(prBody);
  const hasPerfNarrative = /\b(perf(ormance)?|latency|throughput|benchmark)\b/i.test(prBody);

  if (/(test|coverage|unit|integration|e2e|regression)/i.test(text)) {
    return {
      satisfied: testFiles.length > 0,
      reason: "expects test evidence",
    };
  }

  if (/(doc|readme|runbook|guide)/i.test(text)) {
    return {
      satisfied: docsFiles.length > 0,
      reason: "expects documentation update",
    };
  }

  if (/(migration|schema|database|db|sql)/i.test(text)) {
    return {
      satisfied: dbFiles.length > 0,
      reason: "expects database/migration changes",
    };
  }

  if (/(api|endpoint|route|controller)/i.test(text)) {
    return {
      satisfied: apiFiles.length > 0,
      reason: "expects API/route evidence",
    };
  }

  if (/(ui|screenshot|design|layout|visual)/i.test(text)) {
    return {
      satisfied: uiFiles.length > 0 || hasImage,
      reason: "expects UI evidence or screenshot",
    };
  }

  if (/(performance|latency|throughput|benchmark)/i.test(text)) {
    return {
      satisfied: perfFiles.length > 0 || hasPerfNarrative,
      reason: "expects performance validation evidence",
    };
  }

  const keywordCandidates = extractKeywords(criterion).slice(0, 6);
  const evidenceCorpus = context.filePathsText + "\n" + prBody.toLowerCase();
  const overlap = keywordCandidates.filter((keyword) => evidenceCorpus.includes(keyword));
  return {
    satisfied: overlap.length > 0 || keywordCandidates.length === 0,
    reason: "expects scope overlap evidence",
  };
}

function runShellCommand(command) {
  execSync(command, {
    stdio: "inherit",
    env: process.env,
    shell: "/bin/bash",
  });
}

async function runContextAction(pr, issueKey) {
  let blockHuman = false;
  let blockReason = "";
  let reasoningTier = "medium";
  let estimate = "unknown";
  let assignee = "unknown";
  let workspace = "unknown";
  let issueTitle = "";
  let issueUrl = "";
  let issueDescription = "";

  if (!issueKey) {
    blockHuman = true;
    blockReason = "No linked Linear issue key found in PR title/body/branch.";
  } else {
    try {
      const { routing } = await loadRoutingForIssue(issueKey);
      estimate = toStringValue(routing.estimate, "unset");
      reasoningTier = toStringValue(routing.reasoningTier, "medium");
      assignee = toStringValue(routing.linearAssignee, "unassigned");
      workspace = toStringValue(routing.workspace, "unknown");
      issueTitle = toStringValue(routing.issueTitle, "");
      issueUrl = toStringValue(routing.issueUrl, "");
      issueDescription = toStringValue(routing.issueDescription, "");
      blockHuman = routing.blockHuman === true;
      blockReason = toStringValue(routing.blockReason, "");
    } catch (error) {
      blockHuman = true;
      blockReason =
        error instanceof Error
          ? error.message
          : "Failed to fetch review context from ops-bridge";
    }
  }

  appendOutput("issue_key", issueKey ?? "");
  appendOutput("estimate", estimate);
  appendOutput("reasoning_tier", reasoningTier);
  appendOutput("linear_assignee", assignee);
  appendOutput("linear_workspace", workspace);
  appendOutput("issue_title", issueTitle);
  appendOutput("issue_url", issueUrl);
  appendOutput("issue_description_b64", Buffer.from(issueDescription, "utf8").toString("base64"));
  appendOutput("block_human", String(blockHuman));
  appendOutput("block_reason", blockReason);

  appendSummary(
    [
      "### Claude Review Routing",
      `- Issue key: ${issueKey ?? "not found"}`,
      `- Issue title: ${issueTitle || "unknown"}`,
      `- Estimate: ${estimate}`,
      `- Reasoning tier: ${reasoningTier}`,
      `- Assignee: ${assignee}`,
      `- Workspace: ${workspace}`,
      `- Blocked: ${blockHuman ? "yes" : "no"}`,
      blockReason ? `- Reason: ${blockReason}` : "",
    ].filter(Boolean),
  );
}

async function runRiskCheckAction(payload, pr, issueKey) {
  const repoContext = resolveRepo(payload);
  const token = getGitHubToken();
  const files = await getPullRequestFiles(token, repoContext, pr.number);

  let estimate = null;
  if (issueKey) {
    try {
      const { routing } = await loadRoutingForIssue(issueKey);
      estimate = parseEstimateNumber(routing.estimate);
    } catch {
      estimate = null;
    }
  }

  const assessment = computeRiskAssessment({
    estimate,
    files,
    findingsCount: 0,
  });

  appendOutput("risk_level", assessment.level);
  appendOutput("risk_score", String(assessment.score));
  appendOutput("risk_reasons", assessment.reasons.join(" | "));
  appendOutput("risk_changed_lines", String(assessment.changedLines));
  appendOutput("risk_file_count", String(assessment.fileCount));

  appendSummary([
    "### Risk Assessment",
    `- Risk level: ${assessment.level}`,
    `- Risk score: ${assessment.score}`,
    `- Changed lines: ${assessment.changedLines}`,
    `- Changed files: ${assessment.fileCount}`,
    ...(assessment.reasons.length > 0
      ? assessment.reasons.map((reason) => `- ${reason}`)
      : ["- No elevated risk signals detected"]),
  ]);
}

async function runScopeCheckAction(payload, pr, issueKey) {
  if (!issueKey) {
    throw new Error("Scope review failed: no linked issue key found in PR title/body/branch");
  }

  const repoContext = resolveRepo(payload);
  const token = getGitHubToken();
  const { routing } = await loadRoutingForIssue(issueKey);
  const files = await getPullRequestFiles(token, repoContext, pr.number);

  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("Scope review failed: PR has no changed files");
  }

  const issueText = [
    toStringValue(routing.issueTitle, ""),
    toStringValue(routing.issueDescription, ""),
  ]
    .filter(Boolean)
    .join("\n");

  const keywords = extractKeywords(issueText);
  const prContextText = [
    pr.title,
    pr.body,
    ...files.map((file) => file.filename),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

  const overlap = keywords.filter((keyword) => prContextText.includes(keyword));
  const strict = process.env.CLAUDE_SCOPE_STRICT !== "false";

  if (strict && keywords.length >= 5 && overlap.length === 0) {
    throw new Error(
      "Scope review failed: no meaningful overlap between Linear issue scope and PR title/body/file paths. Configure CLAUDE_SCOPE_REVIEW_COMMAND for repo-specific semantic checks if needed.",
    );
  }

  const issueDescription = toStringValue(routing.issueDescription, "");
  const acceptanceCriteria = parseAcceptanceCriteria(issueDescription);

  if (acceptanceCriteria.length > 0) {
    const filePaths = files.map((file) => String(file.filename ?? ""));
    const context = {
      testFiles: filePaths.filter((path) => isTestFile(path)),
      docsFiles: filePaths.filter((path) => isDocsFile(path)),
      dbFiles: filePaths.filter((path) => isDbFile(path)),
      apiFiles: filePaths.filter((path) => isApiFile(path)),
      uiFiles: filePaths.filter((path) => isUiFile(path)),
      perfFiles: filePaths.filter((path) => isPerfFile(path)),
      filePathsText: filePaths.join("\n").toLowerCase(),
      prBody: `${pr.title ?? ""}\n${pr.body ?? ""}`,
    };

    const unsatisfied = [];
    for (const criterion of acceptanceCriteria) {
      const result = evaluateCriterion(criterion, context);
      if (!result.satisfied) {
        unsatisfied.push(`${criterion} (${result.reason})`);
      }
    }

    if (unsatisfied.length > 0) {
      throw new Error(
        `Scope review failed: acceptance criteria missing evidence:\n${unsatisfied
          .map((item) => `- ${item}`)
          .join("\n")}`,
      );
    }
  }

  appendSummary([
    "### Scope Review",
    `- Issue key: ${issueKey}`,
    `- Issue title: ${toStringValue(routing.issueTitle, "unknown")}`,
    `- Changed files: ${files.length}`,
    `- Scope keyword overlap: ${overlap.length}`,
    `- Acceptance criteria checked: ${acceptanceCriteria.length}`,
  ]);
}

async function runQualityGuardrailsAction(payload, pr, issueKey) {
  const repoContext = resolveRepo(payload);
  const token = getGitHubToken();
  const files = await getPullRequestFiles(token, repoContext, pr.number);
  const filePaths = files.map((file) => String(file.filename ?? ""));

  let estimate = null;
  if (issueKey) {
    try {
      const { routing } = await loadRoutingForIssue(issueKey);
      estimate = parseEstimateNumber(routing.estimate);
    } catch {
      estimate = null;
    }
  }

  const risk = computeRiskAssessment({ estimate, files });
  const srcFiles = filePaths.filter((path) => isSourceFile(path));
  const testFiles = filePaths.filter((path) => isTestFile(path));

  const srcBasenames = srcFiles.map((path) => path.split("/").pop()?.split(".")[0] ?? "");
  const matchedSrcFiles = srcBasenames.filter((basename) =>
    testFiles.some((path) => path.toLowerCase().includes(basename.toLowerCase())),
  );

  const matchRatio = srcFiles.length > 0 ? matchedSrcFiles.length / srcFiles.length : 1;
  const srcChangedLines = files
    .filter((file) => isSourceFile(String(file.filename ?? "")))
    .reduce((sum, file) => sum + Number(file.additions ?? 0) + Number(file.deletions ?? 0), 0);
  const testChangedLines = files
    .filter((file) => isTestFile(String(file.filename ?? "")))
    .reduce((sum, file) => sum + Number(file.additions ?? 0) + Number(file.deletions ?? 0), 0);
  const diffCoverageRatio = srcChangedLines > 0 ? testChangedLines / srcChangedLines : 1;

  const defaultMatchThreshold = risk.level === "high" || risk.level === "highest" ? 0.8 : 0.5;
  const defaultCoverageThreshold = risk.level === "high" || risk.level === "highest" ? 0.35 : 0.2;
  const minMatchRatio = Number.parseFloat(process.env.CLAUDE_MIN_TEST_MATCH_RATIO ?? "");
  const minCoverageRatio = Number.parseFloat(process.env.CLAUDE_MIN_DIFF_COVERAGE_RATIO ?? "");
  const targetMatchRatio = Number.isFinite(minMatchRatio) ? minMatchRatio : defaultMatchThreshold;
  const targetCoverageRatio = Number.isFinite(minCoverageRatio) ? minCoverageRatio : defaultCoverageThreshold;

  const criticalChanges = filePaths.filter((path) => isSensitivePath(path));
  const targetedTestCommand = process.env.CLAUDE_TARGETED_TEST_COMMAND?.trim() ?? "";

  const failures = [];

  if (srcFiles.length > 0 && matchRatio < targetMatchRatio) {
    failures.push(
      `Test impact ratio ${matchRatio.toFixed(2)} is below threshold ${targetMatchRatio.toFixed(2)}`,
    );
  }

  if (srcChangedLines > 0 && diffCoverageRatio < targetCoverageRatio) {
    failures.push(
      `Diff coverage ratio ${diffCoverageRatio.toFixed(2)} is below threshold ${targetCoverageRatio.toFixed(2)}`,
    );
  }

  if (criticalChanges.length > 0 && testFiles.length === 0) {
    failures.push("Critical paths changed without any accompanying test file changes");
  }

  if (criticalChanges.length > 0 && !targetedTestCommand) {
    failures.push("Critical paths changed but CLAUDE_TARGETED_TEST_COMMAND is not configured");
  }

  if (targetedTestCommand) {
    runShellCommand(targetedTestCommand);
  }

  appendSummary([
    "### Quality Guardrails",
    `- Risk level: ${risk.level}`,
    `- Source files changed: ${srcFiles.length}`,
    `- Test files changed: ${testFiles.length}`,
    `- Test impact ratio: ${matchRatio.toFixed(2)} (threshold ${targetMatchRatio.toFixed(2)})`,
    `- Diff coverage ratio: ${diffCoverageRatio.toFixed(2)} (threshold ${targetCoverageRatio.toFixed(2)})`,
    `- Critical path changes: ${criticalChanges.length}`,
    targetedTestCommand ? `- Targeted test command: ${targetedTestCommand}` : "- Targeted test command: not configured",
  ]);

  if (failures.length > 0) {
    throw new Error(`Quality guardrails failed:\n${failures.map((line) => `- ${line}`).join("\n")}`);
  }
}

async function runSecurityCheckAction(payload, pr) {
  const repoContext = resolveRepo(payload);
  const token = getGitHubToken();
  const files = await getPullRequestFiles(token, repoContext, pr.number);

  const patterns = [
    { label: "dynamic code execution", regex: /\beval\s*\(/i },
    { label: "dynamic function constructor", regex: /\bnew\s+Function\s*\(/i },
    { label: "shell execution", regex: /\bchild_process\.(exec|execSync)\s*\(/i },
    { label: "unsafe HTML insertion", regex: /\binnerHTML\s*=|dangerouslySetInnerHTML/i },
    { label: "hardcoded secret-like assignment", regex: /\b(API[_-]?KEY|SECRET|TOKEN|PASSWORD)\b\s*[:=]/i },
    { label: "private key material", regex: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/i },
    { label: "aws access key pattern", regex: /AKIA[0-9A-Z]{16}/i },
  ];

  const findings = [];
  let totalAdditions = 0;

  for (const file of files) {
    const additions = Number(file.additions ?? 0);
    totalAdditions += additions;

    if (additions > 1500) {
      findings.push(`${file.filename}: very large single-file diff (${additions} additions)`);
    }

    const patch = typeof file.patch === "string" ? file.patch : "";
    if (!patch) {
      continue;
    }

    const addedLines = patch
      .split(/\r?\n/)
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1));

    for (const line of addedLines) {
      for (const pattern of patterns) {
        if (pattern.regex.test(line)) {
          findings.push(`${file.filename}: ${pattern.label} -> ${line.slice(0, 160)}`);
          break;
        }
      }

      if (findings.length >= 20) {
        break;
      }
    }

    if (findings.length >= 20) {
      break;
    }
  }

  if (totalAdditions > 4000) {
    findings.push(`PR adds ${totalAdditions} lines; performance/regression risk is high`);
  }

  if (findings.length > 0) {
    const detail = findings.slice(0, 20).map((finding) => `- ${finding}`).join("\n");
    throw new Error(`Security/performance review failed:\n${detail}`);
  }

  appendSummary([
    "### Security/Performance Review",
    `- Files scanned: ${files.length}`,
    `- Added lines scanned: ${totalAdditions}`,
    "- High-risk pattern findings: 0",
  ]);
}

async function runReviewStartedAction(payload, pr, issueKey) {
  if (!issueKey) {
    appendSummary([
      "### Claude Review",
      "Skipping review-started lifecycle update because no issue key was detected.",
    ]);
    return;
  }

  const repoContext = resolveRepo(payload);
  const token = getGitHubToken();
  const linkedBody = await ensureLinearLinkInPrBody(token, repoContext, pr, issueKey);

  const { routing, oidcToken } = await loadRoutingForIssue(issueKey);

  const commentBody = [
    "Claude review has been delegated and started.",
    `- Issue: ${issueKey}`,
    `- Estimate: ${toStringValue(routing.estimate, "unset")}`,
    `- Reasoning tier: ${toStringValue(routing.reasoningTier, "medium")}`,
    `- Workspace: ${toStringValue(routing.workspace, "unknown")}`,
    linkedBody ? "- PR body was updated with a native Linear link reference (`Refs <ISSUE_KEY>`)." : "",
  ]
    .filter(Boolean)
    .join("\n");

  await upsertIssueComment(token, repoContext, pr.number, "<!-- claude-review:start -->", commentBody);

  await postPullRequestLifecycle(oidcToken, {
    issueKey,
    stage: "review_started",
    pr: createPrContext(pr, repoContext.fullName),
    summary: `Delegated review started (tier ${toStringValue(routing.reasoningTier, "medium")}).`,
  });
}

async function runReviewBlockedAction(payload, pr, issueKey, options) {
  const repoContext = resolveRepo(payload);
  const token = getGitHubToken();
  const findings = extractFindings(options.logFile);
  if (options.reason) {
    findings.unshift(options.reason.trim());
  }

  const unique = [];
  const seen = new Set();
  for (const finding of findings) {
    const normalized = finding.trim();
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(normalized);
    if (unique.length >= 12) {
      break;
    }
  }

  const commentLines = [
    "Claude found blocking issues that require resolution before merge.",
    "",
    ...((unique.length > 0 ? unique : ["Blocking checks failed."]).map((finding) => `- [ ] ${finding}`)),
  ];

  await upsertIssueComment(
    token,
    repoContext,
    pr.number,
    "<!-- claude-review:blocking -->",
    commentLines.join("\n"),
  );

  if (!issueKey) {
    appendSummary([
      "### Claude Review",
      "Posted blocking PR comment, but skipped Linear lifecycle update because no issue key was detected.",
    ]);
    return;
  }

  const audience = process.env.OPS_BRIDGE_GITHUB_AUDIENCE ?? "ops-bridge-review";
  const oidcToken = await getGitHubOidcToken(audience);

  await postPullRequestLifecycle(oidcToken, {
    issueKey,
    stage: "review_blocked",
    pr: createPrContext(pr, repoContext.fullName),
    summary: options.reason || "Blocking checks failed in claude-review workflow.",
    findings: unique,
  });
}

async function runReviewResolvedAction(payload, pr, issueKey, options) {
  if (!issueKey) {
    appendSummary([
      "### Claude Review",
      "Skipping review-resolved lifecycle update because no issue key was detected.",
    ]);
    return;
  }

  const repoContext = resolveRepo(payload);
  const token = getGitHubToken();
  const { routing, oidcToken } = await loadRoutingForIssue(issueKey);

  const comprehensiveComment = [
    "Claude review completed with no remaining blocking findings.",
    "",
    `- Issue: ${issueKey}`,
    `- Estimate: ${toStringValue(routing.estimate, "unset")}`,
    `- Reasoning tier: ${toStringValue(routing.reasoningTier, "medium")}`,
    `- Assignee: ${toStringValue(routing.linearAssignee, "unassigned")}`,
    `- Workspace: ${toStringValue(routing.workspace, "unknown")}`,
    "- Passes: scope, code quality, security/performance",
    "- Status: ready for peer review cross-check",
  ].join("\n");

  await upsertIssueComment(
    token,
    repoContext,
    pr.number,
    "<!-- claude-review:resolved -->",
    comprehensiveComment,
  );

  await postPullRequestLifecycle(oidcToken, {
    issueKey,
    stage: "review_resolved",
    pr: createPrContext(pr, repoContext.fullName),
    summary: "All Claude findings resolved and review checks passed.",
  });

  if (options.markReady && pr.draft) {
    await markReadyForReview(token, repoContext, pr.number);
    appendSummary([
      "### Claude Review",
      `Marked PR #${pr.number} as ready for review after successful Claude review.`,
    ]);
  }
}

async function runPeerReviewCheckAction(payload, pr, options) {
  const repoContext = resolveRepo(payload);
  const token = getGitHubToken();
  const peerBots = parsePeerBots();
  const requirePeerReview = process.env.CLAUDE_REQUIRE_PEER_REVIEW !== "false";

  const timeoutAt = Date.now() + options.timeoutSeconds * 1000;
  let foundPeerReview = false;
  let foundRecentPeerReview = false;

  while (Date.now() < timeoutAt) {
    const latestCommitTs = await getLatestPullRequestCommitTimestamp(token, repoContext, pr.number);
    const reviews = await getPullRequestReviews(token, repoContext, pr.number);
    const matchingReviews = reviews.filter((review) => {
      const login = String(review?.user?.login ?? "").toLowerCase();
      const state = String(review?.state ?? "").toUpperCase();
      return peerBots.has(login) && state !== "PENDING";
    });
    foundPeerReview = matchingReviews.length > 0;

    foundRecentPeerReview =
      latestCommitTs === null ||
      matchingReviews.some((review) => {
        const submitted = Date.parse(String(review?.submitted_at ?? review?.submittedAt ?? ""));
        return Number.isFinite(submitted) && submitted >= latestCommitTs;
      });

    if ((!requirePeerReview && foundPeerReview) || (foundPeerReview && foundRecentPeerReview)) {
      break;
    }

    await sleep(options.intervalSeconds * 1000);
  }

  if (!foundPeerReview && requirePeerReview) {
    appendOutput("peer_review_found", "false");
    appendOutput("peer_review_recent", "false");
    appendOutput("unresolved_peer_threads", "0");
    throw new Error(
      `Peer review check failed: no completed peer review from configured bots within ${options.timeoutSeconds}s`,
    );
  }

  if (!foundRecentPeerReview && requirePeerReview) {
    appendOutput("peer_review_found", String(foundPeerReview));
    appendOutput("peer_review_recent", "false");
    appendOutput("unresolved_peer_threads", "0");
    throw new Error(
      "Peer review check failed: peer review is stale and predates the latest commit. Waiting for refreshed peer review.",
    );
  }

  const threads = await listReviewThreads(token, repoContext, pr.number);
  const unresolved = filterUnresolvedPeerThreads(threads, peerBots);

  appendOutput("peer_review_found", String(foundPeerReview));
  appendOutput("peer_review_recent", String(foundRecentPeerReview));
  appendOutput("unresolved_peer_threads", String(unresolved.length));

  appendSummary([
    "### Peer Review Check",
    `- Peer review found: ${foundPeerReview ? "yes" : "no"}`,
    `- Peer review after latest commit: ${foundRecentPeerReview ? "yes" : "no"}`,
    `- Unresolved peer threads: ${unresolved.length}`,
    ...(unresolved.slice(0, 10).map((thread) => `- ${thread.path}${thread.line ? `:${thread.line}` : ""} (${thread.author})`)),
  ]);

  if (unresolved.length > 0) {
    throw new Error(`Peer review check failed: ${unresolved.length} unresolved peer review thread(s)`);
  }
}

async function runPeerReviewResolveAction(payload, pr) {
  const repoContext = resolveRepo(payload);
  const token = getGitHubToken();
  const peerBots = parsePeerBots();

  const threads = await listReviewThreads(token, repoContext, pr.number);
  const unresolved = filterUnresolvedPeerThreads(threads, peerBots);

  if (unresolved.length === 0) {
    appendSummary([
      "### Peer Review Resolution",
      "No unresolved peer review threads found.",
    ]);
    return;
  }

  const runUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : "";

  let resolvedCount = 0;

  for (const thread of unresolved) {
    if (typeof thread.commentId === "number") {
      const body = [
        "Addressed this peer-review finding in the latest Claude updates.",
        runUrl ? `Validation run: ${runUrl}` : "",
        "Resolving this thread now.",
      ]
        .filter(Boolean)
        .join("\n");

      await githubRequest(
        token,
        `/repos/${repoContext.owner}/${repoContext.repo}/pulls/comments/${thread.commentId}/replies`,
        {
          method: "POST",
          body: { body },
        },
      );
    }

    await resolveReviewThread(token, thread.threadId);
    resolvedCount += 1;
  }

  appendOutput("resolved_peer_threads", String(resolvedCount));

  appendSummary([
    "### Peer Review Resolution",
    `- Resolved peer threads: ${resolvedCount}`,
  ]);
}

async function main() {
  const action = process.argv[2] ?? "context";
  const options = parseArgs(process.argv.slice(3));

  const { payload, pr } = readEventPayload();
  const issueKey = extractIssueKey(pr.title, pr.body, pr.head?.ref, pr.base?.ref);

  if (action === "context") {
    await runContextAction(pr, issueKey);
    return;
  }

  if (action === "risk-check") {
    await runRiskCheckAction(payload, pr, issueKey);
    return;
  }

  if (action === "scope-check") {
    await runScopeCheckAction(payload, pr, issueKey);
    return;
  }

  if (action === "quality-guardrails") {
    await runQualityGuardrailsAction(payload, pr, issueKey);
    return;
  }

  if (action === "security-check") {
    await runSecurityCheckAction(payload, pr);
    return;
  }

  if (action === "review-started") {
    await runReviewStartedAction(payload, pr, issueKey);
    return;
  }

  if (action === "review-blocked") {
    await runReviewBlockedAction(payload, pr, issueKey, options);
    return;
  }

  if (action === "review-resolved") {
    await runReviewResolvedAction(payload, pr, issueKey, options);
    return;
  }

  if (action === "peer-review-check") {
    await runPeerReviewCheckAction(payload, pr, options);
    return;
  }

  if (action === "peer-review-resolve") {
    await runPeerReviewResolveAction(payload, pr);
    return;
  }

  throw new Error(`Unknown claude-review action: ${action}`);
}

main().catch((error) => {
  console.error("claude-review failed", error);
  process.exit(1);
});
