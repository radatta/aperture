// Aperture background script (MV3 event page in Firefox — background.scripts).
// Receives "attempt" messages from the relay, stamps tzOffsetMinutes, and POSTs each attempt to
// the Aperture backend using the user's device token.

(() => {
  "use strict";

  const runtime =
    (typeof browser !== "undefined" && browser.runtime && browser) ||
    (typeof chrome !== "undefined" && chrome.runtime && chrome) ||
    null;

  if (!runtime) return;

  // Mirrors packages/shared/src/rpc.ts AUTH_HEADER — the extension can't import from the workspace,
  // so the header name is hardcoded here. Keep in sync with the app if that constant ever changes.
  const AUTH_HEADER = "x-aperture-authorization";

  // Belt-and-suspenders in-memory dedupe. The server is authoritative; this just avoids obvious
  // double-sends within a single background lifetime. Bounded so it can't grow unbounded.
  const recentlySent = new Set();
  const MAX_RECENT = 500;

  function rememberSent(id) {
    recentlySent.add(id);
    if (recentlySent.size > MAX_RECENT) {
      // Drop the oldest entry (insertion order).
      const first = recentlySent.values().next().value;
      recentlySent.delete(first);
    }
  }

  function getStored() {
    // browser.* returns a promise; chrome.* uses a callback. Normalize to a promise.
    try {
      const p = runtime.storage.local.get(["apiOrigin", "deviceToken"]);
      if (p && typeof p.then === "function") return p;
    } catch (_e) {
      // fall through to callback form
    }
    return new Promise((resolve) => {
      try {
        runtime.storage.local.get(["apiOrigin", "deviceToken"], (res) => resolve(res || {}));
      } catch (_e) {
        resolve({});
      }
    });
  }

  function normalizeOrigin(origin) {
    if (typeof origin !== "string") return "";
    return origin.replace(/\/+$/, ""); // strip trailing slashes
  }

  async function sendAttempt(payload) {
    if (!payload || !payload.leetcodeSubmissionId) {
      console.warn("[Aperture] dropping attempt with no submission id");
      return;
    }
    const id = String(payload.leetcodeSubmissionId);
    if (recentlySent.has(id)) {
      console.info("[Aperture] skipping duplicate submission", id);
      return;
    }

    const { apiOrigin, deviceToken } = await getStored();
    const origin = normalizeOrigin(apiOrigin);
    if (!origin || !deviceToken) {
      console.warn(
        "[Aperture] apiOrigin/deviceToken not configured — dropping attempt",
        id,
        "(set them in the extension options page)"
      );
      return;
    }

    // Stamp the timezone offset at send time in the background context.
    const outbound = Object.assign({}, payload, {
      tzOffsetMinutes: new Date().getTimezoneOffset(),
    });

    const url = origin + "/api/recordLeetcodeAttempt";
    rememberSent(id); // mark before awaiting so concurrent messages don't race a double-send

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [AUTH_HEADER]: "Bearer " + deviceToken,
        },
        body: JSON.stringify({ args: [outbound] }),
      });
      if (res.ok) {
        console.info("[Aperture] recorded attempt", id, "->", res.status);
      } else {
        // Allow a retry on server/transport failure by un-remembering.
        recentlySent.delete(id);
        const text = await res.text().catch(() => "");
        console.warn("[Aperture] backend rejected attempt", id, res.status, text.slice(0, 500));
      }
    } catch (err) {
      recentlySent.delete(id);
      console.warn("[Aperture] failed to POST attempt", id, err && err.message ? err.message : err);
    }
  }

  runtime.runtime.onMessage.addListener((message) => {
    try {
      if (!message || message.type !== "attempt") return;
      // Fire and forget; errors are handled inside sendAttempt. Returning nothing keeps the
      // message channel from staying open.
      sendAttempt(message.payload);
    } catch (err) {
      console.warn("[Aperture] onMessage handler error", err && err.message ? err.message : err);
    }
  });
})();
