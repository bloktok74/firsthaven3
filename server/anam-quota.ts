// Fail-closed Redis REST ledger. No process-local quota fallback.
// Only SHA256 hashes, a session UUID, counters and Redis expiry are stored.
type Environment = Record<string, string | undefined>;
export type AnamReservation = 'ok' | 'daily_limit' | 'already_active';
export type AnamLease = { tokenHash?: string; sessionId?: string; claimed: boolean };
// Shared Redis hash tag keeps the counter and lease in one cluster slot.
export const ANAM_QUOTA_LEASE_SECONDS = 330; // Conservative: covers 120s tokens, prior 180s sessions and 30s grace.
const DAILY_LIMIT = 20;
const DAILY_TTL = 172800;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const INPUT_ERROR = 'Anam quota input is invalid.';
const STORE_ERROR = 'Anam test quota storage is unavailable.';

const RESERVE = `-- anam-quota:reserve:v1
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
if not count or count < 0 or count % 1 ~= 0 then return redis.error_reply('Invalid quota counter') end
if count >= tonumber(ARGV[2]) then return 1 end
if redis.call('EXISTS', KEYS[2]) == 1 then return 2 end
redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
redis.call('HSET', KEYS[2], 'owner', ARGV[1], 'claimed', '0')
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[4]))
return 0`;
const BIND_TOKEN = `-- anam-quota:bind-token:v1
if redis.call('HGET', KEYS[1], 'owner') ~= ARGV[1] then return 0 end
local token = redis.call('HGET', KEYS[1], 'token')
local claimed = redis.call('HGET', KEYS[1], 'claimed')
if token then
  if token == ARGV[2] and claimed == '0' and not redis.call('HGET', KEYS[1], 'session') then return 1 end
  return 0
end
if claimed ~= '0' or redis.call('HGET', KEYS[1], 'session') then return 0 end
redis.call('HSET', KEYS[1], 'token', ARGV[2])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
return 1`;
const CLAIM_TOKEN = `-- anam-quota:claim-token:v1
local owner = redis.call('HGET', KEYS[1], 'owner')
if not owner or redis.call('HGET', KEYS[1], 'token') ~= ARGV[1] or redis.call('HGET', KEYS[1], 'claimed') ~= '0' then return nil end
redis.call('HSET', KEYS[1], 'claimed', '1')
return owner`;
const BIND_SESSION = `-- anam-quota:bind-session:v1
if redis.call('HGET', KEYS[1], 'owner') ~= ARGV[1] or not redis.call('HGET', KEYS[1], 'token') or redis.call('HGET', KEYS[1], 'claimed') ~= '1' then return 0 end
local session = redis.call('HGET', KEYS[1], 'session')
if session then if session == ARGV[2] then return 1 else return 0 end end
redis.call('HSET', KEYS[1], 'session', ARGV[2])
return 1`;
const LOOKUP = `-- anam-quota:lookup:v1
if redis.call('HGET', KEYS[1], 'owner') ~= ARGV[1] then return nil end
return {redis.call('HGET', KEYS[1], 'token') or '', redis.call('HGET', KEYS[1], 'session') or '', redis.call('HGET', KEYS[1], 'claimed') or ''}`;
const RELEASE = `-- anam-quota:release:v1
if redis.call('HGET', KEYS[1], 'owner') ~= ARGV[1] then return 0 end
if not redis.call('HGET', KEYS[1], 'token') or (ARGV[2] == '1' and redis.call('HGET', KEYS[1], 'session') and redis.call('HGET', KEYS[1], 'claimed') == '1') then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0`;

