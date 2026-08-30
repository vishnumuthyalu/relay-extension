const DEFAULT_RETRIES = 2; // up to 3 total attempts
const DEFAULT_BASE_DELAY_MS = 150;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableResponse(result) {
  return !!result && typeof result === 'object' && 'ok' in result && !result.ok && RETRYABLE_STATUSES.has(result.status);
}

// Retries a fetch-like async call on transient failure: a thrown/rejected
// error (network failure), or a resolved Response with a retryable status
// (429 or 5xx). A non-retryable rejection (bad status like 400/401) is
// returned/thrown as-is on the first attempt so callers can handle it
// immediately. After the retry budget is exhausted, the last response or
// error is returned/thrown unchanged so callers see the same failure shape
// they would have seen without retrying.
async function withRetry(fn, { retries = DEFAULT_RETRIES, baseDelayMs = DEFAULT_BASE_DELAY_MS } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await fn();
      if (!isRetryableResponse(result) || attempt === retries) {
        return result;
      }
    } catch (err) {
      if (attempt === retries) throw err;
    }
    await sleep(baseDelayMs * 2 ** attempt);
  }
}

module.exports = { withRetry };
