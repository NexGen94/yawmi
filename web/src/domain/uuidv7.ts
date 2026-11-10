// The single UUIDv7 implementation lives in ../sync/uuidv7 (the outbox uses it for event ids).
// Re-exported here so domain callers have one import path without a second copy of the code.
export { uuidv7 } from '../sync/uuidv7';
