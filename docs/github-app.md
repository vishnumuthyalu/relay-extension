# Registering the Relay GitHub App

Relay runs as a GitHub App. Installing the app is what connects a user's or
organization's repositories to Relay. Nobody creates webhooks or personal
access tokens by hand.

## 1. Create the app

GitHub → **Settings → Developer settings → GitHub Apps → New GitHub App**
(or the same page under an organization's settings).

| Field | Value |
|-------|-------|
| GitHub App name | e.g. `Relay Digests` (its URL slug becomes `GITHUB_APP_SLUG`) |
| Homepage URL | `PUBLIC_URL` |
| Callback URL | `PUBLIC_URL/auth/callback` |
| Request user authorization (OAuth) during installation | **Off** |
| Setup URL | `PUBLIC_URL/auth/login?returnTo=/dashboard` (tick **Redirect on update**) |
| Webhook → Active | **On** |
| Webhook URL | `PUBLIC_URL/webhook/github` |
| Webhook secret | a random string → `GITHUB_WEBHOOK_SECRET` |
| Where can this app be installed? | Only on this account while developing; Any account at launch |

## 2. Permissions and events

| Permission | Access | Why |
|------------|--------|-----|
| Repository → Contents | Read-only | Required to receive `push` events, and for change stats |
| Repository → Metadata | Read-only | Always on |
| Repository → Pull requests | Read-only | Optional: pull request context in summaries ([summaries.md](summaries.md)) |

Subscribe to the **Push** event. GitHub always sends `installation` events to
apps; Relay uses them to add, suspend and remove tenants.

Relay asks for nothing else. Adding a permission later prompts existing
installations to approve the change.

## 3. Credentials → environment

| From the app page | Env var |
|-------------------|---------|
| The slug in `github.com/apps/<slug>` | `GITHUB_APP_SLUG` |
| Client ID | `GITHUB_CLIENT_ID` |
| Generate a new client secret | `GITHUB_CLIENT_SECRET` |
| Webhook secret you chose | `GITHUB_WEBHOOK_SECRET` |
| App ID (optional, for pull request context) | `GITHUB_APP_ID` |
| Generate a private key (optional, same) | `GITHUB_APP_PRIVATE_KEY` (the PEM; `\n` for line breaks is fine) |

Keep them in `.env` locally and in your host's secret store in production.
Never commit them.

## 4. Local development

GitHub has to reach your machine, so run a tunnel (`ngrok http 3000`) and use
its URL as `PUBLIC_URL`, the webhook URL and the callback URL. Use a
separate development app, so changing those URLs never touches production.

## What Relay stores, and deleting it

- An installation row (id, account login and type) and which GitHub users may
  manage it, refreshed on every sign-in.
- Client mappings (repository, client name and email, confirmation and
  unsubscribe state), sent digests, delivery ids and monthly usage counts.
- If a tenant connects a ticket tracker: its MCP URL, allowed tool names and
  an encrypted access token.
- Relay does **not** store GitHub tokens or source code. Installation tokens
  for pull request context live in memory for under an hour.

Uninstalling the app sends an `installation.deleted` event, and Relay
deletes everything above for that installation.