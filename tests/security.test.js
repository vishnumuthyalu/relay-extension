const crypto = require('crypto');
const { verifyGithubSignature, requireConfigKey } = require('../lib/security');

describe('verifyGithubSignature', () => {
  const secret = 'test-secret';
  const body = Buffer.from(JSON.stringify({ hello: 'world' }));
  const validSig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

  test('accepts a correctly signed body', () => {
    expect(verifyGithubSignature(body, validSig, secret)).toBe(true);
  });

  test('rejects a tampered body', () => {
    const tampered = Buffer.from(JSON.stringify({ hello: 'mallory' }));
    expect(verifyGithubSignature(tampered, validSig, secret)).toBe(false);
  });

  test('rejects a missing signature header', () => {
    expect(verifyGithubSignature(body, undefined, secret)).toBe(false);
  });

  test('rejects a malformed header', () => {
    expect(verifyGithubSignature(body, 'not-a-real-signature', secret)).toBe(false);
  });
});

describe('requireConfigKey', () => {
  function mockRes() {
    const res = {};
    res.status = jest.fn(() => res);
    res.json = jest.fn(() => res);
    return res;
  }

  test('calls next() when the key matches', () => {
    const req = { get: () => 'right-key' };
    const res = mockRes();
    const next = jest.fn();
    requireConfigKey('right-key')(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('returns 401 when the key is missing or wrong', () => {
    const req = { get: () => undefined };
    const res = mockRes();
    const next = jest.fn();
    requireConfigKey('right-key')(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});