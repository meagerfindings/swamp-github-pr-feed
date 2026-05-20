# @mgreten/github-pr-feed

Poll open GitHub PRs for new reviews, comments, and check failures. Maintains
per-PR watermarks so each refresh cycle only detects genuinely new activity.
Includes GitHub REST API rate-limit awareness with exponential backoff.

Designed as a shared data layer — call `refresh` once on a schedule and let any
number of downstream models (PR watchers, slop detectors, EOD digests) read the
cached `feedbackEvent` and `prSnapshot` artifacts without making additional
GitHub API calls.

## Installation

```sh
swamp extension pull @mgreten/github-pr-feed
```

## Setup

Create a model instance with your GitHub username and repo:

```sh
swamp model create pr-feed --type @mgreten/github-pr-feed \
  --global-args '{"githubUser": "octocat", "repo": "octocat/hello-world"}'
```

Requires `gh` CLI to be installed and authenticated (`gh auth login`).

## Usage

Poll for new feedback:

```sh
swamp model method run pr-feed refresh --json
```

Dry run (detect without writing artifacts):

```sh
swamp model method run pr-feed refresh --input 'dryRun=true' --json
```

Check rate limit status:

```sh
swamp model method run pr-feed getRateLimit --json
```

Clear rate limit backoff manually:

```sh
swamp model method run pr-feed clearBackoff --json
```

## Global Arguments

| Argument          | Type     | Default                             | Description                              |
| ----------------- | -------- | ----------------------------------- | ---------------------------------------- |
| `githubUser`      | string   | *(required)*                        | GitHub username for `--author` filter    |
| `repo`            | string   | *(required)*                        | Repository in `owner/repo` format        |
| `skipAuthors`     | string[] | `["dependabot[bot]", "renovate[bot]"]` | Authors silently skipped               |
| `rateLimitFloor`  | number   | `500`                               | Min remaining calls before backoff       |
| `backoffSchedule` | number[] | `[1800, 3600, 7200]`               | Escalating backoff seconds (30m, 1h, 2h) |

## Methods

### `refresh`

Polls all open PRs authored by `githubUser` and detects new activity since the
last watermark. Writes `feedbackEvent` artifacts for each new review, comment,
or check failure. Updates `prSnapshot` watermarks to prevent reprocessing.

Checks `gh api rate_limit` before making requests. If remaining calls are below
`rateLimitFloor`, enters exponential backoff and skips the refresh.

| Argument | Type    | Default | Description                                       |
| -------- | ------- | ------- | ------------------------------------------------- |
| `dryRun` | boolean | `false` | Log events without writing artifacts or watermarks |

### `getRateLimit`

Returns current GitHub REST API rate limit status and any active backoff state.

### `clearBackoff`

Clears rate limit backoff state to resume polling immediately.

## Resources

| Resource        | Lifetime | GC  | Description                                        |
| --------------- | -------- | --- | -------------------------------------------------- |
| `refreshResult` | 7d       | 50  | Summary of each refresh cycle                      |
| `prSnapshot`    | 30d      | 100 | Per-PR watermarks and state                        |
| `feedbackEvent` | 14d      | 200 | Individual feedback events (reviews, comments, CI) |
| `rateLimit`     | 1d       | 20  | Rate limit backoff state                           |

## How It Works

Each refresh cycle:

1. Checks GitHub rate limit headroom via `gh api rate_limit`
2. Lists open PRs via `gh pr list --author {user} --state open`
3. For each PR, fetches reviews, inline comments, issue comments, and check runs
4. Compares each item's ID against stored watermarks
5. Writes `feedbackEvent` artifacts for new items (deterministic IDs for dedup)
6. Updates `prSnapshot` with new watermarks

Watermarks use GitHub's monotonically increasing integer IDs rather than
timestamps, which avoids clock-skew issues.

API budget: ~4 calls per open PR + 1 rate limit check. With 5 open PRs at 120s
intervals, that is roughly 630 calls/hour (13% of the 5000/hour limit).

## Downstream Consumption

Other models read cached artifacts via swamp data commands or CEL expressions:

```sh
# List all feedback events
swamp data list pr-feed --spec feedbackEvent --json

# Query events for a specific PR
swamp data query pr-feed "attributes.prNumber == 1234"
```

```
# CEL expression for latest snapshot
data.latest("pr-feed", "snapshot-1234").attributes.reviewState
```

## License

MIT — see LICENSE.txt for details.