function hash(value: string): string {
  if (typeof value !== 'string' || !HASH.test(value)) throw Error(INPUT_ERROR);
  return value;
}
function session(value: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw Error(INPUT_ERROR);
  return value.toLowerCase();
}
function utcDay(nowMs: number): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > 253402300799999) throw Error(INPUT_ERROR);
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function createAnamQuota(env: Environment, fetcher: typeof fetch = fetch) {
  // The endpoint is trusted server configuration, never a request parameter.
  // Upstash REST and explicitly configured HTTPS-compatible REST endpoints work.
  let endpoint: string;
  const prefix = '{firsthaven3:anam:preview:v1}:';
  const lease = prefix + 'lease';
  const token = env.ANAM_QUOTA_REDIS_REST_TOKEN;
  try {
    const configured = env.ANAM_QUOTA_REDIS_REST_URL;
    if (env.VERCEL_ENV !== 'preview' || typeof configured !== 'string' || !configured.trim() || typeof token !== 'string' || !token.trim() || /[\x00-\x20\x7f]/.test(token)) throw Error();
    const url = new URL(configured);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash || /[\x00-\x20\x7f]/.test(configured)) throw Error();
    endpoint = url.href;
  } catch { throw Error('Anam test quota storage is not configured.'); }

  async function evaluate(script: string, keys: string[], args: string[]): Promise<unknown> {
    try {
      const response = await fetcher(endpoint, {
        method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(['EVAL', script, keys.length, ...keys, ...args]),
        redirect: 'error', signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw Error();
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.hasOwn(body, 'result') || ('error' in body && body.error != null)) throw Error();
      return (body as { result: unknown }).result;
    } catch { throw Error(STORE_ERROR); }
  }
  async function boolean(script: string, owner: string, args: string[]): Promise<boolean> {
    const result = await evaluate(script, [lease], [hash(owner), ...args]);
    if (result !== 0 && result !== 1) throw Error(STORE_ERROR);
    return result === 1;
  }

  return {
    async reserve(ownerHash: string, nowMs: number): Promise<AnamReservation> {
      const owner = hash(ownerHash);
      const result = await evaluate(RESERVE, [prefix + 'daily:' + utcDay(nowMs), lease], [owner, String(DAILY_LIMIT), String(DAILY_TTL), String(ANAM_QUOTA_LEASE_SECONDS)]);
      if (result !== 0 && result !== 1 && result !== 2) throw Error(STORE_ERROR);
      return result === 0 ? 'ok' : result === 1 ? 'daily_limit' : 'already_active';
    },
    async bindToken(ownerHash: string, tokenHash: string): Promise<boolean> {
      return boolean(BIND_TOKEN, ownerHash, [hash(tokenHash), String(ANAM_QUOTA_LEASE_SECONDS)]);
    },
    async claimToken(tokenHash: string): Promise<string | null> {
      const result = await evaluate(CLAIM_TOKEN, [lease], [hash(tokenHash)]);
      if (result === null) return null;
      if (typeof result !== 'string' || !HASH.test(result)) throw Error(STORE_ERROR);
      return result;
    },
    async bindSession(ownerHash: string, sessionUUID: string): Promise<boolean> {
      return boolean(BIND_SESSION, ownerHash, [session(sessionUUID)]);
    },
    async lookup(ownerHash: string): Promise<AnamLease | null> {
      const result = await evaluate(LOOKUP, [lease], [hash(ownerHash)]);
      if (result === null) return null;
      if (!Array.isArray(result) || result.length !== 3) throw Error(STORE_ERROR);
      const [tokenHash, sessionId, claimed] = result;
      if (typeof tokenHash !== 'string' || (tokenHash !== '' && !HASH.test(tokenHash)) || typeof sessionId !== 'string' || (sessionId !== '' && !UUID.test(sessionId)) || !['0', '1'].includes(claimed) || (claimed === '1' && !tokenHash) || (sessionId && (!tokenHash || claimed !== '1'))) throw Error(STORE_ERROR);
      return { ...(tokenHash ? { tokenHash } : {}), ...(sessionId ? { sessionId: sessionId.toLowerCase() } : {}), claimed: claimed === '1' };
    },
    // stopConfirmed is trusted server evidence of provider termination, never a
    // client assertion. A bound but unused token holds the full safety lease.
    async release(ownerHash: string, stopConfirmed = false): Promise<boolean> {
      return boolean(RELEASE, ownerHash, [stopConfirmed === true ? '1' : '0']);
    },
  };
}
