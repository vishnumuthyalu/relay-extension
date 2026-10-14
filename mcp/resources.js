const { ResourceTemplate } = require('@modelcontextprotocol/server');
const summarySchema = require('../spec/summary.schema.json');

function json(uri, value, mimeType = 'application/json') {
  return { contents: [{ uri: uri.href, mimeType, text: JSON.stringify(value, null, 2) }] };
}

// Resources are addressed per account, so someone who manages several
// GitHub accounts can browse each one: relay://accounts/{account}/...
function registerRelayResources(server, relay) {
  server.registerResource(
    'client-mappings',
    new ResourceTemplate('relay://accounts/{account}/clients', {
      list: async () => ({
        resources: (await relay.listAccounts()).map((a) => ({
          uri: `relay://accounts/${a.account}/clients`,
          name: `${a.account}: client mappings`,
          mimeType: 'application/json',
        })),
      }),
    }),
    {
      title: 'Client mappings',
      description: 'Every watched repository in one account and the client who receives its digests',
      mimeType: 'application/json',
    },
    async (uri, { account }) => json(uri, await (await relay.resolve(String(account))).listMappings())
  );

  server.registerResource(
    'digest',
    new ResourceTemplate('relay://accounts/{account}/digests/{deliveryId}', {
      // The 20 most recent digests of each account.
      list: async () => {
        const resources = [];
        for (const a of await relay.listAccounts()) {
          const svc = await relay.resolve(a.account);
          for (const d of await svc.listDigests({ limit: 20 })) {
            resources.push({
              uri: `relay://accounts/${a.account}/digests/${d.deliveryId}`,
              name: d.headline,
              description: `${d.repo} → ${d.recipient} at ${d.sentAt}`,
              mimeType: 'application/json',
            });
          }
        }
        return { resources };
      },
    }),
    {
      title: 'Sent digest',
      description: 'One digest Relay emailed, with the full summary',
      mimeType: 'application/json',
    },
    async (uri, { account, deliveryId }) =>
      json(uri, await (await relay.resolve(String(account))).getDigest({ deliveryId: String(deliveryId) }))
  );

  server.registerResource(
    'summary-schema',
    'relay://schema/summary',
    {
      title: 'Digest summary schema',
      description: 'JSON Schema every Claude-written digest must satisfy',
      mimeType: 'application/schema+json',
    },
    async (uri) => json(uri, summarySchema, 'application/schema+json')
  );
}

module.exports = { registerRelayResources };
