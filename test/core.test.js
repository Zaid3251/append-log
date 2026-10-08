import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AppendLog } from "../src/index.js";

/**
 * Create a fresh temp file path. We delete any existing file at that path so
 * each test starts from a genuinely empty log. Returning a cleanup function is
 * less noisy than using a global afterEach, because each test knows its own
 * temp path.
 *
 * @returns {string}
 */function freshPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "appendlog-"));
  return path.join(dir, "log.bin");
}

/**
 * Write `count` full zero-byte records followed by one torn record at the tail.
 * A "torn" record is one whose 4-byte length prefix is present but announces
 * more payload bytes than the file contains. This simulates a crash mid-write.
 *
 * @param {string} filePath
 * @param {number} count
 * @returns {{ tornOffset: number, payloadLength: number }}
 */
function writeTornTail(filePath, count) {
  // Two passes so we know the exact byte layout of what we corrupted.
  const log = new AppendLog(filePath, { syncDir: false });
  for (let i = 0; i < count; i++) {
    log.append(Buffer.alloc(0));
  }
  const tornOffset = fs.statSync(filePath).size;
  // Announce 10 payload bytes but write none — a classic torn write.
  const torn = Buffer.from([0, 0, 0, 10]);
  fs.writeFileSync(filePath, torn, { flag: "a" });
  log.close();
  return { tornOffset, payloadLength: 10 };
}

test("append and read back a single string payload", () => {
  const p = freshPath();
  const log = new AppendLog(p, { syncDir: false });
  const off = log.append("hello");
  assert.equal(off, 0);
  const entries = Array.from(log.read());
  assert.equal(entries.length, 1);
  const e = entries[0];
  assert.equal(e.offset, 0);
  assert.equal(e.length, 5);
  assert.equal(e.payload.toString("utf8"), "hello");
  log.close();
});

test("multiple appends produce offsets that strictly increase", () => {
  const p = freshPath();
  const log = new AppendLog(p, { syncDir: false });
  const o1 = log.append("a");
  const o2 = log.append("bb");
  const o3 = log.append("ccc");
  assert.equal(o1, 0);
  assert.equal(o2, 4 + 1); // header + "a" = 5
  assert.equal(o3, 5 + (4 + 2)); // previous + header + "bb" = 11
  const entries = Array.from(log.read());
  assert.deepEqual(
    entries.map((e) => e.payload.toString("utf8")),
    ["a", "bb", "ccc"]
  );
  log.close();
});

test("empty payload is a valid record", () => {
  const p = freshPath();
  const log = new AppendLog(p, { syncDir: false });
  log.append(Buffer.alloc(0));
  const [e] = Array.from(log.read());
  assert.equal(e.length, 0);
  assert.equal(e.payload.length, 0);
  assert.equal(e.offset, 0);
  log.close();
});

test("payload can contain NUL and newline bytes", () => {
  const p = freshPath();
  const log = new AppendLog(p, { syncDir: false });
  const payload = Buffer.from([0x00, 0x0a, 0x0d, 0x41, 0x00, 0x0a]);
  log.append(payload);
  const [e] = Array.from(log.read());
  assert.deepEqual(new Uint8Array(e.payload), new Uint8Array(payload));
  log.close();
});

test("reopening a log appends after existing records", () => {
  const p = freshPath();
  let log = new AppendLog(p, { syncDir: false });
  log.append("first");
  log.close();

  log = new AppendLog(p, { syncDir: false });
  log.append("second");
  log.close();

  log = new AppendLog(p, { syncDir: false });
  const entries = Array.from(log.read());
  assert.deepEqual(
    entries.map((e) => e.payload.toString("utf8")),
    ["first", "second"]
  );
  log.close();
});

test("torn tail (short payload) is truncated on reopen and not read", () => {
  const p = freshPath();
  const { tornOffset } = writeTornTail(p, 3);
  assert.equal(tornOffset, 3 * (4 + 0)); // three empty records

  const log = new AppendLog(p, { syncDir: false });
  const entries = Array.from(log.read());
  assert.equal(entries.length, 3); // torn tail not returned
  assert.equal(fs.statSync(p).size, tornOffset); // file truncated to valid end
  log.close();
});

