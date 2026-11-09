// What content.js hands the background, and when — pure, over a caller's clock. Events coalesce for 3 s; a
// run or submit goes at once. Snapshots (LeetCode's autosave of the whole editor) are throttled to one per
// 30 s window, trailing: the window opens at the first snapshot after a quiet spell and sends the latest code
// when it closes, so live code is never more than 30 s behind and a long sitting stays well under A1's
// per-sitting event cap. The pending snapshot also goes before a run or submit, and on hide or navigation.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.ApertureLC = root.ApertureLC || {}).batch = api;
})(globalThis, function () {
  'use strict';
  function createBatcher({ coalesceMs = 3000, snapshotMs = 30_000 } = {}) {
    let snap = null;
    let snapAt = null;
    let others = [];
    let othersAt = null;
    // 'now' when the caller should flush at once (a run or submit), else 'later' (arm a timer to dueAt()).
    function push(e, now) {
      if (e.type === 'snapshot') {
        snap = e;
        if (snapAt == null) snapAt = now + snapshotMs;
        return 'later';
      }
      others.push(e);
      if (e.type === 'run' || e.type === 'submit') return 'now';
      if (othersAt == null) othersAt = now + coalesceMs;
      return 'later';
    }
    const dueAt = () =>
      snapAt == null ? othersAt : othersAt == null ? snapAt : Math.min(snapAt, othersAt);
    function drain(now) {
      const out = [];
      if (snapAt != null && now >= snapAt) {
        out.push(snap);
        snap = null;
        snapAt = null;
      }
      if (othersAt != null && now >= othersAt) {
        out.push(...others);
        others = [];
        othersAt = null;
      }
      return out;
    }
    function flush() {
      const out = snap ? [snap, ...others] : others;
      snap = null;
      snapAt = null;
      others = [];
      othersAt = null;
      return out;
    }
    return { push, dueAt, drain, flush };
  }
  return { createBatcher };
});
