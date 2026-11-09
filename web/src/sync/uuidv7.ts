// UUID version 7 (RFC 9562 section 5.7): a 48-bit Unix millisecond timestamp, then version and
// variant bits, then random bits. Ids made later sort later as plain strings, which is what the
// outbox and the server's ON CONFLICT (id) DO NOTHING both rely on.

const MAX_TIMESTAMP = 2 ** 48 - 1;

const defaultRand = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));

export function uuidv7(now: number = Date.now(), rand: (n: number) => Uint8Array = defaultRand): string {
  if (!Number.isInteger(now) || now < 0 || now > MAX_TIMESTAMP) {
    throw new RangeError('uuidv7: timestamp must be an integer in [0, 2^48)');
  }
  const random = rand(10);
  if (random.length !== 10) throw new RangeError('uuidv7: rand(10) must return 10 bytes');

  const bytes = new Uint8Array(16);
  // Bytes 0-5: the timestamp, big-endian. `>>>` would truncate to 32 bits, so split it.
  const high = Math.floor(now / 2 ** 32);
  const low = now % 2 ** 32;
  bytes[0] = (high >>> 8) & 0xff;
  bytes[1] = high & 0xff;
  bytes[2] = (low >>> 24) & 0xff;
  bytes[3] = (low >>> 16) & 0xff;
  bytes[4] = (low >>> 8) & 0xff;
  bytes[5] = low & 0xff;
  bytes.set(random, 6);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70; // version 7
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // variant 10

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
