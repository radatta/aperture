// A short, self-contained chime — no asset, and a no-op where Web Audio is absent (tests, blocked tabs).
// WebKit only lets an AudioContext start inside a user gesture, and the chime fires from the 1s tick, so
// one shared context is started by a click/keypress and left running. Never suspended between chimes:
// resuming outside a gesture is exactly what WebKit may refuse, or leave pending and fire late.
let audio: AudioContext | null = null;

function context() {
  if (audio) return audio;
  const Ctx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (Ctx) audio = new Ctx();
  return audio;
}

// Call from a user-gesture handler. Also restarts a context the OS interrupted (sleep, a call).
export function unlockAudio() {
  try {
    const ac = context();
    if (ac && ac.state !== 'running') void ac.resume().catch(() => {});
  } catch {
    // No audio available.
  }
}

export function chime() {
  if (audio?.state !== 'running') return; // not unlocked yet, or interrupted — the next gesture restarts it
  try {
    const ac = audio;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.frequency.value = 660;
    gain.gain.setValueAtTime(0.06, ac.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.4);
    osc.start();
    osc.stop(ac.currentTime + 0.4);
  } catch {
    // No audio available — the visual "Done" state carries it.
  }
}

// Test seam: module state outlives a test file under isolate: false.
export function forgetAudio() {
  audio = null;
}
