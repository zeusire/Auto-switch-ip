import fs from "node:fs";
import { LOG_FILE, readLogTail } from "@/lib/autoswitchip/engine";

export const dynamic = "force-dynamic";

const POLL_MS = 1000;
const PING_MS = 25000;
const MAX_CHUNK = 256 * 1024;

/**
 * GET /api/autoswitchip/logs/stream — SSE tail of daemon.log.
 *
 * Tails by offset instead of re-reading the file, so a multi-megabyte log
 * costs one read on connect and only the new bytes afterwards. Rotation and
 * truncation (the Clear button) both show up as size < offset and restart the
 * tail from the top.
 */
export async function GET(request) {
  const encoder = new TextEncoder();
  const state = { closed: false, offset: 0, timer: null, ping: null };

  const cleanup = () => {
    if (state.closed) return;
    state.closed = true;
    if (state.timer) clearInterval(state.timer);
    if (state.ping) clearInterval(state.ping);
  };
  request.signal.addEventListener("abort", cleanup, { once: true });

  const stream = new ReadableStream({
    start(controller) {
      const send = (payload) => {
        if (state.closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          cleanup();
        }
      };

      // Seed with the tail so the panel is useful before the next line lands.
      const tail = readLogTail({ lines: 200 });
      state.offset = tail.size;
      send({ type: "init", lines: tail.lines });

      state.timer = setInterval(() => {
        if (state.closed) return;
        let st;
        try {
          st = fs.statSync(LOG_FILE);
        } catch {
          return; // log not created yet; the next tick may find it
        }
        if (st.size < state.offset) {
          state.offset = 0;
          send({ type: "clear" });
        }
        if (st.size === state.offset) return;
        const length = Math.min(st.size - state.offset, MAX_CHUNK);
        let fd;
        try {
          fd = fs.openSync(LOG_FILE, "r");
          const buf = Buffer.alloc(length);
          fs.readSync(fd, buf, 0, length, state.offset);
          state.offset += length;
          const lines = buf.toString("utf8").split(/\r?\n/).filter(Boolean);
          if (lines.length) send({ type: "lines", lines });
        } catch {
          /* file vanished mid-read; retry next tick */
        } finally {
          if (fd !== undefined) {
            try {
              fs.closeSync(fd);
            } catch {
              /* ignore */
            }
          }
        }
      }, POLL_MS);
      state.timer?.unref?.();

      // Keepalive: proxies and browsers drop an idle SSE stream.
      state.ping = setInterval(() => send({ type: "ping" }), PING_MS);
      state.ping?.unref?.();
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
