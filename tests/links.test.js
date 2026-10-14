const { createLinks } = require('../lib/links');

describe('signed email links', () => {
  let now = Date.parse('2026-10-01T00:00:00Z');
  const links = createLinks({ secret: 's'.repeat(40), publicUrl: 'https://relay.test', now: () => now });
  const target = { installationId: 7, repo: 'acme/site', email: 'jane@acme.test' };
  const tokenOf = (url) => new URL(url).searchParams.get('token');

  test('round-trips a confirm and an unsubscribe link', () => {
    expect(links.verifyConfirm(tokenOf(links.confirmUrl(target)))).toEqual(target);
    expect(links.verifyUnsubscribe(tokenOf(links.unsubscribeUrl(target)))).toEqual(target);
  });

  test('a link for one purpose is rejected for the other', () => {
    expect(links.verifyUnsubscribe(tokenOf(links.confirmUrl(target)))).toBeNull();
    expect(links.verifyConfirm(tokenOf(links.unsubscribeUrl(target)))).toBeNull();
  });

  test('an edited token is rejected', () => {
    const [body, mac] = tokenOf(links.unsubscribeUrl(target)).split('.');
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    const forged = Buffer.from(JSON.stringify({ ...payload, i: 8 })).toString('base64url');
    expect(links.verifyUnsubscribe(`${forged}.${mac}`)).toBeNull();
    expect(links.verifyUnsubscribe('garbage')).toBeNull();
    expect(links.verifyUnsubscribe(undefined)).toBeNull();
  });

  test('a token signed with another secret is rejected', () => {
    const other = createLinks({ secret: 'o'.repeat(40), publicUrl: 'https://relay.test' });
    expect(links.verifyUnsubscribe(tokenOf(other.unsubscribeUrl(target)))).toBeNull();
  });

  test('confirm links expire after 7 days; unsubscribe links do not', () => {
    const confirm = tokenOf(links.confirmUrl(target));
    const unsubscribe = tokenOf(links.unsubscribeUrl(target));
    now += 8 * 24 * 60 * 60 * 1000;
    expect(links.verifyConfirm(confirm)).toBeNull();
    expect(links.verifyUnsubscribe(unsubscribe)).toEqual(target);
  });
});