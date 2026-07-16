import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  classifyAuthor,
  model,
  parseJsonArray,
  truncate,
} from "./github_pr_feed.ts";

Deno.test("parseJsonArray: returns object entries from valid arrays", () => {
  assertEquals(parseJsonArray('[{"id":1},{"id":2}]'), [{ id: 1 }, { id: 2 }]);
});

Deno.test("parseJsonArray: returns empty for malformed JSON", () => {
  assertEquals(parseJsonArray("not json"), []);
  assertEquals(parseJsonArray(""), []);
});

Deno.test("parseJsonArray: returns empty for valid non-array JSON", () => {
  assertEquals(parseJsonArray('{"id":1}'), []);
  assertEquals(parseJsonArray("null"), []);
});

Deno.test("classifyAuthor: recognizes GitHub bot suffix", () => {
  assertEquals(classifyAuthor("dependabot[bot]"), "bot");
  assertEquals(classifyAuthor("github-actions[bot]"), "bot");
});

Deno.test("classifyAuthor: treats ordinary and bot-like names as human", () => {
  assertEquals(classifyAuthor("octocat"), "human");
  assertEquals(classifyAuthor("robot"), "human");
  assertEquals(classifyAuthor("Dependabot[BOT]"), "human");
});

Deno.test("truncate: preserves strings at or below the limit", () => {
  assertEquals(truncate("hello", 5), "hello");
  assertEquals(truncate("hi", 5), "hi");
});

Deno.test("truncate: slices overlong strings and appends an ellipsis", () => {
  assertEquals(truncate("abcdef", 3), "abc…");
});

Deno.test("truncate: normalizes absent and empty values", () => {
  assertEquals(truncate(undefined, 10), "");
  assertEquals(truncate(null, 10), "");
  assertEquals(truncate("", 10), "");
});

Deno.test("global arguments: applies dedupe and backoff defaults", () => {
  const parsed = model.globalArguments.parse({
    githubUser: "octocat",
    repo: "owner/repo",
  });
  assertEquals(parsed.skipAuthors, ["dependabot[bot]", "renovate[bot]"]);
  assertEquals(parsed.rateLimitFloor, 500);
  assertEquals(parsed.backoffSchedule, [1800, 3600, 7200]);
});

Deno.test("global arguments: preserves explicit polling policy", () => {
  const parsed = model.globalArguments.parse({
    githubUser: "octocat",
    repo: "owner/repo",
    skipAuthors: ["ci[bot]"],
    rateLimitFloor: 100,
    backoffSchedule: [60, 120],
  });
  assertEquals(parsed.skipAuthors, ["ci[bot]"]);
  assertEquals(parsed.rateLimitFloor, 100);
  assertEquals(parsed.backoffSchedule, [60, 120]);
});

Deno.test("global arguments: rejects missing repository identity", () => {
  assertThrows(() => model.globalArguments.parse({ githubUser: "octocat" }));
  assertThrows(() => model.globalArguments.parse({ repo: "owner/repo" }));
});

Deno.test("feedbackEvent schema: accepts each event shape and rejects unknown type", () => {
  const base = {
    eventId: "42-review-7",
    prNumber: 42,
    prTitle: "Improve polling",
    prUrl: "https://github.com/owner/repo/pull/42",
    headBranch: "feature",
    author: "reviewer",
    authorType: "human",
    body: "Looks good",
    detectedAt: "2026-07-16T12:00:00.000Z",
  };
  for (const type of ["review", "review_comment", "issue_comment", "check_failure"]) {
    assertEquals(
      model.resources.feedbackEvent.schema.safeParse({ ...base, type }).success,
      true,
    );
  }
  assertEquals(
    model.resources.feedbackEvent.schema.safeParse({ ...base, type: "push" })
      .success,
    false,
  );
});

Deno.test("prSnapshot schema: rejects invalid aggregate states", () => {
  const snapshot = {
    prNumber: 42,
    prTitle: "Improve polling",
    prUrl: "https://github.com/owner/repo/pull/42",
    headBranch: "feature",
    headSha: "abc123",
    lastReviewId: 7,
    lastCommentId: 8,
    lastIssueCommentId: 9,
    lastFailedCheckId: 10,
    reviewState: "approved",
    checksState: "success",
    lastPollAt: "2026-07-16T12:00:00.000Z",
  };
  assertEquals(model.resources.prSnapshot.schema.safeParse(snapshot).success, true);
  assertEquals(
    model.resources.prSnapshot.schema.safeParse({
      ...snapshot,
      checksState: "cancelled",
    }).success,
    false,
  );
});

Deno.test("refresh arguments: defaults dryRun and rejects non-booleans", () => {
  assertEquals(model.methods.refresh.arguments.parse({}), { dryRun: false });
  assertThrows(() => model.methods.refresh.arguments.parse({ dryRun: "yes" }));
});
