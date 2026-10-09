# Append Log

A small, crash-safe, append-only record log for Node.js ESM. Each record is a length-prefixed binary frame, written and `fsync`'d before `append()` returns. On reopen, a torn record at the tail is detected and truncated so the log stays self-consistent.

```js
import { AppendLog } from "append-log";

const log = new AppendLog("./events.bin");
log.append("hello");          // returns byte offset of the record's length prefix
log.append(Buffer.from([1,2,3]));

for (const { payload, offset, length } of log.read()) {
  console.log(offset, length, payload);
}

log.close();
```

## Why this exists

This library is for the case where you want a durable, append-only journal of opaque byte records and you do not want to pull in a database. The intended workload is moderate write volume where durability matters more than throughput. To keep the crash-safety argument honest and easy to audit, the implementation uses synchronous I/O (`fs.writeFileSync` semantics via `fs.writeSync` + `fs.fsyncSync`) and a single framing format: a 4-byte big-endian length prefix followed by exactly that many payload bytes.

The trade-off is throughput: every `append()` is an `fsync`. That is the point — you are paying for a durability guarantee you can reason about. If you need batching, batch at the caller and append larger records.

## The awkward edge

The awkward edge is the torn tail. If the process is killed between writing the length prefix and finishing the payload, the file ends with bytes that are not a complete record. `AppendLog` handles this in two places: on `open()` it scans the existing file and truncates any incomplete trailing record; on `read()` it stops at the first record whose `[length][payload]` does not fully fit in the remaining bytes. A torn tail is never returned by `read()` and is removed from the file the next time the log is opened.

There is one consequence worth stating plainly: a record that was reported as appended (i.e. `append()` returned without throwing) is guaranteed on disk. A record whose `append()` did not return is not guaranteed on disk; the bytes that did land may be truncated away on the next open. There is no third state.

## Exports

- `AppendLog` (named export) — the class. Also the default export.

## `AppendLog` API

- `new AppendLog(filePath, opts?)` — open or create the log file. `opts.syncDir` (default `true`) controls whether the parent directory is `fsync`'d once when the file is first created; set it to `false` only if you know the directory entry is already durable.
- `append(payload)` — append one record. `payload` is a `Buffer`, `Uint8Array`, or `string` (UTF-8). Returns the byte offset of the record's length prefix. Throws if the payload is larger than 2^32 - 1 bytes.
- `read()` — a generator yielding `{ payload: Buffer, offset: number, length: number }` for each complete record, oldest first.
- `close()` — release the file descriptor. Idempotent. After `close()`, `append()` and `read()` throw.

## Wire format

```
+------------+---------+
| length(u32)| payload |
+------------+---------+
|     4      | length  |
+------------+---------+
```

`length` is the byte length of `payload`, written big-endian. The format is deliberately not text: a length prefix lets a payload contain any byte (NUL, newline) without escaping, and the framing is auditable under `xxd`.