test("torn tail is truncated even with non-empty payloads before it", () => {
  const p = freshPath();
  const log = new AppendLog(p, { syncDir: false });
  log.append("aaaa"); // 8 bytes on disk
  log.append("bbbb"); // 8 bytes on disk, total 16
  log.close();

  // Append a torn record: length prefix says 10, but we only write the 4-byte
  // header. On reopen, scan() must stop at offset 16 and the file must be
  // truncated back to 16.
  fs.writeFileSync(p, Buffer.from([0, 0, 0, 10]), { flag: "a" });
  assert.equal(fs.statSync(p).size, 16 + 4);

  const log2 = new AppendLog(p, { syncDir: false });
  const entries = Array.from(log2.read());
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((e) => e.payload.toString("utf8")),
    ["aaaa", "bbbb"]
  );
  assert.equal(fs.statSync(p).size, 16);
  log2.close();
});

test("append after torn-tail truncation writes a clean record", () => {
  const p = freshPath();
  const { tornOffset } = writeTornTail(p, 1);

  const log = new AppendLog(p, { syncDir: false });
  const off = log.append("recovered");
  assert.equal(off, tornOffset); // picked up exactly after the last good record
  log.close();

  const log2 = new AppendLog(p, { syncDir: false });
  const entries = Array.from(log2.read());
  assert.deepEqual(
    entries.map((e) => e.payload.toString("utf8")),
    ["", "recovered"]
  );
  log2.close();
});

test("torn length prefix (fewer than 4 bytes) is truncated on reopen", () => {
  const p = freshPath();
  const log = new AppendLog(p, { syncDir: false });
  log.append("good"); // 8 bytes
  log.close();
  // Append a partial length prefix — only 2 bytes.
  fs.writeFileSync(p, Buffer.from([0x00, 0x00]), { flag: "a" });
  assert.equal(fs.statSync(p).size, 8 + 2);

  const log2 = new AppendLog(p, { syncDir: false });
  const entries = Array.from(log2.read());
  assert.equal(entries.length, 1);
  assert.equal(entries[0].payload.toString("utf8"), "good");
  assert.equal(fs.statSync(p).size, 8); // torn prefix truncated
  log2.close();
});

test("close is idempotent and subsequent append throws", () => {
  const p = freshPath();
  const log = new AppendLog(p, { syncDir: false });
  log.append("x");
  log.close();
  log.close(); // second close is a no-op
  assert.throws(() => log.append("y"), /closed/);
  assert.throws(() => Array.from(log.read()), /closed/);
});

test("append rejects null and undefined payloads", () => {
  const p = freshPath();
  const log = new AppendLog(p, { syncDir: false });
  assert.throws(() => log.append(null), /null or undefined/);
  assert.throws(() => log.append(undefined), /null or undefined/);
  log.close();
});

test("append rejects payloads exceeding MAX_PAYLOAD", () => {
  const p = freshPath();
  const log = new AppendLog(p, { syncDir: false });
  // 2**32 = 4294967296 is one greater than the maximum length we can encode
  // in a u32 prefix (2**32 - 1 = 4294967295). Use the number directly to
  // avoid allocating a 4 GiB buffer in the test runner.
  const tooBig = Buffer.alloc(1);
  const original = tooBig.length;
  Object.defineProperty(tooBig, "length", { value: 4294967296 });
  assert.throws(() => log.append(tooBig), /exceeds maximum/);
  // sanity check: we didn't accidentally mutate the real length semantics
  assert.equal(original, 1);
  log.close();
});

test("Uint8Array payload is accepted and copied", () => {
  const p = freshPath();
  const log = new AppendLog(p, { syncDir: false });
  const src = new Uint8Array([1, 2, 3]);
  log.append(src);
  // Mutate after append: the log must not be affected because it copied.
  src[0] = 99;
  const [e] = Array.from(log.read());
  assert.deepEqual(Array.from(new Uint8Array(e.payload)), [1, 2, 3]);
  log.close();
});

test("constructor throws on empty path", () => {
  assert.throws(() => new AppendLog(""), /non-empty string/);
});

test("new file in a non-existent directory fails with a real error", () => {
  const p = path.join(freshPath(), "no", "log.bin");
  assert.throws(() => new AppendLog(p, { syncDir: false }), /ENOENT/);
});
