# GitHub Webhook Contract

## Delivery
Relay is a GitHub App. GitHub sends every event for every installation to
`POST /webhook/github`. Three headers are load-bearing:

| Header                    | Meaning                                          |
|----------------------------|--------------------------------------------------|
| `X-Hub-Signature-256`      | `sha256=<hex hmac>` of the raw request body      |
| `X-GitHub-Event`           | Event name: Relay acts on `push` and `installation` |
| `X-GitHub-Delivery`        | Unique per delivery, **stable on redelivery**    |

Push payloads must match [`push-event.schema.json`](push-event.schema.json),
which lists the subset of GitHub's payload Relay depends on. Relay must not
depend on any other field.

## Signature verification
1. Compute `hmac = HMAC_SHA256(secret=GITHUB_WEBHOOK_SECRET, message=rawBody)`.
2. Compare `"sha256=" + hex(hmac)` to `X-Hub-Signature-256` using a
   constant-time comparison (`crypto.timingSafeEqual`), never `===`.
3. Reject with `401` on mismatch, missing header, or missing raw body.
   The raw body MUST be captured before any body-parsing middleware
   touches it. Parsing and re-serializing JSON does not reproduce the
   exact bytes GitHub signed.

Verification happens before any other code reads the body, so unsigned
requests never see validation errors.

## Installation events
| `action` | Effect |
|----------|--------|
| `created` | Upsert the installation; the sender becomes a member who can manage it |
| `deleted` | Delete the installation and, by cascade, all of its mappings, deliveries, digests and usage |
| `suspend` / `unsuspend` | Set or clear `suspended_at`; pushes for a suspended installation are filtered |

Replies `200 {"status":"handled"}`. `ping`, `installation_repositories` and
other events get `200 {"status":"filtered"}`.

## Idempotency
GitHub redelivers events (automatically on some failures, and manually
from the "Recent Deliveries" page). `X-GitHub-Delivery` is the same on
every redelivery of the same event, so it is the idempotency key.

Each push delivery moves through a lifecycle in the `deliveries` table:

| Step | When | Row |
|------|------|-----|
| claim | right after the signature check | inserted with `status = 'processing'` |
| complete | filtered, or the worker sent the digest | `status = 'done'`, `outcome` records why |
| release | enqueueing failed, or the worker's final retry failed | row deleted, so a redelivery can retry |

The claim is a single `INSERT … ON CONFLICT`, so the insert itself is the
lock and two concurrent copies of one delivery can't both win. A losing
or repeated delivery gets `200 {"status":"duplicate"}`. A `processing`
claim older than 30 minutes (longer than the queue's whole retry window)
is treated as abandoned and can be re-claimed.

The worker also checks `digests` before sending. If a digest already
exists for the delivery (the email went out but a later step failed), it
completes the delivery without sending again.

## Response timing
Relay replies `202 {"status":"accepted"}` once a push is claimed, matched
to an active mapping and enqueued. The worker process sends the digest.
GitHub only needs to know the delivery was accepted, and waiting for
Claude and Resend inside the request would risk GitHub's delivery timeout.

## Filtering
These pushes are accepted with `200 {"status":"filtered"}` and never
summarized or emailed. This is a deliberate no-op, not an error:

- deliveries without `installation.id` (not from the GitHub App)
- a suspended installation
- refs that aren't branches (`refs/tags/...`)
- branch deletions (`"deleted": true`) and pushes with no commits
- repos with no client mapped, or whose client hasn't confirmed or has
  unsubscribed
- branches other than the mapping's `branch`, or the repository's
  `default_branch` when the mapping doesn't set one

A push for an installation Relay hasn't seen (its `created` event was
missed) creates the installation from the push payload, then filters as
above.