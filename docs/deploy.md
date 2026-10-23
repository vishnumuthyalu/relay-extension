# Deploying and releasing Relay

Relay ships as one Docker image that runs as two processes: `web` (webhooks,
`/mcp`, OAuth, dashboard, API) and `worker` (digests). It needs one Postgres
database. These steps use [Fly.io](https://fly.io) with `fly.toml` from this
repo. Any host that runs a Docker image as two processes, with managed
Postgres, works the same way.

## 1. First deploy

```bash
fly launch --no-deploy --copy-config        # creates the app from fly.toml; pick your own app name
fly postgres create                         # or attach any managed Postgres
fly postgres attach <db-app-name>           # sets DATABASE_URL as a secret
fly secrets set \
  PUBLIC_URL=https://relay.example.com \
  SESSION_SECRET=$(openssl rand -hex 32) \
  GITHUB_APP_SLUG=... GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... GITHUB_WEBHOOK_SECRET=... \
  ANTHROPIC_API_KEY=... RESEND_API_KEY=... FROM_EMAIL=digests@yourdomain.com \
  DIGEST_MONTHLY_CAP=100
fly deploy                                  # runs migrations (release_command), then web + worker
fly scale count web=1 worker=1
```

Optional secrets: `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` for pull
request context, and `INTEGRATIONS_KEY` for ticket trackers
([summaries.md](summaries.md)).

## 2. Domain

Point `relay.example.com` at the app (`fly certs add relay.example.com`),
then use that URL everywhere it appears:

| Where | Value |
|-------|-------|
| `PUBLIC_URL` secret | `https://relay.example.com` |
| GitHub App → Homepage, Callback, Webhook URLs | `…`, `…/auth/callback`, `…/webhook/github` |
| `server.json` → `remotes[0].url` | `https://relay.example.com/mcp` |

The MCP canonical URI, OAuth issuer and token audience all derive from
`PUBLIC_URL`, so pick the domain once. Changing it later invalidates every
MCP client's tokens.

## 3. Releases

| Tag | What happens |
|-----|--------------|
| `v1.2.3` | `deploy.yml` runs CI, deploys with `flyctl deploy` (migrations first), creates a GitHub Release with generated notes, then `mcp-registry.yml` publishes `server.json` at version `1.2.3` |
| `ext-v1.2.3` | `extension.yml` packages the VS Code extension and publishes the same `.vsix` to the Visual Studio Marketplace and Open VSX |

Repository secrets: `FLY_API_TOKEN` (`fly tokens create deploy`), `VSCE_PAT`
(Visual Studio Marketplace publisher token) and `OVSX_PAT` (open-vsx.org
token). The MCP Registry needs no secret: the workflow proves ownership of
`io.github.vishnumuthyalu/*` with GitHub's OIDC token.

Before the first extension release, create the publisher `vishnumuthyalu` on
the Visual Studio Marketplace, and create the namespace on Open VSX
(`npx ovsx create-namespace vishnumuthyalu`). Follow each site's current
publishing docs for the token steps.

## 4. Operations

- **Health**: `/health` (process up) and `/ready` (Postgres reachable; Fly
  routes traffic only to ready machines).
- **Logs**: both processes log JSON with pino (`fly logs`).
- **Backups**: enable daily backups or snapshots on the Postgres you use.
- **Error tracking**: add Sentry or similar to both processes if you want
  alerts. Its free tier is enough to start.
- **Spend**: set a monthly spend limit in the Anthropic Console as a hard
  backstop above `DIGEST_MONTHLY_CAP`.

## 5. Going public

- In the GitHub App settings, allow installs on **any account** and add a
  description, logo and homepage. Link `https://relay.example.com/privacy`
  as the privacy policy.
- Verify your sending domain in Resend (SPF, DKIM, DMARC) before real
  clients receive mail.
- Do the pre-launch hardening in
  [ADR 005](adr/005-separate-authorization-server.md) and
  [summaries.md](summaries.md): resolve DNS before fetching client metadata
  or tracker URLs, and refuse private addresses.