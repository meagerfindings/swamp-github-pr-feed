/**
 * Poll open GitHub PRs for new reviews, comments, and check failures.
 * Maintains per-PR watermarks for deduplication and includes GitHub
 * API rate-limit awareness with exponential backoff.
 *
 * @module
 */

import { z } from "npm:zod@4";

// --- Schemas ---

const GlobalArgsSchema = z.object({
  /** GitHub username to filter PRs by (used with --author). */
  githubUser: z.string(),
  /** GitHub repository in owner/repo format. */
  repo: z.string(),
  /** Authors whose activity is silently skipped (no event, no watermark update). */
  skipAuthors: z.array(z.string()).default([
    "dependabot[bot]",
    "renovate[bot]",
  ]),
  /** Minimum remaining REST API calls before entering backoff. */
  rateLimitFloor: z.number().default(500),
  /** Escalating backoff durations in seconds (30m, 1h, 2h). */
  backoffSchedule: z.array(z.number()).default([1800, 3600, 7200]),
});

const PrSnapshotSchema = z.object({
  /** PR number on GitHub. */
  prNumber: z.number(),
  /** PR title at time of snapshot. */
  prTitle: z.string(),
  /** Full URL to the PR. */
  prUrl: z.string(),
  /** Head branch name. */
  headBranch: z.string(),
  /** Head commit SHA (used for check-runs endpoint). */
  headSha: z.string(),
  /** Highest review ID seen for this PR. */
  lastReviewId: z.number(),
  /** Highest inline review comment ID seen. */
  lastCommentId: z.number(),
  /** Highest general issue comment ID seen. */
  lastIssueCommentId: z.number(),
  /** Highest failed check-run ID seen. */
  lastFailedCheckId: z.number(),
  /** Overall review state. */
  reviewState: z.enum([
    "pending",
    "approved",
    "changes_requested",
    "commented",
  ]),
  /** Overall checks state. */
  checksState: z.enum(["pending", "success", "failure", "neutral"]),
  /** Timestamp of last poll for this PR. */
  lastPollAt: z.string(),
});

const FeedbackEventSchema = z.object({
  /** Deterministic ID: {prNumber}-{type}-{sourceId}. */
  eventId: z.string(),
  /** PR number this event belongs to. */
  prNumber: z.number(),
  /** PR title at detection time. */
  prTitle: z.string(),
  /** Full URL to the PR. */
  prUrl: z.string(),
  /** Head branch name. */
  headBranch: z.string(),
  /** Kind of feedback detected. */
  type: z.enum(["review", "review_comment", "issue_comment", "check_failure"]),
  /** GitHub username of the feedback author. */
  author: z.string(),
  /** Whether the author is classified as a bot or human. */
  authorType: z.enum(["human", "bot"]),
  /** Comment or review body (truncated to 2000 chars). */
  body: z.string(),
  /** File path for inline review comments. */
  filePath: z.string().optional(),
  /** Line number for inline review comments. */
  line: z.number().optional(),
  /** Diff hunk context for inline review comments. */
  diffHunk: z.string().optional(),
  /** Review state (APPROVED, CHANGES_REQUESTED, etc.) for review events. */
  state: z.string().optional(),
  /** Check run name for check_failure events. */
  checkName: z.string().optional(),
  /** Check run conclusion for check_failure events. */
  checkConclusion: z.string().optional(),
  /** When this event was first detected. */
  detectedAt: z.string(),
});

const RefreshResultSchema = z.object({
  /** GitHub repo that was polled. */
  repo: z.string(),
  /** Timestamp of this refresh. */
  refreshedAt: z.string(),
  /** Number of open PRs found. */
  openPrCount: z.number(),
  /** Total new feedback events detected. */
  newEventCount: z.number(),
  /** Per-PR breakdown of new events. */
  prSummaries: z.array(z.object({
    prNumber: z.number(),
    prTitle: z.string(),
    newEvents: z.number(),
  })),
  /** Whether the refresh was skipped due to rate limiting. */
  rateLimited: z.boolean(),
  /** Current GitHub rate limit remaining (at time of check). */
  rateLimitRemaining: z.number().optional(),
});

const RateLimitStateSchema = z.object({
  /** Source identifier (always "github-rest"). */
  source: z.string(),
  /** Number of consecutive backoff events. */
  attempts: z.number(),
  /** Timestamp of last rate limit detection. */
  lastHitAt: z.string(),
  /** Do not retry before this timestamp. */
  backoffUntil: z.string(),
});

// --- Helpers ---

