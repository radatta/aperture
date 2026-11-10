// The fake LeetCode page's behaviour (fake-leetcode.html): it makes LeetCode's real requests on LeetCode's
// real paths, with the shapes in extension/README.md → Wire contract, so the extension sees what it would on
// leetcode.com. What it did is recorded on window.__fake for the tests to read.
(() => {
  'use strict';
  const TEMPLATE = 'class Solution:\n    def twoSum(self, nums, target):\n        ';
  const slug = (location.pathname.match(/^\/problems\/([^/]+)/) || [])[1] || 'two-sum';
  const qid = slug === 'two-sum' ? 1 : 2;
  const fake = (window.__fake = {
    resets: 0,
    timerStarts: 0,
    timerResets: 0,
    timerOpens: 0,
    strays: 0, // clicks on anything Start must never touch: the other toolbar icons, the streaks pop-over
    submits: 0,
    runs: 0,
    syncs: 0,
    resetCloses: false, // a test's switch: the timer pop-up closes after its reset instead of staying open
    resetInert: false, // a test's switch: the pop-up's Reset does nothing (LeetCode never goes idle)
    stickyPopup: false, // a test's switch: an outside click doesn't dismiss the pop-up
    timerResetClicks: 0, // clicks on the widget's own Reset control (the one that opens the pop-up)
  });
  const gql = (operationName, variables) => {
    if (operationName === 'updateSyncedCode') fake.syncs++;
    return fetch('/graphql/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operationName, variables, query: `query ${operationName} { x }` }),
    }).then((r) => r.json());
  };
  const $ = (q) => document.querySelector(q);
  const code = $('[data-fake=code]');
  code.value = TEMPLATE + 'pass\n';

  // A test's switch, set before load: LeetCode names the question later, on sendHint(), not at once.
  if (!(window.__fakeOpts && window.__fakeOpts.lateHint))
    gql('syncedCode', { lang: 11, questionId: qid });

  // The editor reset asks first, in a modal LeetCode renders inside the toolbar's group (#editor), as logged.
  const toolbar = $('[data-fake=toolbar]');
  for (const b of toolbar.querySelectorAll('button')) {
    if (b.getAttribute('data-fake') !== 'reset') b.addEventListener('click', () => fake.strays++);
  }
  $('[data-fake=streaks]').addEventListener('click', () => fake.strays++);
  $('[data-fake=reset]').addEventListener('click', () => {
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.className = 'fixed overflow-y-auto z-modal inset-0';
    modal.innerHTML =
      '<p>Are you sure? Your current code will be discarded.</p><div class="mt-8 flex justify-end"><div><div class="flex flex-wrap"><div><button type="button" class="px-3 bg-fill-3" data-fake="cancel">Cancel</button></div><div><button type="button" class="px-3 text-label-r bg-green-s" data-fake="confirm">Confirm</button></div></div></div></div>';
    toolbar.append(modal);
    modal.querySelector('[data-fake=confirm]').addEventListener('click', () => {
      fake.resets++;
      code.value = TEMPLATE;
      gql('updateSyncedCode', { code: code.value, lang: 11, questionId: qid });
      setTimeout(() => modal.remove(), 100); // it lingers while it animates out
    });
    modal.querySelector('[data-fake=cancel]').addEventListener('click', () => modal.remove());
  });

  // The timer keeps its state in localStorage, as LeetCode's does (the logged shape), and the widget follows it.
  const KEY = 'QD_TIMER_STATE';
  const readTimer = () => {
    try {
      return JSON.parse(localStorage.getItem(KEY)) || null;
    } catch {
      return null;
    }
  };
  const base = { lastUsedEndMs: 3600000, isUserPaused: false, alertMinute: 10 };
  const idle = (mode) => ({
    ...base,
    mode,
    startTimestamp: null,
    pauseMs: null,
    endMs: mode === 'reverse' ? 3600000 : null,
    status: 'idle',
  });
  const writeTimer = (st) => {
    localStorage.setItem(KEY, JSON.stringify(st));
    render();
  };
  const timerBox = $('[data-fake=timer]');
  let popup = null;
  // Closing animates out, as Radix's does: `data-state="closed"` and inert for a moment, then gone.
  const closePopup = () => {
    if (!popup) return;
    const gone = popup;
    popup = null;
    gone.setAttribute('data-state', 'closed');
    setTimeout(() => gone.remove(), 150);
  };
  // A press outside the pop-up and its widget dismisses it (Radix's default) — a click on our overlay too.
  document.addEventListener(
    'click',
    (e) => {
      if (fake.stickyPopup) return;
      if (popup && !popup.contains(e.target) && !timerBox.contains(e.target)) closePopup();
    },
    true,
  );
  // The pop-up's one action button: Start in the tab LeetCode last used, or (asked by Reset) its Reset.
  function popupButton(kind) {
    const st = readTimer() || idle('forward');
    const name = st.mode === 'reverse' ? 'Timer' : 'Stopwatch';
    const b = document.createElement('button');
    b.type = 'button';
    b.className =
      kind === 'start'
        ? 'relative font-medium bg-sd-primary'
        : 'relative font-medium bg-sd-secondary';
    b.textContent = `${kind === 'start' ? 'Start' : 'Reset'} ${name}`;
    b.addEventListener('click', () => {
      if (b.closest('[data-state="closed"]')) return; // a closing pop-up's buttons do nothing
      if (kind === 'start') {
        fake.timerStarts++;
        writeTimer({ ...idle(st.mode), startTimestamp: Date.now(), status: 'running' });
        closePopup();
      } else {
        fake.timerResets++;
        if (fake.resetInert) return;
        writeTimer(idle(st.mode));
        if (fake.resetCloses) return closePopup();
        // It stays open and swaps its Reset for Start, both present for a moment.
        const s = popupButton('start');
        b.after(s);
        setTimeout(() => b.remove(), 30);
      }
    });
    return b;
  }
  function openPopup(kind) {
    closePopup();
    popup = document.createElement('div');
    popup.setAttribute('role', 'dialog');
    popup.id = 'radix-_r_c_';
    popup.setAttribute('data-state', 'open');
    popup.innerHTML =
      '<div class="tabs"><div>Stopwatch</div><div>Timer</div></div><div class="h-8 w-full"><div class="absolute"></div></div>';
    popup.querySelector('.absolute').append(popupButton(kind));
    document.body.append(popup);
  }
  function render() {
    const st = readTimer();
    const status = (st && st.status) || 'idle';
    const elapsed = st
      ? (st.pauseMs || 0) + (st.startTimestamp ? Date.now() - st.startTimestamp : 0)
      : 0;
    timerBox.innerHTML = '';
    // The controls layer, always mounted (pointer-events off while idle on LeetCode; reachable by querySelector).
    const layer = document.createElement('div');
    layer.innerHTML =
      '<div role="button" aria-label="Hide">⌃</div>' +
      `<div role="button" aria-label="${status === 'pause' ? 'Resume' : 'Pause'}" data-fake="toggle">${Math.round(elapsed / 1000)}s</div>` +
      '<div role="button" aria-label="Reset" data-fake="timer-reset">↺</div>';
    timerBox.append(layer);
    layer.querySelector('[data-fake=timer-reset]').addEventListener('click', () => {
      fake.timerResetClicks++;
      openPopup('reset');
    });
    layer.querySelector('[data-fake=toggle]').addEventListener('click', () => {
      const cur = readTimer();
      if (!cur || cur.status === 'idle') return;
      if (cur.status === 'pause')
        writeTimer({
          ...cur,
          status: 'running',
          pauseMs: null,
          startTimestamp: Date.now() - (cur.pauseMs || 0),
        });
      else
        writeTimer({
          ...cur,
          status: 'pause',
          isUserPaused: true,
          startTimestamp: null,
          pauseMs: Date.now() - cur.startTimestamp,
        });
    });
    // The opener's layer is mounted in every state, as logged (only shown while idle); on a clock that is going
    // it opens the pop-up on its Reset — a guess, never logged.
    const opener = document.createElement('div');
    opener.setAttribute('role', 'button');
    opener.setAttribute('aria-label', st && st.mode === 'reverse' ? 'Timer' : 'Stopwatch');
    opener.setAttribute('data-fake', 'opener');
    opener.addEventListener('click', () => {
      fake.timerOpens++;
      if (popup) closePopup();
      else openPopup(status === 'idle' ? 'start' : 'reset');
    });
    timerBox.append(opener);
  }
  fake.setTimer = (st) => writeTimer(st);
  render();

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
    // slowNext: as LeetCode often does, the tab title still names the last problem for a moment, and the
    // new problem's doc comes later (or not at all).
    if (window.__fake.slowNext) return;
    gql('questionDetail', { titleSlug: 'add-two-numbers' });
  });
  window.__fake.finishNext = () => gql('questionDetail', { titleSlug: 'add-two-numbers' });
  // LeetCode fetching this problem's doc on its own (it does after a submit or a nav), for a test to time.
  window.__fake.fetchDoc = () => gql('questionDetail', { titleSlug: slug });
  window.__fake.sendHint = () => gql('syncedCode', { lang: 11, questionId: qid });
})();
