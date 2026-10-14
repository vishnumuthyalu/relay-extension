const express = require('express');
const cors = require('cors');
const { createMcpHandler, OAuthError, OAuthErrorCode } = require('@modelcontextprotocol/server');
const { requireBearerAuth, getOAuthProtectedResourceMetadataUrl, hostHeaderValidation } = require('@modelcontextprotocol/express');
const { toNodeHandler } = require('@modelcontextprotocol/node');
const { createRelayMcpServer, forUser } = require('../mcp/server');

// The remote MCP endpoint: https://<host>/mcp over Streamable HTTP.
//
// - Stateless: every request builds a fresh McpServer for the token's
//   user, so any number of web instances can serve it.
// - Every request needs a Bearer token issued by Relay's own authorization
//   server (routes/oauth.js) for exactly this URL (RFC 8707 audience).
//   Unauthenticated requests get 401 + WWW-Authenticate pointing at the
//   protected resource metadata, which is how clients find the sign-in.
function createMcpRouter({ pool, pipeline, config, tokens, github, log = console }) {
  const router = express.Router();
  const resourceUrl = new URL(`${config.publicUrl}/mcp`);
  const resource = resourceUrl.href;
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);

  const verifier = {
    async verifyAccessToken(token) {
      const claims = tokens.verifyAccessToken(token, { resource });
      if (!claims) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid or expired access token');
      return {
        token,
        clientId: claims.client_id,
        scopes: claims.scope ? claims.scope.split(' ') : [],
        expiresAt: claims.exp,
        resource: new URL(claims.aud),
        extra: { githubUserId: Number(claims.sub) },
      };
    },
  };

  const handler = createMcpHandler(
    (ctx) => createRelayMcpServer(forUser({
      pool,
      pipeline,
      config,
      installUrl: github.installUrl,
      githubUserId: ctx.authInfo.extra.githubUserId,
    })),
    { onerror: (err) => log.error?.({ err }, 'mcp handler error') }
  );

  router.use(
    '/mcp',
    // Rejects requests whose Host isn't ours (DNS-rebinding protection).
    hostHeaderValidation([resourceUrl.hostname]),
    // Browser-based clients need CORS, and must be able to read the auth
    // challenge and the MCP headers.
    cors({
      origin: '*',
      exposedHeaders: ['WWW-Authenticate', 'Mcp-Session-Id', 'Mcp-Protocol-Version'],
      allowedHeaders: ['Authorization', 'Content-Type', 'Mcp-Session-Id', 'Mcp-Protocol-Version', 'Last-Event-ID'],
    }),
    requireBearerAuth({ verifier, resourceMetadataUrl }),
    toNodeHandler(handler)
  );

  return { router, close: () => handler.close() };
}

module.exports = { createMcpRouter };
