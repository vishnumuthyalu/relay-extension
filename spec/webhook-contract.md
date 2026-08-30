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
GitHub retries deliveries that time out or 5xx. `X-GitHub-Delivery` is
the same UUID on every retry of the same event, so it is the natural
idempotency key: before processing, check whether that delivery ID is
already recorded; if so, return `200` without re-summarizing or
re-emailing.

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
If `ONLY_BRANCH` is set, pushes whose `ref` doesn't end in
`/<ONLY_BRANCH>` are accepted (`200`) but not summarized or emailed —
this is a deliberate no-op, not an error.