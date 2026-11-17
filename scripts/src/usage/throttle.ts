// A byte-rate-limited line reader. The transcript store sits on the container's root disk, and COI pauses the
// container when reads pass ~250 MB/s (docs/ops/COI-INCIDENTS.md), so every transcript byte goes through this.
import { createReadStream } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

export interface LineOpts {
  start?: number; // byte offset to begin at (a line boundary)
  end: number; // exclusive: the file's size when it was stat'ed, so a growing file is read only that far
  maxBps: number; // bytes per second, averaged from the start
  maxLine?: number; // longer lines are skipped, not buffered
  hwm?: number; // read chunk size
}
export interface Line {
  line: Buffer;
  next: number; // offset just past this line's newline
}
export interface ReadStats {
  bytes: number;
  skipped: number; // lines over maxLine
  done: number; // offset past the last complete line (a trailing partial line is left for the next run)
}

export async function* lines(path: string, o: LineOpts, stats?: ReadStats): AsyncGenerator<Line> {
  const start = o.start ?? 0;
  const maxLine = o.maxLine ?? 64 * 1024 * 1024;
  const st = stats ?? { bytes: 0, skipped: 0, done: start };
  st.done = start;
  if (o.end <= start) return;
  const t0 = Date.now();
  let parts: Buffer[] = [];
  let partLen = 0;
  let skipping = false;
  let pos = start; // file offset of the first byte of the current chunk
  const stream = createReadStream(path, {
    start,
    end: o.end - 1,
    highWaterMark: o.hwm ?? 1024 * 1024,
  });
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    let from = 0;
    for (let nl = chunk.indexOf(0x0a); nl !== -1; nl = chunk.indexOf(0x0a, from)) {
      const next = pos + nl + 1;
      if (!skipping) {
        const piece = chunk.subarray(from, nl);
        const line = partLen ? Buffer.concat([...parts, piece]) : piece;
        if (line.length) yield { line, next };
      }
      parts = [];
      partLen = 0;
      skipping = false;
      st.done = next;
      from = nl + 1;
    }
    if (from < chunk.length && !skipping) {
      parts.push(chunk.subarray(from));
      partLen += chunk.length - from;
      if (partLen > maxLine) {
        skipping = true;
        st.skipped++;
        parts = [];
        partLen = 0;
      }
    }
    pos += chunk.length;
    st.bytes += chunk.length;
    const ahead = (st.bytes / o.maxBps) * 1000 - (Date.now() - t0);
    if (ahead > 1) await sleep(ahead);
  }
}
