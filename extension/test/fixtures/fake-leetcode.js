// The fake LeetCode page's behaviour (fake-leetcode.html): it makes LeetCode's real requests on LeetCode's
// real paths, with the shapes in extension/README.md → Wire contract, so the extension sees what it would on
// leetcode.com. What it did is recorded on window.__fake for the tests to read.
(() => {
  'use strict';
  const TEMPLATE = 'class Solution:\n    def twoSum(self, nums, target):\n        ';
  const slug = (location.pathname.match(/^\/problems\/([^/]+)/) || [])[1] || 'two-sum';
  const qid = slug === 'two-sum' ? 1 : 2;
  const fake = (window.__fake = { resets: 0, timerStarts: 0, submits: 0, runs: 0 });
  const gql = (operationName, variables) =>
    fetch('/graphql/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operationName, variables, query: `query ${operationName} { x }` }),
    }).then((r) => r.json());
  const $ = (q) => document.querySelector(q);
  const code = $('[data-fake=code]');
  code.value = TEMPLATE + 'pass\n';

  gql('syncedCode', { lang: 11, questionId: qid });

  // The editor reset asks first, in a modal.
  $('[data-fake=reset]').addEventListener('click', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.innerHTML =
      '<p>Are you sure? Your current code will be discarded.</p><button type="button" data-fake="cancel">Cancel</button><button type="button" data-fake="confirm">Confirm</button>';
    document.body.append(dialog);
    dialog.querySelector('[data-fake=confirm]').addEventListener('click', () => {
      dialog.remove();
      fake.resets++;
      code.value = TEMPLATE;
      gql('updateSyncedCode', { code: code.value, lang: 11, questionId: qid });
    });
    dialog.querySelector('[data-fake=cancel]').addEventListener('click', () => dialog.remove());
  });

  // The timer keeps its state in localStorage, as LeetCode's does.
  const writeTimer = (s) => localStorage.setItem('QD_TIMER_STATE', JSON.stringify(s));
  $('[data-fake=timer-reset]').addEventListener('click', () =>
    writeTimer({
      mode: 'stopwatch',
      startTimestamp: null,
      pauseMs: 0,
      endMs: 3600000,
      status: 'pause',
    }),
  );
  $('[data-fake=timer-start]').addEventListener('click', () => {
    fake.timerStarts++;
    writeTimer({
      mode: 'stopwatch',
      startTimestamp: Date.now(),
      pauseMs: 0,
      endMs: 3600000,
      status: 'running',
    });
  });

  // Typing syncs the full code, debounced, as updateSyncedCode does.
  let typing = null;
  code.addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(
      () => gql('updateSyncedCode', { code: code.value, lang: 11, questionId: qid }),
      300,
    );
  });

  const poll = async (id, path) => {
    for (let i = 0; i < 20; i++) {
      const r = await fetch(`/submissions/detail/${id}/${path}`).then((x) => x.json());
      if (r.state === 'SUCCESS') return r;
      await new Promise((res) => setTimeout(res, 100));
    }
    return null;
  };
  $('[data-e2e-locator=console-submit-button]').addEventListener('click', async () => {
    fake.submits++;
    const r = await fetch(`/problems/${slug}/submit/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        lang: 'python3',
        question_id: String(qid),
        typed_code: code.value,
        solve_session_id: 'ss-1',
        solve_elapsed_ms: 1000,
      }),
    }).then((x) => x.json());
    await poll(r.submission_id, 'v2/check/');
    gql('submissionDetails', { submissionId: String(r.submission_id) });
    gql('questionDetail', { titleSlug: slug });
  });
  $('[data-e2e-locator=console-run-button]').addEventListener('click', async () => {
    fake.runs++;
    const r = await fetch(`/problems/${slug}/interpret_solution/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        lang: 'python3',
        question_id: String(qid),
        typed_code: code.value,
        data_input: '[2,7]\n9',
      }),
    }).then((x) => x.json());
    await poll(r.interpret_id, 'check/');
  });

  // The replay stream, every 2 s while there's something to send.
  let edits = 0;
  code.addEventListener('input', () => edits++);
  setInterval(() => {
    if (!edits) return;
    const events = JSON.stringify([{ questionId: String(qid), type: 7, ts: Date.now(), n: edits }]);
    edits = 0;
    gql('PracticeReplayUploadEvents', {
      questionSlug: slug,
      clientSessionId: 'practice-1',
      events,
      activeSessionId: 1,
    });
  }, 2000);

  // "Next problem" is a single-page navigation, as on LeetCode.
  $('[data-fake=next]').addEventListener('click', (e) => {
    e.preventDefault();
    history.pushState({}, '', '/problems/add-two-numbers/');
    gql('questionDetail', { titleSlug: 'add-two-numbers' });
  });
})();
