// What LeetCode's own traffic means — pure, no DOM, no extension APIs. inject-main.js (the page world) feeds
// it every request it sees and dispatches what comes out; content.js turns those items into the sitting
// events A1 takes (packages/shared/src/sittings.ts). Shapes verified against the 2026-11-08 captures
// (extension/README.md → Wire contract): Runs poll /check/ with no /v2/; Submits poll /v2/check/.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.ApertureLC = root.ApertureLC || {}).wire = api;
})(globalThis, function () {
  'use strict';

  const GRAPHQL_RE = /^\/graphql\/?$/;
  const SUBMIT_RE = /^\/problems\/([^/]+)\/submit\/?$/;
  const RUN_RE = /^\/problems\/([^/]+)\/interpret_solution\/?$/;
  const CHECK_RE = /^\/submissions\/detail\/([^/]+)\/(?:v2\/)?check\/?$/;
  // A run or submit LeetCode never reports SUCCESS for is still sent, unjudged, after this long.
  const PAIR_TIMEOUT_MS = 120_000;
  const REPLAY_PART_BYTES = 60 * 1024;
  // GraphQL operations whose response matters; the others are read from the request alone.
  const RESPONSE_OPS = ['questionDetail', 'submissionDetails'];
  const REQUEST_OPS = [
    'updateSyncedCode',
    'syncedCode',
    'updateNote',
    'PracticeReplayUploadEvents',
  ];

  const encoder = new TextEncoder();
  const bytes = (s) => encoder.encode(s).length;
  const parse = (text) => {
    if (typeof text !== 'string' || !text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
  const idStr = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v) : null);

  // LeetCode's own paths only — a request to any other host is never ours to read.
  function pathOf(url) {
    try {
      const u = new URL(String(url), 'https://leetcode.com');
      return /(^|\.)leetcode\.com$/.test(u.hostname) ? u.pathname : null;
    } catch {
      return null;
    }
  }
  const route = (url) => {
    const p = pathOf(url);
    if (p === null) return null;
    if (GRAPHQL_RE.test(p)) return { type: 'graphql' };
    let m = p.match(SUBMIT_RE);
    if (m) return { type: 'submit', slug: m[1] };
    m = p.match(RUN_RE);
    if (m) return { type: 'run', slug: m[1] };
    m = p.match(CHECK_RE);
    if (m) return { type: 'check', id: m[1] };
    return null;
  };
  const ops = (body) => (Array.isArray(body) ? body : body ? [body] : []).map(obj).filter(Boolean);

  // Whether a request is one we read at all (its URL), and whether its response body is needed too.
  const interesting = (url) => route(url) !== null;
  function wantsResponse(url, reqText) {
    const r = route(url);
    if (!r) return false;
    if (r.type !== 'graphql') return true;
    return ops(parse(reqText)).some((o) => RESPONSE_OPS.includes(o.operationName));
  }
  function wantsRequestOnly(url, reqText) {
    const r = route(url);
    return (
      !!r &&
      r.type === 'graphql' &&
      ops(parse(reqText)).some((o) => REQUEST_OPS.includes(o.operationName))
    );
  }

  function graphqlItems(reqText, resText, reqAt, resAt) {
    const reqs = ops(parse(reqText));
    const res = parse(resText);
    const out = [];
    reqs.forEach((o, i) => {
      const v = obj(o.variables) || {};
      const data = obj((Array.isArray(res) ? obj(res[i]) : obj(res))?.data);
      switch (o.operationName) {
        case 'updateSyncedCode':
          if (typeof v.code !== 'string') return;
          out.push({
            kind: 'snapshot',
            slug: null,
            questionId: idStr(v.questionId),
            at: reqAt,
            payload: { code: v.code, questionId: idStr(v.questionId), lang: idStr(v.lang) },
          });
          return;
        case 'syncedCode':
          if (idStr(v.questionId))
            out.push({
              kind: 'hint',
              slug: null,
              questionId: idStr(v.questionId),
              at: reqAt,
              payload: null,
            });
          return;
        case 'updateNote':
          if (typeof v.titleSlug !== 'string' || typeof v.content !== 'string') return;
          out.push({
            kind: 'note',
            slug: v.titleSlug,
            questionId: null,
            at: reqAt,
            payload: { slug: v.titleSlug, content: v.content },
          });
          return;
        case 'PracticeReplayUploadEvents': {
          const events =
            typeof v.events === 'string'
              ? v.events
              : v.events != null
                ? JSON.stringify(v.events)
                : null;
          if (!events) return;
          out.push({
            kind: 'replay',
            slug: typeof v.questionSlug === 'string' ? v.questionSlug : null,
            questionId: null,
            at: reqAt,
            clientSessionId: typeof v.clientSessionId === 'string' ? v.clientSessionId : null,
            events,
          });
          return;
        }
        case 'questionDetail': {
          const q = obj(data?.question);
          if (!q || typeof q.titleSlug !== 'string') return;
          out.push({
            kind: 'problem',
            slug: q.titleSlug,
            questionId: idStr(q.questionId),
            at: resAt,
            payload: q,
          });
          return;
        }
        case 'submissionDetails': {
          const d = obj(data?.submissionDetails);
          if (!d) return;
          out.push({
            kind: 'submitDetails',
            slug: typeof obj(d.question)?.titleSlug === 'string' ? d.question.titleSlug : null,
            questionId: null,
            at: resAt,
            payload: { submissionId: idStr(v.submissionId), details: d },
          });
          return;
        }
      }
    });
    return out;
  }

  // One per page load: pairs each /submit/ or /interpret_solution/ with its final /check/, once.
  function createCapture() {
    const pending = new Map(); // submission or interpret id -> {kind, slug, request, at, page}
    const fired = new Set();
    const markFired = (id) => {
      fired.add(id);
      if (fired.size > 500) fired.delete(fired.values().next().value);
    };
    const judged = (id, p, result, at) => {
      markFired(id);
      pending.delete(id);
      const kind = p ? p.kind : id.startsWith('runcode_') ? 'run' : 'submit';
      const slug = p ? p.slug : null;
      const payload =
        kind === 'run'
          ? { interpretId: id, slug, request: p ? p.request : null, result }
          : { submissionId: id, slug, request: p ? p.request : null, result };
      // `page`: the page the run or submit was made from, not the one polling for its verdict.
      return { kind, slug, questionId: null, at: p ? p.at : at, payload, page: p ? p.page : null };
    };

    // A finished request: its URL, the page it was made from, request text, response text (null when unread
    // or failed), times. Each item carries the page it came from.
    function observe({ url, page = null, reqText, resText, reqAt, resAt }) {
      const r = route(url);
      if (!r) return [];
      if (r.type === 'graphql')
        return graphqlItems(reqText, resText, reqAt, resAt).map((i) => ({ ...i, page }));
      const res = obj(parse(resText));
      if (r.type === 'submit' || r.type === 'run') {
        const id = idStr(r.type === 'submit' ? res?.submission_id : res?.interpret_id);
        if (!id || fired.has(id)) return [];
        pending.set(id, {
          kind: r.type,
          slug: r.slug,
          request: obj(parse(reqText)),
          at: reqAt,
          page,
        });
        return [];
      }
      // check: only the final SUCCESS counts; RUNNING_TESTS / STARTED / PENDING are polls.
      if (!res || res.state !== 'SUCCESS' || fired.has(r.id)) return [];
      return [judged(r.id, pending.get(r.id), res, resAt)];
    }
    function sweep(now) {
      const out = [];
      for (const [id, p] of pending)
        if (now - p.at > PAIR_TIMEOUT_MS) out.push(judged(id, p, { pending: true }, now));
      return out;
    }
    return { observe, sweep };
  }

  // A captured item → the sitting events A1 takes ({id, type, at, payload} or a replay chunk). A replay over
  // 60 KB is split along its JSON array; one that can't be split is dropped (A1 would refuse it).
  function toEventInputs(item, mintId) {
    if (item.kind === 'replay') {
      return splitReplay(item.events).map((events) => ({
        id: mintId(),
        type: 'replay',
        at: item.at,
        clientSessionId: item.clientSessionId || null,
        events,
      }));
    }
    return [{ id: mintId(), type: item.kind, at: item.at, payload: item.payload }];
  }
  function splitReplay(events, max = REPLAY_PART_BYTES) {
    if (bytes(events) <= max) return [events];
    const arr = parse(events);
    if (!Array.isArray(arr)) return [];
    const parts = [];
    let cur = [];
    let curBytes = 2; // the brackets; each element adds its bytes and a comma
    for (const e of arr) {
      const one = bytes(JSON.stringify(e));
      if (one + 2 > max) continue; // a single event over the cap: skipped
      if (cur.length && curBytes + 1 + one > max) {
        parts.push(JSON.stringify(cur));
        cur = [];
        curBytes = 2;
      }
      curBytes += (cur.length ? 1 : 0) + one;
      cur.push(e);
    }
    if (cur.length) parts.push(JSON.stringify(cur));
    return parts;
  }

  // The problem doc LeetCode renders into a fresh load's __NEXT_DATA__ (debug log 8, 2026-11-10): the
  // dehydrated questionDetail query whose question is the slug its key names; null for any other shape.
  function pageProblem(text) {
    const queries = obj(obj(obj(obj(parse(text))?.props)?.pageProps)?.dehydratedState)?.queries;
    if (!Array.isArray(queries)) return null;
    for (const entry of queries) {
      const key = obj(entry)?.queryKey;
      if (!Array.isArray(key) || key[0] !== 'questionDetail') continue;
      const slug = obj(key[1])?.titleSlug;
      const q = obj(obj(obj(entry.state)?.data)?.question);
      if (q && typeof slug === 'string' && q.titleSlug === slug) return q;
    }
    return null;
  }
  // The fields A1 and the sitting read (content.js startBody; packages/shared/src/sittings.ts
  // problemStatementText, problemCompanies).
  const PROBLEM_FIELDS = [
    'title',
    'titleSlug',
    'questionId',
    'questionFrontendId',
    'difficulty',
    'topicTags',
    'content',
    'companyTagStatsV2',
  ];
  // A doc as the Start may carry it: whole when it fits `max` bytes, else only PROBLEM_FIELDS, else null.
  function fitProblem(doc, max) {
    const d = obj(doc);
    if (!d) return null;
    if (bytes(JSON.stringify(d)) <= max) return d;
    const slim = {};
    for (const k of PROBLEM_FIELDS) if (k in d) slim[k] = d[k];
    return bytes(JSON.stringify(slim)) <= max ? slim : null;
  }
  // A request's GraphQL operation names, for the debug log: only text shaped as a GraphQL name (the page
  // writes it), never variables.
  const OP_NAME = /^[_A-Za-z][_0-9A-Za-z]{0,39}$/;
  const opNames = (reqText) =>
    ops(parse(reqText))
      .map((o) => o.operationName)
      .filter((n) => typeof n === 'string' && OP_NAME.test(n))
      .slice(0, 5);

  const SENDABLE = ['snapshot', 'run', 'submit', 'submitDetails', 'note', 'replay'];
  const KINDS = [...SENDABLE, 'hint', 'problem'];

  return {
    interesting,
    wantsResponse,
    wantsRequestOnly,
    createCapture,
    toEventInputs,
    splitReplay,
    pageProblem,
    fitProblem,
    opNames,
    PROBLEM_FIELDS,
    pathOf,
    bytes,
    SENDABLE,
    KINDS,
    PAIR_TIMEOUT_MS,
  };
});
