const { z } = require('zod');
const { RelayError } = require('../lib/service');

const repoSchema = z
  .string()
  .regex(/^[\w.-]+\/[\w.-]+$/, 'Use the owner/repo form, e.g. acme/website')
  .describe('GitHub repository as owner/repo');

const mappingSchema = z.object({
  repo: z.string(),
  clientName: z.string(),
  clientEmail: z.string(),
  branch: z.string().nullable(),
  status: z.enum(['pending', 'active', 'unsubscribed']).describe('pending until the client confirms by email'),
  updatedAt: z.string(),
});

const summarySchema = z.object({
  headline: z.string(),
  summary: z.string(),
  highlights: z.array(z.string()),
  risk_notes: z.string().nullable(),
});

const digestListItemSchema = z.object({
  deliveryId: z.string(),
  repo: z.string(),
  recipient: z.string(),
  headline: z.string(),
  commitCount: z.number().int(),
  sentAt: z.string(),
});

// Every tool returns its data twice: as structuredContent (validated
// against outputSchema, for clients that read JSON) and as one line of
// text (for clients and models that only read text).
function ok(text, structuredContent) {
  return { content: [{ type: 'text', text }], structuredContent };
}

// Wraps a handler so expected problems come back as a tool error the
// model can read and correct, rather than a protocol-level failure.
function handle(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof RelayError || err?.name === 'SummaryError') {
        return { isError: true, content: [{ type: 'text', text: err.message }] };
      }
      throw err;
    }
  };
}

function registerRelayTools(server, svc) {
  server.registerTool('list_client_mappings', {
    title: 'List client mappings',
    description: 'List every repository Relay watches and the client who receives its digests.',
    outputSchema: z.object({ mappings: z.array(mappingSchema) }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, handle(async () => {
    const mappings = await svc.listMappings();
    const text = mappings.length
      ? mappings.map((m) => `${m.repo} → ${m.clientName} <${m.clientEmail}> (${m.status})`).join('\n')
      : 'No repositories are mapped yet.';
    return ok(text, { mappings });
  }));

  server.registerTool('set_client_mapping', {
    title: 'Map a repo to a client',
    description:
      'Create or update which client receives digests for a repository. A new or changed address ' +
      'gets a confirmation email, and digests start only after the client confirms.',
    inputSchema: z.object({
      repo: repoSchema,
      clientName: z.string().min(1).max(120).describe('How the client is greeted in the email'),
      clientEmail: z.email().describe('Where digests are sent'),
      branch: z.string().min(1).optional().describe("Branch to watch; defaults to the repo's default branch"),
    }),
    outputSchema: mappingSchema.extend({ confirmationSent: z.boolean() }),
    // Sends a confirmation email when the address is new.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, handle(async (args) => {
    const mapping = await svc.setMapping({ ...args, branch: args.branch ?? null });
    const note = mapping.confirmationSent
      ? ` A confirmation email went to ${mapping.clientEmail}; digests start once they confirm.`
      : '';
    return ok(`Mapped ${mapping.repo} → ${mapping.clientName} <${mapping.clientEmail}> (${mapping.status}).${note}`, mapping);
  }));

  server.registerTool('remove_client_mapping', {
    title: 'Remove a client mapping',
    description: 'Stop sending digests for a repository. Its digest history is kept.',
    inputSchema: z.object({ repo: repoSchema }),
    outputSchema: z.object({ repo: z.string(), removed: z.boolean() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, handle(async ({ repo }) => {
    const result = await svc.removeMapping({ repo });
    return ok(result.removed ? `Removed the mapping for ${repo}.` : `${repo} was not mapped.`, result);
  }));

  server.registerTool('preview_digest', {
    title: 'Preview a digest',
    description:
      'Summarize a list of commit messages exactly as Relay would for the client, without sending anything. ' +
      'Use it to check tone before real pushes go out.',
    inputSchema: z.object({
      repo: repoSchema,
      commits: z
        .array(z.object({
          message: z.string().min(1).describe('Commit message; only the first line is used'),
          author: z.string().optional().describe('Commit author name'),
        }))
        .min(1)
        .max(200),
    }),
    outputSchema: summarySchema,
    // Calls Claude, but changes nothing in Relay or the outside world.
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, handle(async ({ repo, commits }) => {
    const summary = await svc.previewDigest({
      repo,
      commits: commits.map((c) => ({ message: c.message, author: c.author ? { name: c.author } : undefined })),
    });
    const bullets = summary.highlights.map((h) => `• ${h}`).join('\n');
    return ok(`${summary.headline}\n\n${summary.summary}\n\n${bullets}`, summary);
  }));

  server.registerTool('send_test_digest', {
    title: 'Send a test digest',
    description: "Email a sample digest to the repository's confirmed client to check delivery works.",
    inputSchema: z.object({ repo: repoSchema }),
    outputSchema: z.object({ repo: z.string(), sentTo: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, handle(async ({ repo }) => {
    const result = await svc.sendTestDigest({ repo });
    return ok(`Test digest for ${repo} sent to ${result.sentTo}.`, result);
  }));

  server.registerTool('list_recent_digests', {
    title: 'List recent digests',
    description: 'Show digests Relay has emailed, newest first, optionally for one repository.',
    inputSchema: z.object({
      repo: repoSchema.optional(),
      limit: z.number().int().min(1).max(50).default(10),
    }),
    outputSchema: z.object({ digests: z.array(digestListItemSchema) }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, handle(async ({ repo, limit }) => {
    const digests = (await svc.listDigests({ repo, limit })).map((d) => ({
      deliveryId: d.deliveryId,
      repo: d.repo,
      recipient: d.recipient,
      headline: d.headline,
      commitCount: d.commitCount,
      sentAt: d.sentAt,
    }));
    const text = digests.length
      ? digests.map((d) => `${d.sentAt}  ${d.repo}  "${d.headline}" → ${d.recipient}  [${d.deliveryId}]`).join('\n')
      : 'No digests have been sent yet.';
    return ok(text, { digests });
  }));

  server.registerTool('resend_digest', {
    title: 'Resend a digest',
    description: "Email a previously sent digest again, to the repository's current client.",
    inputSchema: z.object({ deliveryId: z.string().min(1).describe('From list_recent_digests') }),
    outputSchema: z.object({ deliveryId: z.string(), sentTo: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, handle(async ({ deliveryId }) => {
    const result = await svc.resendDigest({ deliveryId });
    return ok(`Digest ${deliveryId} re-sent to ${result.sentTo}.`, result);
  }));
}

module.exports = { registerRelayTools };