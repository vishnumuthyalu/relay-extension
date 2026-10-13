# GitHub Webhook Contract

## Delivery
GitHub sends a `POST` to `/webhook/github` for every push to a watched repo.
Three headers are load-bearing:

| Header                    | Meaning                                          |
|----------------------------|--------------------------------------------------|
| `X-Hub-Signature-256`      | `sha256=<hex hmac>` of the raw request body      |
| `X-GitHub-Event`           | Event name — we only act on `push`               |
| `X-GitHub-Delivery`        | A UUID, unique per delivery, **stable on retry**  |

## Signature verification
1. Compute `hmac = HMAC_SHA256(secret=GITHUB_WEBHOOK_SECRET, message=rawBody)`.
2. Compare `"sha256=" + hex(hmac)` to `X-Hub-Signature-256` using a
   constant-time comparison (`crypto.timingSafeEqual`), never `===`.
3. Reject with `401` on mismatch, missing header, or missing raw body.
   The raw body MUST be captured before any body-parsing middleware
   touches it — parsing and re-serializing JSON does not reproduce the
   exact bytes GitHub signed.

## Idempotency
GitHub redelivers events (automatically on some failures, and manually
from the "Recent Deliveries" page). `X-GitHub-Delivery` is the same UUID
on every redelivery of the same event, so it is the idempotency key.

Each delivery ID moves through a small lifecycle in `processed_deliveries`:

| Step | When | Row |
|------|------|-----|
| claim | right after the signature check | inserted with `status = 'processing'` |
| complete | filtered, or summary + email succeeded | `status = 'done'` |
| release | background processing failed | row deleted, so a redelivery can retry |

The claim is a single `INSERT … ON CONFLICT` — the insert itself is the
lock, so two concurrent copies of one delivery can't both win. A losing
or repeated delivery gets `200 {"status":"duplicate"}`. A `processing`
claim older than 10 minutes is treated as abandoned (the process died
mid-delivery) and can be re-claimed.

## Response timing
Relay replies `202 {"status":"accepted"}` as soon as a delivery is claimed
and matched to a client, then summarizes and emails in the background.
GitHub only needs to know the delivery was accepted; waiting for Claude
and Resend inside the request risks GitHub's delivery timeout.

## Payload (subset we depend on)
We only read these fields from the `push` event body — everything else
in GitHub's payload is ignored and MUST NOT be depended on elsewhere:

```json
{
  "ref": "refs/heads/main",
  "repository": { "full_name": "owner/repo" },
  "pusher": { "name": "octocat" },
  "commits": [
    {
      "id": "a1b2c3d",
      "message": "Fix off-by-one in pagination",
      "url": "https://github.com/owner/repo/commit/a1b2c3d",
      "author": { "name": "octocat" }
    }
  ]
}
```

## Filtering
These are accepted with `200 {"status":"filtered"}` and never summarized
or emailed — a deliberate no-op, not an error:

- any event other than `push`
- refs that aren't branches (`refs/tags/...`)
- branches other than `ONLY_BRANCH`, when it is set (exact match on the
  branch name, so `feature/main` is not `main`)
- branch deletions (`"deleted": true`) and pushes with no commits
- repos with no client mapped
