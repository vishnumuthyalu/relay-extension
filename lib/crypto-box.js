const crypto = require('crypto');

// AES-256-GCM for secrets Relay has to store and use later (a tenant's
// ticket-tracker token). The key comes from INTEGRATIONS_KEY: 32 random
// bytes, base64-encoded (`openssl rand -base64 32`). GCM authenticates the
// ciphertext, so a tampered value fails to decrypt instead of decrypting
// to garbage.

function parseKey(base64Key) {
  const key = Buffer.from(String(base64Key || ''), 'base64');
  if (key.length !== 32) throw new Error('INTEGRATIONS_KEY must be 32 bytes, base64-encoded');
  return key;
}

function encrypt(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':');
}

function decrypt(value, key) {
  const [version, iv, tag, ciphertext] = String(value).split(':');
  if (version !== 'v1' || !iv || !tag || ciphertext === undefined) throw new Error('unrecognized encrypted value');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

module.exports = { parseKey, encrypt, decrypt };