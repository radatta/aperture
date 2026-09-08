// Aperture options page logic. Loads stored values on open; on save persists to storage.local and
// requests the optional host permission for the configured API origin.

(() => {
  "use strict";

  const api =
    (typeof browser !== "undefined" && browser.runtime && browser) ||
    (typeof chrome !== "undefined" && chrome.runtime && chrome) ||
    null;

  const originInput = document.getElementById("apiOrigin");
  const tokenInput = document.getElementById("deviceToken");
  const form = document.getElementById("options-form");
  const statusEl = document.getElementById("status");

  function setStatus(msg, kind) {
    statusEl.textContent = msg;
    statusEl.className = kind || "";
  }

  function normalizeOrigin(value) {
    if (typeof value !== "string") return "";
    return value.trim().replace(/\/+$/, "");
  }

  // Promise-normalizing wrappers (browser.* is promise-based; chrome.* is callback-based).
  function storageGet(keys) {
    try {
      const p = api.storage.local.get(keys);
      if (p && typeof p.then === "function") return p;
    } catch (_e) {
      /* fall through */
    }
    return new Promise((resolve) => api.storage.local.get(keys, (r) => resolve(r || {})));
  }

  function storageSet(obj) {
    try {
      const p = api.storage.local.set(obj);
      if (p && typeof p.then === "function") return p;
    } catch (_e) {
      /* fall through */
    }
    return new Promise((resolve) => api.storage.local.set(obj, () => resolve()));
  }

  function permissionsRequest(perm) {
    try {
      const p = api.permissions.request(perm);
      if (p && typeof p.then === "function") return p;
    } catch (_e) {
      /* fall through */
    }
    return new Promise((resolve) => api.permissions.request(perm, (granted) => resolve(granted)));
  }

  async function load() {
    if (!api) {
      setStatus("Extension APIs unavailable.", "err");
      return;
    }
    try {
      const { apiOrigin, deviceToken } = await storageGet(["apiOrigin", "deviceToken"]);
      if (typeof apiOrigin === "string") originInput.value = apiOrigin;
      if (typeof deviceToken === "string") tokenInput.value = deviceToken;
    } catch (err) {
      setStatus("Could not load saved settings.", "err");
    }
  }

  // NOTE: the handler is deliberately NOT async. permissions.request() must be invoked synchronously
  // inside the user gesture (the click) — any `await` before it drops the gesture and Firefox rejects
  // it with "may only be called from a user input handler". So we call it FIRST, then persist + report.
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    setStatus("", "");

    const apiOrigin = normalizeOrigin(originInput.value);
    const deviceToken = tokenInput.value.trim();

    if (!apiOrigin) {
      setStatus("Enter an API origin.", "err");
      return;
    }
    let parsed;
    try {
      parsed = new URL(apiOrigin);
    } catch (_e) {
      setStatus("API origin is not a valid URL.", "err");
      return;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      setStatus("API origin must be http(s).", "err");
      return;
    }
    if (!deviceToken) {
      setStatus("Enter a device token.", "err");
      return;
    }

    // FIRST async call — still within the user gesture (nothing awaited yet).
    let permPromise;
    try {
      permPromise = permissionsRequest({ origins: [parsed.origin + "/*"] });
    } catch (err) {
      setStatus("Permission request failed: " + (err && err.message ? err.message : err), "err");
      return;
    }

    permPromise.then(
      (granted) => {
        storageSet({ apiOrigin, deviceToken }).then(
          () => {
            if (granted) {
              setStatus("Saved. Permission granted for " + parsed.origin + ".", "ok");
            } else {
              setStatus(
                "Saved, but host permission was not granted — attempts won't send until you allow " +
                  parsed.origin +
                  ".",
                "err"
              );
            }
          },
          () => setStatus("Failed to save settings.", "err"),
        );
      },
      (err) =>
        setStatus("Permission request failed: " + (err && err.message ? err.message : err), "err"),
    );
  });

  load();
})();
