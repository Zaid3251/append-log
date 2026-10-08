/**
 * Append Log — a crash-safe, append-only record log for Node.js ESM.
 *
 * Design summary (see README for the rationale):
 * - Each entry is a length-prefixed binary record: [u32 BE length][payload].
 * - Writes are durably flushed (data + directory) before a write is reported as done,
 *   so a crash after AppendLog.append() resolves means the record is on disk.
 * - A partially-written record (torn length or truncated payload) at the tail is
 *   detected on read and skipped. We never corrupt the preceding records.
 * - We use synchronous I/O (fs.writeFileSync and fs.fsyncSync) so the behaviour is
 *   easy to reason about. This library is for durability-first, not throughput-first,
 *   workloads; that trade-off is stated in the README.
 */

import { AppendLog } from "./core.js";

export { AppendLog };
export default AppendLog;
