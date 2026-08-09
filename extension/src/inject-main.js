// Aperture LeetCode interceptor — runs in the page's MAIN world (manifest content_scripts world: "MAIN").
// It monkey-patches window.fetch and XMLHttpRequest so it can observe LeetCode's own network
// traffic regardless of which transport LeetCode uses for a given request. It NEVER blocks or
// alters the real request/response, and NEVER throws into the page.
//
// Flow:
//   1. On a submit call (POST /problems/<slug>/submit/) we remember submission_id -> {slug, lang, question_id}.
//   2. On a result poll (GET /submissions/detail/<id>/v2/check/) whose state === "SUCCESS", we fire once,
//      enrich with problem metadata via a GraphQL question() query, and dispatch a CustomEvent that the
//      ISOLATED-world relay (content-relay.js) forwards to the background script.
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

  // ---- Problem metadata (GraphQL) -----------------------------------------

  // Uses the page's own logged-in session (credentials: 'include'). Best-effort: on any failure we
  // return nulls so the attempt is still recorded without the metadata.
  async function fetchProblemMeta(slug) {
    const empty = { title: null, difficulty: null, topicTags: null };
    if (!slug) return empty;
    try {
      const body = {
        operationName: "apertureQuestionMeta",
        query:
          "query apertureQuestionMeta($slug: String!) { question(titleSlug: $slug) { title difficulty topicTags { name } } }",
        variables: { slug },
      };
      // Call the real (unpatched) fetch reference captured below to avoid re-entrancy.
      const res = await realFetch.call(window, "https://leetcode.com/graphql/", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res || !res.ok) return empty;
      const json = await res.json().catch(() => null);
      const q = json && json.data && json.data.question;
      if (!q) return empty;
      const tags = Array.isArray(q.topicTags)
        ? q.topicTags.map((t) => (t && typeof t.name === "string" ? t.name : null)).filter(Boolean)
        : null;
      return {
        title: typeof q.title === "string" ? q.title : null,
        difficulty: typeof q.difficulty === "string" ? q.difficulty : null,
        topicTags: tags,
      };
    } catch (_e) {
      return empty;
    }
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

      // Enrich asynchronously, then dispatch. Metadata failures degrade to nulls.
      fetchProblemMeta(slug)
        .then((meta) => {
          const payload = {
            leetcodeSubmissionId: submissionId,
            problemSlug: slug,
            problemTitle: meta.title,
            statusCode: typeof body.status_code === "number" ? body.status_code : Number(body.status_code) || null,
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
        })
        .catch(() => {
          // Swallow — best effort.
        });
    } catch (_e) {
      // Never throw into the page.
    }
  }

  // ---- fetch patch ---------------------------------------------------------

  const realFetch = window.fetch ? window.fetch.bind(window) : null;

  if (realFetch) {
    window.fetch = function (input, init) {
      let url = "";
      let method = "GET";
      try {
        if (typeof input === "string") {
          url = input;
        } else if (input && typeof input.url === "string") {
          url = input.url;
          method = input.method || method;
        }
        if (init && init.method) method = init.method;
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
