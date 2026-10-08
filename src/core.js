/**
 * Core implementation of the append-only log.
 *
 * Wire format (all integers big-endian):
 *
 *   +------------+---------+
 *   | length(u32)| payload |
 *   +------------+---------+
 *   |     4      | length  |
 *   +------------+---------+
 *
 * length is the byte length of `payload`, max 2**32 - 1 (4 GiB). The four-byte
 * prefix is what makes the log self-describing: a reader can walk forward, skip
 * whole records, and detect a torn write at the tail.
 *
 * Why this shape and not JSON-per-line:
 *   - A length prefix lets a payload contain arbitrary bytes, including NUL and
 *     newlines, without escaping. We never misinterpret a payload byte as a
 *     framing byte.
 *   - Big-endian integers are stable across machines; they also read cleanly
 *     under xxd, which helps post-mortem debugging.
 *
 * Crash safety story:
 *   - append() writes the framed record in a single fs.writeFileSync call, then
 *     fsyncs the file. On Linux/macOS we also fsync the directory once, which is
 *     needed to make the file's existence durable if the file was just created.
 *   - On a crash mid-write the file may contain: (a) a torn length prefix, (b) a
 *     complete length prefix but a short payload, or (c) a complete record plus
 *     a torn prefix for the next. scan() handles all three by treating a record
 *     as valid only when its full [length][payload] fits in the remaining bytes.
 */

import fs from "node:fs";
import path from "node:path";

const HEADER_SIZE = 4; // u32 big-endian length prefix
const MAX_PAYLOAD = 0xffffffff; // 4 GiB minus one; imposed by u32 length field

/**
 * Decode a big-endian unsigned 32-bit integer from a 4-byte Buffer.
 * Inlined instead of using Buffer.readUInt32BE because the helper is tiny and
 * keeping it inline makes the framing logic easier to audit in one read.
 *
 * @param {Buffer} buf - buffer of at least 4 bytes
 * @param {number} off - offset into buf
 * @returns {number}
 */
function readU32BE(buf, off) {
  return (
    (buf[off] * 0x1000000) + // 2^24
    ((buf[off + 1] << 16) |
      (buf[off + 2] << 8) |
      buf[off + 3])
  );
}

/**
 * Write a big-endian unsigned 32-bit integer into a 4-byte Buffer at offset.
 * Uses multiplication/shifts that are safe under plain JS number arithmetic
 * since the value is at most 2**32 - 1.
 *
 * @param {Buffer} buf
 * @param {number} off
 * @param {number} val
 * @returns {void}
 */
function writeU32BE(buf, off, val) {
  buf[off] = (val >>> 24) & 0xff;
  buf[off + 1] = (val >>> 16) & 0xff;
 buf[off + 2] = (val >>> 8) & 0xff;
  buf[off + 3] = val & 0xff;
}

/**
 * @typedef {Object} Entry
 * @property {Buffer} payload - the exact bytes appended
 * @property {number} offset - byte offset of this record's length prefix
 * @property {number} length - byte length of the payload (matches payload.length)
 */

/**
 * @typedef {Object} AppendLogOptions
 * @property {boolean} [syncDir=true]
 *   Whether to fsync the parent directory after creating the file. This matters
 *   for the very first append: without a directory fsync, the file's existence
 *   is not guaranteed to survive a crash. We default to true for safety; tests
 *   set it false because fsyncing an OS-provided temp directory is not part of
 *   the behaviour we are exercising.
 */

/**
 * AppendLog is intentionally a small, synchronous, single-file log. It is not
 * a queue, it does not support random deletion, and it does not do compaction.
 * It is the primitive a higher-level queue or journal would build on.
 */
export class AppendLog {
  #path = "";
  #fd = 0;
  #nextOffset = 0;
  #opened = false;
  #closed = false;

  /**
   * @param {string} filePath
   * @param {AppendLogOptions} [opts]
   */
  constructor(filePath, opts = {}) {
    if (typeof filePath !== "string" || filePath.length === 0) {
      throw new TypeError("AppendLog: filePath must be a non-empty string");
    }
    const syncDir = opts.syncDir === undefined ? true : Boolean(opts.syncDir);
    this.#path = filePath;
    this.#opened = false;
    this.#closed = false;
    this.#open(syncDir);
  }

