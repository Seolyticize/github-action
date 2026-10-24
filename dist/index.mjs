// Seolyticize SEO check for GitHub Actions. Dependency-free on purpose: it
// runs as written, with nothing to install or bundle, on the runner's Node.
//
// It calls the check_deploy tool (POST /api/v1/tools/check_deploy), writes the
// result to the job summary and outputs, comments on the pull request, and
// fails the job when anything at or above fail-on changed.
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Marks our comment so a re-run updates it instead of adding another. */
export const MARKER = "<!-- seolyticize-seo-check -->";

/** An action input, as the runner passes it (INPUT_<NAME>, hyphens kept). */
export function input(env, name, fallback = "") {
  const value = env[`INPUT_${name.toUpperCase()}`];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

export function readInputs(env) {
  const urls = input(env, "urls")
    .split(/[\n,]/)
    .map((url) => url.trim())
    .filter(Boolean);
  const previewUrl = input(env, "preview-url") || null;
  const failOn = input(env, "fail-on", "critical");
  if (!["critical", "warning", "notice"].includes(failOn)) {
    throw new Error(`fail-on must be critical, warning or notice, not "${failOn}".`);
  }
  const apiKey = input(env, "api-key");
  const clientId = input(env, "client-id");
  if (!apiKey) throw new Error("api-key is required.");
  if (!clientId) throw new Error("client-id is required.");
  if (!previewUrl && urls.length === 0) throw new Error("Give preview-url or urls.");
  const maxUrls = Math.min(Math.max(Number(input(env, "max-urls", "50")) || 50, 1), 200);
  return {
    apiKey,
    clientId,
    previewUrl,
    urls,
    maxUrls,
    failOn,
    comment: input(env, "comment", "true") !== "false",
    githubToken: input(env, "github-token"),
    apiBase: input(env, "api-base", "https://seolyticize.com").replace(/\/+$/, ""),
  };
}

/** Runs check_deploy and returns its result, or throws with the API's own words. */
export async function checkDeploy(inputs, fetchImpl = fetch) {
  const body = {
    clientId: inputs.clientId,
    maxUrls: inputs.maxUrls,
    failOn: inputs.failOn,
    ...(inputs.previewUrl ? { previewUrl: inputs.previewUrl } : { urls: inputs.urls }),
  };
  const response = await fetchImpl(`${inputs.apiBase}/api/v1/tools/check_deploy`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${inputs.apiKey}`,
      "content-type": "application/json",
      "user-agent": "seolyticize-github-action/1",
    },
    body: JSON.stringify(body),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok || !payload || typeof payload.data !== "object") {
    const reason = payload && payload.error ? payload.error : `HTTP ${response.status}`;
    const next = payload && payload.next ? ` ${payload.next}` : "";
    throw new Error(`Seolyticize refused the check: ${reason}.${next}`);
  }
  return payload.data;
}

/** The pull request number from the event that started the job, or null. */
export function pullRequestNumber(event) {
  const number =
    event?.pull_request?.number ?? (event?.issue?.pull_request ? event.issue.number : null);
  return typeof number === "number" ? number : null;
}

/** Posts the comment, or updates the one an earlier run left. */
export async function upsertComment({ api, repo, number, token, body }, fetchImpl = fetch) {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "seolyticize-github-action/1",
  };
  const text = `${MARKER}\n${body}`;
  const listed = await fetchImpl(
    `${api}/repos/${repo}/issues/${number}/comments?per_page=100`,
    { headers },
  );
  const comments = listed.ok ? await listed.json() : [];
  const existing = Array.isArray(comments)
    ? comments.find((comment) => typeof comment.body === "string" && comment.body.includes(MARKER))
    : undefined;
  const response = existing
    ? await fetchImpl(`${api}/repos/${repo}/issues/comments/${existing.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ body: text }),
      })
    : await fetchImpl(`${api}/repos/${repo}/issues/${number}/comments`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: text }),
      });
  if (!response.ok) throw new Error(`GitHub refused the comment: HTTP ${response.status}.`);
  return existing ? "updated" : "created";
}

/** Escapes text for a workflow command, as the runner requires. */
const escape = (text) => String(text).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

export async function run(env = process.env, fetchImpl = fetch, log = console) {
  const inputs = readInputs(env);
  const result = await checkDeploy(inputs, fetchImpl);

  if (env.GITHUB_OUTPUT) {
    appendFileSync(
      env.GITHUB_OUTPUT,
      `passed=${result.passed ? "true" : "false"}\ncritical=${result.summary?.critical ?? 0}\nchecked=${result.checked ?? 0}\n`,
    );
  }
  if (env.GITHUB_STEP_SUMMARY && result.markdown) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${result.markdown}\n`);
  }

  if (inputs.comment && env.GITHUB_EVENT_PATH && inputs.githubToken) {
    let event = null;
    try {
      event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    } catch {
      event = null;
    }
    const number = pullRequestNumber(event);
    if (number !== null && env.GITHUB_REPOSITORY) {
      try {
        await upsertComment(
          {
            api: env.GITHUB_API_URL || "https://api.github.com",
            repo: env.GITHUB_REPOSITORY,
            number,
            token: inputs.githubToken,
            body: result.markdown ?? "",
          },
          fetchImpl,
        );
      } catch (error) {
        // A comment that could not be posted (a fork's read-only token) must
        // not hide the verdict.
        log.log(`::warning::${escape(error instanceof Error ? error.message : error)}`);
      }
    }
  }

  for (const change of (result.changes ?? []).filter((c) => c.severity === "critical").slice(0, 20)) {
    log.log(`::error title=${escape(change.kind)}::${escape(`${change.url}: ${change.message}`)}`);
  }
  log.log(
    `${result.checked ?? 0} pages checked: ${result.summary?.critical ?? 0} critical, ${result.summary?.warning ?? 0} warnings, ${result.summary?.notice ?? 0} notices.`,
  );
  return result.passed === true ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.log(`::error::${escape(error instanceof Error ? error.message : error)}`);
      process.exitCode = 1;
    });
}
