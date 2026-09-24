// Aperture LeetCode interceptor — runs in the page's MAIN world (manifest content_scripts world: "MAIN").
// It monkey-patches window.fetch and XMLHttpRequest so it can OBSERVE LeetCode's own submit/judge
// traffic regardless of which transport LeetCode uses. It NEVER blocks or alters the real request/
// response, NEVER issues its own requests, and NEVER throws into the page.
//
// Why it is passive, and why metadata comes from the DOM: docs/areas/recruiting/index.md → Design decisions.
//
// Flow:
//   1. On a submit call (POST /problems/<slug>/submit/) we remember submission_id -> {slug, lang, question_id}.
//   2. On a result poll (GET /submissions/detail/<id>/v2/check/) whose state === "SUCCESS", we fire once,
//      read problem metadata (title/difficulty/topicTags) straight from the RENDERED PAGE, and dispatch a
//      CustomEvent that the ISOLATED-world relay (content-relay.js) forwards to the background script.
//
// The background script adds tzOffsetMinutes and performs the actual POST to the Aperture backend.

(() => {
  "use strict";

  // Guard against double-injection (e.g. bfcache / re-injection).
  if (window.__apertureLeetcodeInjected) return;
  window.__apertureLeetcodeInjected = true;

  const SUBMIT_RE = /\/problems\/([^/]+)\/submit\/?(?:\?|$)/;
  const CHECK_RE = /\/submissions\/detail\/([^/]+)\/v2\/check\/?(?:\?|$)/;

  // submission_id (string) -> { slug, lang, question_id }
  const submitContext = new Map();
  // submission_ids we've already fired for, so we emit exactly once per submission.
  const firedSubmissions = new Set();

  // Debug logging — MAIN world, so these land in the LeetCode page's DevTools console. Flip DEBUG on
  // to trace capture (interceptor-loaded marker + per-submit payload with difficulty candidates).
  const DEBUG = false;
  function dlog() {
    if (!DEBUG) return;
    try {
      console.debug.apply(console, ["[Aperture]"].concat(Array.prototype.slice.call(arguments)));
    } catch (_e) {
      /* ignore */
    }
  }
  dlog("interceptor loaded on", location.pathname);

  // ---- Parsing helpers -----------------------------------------------------

  // "0 ms" -> 0, "12 ms" -> 12, "N/A" / undefined -> null
  function parseRuntimeMs(statusRuntime) {
    if (typeof statusRuntime !== "string") return null;
    const m = statusRuntime.match(/(\d+(?:\.\d+)?)\s*ms/i);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  }

  // Prefer the raw `memory` bytes number from the check response; ignore the pretty "20.8 MB" string.
  function parseMemoryBytes(memory) {
    if (typeof memory === "number" && Number.isFinite(memory)) return memory;
    if (typeof memory === "string") {
      const n = Number(memory);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  function safeJsonParse(text) {
    if (typeof text !== "string" || text.length === 0) return null;
    try {
      return JSON.parse(text);
    } catch (_e) {
      return null;
    }
  }

  function slugFromSubmitUrl(url) {
    try {
      const m = String(url).match(SUBMIT_RE);
      return m ? m[1] : null;
    } catch (_e) {
      return null;
    }
  }

  function idFromCheckUrl(url) {
    try {
      const m = String(url).match(CHECK_RE);
      return m ? m[1] : null;
    } catch (_e) {
      return null;
    }
  }

  // "hash-table" -> "Hash Table". Used for a slug-derived title fallback and tag-name fallback.
  function humanizeSlug(slug) {
    if (typeof slug !== "string" || !slug) return null;
    return slug
      .split("-")
      .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
      .join(" ");
  }

  // ---- Problem metadata (read from the rendered page, no network) ----------

  // Read title/difficulty/topicTags off the DOM at capture time. LeetCode server-renders these, so the
  // problem you just submitted is fully present. Best-effort: any field we can't find degrades to null
  // (title falls back to a slug-derived string). Returns a `dbg` field for the debug log only.
  function readProblemMeta(slug) {
    let title = humanizeSlug(slug);
    let difficulty = null;
    let topicTags = null;
    const dbg = {};

    // Title: "Roman to Integer - LeetCode" -> "Roman to Integer".
    try {
      const t = (document.title || "").replace(/\s*-\s*LeetCode\s*$/i, "").trim();
      if (t) title = t;
    } catch (_e) {
      /* keep fallback */
    }

    // Difficulty: leaf nodes whose text is exactly Easy/Medium/Hard. The problem's own pill is in the
    // header (first in DOM order, not inside a link); similar-questions rows are link-nested — skip those.
    try {
      const cands = Array.prototype.slice
        .call(document.querySelectorAll("div,span,a,button,p"))
        .filter(
          (e) => e.childElementCount === 0 && /^(Easy|Medium|Hard)$/.test((e.textContent || "").trim()),
        );
      dbg.difficultyCandidates = cands.map((e) => (e.textContent || "").trim());
      const chosen = cands.find((e) => !e.closest("a")) || cands[0] || null;
      if (chosen) difficulty = (chosen.textContent || "").trim();
    } catch (_e) {
      /* leave null */
    }

    // Topic tags: anchors to /tag/<slug>/ are the current problem's topics. Prefer the anchor text,
    // fall back to humanizing the slug. Dedup by tag slug. (Empty if LeetCode is hiding topics.)
    try {
      const seen = Object.create(null);
      const tags = [];
      const anchors = document.querySelectorAll('a[href*="/tag/"]');
      for (let i = 0; i < anchors.length; i++) {
        const href = anchors[i].getAttribute("href") || "";
        const m = href.match(/\/tag\/([^/?#]+)/);
        if (!m) continue;
        const key = m[1];
        if (seen[key]) continue;
        seen[key] = true;
        tags.push((anchors[i].textContent || "").trim() || humanizeSlug(key));
      }
      if (tags.length) topicTags = tags;
    } catch (_e) {
      /* leave null */
    }

    return { title, difficulty, topicTags, dbg };
  }

  // ---- Core handlers -------------------------------------------------------

  function handleSubmit(url, requestBodyText, responseText) {
    try {
      const slug = slugFromSubmitUrl(url);
      const reqBody = safeJsonParse(requestBodyText) || {};
      const resBody = safeJsonParse(responseText);
      if (!resBody) return;
      const submissionId = resBody.submission_id;
      if (submissionId === undefined || submissionId === null) return;
      const key = String(submissionId);
      submitContext.set(key, {
        slug: slug || null,
        lang: typeof reqBody.lang === "string" ? reqBody.lang : null,
        question_id:
          reqBody.question_id !== undefined && reqBody.question_id !== null
            ? String(reqBody.question_id)
            : null,
      });
    } catch (_e) {
      // Never throw into the page.
    }
  }

  function handleCheck(url, responseText) {
    try {
      const idFromUrl = idFromCheckUrl(url);
      const body = safeJsonParse(responseText);
      if (!body || body.state !== "SUCCESS") return;

      const submissionId =
        body.submission_id !== undefined && body.submission_id !== null
          ? String(body.submission_id)
          : idFromUrl;
      if (!submissionId) return;
      if (firedSubmissions.has(submissionId)) return; // fire once per submission
      firedSubmissions.add(submissionId);

      const ctx = submitContext.get(submissionId) || {};
      const slug = ctx.slug || null;
      const meta = readProblemMeta(slug); // synchronous DOM read — no network
      dlog("check SUCCESS → building payload", {
        submissionId,
        slug,
        title: meta.title,
        difficulty: meta.difficulty,
        topicTags: meta.topicTags,
        difficultyCandidates: meta.dbg.difficultyCandidates,
      });

      const payload = {
        leetcodeSubmissionId: submissionId,
        problemSlug: slug,
        problemTitle: meta.title,
        statusCode:
          typeof body.status_code === "number" ? body.status_code : Number(body.status_code) || null,
        statusMsg: typeof body.status_msg === "string" ? body.status_msg : null,
        submittedAt:
          typeof body.task_finish_time === "number"
            ? body.task_finish_time
            : Number(body.task_finish_time) || null,
        // tzOffsetMinutes is added by the background script at send time.
        lang: typeof body.pretty_lang === "string" ? body.pretty_lang : ctx.lang || null,
        runtimeMs: parseRuntimeMs(body.status_runtime),
        memory: parseMemoryBytes(body.memory),
        frontendId: ctx.question_id || null,
        difficulty: meta.difficulty,
        topicTags: meta.topicTags,
      };
      window.dispatchEvent(new CustomEvent("aperture-leetcode-attempt", { detail: payload }));
    } catch (_e) {
      // Never throw into the page.
    }
  }

  // ---- fetch patch ---------------------------------------------------------

  const realFetch = window.fetch ? window.fetch.bind(window) : null;

  if (realFetch) {
    window.fetch = function (input, init) {
      let url = "";
      try {
        if (typeof input === "string") {
          url = input;
        } else if (input && typeof input.url === "string") {
          url = input.url;
        }
      } catch (_e) {
        // ignore
      }

      const isSubmit = SUBMIT_RE.test(url);
      const isCheck = CHECK_RE.test(url);

      // Capture request body text for submit calls (from init.body when it's a string).
      let reqBodyText = null;
      if (isSubmit) {
        try {
          if (init && typeof init.body === "string") reqBodyText = init.body;
        } catch (_e) {
          // ignore
        }
      }

      const p = realFetch(input, init);

      if (isSubmit || isCheck) {
        p.then((res) => {
          try {
            // Clone so we never disturb the page's own consumption of the body.
            const clone = res.clone();
            clone
              .text()
              .then((text) => {
                if (isSubmit) handleSubmit(url, reqBodyText, text);
                else if (isCheck) handleCheck(url, text);
              })
              .catch(() => {});
          } catch (_e) {
            // ignore
          }
          return res;
        }).catch(() => {
          // Do not interfere with the page's own error handling.
        });
      }

      return p; // Always return the real response promise unchanged.
    };
  }

  // ---- XMLHttpRequest patch ------------------------------------------------

  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const realOpen = XHR.prototype.open;
    const realSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url) {
      try {
        this.__apertureUrl = url;
        this.__apertureMethod = method;
      } catch (_e) {
        // ignore
      }
      return realOpen.apply(this, arguments);
    };

    XHR.prototype.send = function (body) {
      try {
        const url = this.__apertureUrl || "";
        const isSubmit = SUBMIT_RE.test(url);
        const isCheck = CHECK_RE.test(url);
        if (isSubmit || isCheck) {
          const reqBodyText = typeof body === "string" ? body : null;
          this.addEventListener("load", () => {
            try {
              // Only read text-like responses.
              let text = null;
              try {
                if (this.responseType === "" || this.responseType === "text") {
                  text = this.responseText;
                } else if (this.responseType === "json" && this.response) {
                  text = JSON.stringify(this.response);
                }
              } catch (_e) {
                text = null;
              }
              if (text == null) return;
              if (isSubmit) handleSubmit(url, reqBodyText, text);
              else if (isCheck) handleCheck(url, text);
            } catch (_e) {
              // Never throw into the page.
            }
          });
        }
      } catch (_e) {
        // ignore
      }
      return realSend.apply(this, arguments);
    };
  }
})();