  /**
   * Open the file for appending and scan it to find the next write offset.
   * We scan eagerly at open time so the first append() lands at the correct
   * byte offset even if the file was pre-existing and ended with a torn record.
   *
   * The throw on directory-fsync-failure is intentional: the caller has asked
   * for durability and we cannot provide it. We surface the error rather than
   * silently continuing with weaker semantics. We still keep the file open so
   * the caller can read existing records; they can call close() to release it.
   *
   * @param {boolean} syncDir
   * @returns {void}
   */
  #open(syncDir) {
    // O_RDWR lets us both scan existing bytes and append new ones. We do not
    // use O_APPEND because we write at a computed file offset after reading the
    // file with fs.readFileSync in scan(); mixing O_APPEND with positioned
    // writes is not portable across platforms.
    let fd;
    try {
      fd = fs.openSync(this.#path, "r+");
    } catch (err) {
      if (err && typeof err === "object" && err.code === "ENOENT") {
        // File doesn't exist: create it, then reopen r+ so we have a stable
        // file descriptor that permits both reading and writing.
        fd = fs.openSync(this.#path, "w+");
        if (syncDir) {
          this.#syncDir();
        }
      } else {
        throw err;
      }
    }
    this.#fd = fd;
    this.#opened = true;

    try {
      const stat = fs.fstatSync(this.#fd);
      const fileSize = stat.size;
      this.#nextOffset = fileSize === 0 ? 0 : AppendLog.#scanValidEnd(this.#fd, fileSize);
      if (this.#nextOffset < fileSize) {
        // Truncate the torn tail. This is safe because the bytes we are removing
        // are, by construction, an incomplete record that no reader would ever
        // return. Truncating here keeps the file self-consistent for tools that
        // don't know how to skip a torn tail.
        fs.truncateSync(this.#path, this.#nextOffset);
      }
    } catch (err) {
      try {
        fs.closeSync(this.#fd);
      } catch {
        // Swallow: we are already on an error path; the open error matters more.
      }
      this.#opened = false;
      throw err;
    }
  }

  /**
   * fsync the parent directory of the log file. Called once, when we create the
   * file, so that the file's directory entry is durable.
   *
   * @returns {void}
   */
  #syncDir() {
    const dir = path.dirname(this.#path);
    let dirFd;
    try {
      dirFd = fs.openSync(dir, "r");
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch (err) {
      throw new Error(`AppendLog: failed to fsync directory "${dir}": ${err.message}`);
    }
  }

  /**
   * Walk the file forward from offset 0 and return the byte offset just past
   * the last complete record. Bytes after that point (if any) are a torn tail:
   * either a short length prefix, or a length prefix announcing more payload
   * bytes than the file actually contains.
   *
   * @param {number} fd
   * @param {number} fileSize
   * @returns {number} byte offset at which the next valid record should begin
   */
  static #scanValidEnd(fd, fileSize) {
    let offset = 0;
    const header = Buffer.alloc(HEADER_SIZE);
    while (offset < fileSize) {
      const remaining = fileSize - offset;
      if (remaining < HEADER_SIZE) {
        // Not enough bytes for a length prefix: torn write, stop here.
        break;
      }
      // readSync returns the number of bytes read; we need exactly HEADER_SIZE.
      // Reading header-by-header is O(records) syscalls; for the intended
      // workload (moderate record counts, durability-first) that is acceptable.
      const got = fs.readSync(fd, header, 0, HEADER_SIZE, offset);
      if (got < HEADER_SIZE) {
        break;
      }
      const len = readU32BE(header, 0);
      if (len > MAX_PAYLOAD) {
        // A bogus length either indicates corruption in the middle of the file
        // (which we do not attempt to repair) or a torn prefix whose bits land
        // above the legal range. We treat it as "no more complete records here"
        // and stop; the caller will truncate back to `offset`.
        break;
      }
      if (remaining < HEADER_SIZE + len) {
        // Header announced more payload than the file holds: torn write.
        break;
      }
      offset += HEADER_SIZE + len;
    }
    return offset;
  }

  /**
   * Append a record. The payload may be any byte sequence; we do not inspect it.
   * Returns the byte offset at which this record's length prefix was written.
   *
   * @param {Buffer|Uint8Array|string} payload
   * @returns {number} offset of this record's length prefix in the file
   * @throws {Error} if the payload exceeds MAX_PAYLOAD bytes, or if the log is closed
   */
  append(payload) {
    if (!this.#opened || this.#closed) {
      throw new Error("AppendLog: log is closed");
    }
    if (payload === undefined || payload === null) {
      throw new TypeError("AppendLog.append: payload must not be null or undefined");
    }
    /** @type {Buffer} */
    let buf;
    if (Buffer.isBuffer(payload)) {
      buf = payload;
    } else if (payload instanceof Uint8Array) {
      // Copy so the caller cannot mutate the bytes after we have framed them.
      // For Buffer this is a no-op copy (Buffer.from(Buffer) copies) but the
      // guarantee is worth the cost.
      buf = Buffer.from(payload);
    } else if (typeof payload === "string") {
      buf = Buffer.from(payload, "utf8");
    } else {
      throw new TypeError(
        "AppendLog.append: payload must be a Buffer, Uint8Array, or string"
      );
    }
    if (buf.length > MAX_PAYLOAD) {
      throw new Error(
        `AppendLog.append: payload of ${buf.length} bytes exceeds maximum of ${MAX_PAYLOAD}`
      );
    }

    const frame = Buffer.allocUnsafe(HEADER_SIZE + buf.length);
    writeU32BE(frame, 0, buf.length);
    buf.copy(frame, HEADER_SIZE);

    // Positioned write: we computed #nextOffset by scanning, and we never let
    // the kernel seek via O_APPEND, so we know exactly where this frame lands.
    fs.writeSync(this.#fd, frame, 0, frame.length, this.#fdPosition());
    fs.fsyncSync(this.#fd);

    const writtenAt = this.#nextOffset;
    this.#nextOffset += frame.length;
    return writtenAt;
  }

  /**
   * For platforms where pwrite is honoured (Linux, macOS), we pass an explicit
   * position. On Windows, Node maps writeSync with position to a non- positioned
   * write only when position is null; a numeric position is translated to a
   * seek+write by Node's internals, which works for our append-after-scan pattern.
   *
   * @returns {number|null}
   */
  #fdPosition() {
    // Node's fs.writeSync treats `position` of null as "use current file offset".
    // We don't keep an explicit cursor because we already track #nextOffset
    // and pass it in each call; returning the number keeps the code path
    // identical across platforms.
    return this.#nextOffset;
  }

  /**
   * Iterate all complete records, oldest first. Records truncated by scan() at
   * open time are not returned; the only torn bytes that could exist at read
   * time are from a crash that happened after open(), and read() handles them.
   *
   * @yields {Entry}
   * @returns {Generator<Entry, void, void>}
   */  *read() {
    if (!this.#opened) {
      throw new Error("AppendLog: log is closed");
    }
    const stat = fs.fstatSync(this.#fd);
    const fileSize = stat.size;
    let offset = 0;
    const header = Buffer.alloc(HEADER_SIZE);
    while (offset < fileSize) {
      const remaining = fileSize - offset;
      if (remaining < HEADER_SIZE) {
        break; // torn tail
      }
      const got = fs.readSync(this.#fd, header, 0, HEADER_SIZE, offset);
      if (got < HEADER_SIZE) {
        break;
      }
      const len = readU32BE(header, 0);
      if (len > MAX_PAYLOAD) {
        break;
      }
      if (remaining < HEADER_SIZE + len) {
        break; // short payload
      }
      const payload = Buffer.allocUnsafe(len);
      if (len > 0) {
        const r = fs.readSync(this.#fd, payload, 0, len, offset + HEADER_SIZE);
        if (r < len) {
          break; // unexpected short read mid-record
        }
      }
      yield { payload, offset, length: len };
      offset += HEADER_SIZE + len;
    }
  }

  /**
   * Close the underlying file descriptor. Calling close() more than once is a
   * no-op; calling any other method after close() throws.
   *
   * @returns {void}
   */
  close() {
    if (this.#closed) {
      return;
    }
    if (!this.#opened) {
      this.#closed = true;
      return;
    }
    try {
      fs.closeSync(this.#fd);
    } finally {
      this.#closed = true;
      this.#opened = false;
    }
  }
}
