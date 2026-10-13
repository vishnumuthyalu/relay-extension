const fs = require('fs');
const path = require('path');
const { Client } = require('@modelcontextprotocol/client');
const { InMemoryTransport } = require('@modelcontextprotocol/server');
const { createRelayMcpServer } = require('../mcp/server');
const { createLocalService } = require('../mcp/service');
const { createPipeline } = require('../lib/pipeline');
const { openDb, recordDigest } = require('../lib/db');

const summary = {
  headline: 'Checkout now remembers saved cards',
  summary: 'Returning customers can pay with a saved card in one tap.',
  highlights: ['Saved cards at checkout'],
  risk_notes: null,
};

// A real McpServer and Client wired together in memory, with Claude and
// Resend replaced by mocks so nothing leaves the test.
async function connect() {
  const db = openDb(':memory:');
  const summarize = jest.fn().mockResolvedValue(summary);
  const send = jest.fn().mockResolvedValue({ id: 'email_1' });
  const pipeline = createPipeline({
    env: { ANTHROPIC_API_KEY: 'k', RESEND_API_KEY: 'k', FROM_EMAIL: 'relay@example.com' },
    summarize,
    send,
  });
  const server = createRelayMcpServer(createLocalService({ db, pipeline }));
  const client = new Client({ name: 'relay-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { db, client, server, summarize, send };
}

describe('Relay MCP server', () => {
  let ctx;
  beforeEach(async () => { ctx = await connect(); });
  afterEach(async () => { await ctx.client.close(); await ctx.server.close(); });

  test('lists the seven tools with annotations', async () => {
    const { tools } = await ctx.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'list_client_mappings', 'list_recent_digests', 'preview_digest', 'remove_client_mapping',
      'resend_digest', 'send_test_digest', 'set_client_mapping',
    ]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.remove_client_mapping.annotations.destructiveHint).toBe(true);
    expect(byName.list_client_mappings.annotations.readOnlyHint).toBe(true);
    expect(byName.set_client_mapping.outputSchema).toBeDefined();
  });

  test('matches the tool table in spec/mcp-tools.md', async () => {
    const spec = fs.readFileSync(path.join(__dirname, '..', 'spec', 'mcp-tools.md'), 'utf8');
    const documented = [...spec.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]).sort();
    const { tools } = await ctx.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(documented);
  });

  test('maps, lists and removes a repo', async () => {
    const set = await ctx.client.callTool({
      name: 'set_client_mapping',
      arguments: { repo: 'acme/site', clientName: 'Acme', clientEmail: 'jane@acme.test' },
    });
    expect(set.structuredContent).toMatchObject({ repo: 'acme/site', clientEmail: 'jane@acme.test' });

    const list = await ctx.client.callTool({ name: 'list_client_mappings', arguments: {} });
    expect(list.structuredContent.mappings).toHaveLength(1);

    const removed = await ctx.client.callTool({ name: 'remove_client_mapping', arguments: { repo: 'acme/site' } });
    expect(removed.structuredContent).toEqual({ repo: 'acme/site', removed: true });
  });

  test('rejects a malformed repo name', async () => {
    const res = await ctx.client.callTool({
      name: 'set_client_mapping',
      arguments: { repo: 'not a repo', clientName: 'Acme', clientEmail: 'jane@acme.test' },
    });
    expect(res.isError).toBe(true);
  });

  test('previews a digest without sending email', async () => {
    const res = await ctx.client.callTool({
      name: 'preview_digest',
      arguments: { repo: 'acme/site', commits: [{ message: 'feat: saved cards', author: 'jane' }] },
    });
    expect(res.structuredContent).toEqual(summary);
    expect(ctx.summarize).toHaveBeenCalledWith(expect.objectContaining({
      repo: 'acme/site',
      commits: [{ message: 'feat: saved cards', author: { name: 'jane' } }],
    }));
    expect(ctx.send).not.toHaveBeenCalled();
  });

  test('send_test_digest explains an unmapped repo instead of failing', async () => {
    const res = await ctx.client.callTool({ name: 'send_test_digest', arguments: { repo: 'acme/site' } });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/set_client_mapping/);
    expect(ctx.send).not.toHaveBeenCalled();
  });

  test('lists and resends stored digests', async () => {
    await ctx.client.callTool({
      name: 'set_client_mapping',
      arguments: { repo: 'acme/site', clientName: 'Acme', clientEmail: 'jane@acme.test' },
    });
    recordDigest(ctx.db, {
      deliveryId: 'd-1', repo: 'acme/site', recipient: 'old@acme.test', summary, commitCount: 3, model: 'claude-haiku-4-5',
    });

    const list = await ctx.client.callTool({ name: 'list_recent_digests', arguments: { repo: 'acme/site' } });
    expect(list.structuredContent.digests).toEqual([
      expect.objectContaining({ deliveryId: 'd-1', headline: summary.headline, commitCount: 3 }),
    ]);

    const resent = await ctx.client.callTool({ name: 'resend_digest', arguments: { deliveryId: 'd-1' } });
    expect(resent.structuredContent).toEqual({ deliveryId: 'd-1', sentTo: 'jane@acme.test' });
    expect(ctx.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'jane@acme.test', subject: summary.headline }));
  });

  test('exposes mappings, digests and the summary schema as resources', async () => {
    recordDigest(ctx.db, {
      deliveryId: 'd-2', repo: 'acme/site', recipient: 'jane@acme.test', summary, commitCount: 1, model: 'claude-haiku-4-5',
    });
    const { resources } = await ctx.client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toEqual(expect.arrayContaining(['relay://clients', 'relay://schema/summary', 'relay://digests/d-2']));

    const digest = await ctx.client.readResource({ uri: 'relay://digests/d-2' });
    expect(JSON.parse(digest.contents[0].text)).toMatchObject({ deliveryId: 'd-2', summary });

    const schema = await ctx.client.readResource({ uri: 'relay://schema/summary' });
    expect(JSON.parse(schema.contents[0].text).title).toBe('CommitDigestSummary');
  });
});