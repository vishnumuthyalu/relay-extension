const fs = require('fs');
const path = require('path');
const { Client } = require('@modelcontextprotocol/client');
const { InMemoryTransport } = require('@modelcontextprotocol/server');
const { createRelayMcpServer } = require('../mcp/server');

const { createRelayService } = require('../lib/service');
const db = require('../lib/db');
const { createTestDb } = require('./helpers/db');
const { testConfig, testPipeline, goodSummary: summary } = require('./helpers/fixtures');

let testDb, pool;
beforeAll(async () => { testDb = await createTestDb(); pool = testDb.pool; });
afterAll(() => testDb.destroy());

let nextId = 3000;

// A real McpServer and Client wired together in memory for a fresh
// installation, with Claude and Resend replaced by mocks.

async function connect() {
  
  const config = testConfig();
  const installationId = nextId++;
  await db.upsertInstallation(pool, { id: installationId, accountLogin: 'acme', accountType: 'Organization' });
  const installation = await db.getInstallation(pool, installationId);
  const { pipeline, summarize, send } = testPipeline(config);
  const server = createRelayMcpServer(createRelayService({ pool, pipeline, config, installation }));

  const client = new Client({ name: 'relay-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { installationId, client, server, summarize, send };
}

const map = (ctx, repo = 'acme/site', clientEmail = 'jane@acme.test') =>
  ctx.client.callTool({ name: 'set_client_mapping', arguments: { repo, clientName: 'Jane', clientEmail } });


describe('Relay MCP server', () => {
  let ctx;
  beforeEach(async () => { ctx = await connect(); });
  afterEach(async () => { await ctx.client.close(); await ctx.server.close(); });

  test('lists the seven tools with annotations', async () => {
    const { tools } = await ctx.client.listTools();
    


    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName)).toHaveLength(7);
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

  test('mapping a repo sends a confirmation and lists it as pending', async () => {
    const set = await map(ctx);
    expect(set.structuredContent).toMatchObject({ repo: 'acme/site', status: 'pending', confirmationSent: true });
    expect(set.content[0].text).toMatch(/confirmation email/);
    expect(ctx.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'jane@acme.test' }));

    const list = await ctx.client.callTool({ name: 'list_client_mappings', arguments: {} });
    expect(list.structuredContent.mappings).toEqual([expect.objectContaining({ repo: 'acme/site', status: 'pending' })]);

    const removed = await ctx.client.callTool({ name: 'remove_client_mapping', arguments: { repo: 'acme/site' } });
    expect(removed.structuredContent).toEqual({ repo: 'acme/site', removed: true });
  });

  test('rejects a malformed repo name', async () => {
    const res = await map(ctx, 'not a repo');
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

  test('explains why a test digest cannot go out yet', async () => {
    const unmapped = await ctx.client.callTool({ name: 'send_test_digest', arguments: { repo: 'acme/site' } });
    expect(unmapped.isError).toBe(true);
    expect(unmapped.content[0].text).toMatch(/set_client_mapping/);

    await map(ctx);
    const pending = await ctx.client.callTool({ name: 'send_test_digest', arguments: { repo: 'acme/site' } });
    expect(pending.isError).toBe(true);
    expect(pending.content[0].text).toMatch(/hasn't confirmed/);
  });

  test('lists and resends stored digests', async () => {
    await map(ctx);
    await db.confirmMapping(pool, ctx.installationId, 'acme/site', 'jane@acme.test');
    await db.recordDigest(pool, ctx.installationId, {
      deliveryId: `d-${ctx.installationId}`, repo: 'acme/site', recipient: 'jane@acme.test',
      summary, commitCount: 3, model: 'claude-haiku-4-5', kind: 'ai',
    });

    const list = await ctx.client.callTool({ name: 'list_recent_digests', arguments: { repo: 'acme/site' } });
    expect(list.structuredContent.digests).toEqual([
      expect.objectContaining({ deliveryId: `d-${ctx.installationId}`, headline: summary.headline, commitCount: 3 }),
    ]);

    ctx.send.mockClear();
    const resent = await ctx.client.callTool({ name: 'resend_digest', arguments: { deliveryId: `d-${ctx.installationId}` } });
    expect(resent.structuredContent).toEqual({ deliveryId: `d-${ctx.installationId}`, sentTo: 'jane@acme.test' });
    expect(ctx.send).toHaveBeenCalledWith(expect.objectContaining({ subject: summary.headline }));
  });

  test('exposes mappings, digests and the summary schema as resources', async () => {
    await db.recordDigest(pool, ctx.installationId, {
      deliveryId: `r-${ctx.installationId}`, repo: 'acme/site', recipient: 'jane@acme.test',
      summary, commitCount: 1, model: 'claude-haiku-4-5', kind: 'ai',
    });
    const { resources } = await ctx.client.listResources();

    expect(resources.map((r) => r.uri)).toEqual(expect.arrayContaining([
      'relay://clients', 'relay://schema/summary', `relay://digests/r-${ctx.installationId}`,
    ]));

    const digest = await ctx.client.readResource({ uri: `relay://digests/r-${ctx.installationId}` });
    expect(JSON.parse(digest.contents[0].text)).toMatchObject({ summary });

    const schema = await ctx.client.readResource({ uri: 'relay://schema/summary' });
    expect(JSON.parse(schema.contents[0].text).title).toBe('CommitDigestSummary');
  });
});