type GhResult = {
  stdout: string;
  stderr: string;
  success: boolean;
};

/** Run a `gh` CLI command and return structured output. */
async function runGh(args: string[]): Promise<GhResult> {
  const cmd = new Deno.Command("gh", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  return {
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
    success: output.success,
  };
}

/** Parse JSON from gh output, returning an empty array on failure. */
function parseJsonArray(raw: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Classify an author as human or bot. */
function classifyAuthor(login: string): "human" | "bot" {
  if (login.endsWith("[bot]")) return "bot";
  return "human";
}

/** Truncate a string to maxLen characters. */
function truncate(s: string | undefined | null, maxLen: number): string {
  if (!s) return "";
  return s.length > maxLen ? s.slice(0, maxLen) + "…" : s;
}

// --- Context type ---

type MethodContext = {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  definition: { id: string; name: string };
  modelType: string;
  modelId: string;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
    error: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  readResource?: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  dataRepository: {
    findAllForModel: (
      type: string,
      modelId: string,
    ) => Promise<
      Array<{
        name: string;
        tags?: Record<string, string>;
        content?: Uint8Array;
      }>
    >;
    getContent: (
      type: string,
      modelId: string,
      dataName: string,
    ) => Promise<Uint8Array | null>;
  };
};

// --- Data loading helpers ---

/** Load all prSnapshot artifacts into a map keyed by PR number. */
async function loadPrSnapshots(
  context: MethodContext,
): Promise<Map<number, z.infer<typeof PrSnapshotSchema>>> {
  const snapshots = new Map<number, z.infer<typeof PrSnapshotSchema>>();

  try {
    const allData = await context.dataRepository.findAllForModel(
      context.modelType,
      context.modelId,
    );

    for (const data of allData) {
      if (data.tags?.specName !== "prSnapshot") continue;

      const content = await context.dataRepository.getContent(
        context.modelType,
        context.modelId,
        data.name,
      );
      if (!content) continue;

      try {
        const snapshot = JSON.parse(new TextDecoder().decode(content));
        if (typeof snapshot.prNumber === "number") {
          snapshots.set(snapshot.prNumber, snapshot);
        }
      } catch { /* skip corrupt data */ }
    }
  } catch { /* no data yet */ }

  return snapshots;
}

/** Load the current rate limit backoff state, if any. */
async function loadRateLimitState(
  context: MethodContext,
): Promise<z.infer<typeof RateLimitStateSchema> | null> {
  try {
    const existing = await context.readResource?.("ratelimit-github-rest") as
      | z.infer<typeof RateLimitStateSchema>
      | null;
    return existing;
  } catch {
    return null;
  }
}

/** Check if currently in rate limit backoff. */
function isInBackoff(
  state: z.infer<typeof RateLimitStateSchema> | null,
): boolean {
  if (!state || state.attempts === 0) return false;
  return new Date(state.backoffUntil).getTime() > Date.now();
}

// --- Model ---

/** Swamp model for polling GitHub PRs and detecting new feedback. */
export const model = {
  type: "@mgreten/github-pr-feed",
  version: "2026.07.06.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    refreshResult: {
      description:
        "Summary of a single refresh cycle — PRs polled, events detected, rate limit status",
      schema: RefreshResultSchema,
      lifetime: "7d" as const,
      garbageCollection: 50,
    },
    prSnapshot: {
      description:
        "Per-PR state snapshot with watermarks for deduplication across refresh cycles",
      schema: PrSnapshotSchema,
      // Dedup only ever reads the latest watermark per PR; historical versions
      // are never read back. Keeping a large window bloats the model shard and
      // makes every refresh re-sync it (observed: 26min writes at 100×30d). Keep
      // a small debugging window and expire closed-PR snapshots quickly.
      lifetime: "7d" as const,
      garbageCollection: 5,
    },
    feedbackEvent: {
      description:
        "Individual feedback event detected on a PR (review, comment, or check failure)",
      schema: FeedbackEventSchema,
      lifetime: "14d" as const,
      garbageCollection: 200,
    },
    rateLimit: {
      description:
        "GitHub REST API rate limit backoff state with exponential escalation",
      schema: RateLimitStateSchema,
      lifetime: "1d" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    refresh: {
      description:
        "Poll open PRs for new reviews, comments, and check failures. " +
        "Detects new activity since last watermarks and writes feedbackEvent artifacts. " +
        "Skips polling if GitHub rate limit is below the configured floor.",
      arguments: z.object({
        /** Log what would be detected without writing artifacts. */
        dryRun: z.boolean().default(false).describe(
          "Log events without writing artifacts or updating watermarks",
        ),
      }),
      execute: async (
        args: { dryRun: boolean },
        context: MethodContext,
      ): Promise<{ dataHandles: Array<Record<string, unknown>> }> => {
        const {
          githubUser,
          repo,
          skipAuthors,
          rateLimitFloor,
          backoffSchedule,
        } = context.globalArgs;
        const now = new Date();
        const handles: Array<Record<string, unknown>> = [];

        // Check rate limit backoff
        const rlState = await loadRateLimitState(context);
        if (isInBackoff(rlState)) {
          context.logger.warning(
            "Skipping refresh — in rate limit backoff until {until}",
            { until: rlState!.backoffUntil },
          );
          const handle = await context.writeResource(
            "refreshResult",
            `refresh-${Date.now()}`,
            {
              repo,
              refreshedAt: now.toISOString(),
              openPrCount: 0,
              newEventCount: 0,
              prSummaries: [],
              rateLimited: true,
            } as unknown as Record<string, unknown>,
          );
          return { dataHandles: [handle] };
        }

        // Check current rate limit headroom
        const rlCheck = await runGh([
          "api",
          "rate_limit",
          "--jq",
          ".rate.remaining",
        ]);
        const remaining = parseInt(rlCheck.stdout.trim(), 10);

        if (!isNaN(remaining) && remaining < rateLimitFloor) {
          context.logger.warning(
            "GitHub rate limit low ({remaining}/{floor}) — entering backoff",
            { remaining, floor: rateLimitFloor },
          );

          const prevAttempts = rlState?.attempts ?? 0;
          const nextAttempts = prevAttempts + 1;
          const backoffIdx = Math.min(
            nextAttempts - 1,
            backoffSchedule.length - 1,
          );
          const backoffSec = backoffSchedule[backoffIdx];

          if (!args.dryRun) {
            await context.writeResource(
              "rateLimit",
              "ratelimit-github-rest",
              {
                source: "github-rest",
                attempts: nextAttempts,
                lastHitAt: now.toISOString(),
                backoffUntil: new Date(
                  now.getTime() + backoffSec * 1000,
                ).toISOString(),
              } as unknown as Record<string, unknown>,
            );
          }

          const handle = await context.writeResource(
            "refreshResult",
            `refresh-${Date.now()}`,
            {
              repo,
              refreshedAt: now.toISOString(),
              openPrCount: 0,
              newEventCount: 0,
              prSummaries: [],
              rateLimited: true,
              rateLimitRemaining: remaining,
            } as unknown as Record<string, unknown>,
          );
          return { dataHandles: [handle] };
        }

        // Clear backoff on successful rate limit check
        if (rlState && rlState.attempts > 0 && !args.dryRun) {
          await context.writeResource(
            "rateLimit",
            "ratelimit-github-rest",
            {
              source: "github-rest",
              attempts: 0,
              lastHitAt: now.toISOString(),
              backoffUntil: new Date(0).toISOString(),
            } as unknown as Record<string, unknown>,
          );
        }

        // Fetch open PRs
        const prListResult = await runGh([
          "pr",
          "list",
          "--repo",
          repo,
          "--author",
          githubUser,
          "--state",
          "open",
          "--json",
          "number,title,url,headRefName,headRefOid",
          "--limit",
          "50",
        ]);

        if (!prListResult.success) {
          throw new Error(
            `gh pr list failed: ${prListResult.stderr.slice(0, 500)}`,
          );
        }

        const openPrs = parseJsonArray(prListResult.stdout);
        context.logger.info("Found {count} open PRs for {user}", {
          count: openPrs.length,
          user: githubUser,
        });

        // Load existing snapshots
        const snapshots = await loadPrSnapshots(context);
        const skipSet = new Set(skipAuthors.map((a) => a.toLowerCase()));
        const prSummaries: Array<{
          prNumber: number;
          prTitle: string;
          newEvents: number;
        }> = [];
        let totalNewEvents = 0;

        for (const pr of openPrs) {
          const prNumber = pr.number as number;
          const prTitle = pr.title as string;
          const prUrl = pr.url as string;
          const headBranch = pr.headRefName as string;
          const headSha = pr.headRefOid as string;

          const snapshot = snapshots.get(prNumber) ?? {
            prNumber,
            prTitle,
            prUrl,
            headBranch,
            headSha,
            lastReviewId: 0,
            lastCommentId: 0,
            lastIssueCommentId: 0,
            lastFailedCheckId: 0,
            reviewState: "pending" as const,
            checksState: "pending" as const,
            lastPollAt: new Date(0).toISOString(),
          };

          let newEvents = 0;
          let latestReviewId = snapshot.lastReviewId;
          let latestCommentId = snapshot.lastCommentId;
          let latestIssueCommentId = snapshot.lastIssueCommentId;
          let latestFailedCheckId = snapshot.lastFailedCheckId;
          let latestReviewState = snapshot.reviewState;

          // Fetch reviews
          const reviewsResult = await runGh([
            "api",
            `repos/${repo}/pulls/${prNumber}/reviews`,
            "--jq",
            `[.[] | {id, user: .user.login, state, body, submitted_at: .submitted_at}]`,
          ]);
          const reviews = parseJsonArray(reviewsResult.stdout);

          for (const review of reviews) {
            const reviewId = review.id as number;
            if (reviewId <= snapshot.lastReviewId) continue;
            const author = (review.user as string) ?? "";
            if (skipSet.has(author.toLowerCase())) continue;

            const eventId = `${prNumber}-review-${reviewId}`;
            const state = review.state as string;

            if (!args.dryRun) {
              const handle = await context.writeResource(
                "feedbackEvent",
                `event-${eventId}`,
                {
                  eventId,
                  prNumber,
                  prTitle,
                  prUrl,
                  headBranch,
                  type: "review",
                  author,
                  authorType: classifyAuthor(author),
                  body: truncate(review.body as string, 2000),
                  state,
                  detectedAt: now.toISOString(),
                } as unknown as Record<string, unknown>,
              );
              handles.push(handle);
            }

            newEvents++;
            if (reviewId > latestReviewId) latestReviewId = reviewId;

            const stateMap: Record<string, typeof latestReviewState> = {
              APPROVED: "approved",
              CHANGES_REQUESTED: "changes_requested",
              COMMENTED: "commented",
            };
            if (stateMap[state]) latestReviewState = stateMap[state];
          }

          // Fetch inline review comments
          const commentsResult = await runGh([
            "api",
            `repos/${repo}/pulls/${prNumber}/comments`,
            "--jq",
            `[.[] | {id, user: .user.login, body, path, line: .original_line, diff_hunk, created_at}]`,
          ]);
          const comments = parseJsonArray(commentsResult.stdout);

          for (const comment of comments) {
            const commentId = comment.id as number;
            if (commentId <= snapshot.lastCommentId) continue;
            const author = (comment.user as string) ?? "";
            if (skipSet.has(author.toLowerCase())) continue;

            const eventId = `${prNumber}-comment-${commentId}`;

            if (!args.dryRun) {
              const handle = await context.writeResource(
                "feedbackEvent",
                `event-${eventId}`,
                {
                  eventId,
                  prNumber,
                  prTitle,
                  prUrl,
                  headBranch,
                  type: "review_comment",
                  author,
                  authorType: classifyAuthor(author),
                  body: truncate(comment.body as string, 2000),
                  filePath: comment.path as string,
                  line: comment.line as number,
                  diffHunk: truncate(comment.diff_hunk as string, 1000),
                  detectedAt: now.toISOString(),
                } as unknown as Record<string, unknown>,
              );
              handles.push(handle);
            }

            newEvents++;
            if (commentId > latestCommentId) latestCommentId = commentId;
          }

          // Fetch general issue comments
          const issueCommentsResult = await runGh([
            "api",
            `repos/${repo}/issues/${prNumber}/comments`,
            "--jq",
            `[.[] | {id, user: .user.login, body, created_at}]`,
          ]);
          const issueComments = parseJsonArray(issueCommentsResult.stdout);

          for (const comment of issueComments) {
            const commentId = comment.id as number;
            if (commentId <= snapshot.lastIssueCommentId) continue;
            const author = (comment.user as string) ?? "";
            if (skipSet.has(author.toLowerCase())) continue;

            const eventId = `${prNumber}-issue-comment-${commentId}`;

            if (!args.dryRun) {
              const handle = await context.writeResource(
                "feedbackEvent",
                `event-${eventId}`,
                {
                  eventId,
                  prNumber,
                  prTitle,
                  prUrl,
                  headBranch,
                  type: "issue_comment",
                  author,
                  authorType: classifyAuthor(author),
                  body: truncate(comment.body as string, 2000),
                  detectedAt: now.toISOString(),
                } as unknown as Record<string, unknown>,
              );
              handles.push(handle);
            }

            newEvents++;
            if (commentId > latestIssueCommentId) {
              latestIssueCommentId = commentId;
            }
          }

          // Fetch failed check runs
          const checksResult = await runGh([
            "api",
            `repos/${repo}/commits/${headSha}/check-runs`,
            "--jq",
            `[.check_runs[] | select(.conclusion == "failure") | {id, name, conclusion, completed_at}]`,
          ]);
          const failedChecks = parseJsonArray(checksResult.stdout);
          const checksState: z.infer<typeof PrSnapshotSchema>["checksState"] =
            failedChecks.length > 0 ? "failure" : "success";

          for (const check of failedChecks) {
            const checkId = check.id as number;
            if (checkId <= snapshot.lastFailedCheckId) continue;

            const eventId = `${prNumber}-check-${checkId}`;
            const checkName = (check.name as string) ?? "unknown";

            if (!args.dryRun) {
              const handle = await context.writeResource(
                "feedbackEvent",
                `event-${eventId}`,
                {
                  eventId,
                  prNumber,
                  prTitle,
                  prUrl,
                  headBranch,
                  type: "check_failure",
                  author: "github-actions[bot]",
                  authorType: "bot" as const,
                  body: `Check "${checkName}" failed`,
                  checkName,
                  checkConclusion: check.conclusion as string,
                  detectedAt: now.toISOString(),
                } as unknown as Record<string, unknown>,
              );
              handles.push(handle);
            }

            newEvents++;
            if (checkId > latestFailedCheckId) latestFailedCheckId = checkId;
          }

          // Update snapshot
          if (!args.dryRun) {
            const updatedSnapshot = {
              prNumber,
              prTitle,
              prUrl,
              headBranch,
              headSha,
              lastReviewId: latestReviewId,
              lastCommentId: latestCommentId,
              lastIssueCommentId: latestIssueCommentId,
              lastFailedCheckId: latestFailedCheckId,
              reviewState: latestReviewState,
              checksState,
              lastPollAt: now.toISOString(),
            };
            await context.writeResource(
              "prSnapshot",
              `snapshot-${prNumber}`,
              updatedSnapshot as unknown as Record<string, unknown>,
            );
          }

          if (newEvents > 0) {
            prSummaries.push({ prNumber, prTitle, newEvents });
            totalNewEvents += newEvents;
          }
        }

        context.logger.info(
          "Refresh complete: {prs} PRs, {events} new events across {prsWithEvents} PRs",
          {
            prs: openPrs.length,
            events: totalNewEvents,
            prsWithEvents: prSummaries.length,
          },
        );

        const refreshResult = {
          repo,
          refreshedAt: now.toISOString(),
          openPrCount: openPrs.length,
          newEventCount: totalNewEvents,
          prSummaries,
          rateLimited: false,
          rateLimitRemaining: isNaN(remaining) ? undefined : remaining,
        };

        const resultHandle = await context.writeResource(
          "refreshResult",
          `refresh-${Date.now()}`,
          refreshResult as unknown as Record<string, unknown>,
        );
        handles.push(resultHandle);

        return { dataHandles: handles };
      },
    },

    getRateLimit: {
      description:
        "Check current GitHub REST API rate limit status and any active backoff state. " +
        "Useful for other models to verify headroom before making their own gh calls.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ): Promise<{ dataHandles: Array<Record<string, unknown>> }> => {
        const rlState = await loadRateLimitState(context);
        const rlCheck = await runGh([
          "api",
          "rate_limit",
          "--jq",
          ".rate | {limit, remaining, reset, used}",
        ]);

        let rateInfo: Record<string, unknown> = {};
        try {
          rateInfo = JSON.parse(rlCheck.stdout);
        } catch { /* gh call failed */ }

        context.logger.info(
          "Rate limit: {remaining}/{limit}, backoff: {inBackoff}",
          {
            remaining: rateInfo.remaining ?? "unknown",
            limit: rateInfo.limit ?? "unknown",
            inBackoff: isInBackoff(rlState),
          },
        );

        return {
          dataHandles: [],
        };
      },
    },

    clearBackoff: {
      description:
        "Manually clear GitHub rate limit backoff state. Use when you know " +
        "rate limits have recovered and want to resume polling immediately.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ): Promise<{ dataHandles: Array<Record<string, unknown>> }> => {
        const handle = await context.writeResource(
          "rateLimit",
          "ratelimit-github-rest",
          {
            source: "github-rest",
            attempts: 0,
            lastHitAt: new Date().toISOString(),
            backoffUntil: new Date(0).toISOString(),
          } as unknown as Record<string, unknown>,
        );

        context.logger.info("Cleared GitHub rate limit backoff");
        return { dataHandles: [handle] };
      },
    },
  },
};
