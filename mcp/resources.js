const { ResourceTemplate } = require('@modelcontextprotocol/server');
const summarySchema = require('../spec/summary.schema.json');

function json(uri, value) {
  return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(value, null, 2) }] };
}

function registerRelayResources(server, svc) {
  server.registerResource(
    'client-mappings',
    'relay://clients',
    {
      title: 'Client mappings',
      description: 'Every watched repository and the client who receives its digests',
      mimeType: 'application/json',
    },
    async (uri) => json(uri, await svc.listMappings())
  );

  server.registerResource(
    'digest',
    new ResourceTemplate('relay://digests/{deliveryId}', {
      // Lets clients browse the 50 most recent digests as resources.
      list: async () => ({
        resources: (await svc.listDigests({ limit: 50 })).map((d) => ({
          uri: `relay://digests/${d.deliveryId}`,
          name: d.headline,
          description: `${d.repo} → ${d.recipient} at ${d.sentAt}`,
          mimeType: 'application/json',
        })),
      }),
    }),
    {
      title: 'Sent digest',
      description: 'One digest Relay emailed, with the full summary',
      mimeType: 'application/json',
    },
    async (uri, { deliveryId }) => json(uri, await svc.getDigest({ deliveryId: String(deliveryId) }))
  );

  server.registerResource(
    'summary-schema',
    'relay://schema/summary',
    {
      title: 'Digest summary schema',
      description: 'JSON Schema every Claude-written digest must satisfy',
      mimeType: 'application/schema+json',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/schema+json', text: JSON.stringify(summarySchema, null, 2) }],
    })
  );
}

module.exports = { registerRelayResources };