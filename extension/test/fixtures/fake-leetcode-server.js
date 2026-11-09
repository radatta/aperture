// LeetCode's side of the fake page's requests: canned answers by path and GraphQL operation (shapes from
// localNotes/lc-capture/AVAILABLE.md, values synthetic). Used by the jsdom tests and the Chrome E2E's route.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.fakeLeetcodeServer = api;
})(globalThis, function () {
  'use strict';
  function createServer() {
    const checks = new Map(); // id -> polls so far
    let nextId = 900001;
    const question = (slug) => ({
      title: slug === 'two-sum' ? 'Two Sum' : 'Add Two Numbers',
      titleSlug: slug,
      questionId: slug === 'two-sum' ? '1' : '2',
      questionFrontendId: slug === 'two-sum' ? '1' : '2',
      difficulty: slug === 'two-sum' ? 'Easy' : 'Medium',
      topicTags: [{ name: 'Array', slug: 'array' }],
      companyTagStatsV2: '{}',
    });
    // → {status, body} for a request to a LeetCode path; null when it isn't one of the page's.
    function respond(path, method, reqText) {
      if (path === '/graphql/' && method === 'POST') {
        const op = JSON.parse(reqText || '{}');
        const v = op.variables || {};
        const data = {
          syncedCode: { syncedCode: { timestamp: 1, code: 'pass' } },
          updateSyncedCode: { updateSyncedCode: { ok: true } },
          updateNote: { updateNote: { ok: true } },
          PracticeReplayUploadEvents: { createPracticeReplayEvents: { ok: true } },
          questionDetail: { question: question(v.titleSlug) },
          submissionDetails: {
            submissionDetails: { code: 'x', statusCode: 10, user: { username: 'user' }, question: { titleSlug: 'two-sum' } },
          },
        }[op.operationName] || {};
        return { status: 200, body: JSON.stringify({ data }) };
      }
      let m = path.match(/^\/problems\/([^/]+)\/submit\/$/);
      if (m) return { status: 200, body: JSON.stringify({ submission_id: nextId++ }) };
      m = path.match(/^\/problems\/([^/]+)\/interpret_solution\/$/);
      if (m) return { status: 200, body: JSON.stringify({ interpret_id: `runcode_${nextId++}_x`, test_case: '[2,7]\n9' }) };
      m = path.match(/^\/submissions\/detail\/([^/]+)\/(v2\/)?check\/$/);
      if (m) {
        const n = (checks.get(m[1]) || 0) + 1;
        checks.set(m[1], n);
        if (n === 1) return { status: 200, body: JSON.stringify({ state: 'STARTED' }) };
        const run = m[1].startsWith('runcode_');
        return {
          status: 200,
          body: JSON.stringify({
            state: 'SUCCESS',
            status_code: 10,
            status_msg: 'Accepted',
            total_correct: run ? 3 : 63,
            total_testcases: run ? 3 : 63,
            ...(run ? {} : { submission_id: m[1] }),
          }),
        };
      }
      return null;
    }
    return { respond };
  }
  return { createServer };
});
