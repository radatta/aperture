# Flux — webcam neck rehab, on-device

`/flux`: guided cervical exercises with live range-of-motion feedback from the front camera. It's a port
of **flux-track-2** (a standalone TanStack Start app, built for one user with chronic neck pain) at full
feature parity, plus what an Aperture page makes possible. The headline addition is that **a session
counts as a Roll rep**, so neck work rides the estimate-vs-actual calibration. This doc is the design record and the one home for the
engine's delegate/asset policy, the Safari facts it relies on, and the on-device checklist. Built on
`flux`, 2026-10.

**Not a medical device.** Webcam head pose is accurate _relatively_. Flux shows your trends from a
per-session neutral and never claims clinical-grade angles. The published comparison against motion capture
puts the error at roughly 7–11°, with rotation the least reliable axis. The disclaimer gates every
screen.

## 1. Shape

- **Routes:** `/flux` (library) and `/flux/:exerciseId` (the stage). They are child routes of a layout
  that holds the disclaimer gate and footer, so an exercise is a deep link and browser Back works. An
  AppNav link sits after Rolls. Flux is not a dock item and adds nothing to Home.
- **Library:** 19 exercises in four categories. Condition chips (All / Herniated disc / Sprain-strain /
  General) and **stage chips** (new; the data was always there). Both chips persist per device: the condition
  is what shows a contraindication on the stage, so resetting it on Back (flux did that) would hide one.
  Each card shows a measurement badge (Measured / Approximate / Guided), an _End-range_ label for the two
  `provocative` exercises, and a _Caution_ badge when the active condition is contraindicated.
- **Stage:** the camera box with a mirrored video and landmark overlay, and inside it the HUD:
  - tracking badge with fps and a GPU/CPU glyph;
  - voice toggle;
  - the **live readout** (count, hold ring, reposition prompt) top-right, so a set reads without
    scrolling (D29);
  - Calibrate / Re-calibrate and Stop;
  - the last notice or cue.

  From `sm` up the box is capped at `max(50dvh, 20rem)`, so the panel starts on screen. The capture bar is hidden on
  the stage; running timers stay (D30).

  Below the box come the name, badge and voice picker, the **Side A / Side B** toggle for the three one-sided
  stretches, the precaution banner with the contraindication gate, the calibration hint, the exercise panel,
  "Sets this session", the live range since calibrating, the Roll strip, and **Details** (a debug readout).

- **Settings → Flux:** "Count sessions as reps of" (a Roll) and "Show the Flux disclaimer again". Both are
  synced Settings fields (`fluxRollId`, `fluxDisclaimerAckAt`). Voice on/off, voice name, chips, forced
  CPU and the GPU-boot mark are per device (`aperture.flux.*` in `localStorage`): voices differ per OS, and
  the delegate is a property of the device.

## 2. Where it lives

| Path                                              | What                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/flux/`                       | The catalog: `types`, `definitions` (flux's, except the hold times — D31), `catalog`. Reached as the **subpath `@aperture/shared/flux`**, never from the root barrel, because flux's `Category` would collide with Aperture's.                                                                                                          |
| `app/src/modules/flux/engine/`                    | `headPose` (matrix → Euler, the 1€ filter, ROM), `evaluate` (the five-kind reducer), `core` (the hot loop's state as a pure class), `side`, `protocol`, `flux.worker`, `assets`, `tracker` (main-thread shell = the app's engine), `engine` (the seam + factory), `fakeEngine`, `workerEngine`, `model/face_landmarker.float16.v1.task` |
| `app/src/modules/flux/voice/`                     | `cues` (pure event → phrase reducer; counts reps at the hold, D27/D32; a short hold says Hold longer, D35), `speaker` (speechSynthesis shell)                                                                                                                                                                                           |
| `app/src/modules/flux/`                           | `useFluxEngine` (the stage's state machine), `useVoice`, `prefs`, `repState` + `RepTie`, the components                                                                                                                                                                                                                                 |
| `app/src/pages/Flux/`                             | `FluxPage` (layout + gate), `LibraryTab`, `ExerciseView`                                                                                                                                                                                                                                                                                |
| `scripts/aws/{publish-frontend,health-check}.mjs` | `.wasm` uploaded as `application/wasm`; the health check asserts it at the edge                                                                                                                                                                                                                                                         |

## 3. The engine

- **The hot loop runs in a module Web Worker.** The main thread grabs each video frame
  (`requestVideoFrameCallback`, falling back to `requestAnimationFrame`) as an `ImageBitmap` and transfers
  it. The worker runs MediaPipe Face Landmarker, then `FluxCore`: the matrix goes to Euler, then the 1€
  filter, then neutral-relative angles, ROM and the evaluator. Only derived numbers cross back: a sample
  and the overlay points every frame (the main thread re-renders them at ~16 Hz), exercise state at
  ~15 Hz, and events unthrottled. **Video never leaves the device**, and nothing in the engine talks to
  the API.
- **Backpressure:** the worker acks every frame (`frameDone`), dropped or not, and the main thread sends
  the next frame only after the ack, with a 2 s watchdog. flux's guard covered only the bitmap grab, so on a slow CPU path
  frames queued in the worker without bound.
- **One landmarker per worker for life.** MediaPipe's module glue hands its factory over once per realm. A
  second `createFromOptions` in the same worker fails with "ModuleFactory not set", so **flux's in-worker
  GPU→CPU retry could never have worked**. Flux changes delegate by **replacing the worker**. The neutral and
  the selection ride along in `init`, so a fallback mid-session keeps calibration.
- **Delegate policy** (`tracker.ts`, `prefs.ts`):
  - GPU first.
  - A GPU init failure, or five consecutive `detectForVideo` throws, replaces the worker on CPU and says
    so on the stage ("switched to the CPU").
  - A failure on CPU, or any asset failure, is an error with copy and Try again.
  - An init with neither download progress nor `ready` for 30 s counts as a failed init (GPU → CPU,
    CPU → error), so a GPU init that hangs instead of throwing can't spin forever.
  - A fallback replaces the worker, so the current set restarts; the neutral carries over and the stage
    says both.
  - `aperture.flux.gpuBoot` marks only the risky window: set when the worker reports it's starting a GPU
    init (`initStarted`, after the download), cleared at the first sample, on any failure, on Stop, and
    when the page is hidden mid-boot (iOS evicting a backgrounded PWA isn't a GPU crash). Still set at
    the next start means the GPU took the page down, so that start is on CPU. The CPU is sticky, but
    the stage says why and offers **Try the GPU** (D25).
  - The HUD glyph forces CPU, or asks for the GPU again, which also forgives the mark.
  - GPU output can be wrong without throwing on WebKit (MediaPipe issue 6142). Only the Details readout
    and the glyph catch that.
- **Assets are self-hosted and app-cached** (`assets.ts`, inside the worker):
  - The JS glue is a hashed `?url` import of the package's `vision_wasm_module_internal.js`, which the
    SW precache already covers.
  - The 13 MB wasm and the 3.76 MB model are fetched through the Cache API (`aperture-flux-assets`)
    with byte progress, so only Flux users pay for them.
  - The wasm is handed to MediaPipe as a `blob:` URL typed `application/wasm`. The model goes in as
    `modelAssetBuffer`.
  - A `text/html` response (a missing asset served as the SPA fallback) is refused rather than compiled.
  - Old hashed entries are pruned. There is deliberately no Workbox runtime cache on top: it would
    store the 17 MB twice and could cache a missing asset's SPA-fallback HTML.
  - No CDN is involved, and nothing changes in `cdk/`: there is no CSP or Permissions-Policy to widen,
    and the bundle never touches `SharedArrayBuffer`, so no COOP/COEP is needed.
- **Version:** `@mediapipe/tasks-vision` pinned at **1.1.0** (exact). The FaceLandmarker API, the
  `exports` map and the six wasm filenames are identical from 0.10.35 to 1.1.0 (tarballs diffed, 2026-10-08);
  1.1.0 costs +1.84 MB of wasm. If Safari fails on 1.x, fall back to 1.0.1, then 0.10.35.
- **The model is committed** at `float16/1`: 3,758,596 bytes, sha256 `64184e22…0bc9ff`, unchanged
  at Google since 2023-05-03. `app/pwa/fluxModel.test.ts` asserts both. Committing one rarely changing
  3.8 MB file beat LFS (pointer files break silently) and a build-time fetch (Google's bucket becomes a
  deploy dependency).
- **Lifecycle:**
  - `visibilitychange` (hidden) or the track's `ended` event releases the camera and shows **Camera
    paused**. The worker and neutral are kept, and Resume re-acquires the stream.
  - Stop and Back release everything; the neutral is lost (flux parity).
  - A camera granted after Stop is released immediately.
- **Speech:**
  - iOS speaks only after a gesture (WebKit 223473), so Start primes the speaker with a real "Voice on"
    utterance. A zero-length unlock is folklore.
  - `speak()` can pause a `<video>` playing a `getUserMedia` stream (WebKit 218815, still reported on
    iOS 27). The tracker re-plays any pause it didn't ask for.
  - The last cue is mirrored on the HUD, so a silent switch or ducking never hides it.
  - Ducking itself can't be fixed from the web.

## 4. Decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Rejected                                                                                                                                  | Why                                                                                                                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Name **Flux**, route `/flux`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | "Neck", "Rehab"                                                                                                                           | Rahul's call: keeps the original name                                                                                                                                                                                                                          |
| D2  | Pin MediaPipe 1.1.0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 0.10.35 (flux's)                                                                                                                          | API-identical by diff; the Safari unknowns are tested on-device anyway                                                                                                                                                                                         |
| D3  | Self-host + app-cache the wasm and model                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | jsDelivr + GCS                                                                                                                            | Privacy at the network level, offline after first use, cost under $0.01/month                                                                                                                                                                                  |
| D4  | Commit the model                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | LFS; fetch at build; one-off S3 upload                                                                                                    | See §3                                                                                                                                                                                                                                                         |
| D5  | Catalog in `packages/shared` behind a subpath                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Keep it in `app/`                                                                                                                         | The next PR's Lambda (refusing unknown ids) and MCP (exercise names) need it; the subpath avoids the `Category` clash                                                                                                                                          |
| D6  | Nested routes, an exercise is a deep link                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | flux's single route with in-memory selection                                                                                              | Back, bookmarks, PWA relaunch                                                                                                                                                                                                                                  |
| D7  | Condition and stage chips persist (per device)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Reset to All on Back (flux)                                                                                                               | The contraindication only shows under its condition                                                                                                                                                                                                            |
| D8  | Contraindication acks per visit, in memory                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Remembered                                                                                                                                | A safety gate shouldn't be remembered forever (flux parity)                                                                                                                                                                                                    |
| D9  | Stage chips + an _End-range_ label                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Leave the data unexposed                                                                                                                  | Data existed; cheap                                                                                                                                                                                                                                            |
| D10 | speechSynthesis only, with the picker                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Pre-recorded cue clips                                                                                                                    | Parity; clips are a follow-up if iOS speech fails on-device                                                                                                                                                                                                    |
| D11 | **"Again" for every kind** — one guard in `evaluate()`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | flux's Again on three kinds                                                                                                               | Also fixes flux's bug: guided and reposition carried `holdsDone` / `trialsDone` / error sums into the next set                                                                                                                                                 |
| D12 | Disclaimer copy kept except the privacy line ("Only set results — counts and angles — are ever saved to your account")                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Verbatim ("no data ever leaves")                                                                                                          | Would be false once history syncs                                                                                                                                                                                                                              |
| D13 | Stacked layout at every width                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | flux's `lg` two-column                                                                                                                    | The shell is `max-w-3xl`; phone first                                                                                                                                                                                                                          |
| D14 | No COOP/COEP, CSP or Permissions-Policy changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Add headers                                                                                                                               | None needed (§3); COEP would break Plaid and Cognito                                                                                                                                                                                                           |
| D15 | Two PRs: engine + page + Roll tie, then history + backend + MCP                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | One PR (about 85 files)                                                                                                                   | Review stays tractable; page-first                                                                                                                                                                                                                             |
| D16 | Colours: sky → `teal`, emerald → `gold`, amber → `gold-soft` + `ink`, red → `danger`, slate → `panel` / `line-strong`                                                                                                                                                                                                                                                                                                                                                                                                                                                               | flux's palette                                                                                                                            | PRODUCT §5; WCAG tiers                                                                                                                                                                                                                                         |
| D17 | No keyboard shortcuts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `c` / `space` / `m`                                                                                                                       | Phone-first; flux had none                                                                                                                                                                                                                                     |
| D18 | **Roll tie:** the first finished set starts today's rep (`planned` or `backlog` → `in_progress`); Stop offers the DoneForm prefilled with `max(session minutes, the rep's live elapsed)`; Stop before any set offers nothing                                                                                                                                                                                                                                                                                                                                                        | Habit auto-check; night line only; starting the rep on camera start                                                                       | A session is timed work, so calibration rides it; a session that produced nothing shouldn't count                                                                                                                                                              |
| D19 | `fluxRollId` and `fluxDisclaimerAckAt` live in Settings (synced)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `localStorage`                                                                                                                            | Accept once, not once per device; same cost                                                                                                                                                                                                                    |
| D20 | Side **A / B**, not left / right                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Left / right labels                                                                                                                       | The yaw/roll sign convention is unverified until the dev test                                                                                                                                                                                                  |
| D21 | Details readout always available, collapsed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Dev/stub only                                                                                                                             | Read-only numbers; prod misbehaviour stays diagnosable                                                                                                                                                                                                         |
| D22 | Calibrate refused without a face                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | flux's copy of the last smoothed pose                                                                                                     | No silent zero or stale neutral                                                                                                                                                                                                                                |
| D23 | Paused and ready are separate: a worker that comes up while the camera is paused leaves the stage paused; Resume before ready goes back to loading                                                                                                                                                                                                                                                                                                                                                                                                                                  | One status field                                                                                                                          | A backgrounded download used to flip the stage to running with no camera                                                                                                                                                                                       |
| D24 | Session minutes are **active** time: from the first `ready`, paused stretches excluded; each Start is a new session (sets and clock reset)                                                                                                                                                                                                                                                                                                                                                                                                                                          | Wall-clock from Start                                                                                                                     | The Actual feeds calibration — a phone left in the background shouldn't inflate it                                                                                                                                                                             |
| D25 | After a crashed GPU boot the next start is on CPU and stays there, with a note and **Try the GPU**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | One silent retry on GPU                                                                                                                   | A retry would take the page down on every other launch if the GPU path really crashes                                                                                                                                                                          |
| D26 | A mid-set fallback restarts the set (the new worker's evaluator is fresh); the neutral is kept                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Carry evaluator state into the new worker                                                                                                 | Rare; the stage says the set restarted                                                                                                                                                                                                                         |
| D27 | The voice **counts reps** ("One" … "Twenty", digits past that); counts and "Set complete" are `always` priority (bypass the gates, queue, never interrupt); "Good" / "full range" dropped. The count rides the `repCompleted` event                                                                                                                                                                                                                                                                                                                                                 | flux's phrases; counting in the reducer; `high` for Set complete                                                                          | Dev test (2026-10-09): the phrases grated and the number is the information. A reducer count can't survive Again or a fallback; `high` cancelled the final count                                                                                               |
| D28 | The off-plane warning is **visual only**, threshold 20°                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Spoken, at 15°                                                                                                                            | Dev test: it fired constantly; the panel's Keep steady line already says it                                                                                                                                                                                    |
| D29 | The live readout (count, hold ring, prompt; a gold count once done) is **overlaid on the video**, and cues show left of it; counts aren't mirrored as text (the digit is the mirror). The stage is capped at `max(50dvh, 20rem)` from `sm` up                                                                                                                                                                                                                                                                                                                                       | Panel only; capping phones too                                                                                                            | On a Mac the 4:3 stage was ~576 px tall, so the counter sat below the fold mid-set                                                                                                                                                                             |
| D30 | The capture bar is hidden (not unmounted — it keeps its draft) on `/flux/:exerciseId` via a route `handle` (`lib/routeHandle.ts`); `/` doesn't focus it there; timers stay                                                                                                                                                                                                                                                                                                                                                                                                          | A toggle; a path match inside AppShell                                                                                                    | Nothing to capture mid-set; it ate the bottom of the screen; the shell stays feature-agnostic                                                                                                                                                                  |
| D31 | Hold times retuned: ROM reps 2 → 4 s, the three stretches 30 → 10 s, the four isometrics 10 → 5 s; deep-neck-flexor and scapular-retraction stay 10 s                                                                                                                                                                                                                                                                                                                                                                                                                               | flux's values                                                                                                                             | The user's call after the dev test; pinned in `definitions.test`                                                                                                                                                                                               |
| D32 | ROM reps with a hold **count aloud the moment the end-range hold is up** (`holdReached{count}`, once per excursion); the rep still counts on return, and `repCompleted.holdReached` keeps the return silent, so the reducer stays stateless. An early return (and eye-head coordination, which has no hold) is counted on return — **since D35 an early return is no rep**                                                                                                                                                                                                          | Counting on return (flux); counting the rep itself at the hold; reducer memory of "already said"                                          | Dev test (2026-10-10): the user does these eyes closed and nothing said the time was up. The on-screen count and `reachedTarget` don't move; a flag on the event survives Again and a fallback (D27's reasoning)                                               |
| D33 | A hold at target that **breaks after ≥ 1 s**, with the head out for 0.3 s, says "Back into position" (`holdBroken{heldSec}`, `normal`, 3 s cooldown); `positionLost` stays silent                                                                                                                                                                                                                                                                                                                                                                                                   | Speaking `positionLost`; the threshold in the reducer; "Back into the stretch"                                                            | Sub-second holds and one-frame edge blips are flicker, and a wrong "Back into position" with eyes closed is worse than a late one; the evaluator owns thresholds (like the posture warning); the wording fits chin tuck and retraction, which aren't stretches |
| D34 | "And release" is `always` priority, for both hold kinds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `normal` with a 500 ms cooldown                                                                                                           | Eyes closed, it's the signal the time is up, and the 600 ms gap could drop it behind "Hold it there"; timer-paced (≥ 3 s), so it can't chatter                                                                                                                 |
| D35 | A ROM rep with a hold **counts only once the full `holdSec` is held**: a return below `exitDeg` before that is no rep (counts and averages untouched) and says "Hold longer" (`holdShort{heldSec}`, `always`), but only past the same 1 s bar as D33 — shorter is silent. Exercises with no hold still count on return; the panel hint reads "hold 4s to count". Hold time is measured on the excursion’s own side (a jump across is a return); a face dropout at end range still counts as held (the core keeps the last pose — lenient on purpose, that is where the face drops) | Counting the rep and only flagging `reachedTarget` (D32's original rule, flux's); a cooldown in the reducer; saying it on every excursion | The user's call (2026-10-12): a 2 s hold of a 4 s requirement shouldn't count. Hysteresis paces it to one per real attempt, so the evaluator's floor is the only chatter guard needed; sub-second nods while settling in shouldn't nag with your eyes closed   |

## 5. Parity with flux-track-2

Everything flux had is here. Each item is listed with where it lives, or what changed.

- **Library:** condition chips, four ordered categories with icons and counts, empty categories hidden,
  cards with name, chevron, a two-line clamp, measurement badge and Caution.
- **Stage overlays:** idle copy, Start camera, "Loading model…" (now with byte progress), error with Try again
  (flux's was dead: `stop()` overwrote the error in the same batch), plus the new paused overlay.
- **HUD:** Tracking / No face with fps, the voice toggle with flux's aria and title strings, Calibrate
  neutral / Re-calibrate, Stop.
- **Header row:** name, measurement badge, the voice `<select>` ("Auto voice", previewing "Hold it
  there" on change; flux previewed "Good, full range", which no longer exists).
- **Precautions:** the precaution banner and contraindication gate (strings verbatim, warn never hide),
  the calibration hint, and the ack-gated panel (the engine runs with no exercise until acknowledged).
- **Exercise panel:** every kind's panel and strings:
  - romReps: counter, end-range HoldRing, progress bar, Side A/B, compensation warning;
  - holdAtTarget: ring, "Hold n / reps", ▲/▼ chips, "In position — hold";
  - guidedHold: HOLD/rest ring, drift warning, "Rep x / n";
  - reposition: prompts and average error;
  - oscillation: seconds ring, cycles and swing.
- **Start block** and the instructions with cues.
- **Engine:** the 1€ filter (1.2 / 0.02 / 1.0), Rz·Ry·Rx with the gimbal fallback, no face holds the last
  pose, the 15 Hz state throttle, controls applied between frames.
- **All 19 definitions are flux's except the hold times (D31).** The gated phrases keep flux's cooldowns,
  600 ms gap and 1,200 ms dedup; rep counts replace "Good" / "Good, full range", and counts, "Set
  complete", "And release" and "Hold longer" bypass the gates (D27, D34, D35). ROM counts are spoken when the end-range hold
  is up, not on return (D32); a hold that breaks after a second says "Back into position" (D33). A ROM rep returned before its hold is up doesn't count
  and says "Hold longer" (D35); flux counted on return regardless. The posture warning is silent (D28).
- **Persistence:** flux's three `localStorage` keys became `aperture.flux.voice` and `voiceName`
  (per device) and `fluxDisclaimerAckAt` (Settings).
- **Footer:** "Not a medical device…" on every Flux screen.

**Dropped:** the SSR "Loading…" pre-mount and the page `<title>`, both of which don't apply in an SPA.

**Better than flux:**

- deep links;
- Again for every kind, plus the carry-over fix;
- Side B for the three one-sided stretches (flux could only ever register one side);
- live ROM (computed by flux but never shown);
- backpressure, pause/resume, the speech pause guard;
- a real error state with per-cause copy;
- GPU fallback that actually works, plus the crash mark;
- offline after the first download, with no third-party hosts;
- the Roll tie;
- the live count and hold ring on the video, rep counts spoken the moment a hold is up, and a spoken
  nudge when a hold breaks or is cut short — usable eyes closed;
- tests on the effectful shell (core, tracker, speaker, assets, hook), where flux had none.

## 6. What each test surface proves

- **Node-style unit tests (jsdom env, no DOM use):** flux's 47 ported tests unchanged, plus:
  - `core` (timestamps, calibration guard, ROM, throttle, side B);
  - `evaluate` Again for all four kinds (each confirmed failing without the guard), hold-reached once
    per excursion at the crossing frame, broken holds only past a second (never on the release after
    a hold), and short ROM holds dropped (said only past a second);
  - `side`, `repState`, `prefs`, the catalog additions, and the model sha256.
- **`fakeEngine.test`:** the synthetic head finishes a set of **all 19 exercises, both sides**, through
  the real core. That's the guarantee behind the headless review on `?engine=fake`.
- **`tracker.test`** (fake Worker and stream): the init message, backpressure, GPU→CPU replacement with
  the neutral carried over, CPU failure as an error, the GPU-boot mark, hidden → paused → resumed,
  `ended` → paused, the speech pause guard, stop releasing everything, and a camera granted after stop.
- **`assets.test`:** cache miss then hit, monotone progress, the SPA-fallback guard, HTTP errors, and
  CacheStorage refusing to open.
- **`speaker.test`:** unlock once, voice resolution order, high priority cancels, late voices.
- **Page tests (`renderApp` + the manual fake):**
  - the gate (including deep links), the library, chips persisting, Caution, cards as links;
  - every stage status, calibration, the contraindication gate, side B, Back stopping first;
  - voice and delegate persistence, the fallback note;
  - the Roll tie end to end (pick → first set starts → Stop → DoneForm → done);
  - Settings link and disclaimer reset.
- **Not provable off-device:** everything in §7. jsdom has no camera, Worker or wasm. Headless Chromium
  proves layout on the fake engine, not WebKit.

## 7. On-device checklist (iPhone PWA from `dev`, then macOS Safari)

Open **Details** on the stage; it's the instrument.

1. **Boot:**
   - Cold launch → `/flux/cervical-rotation` → Start: the camera prompt shows, the download shows bytes,
     and `delegate` reads GPU or CPU. Note which, and the fps.
   - Move: `raw` changes smoothly and the overlay dots sit on the face.
   - Tap the glyph to force CPU and compare fps and angles. Wrong-but-silent GPU output is only catchable
     here.
   - Relaunch in airplane mode → no download, tracking works.
2. **Signs:** calibrate, then:
   - turn right → note the `rel` yaw sign;
   - tilt right ear to right shoulder → note the roll sign;
   - chin down → pitch should be positive.

   A wrong sign is a one-field flip in `definitions.ts`.

3. **Speech:**
   - "Voice on" is audible at Start.
   - The rep count ("One", "Two"…) is audible without a tap.
   - Neck rotation, eyes closed: the count comes when the ring fills, before you return, and no count on
     return (only "Set complete" after the last rep). Come back at about 2 s → "Hold longer", and the
     count stays put.
   - Chin tuck: drift out after about 2 s → "Back into position"; "And release" is audible at the end of
     every hold.
   - Repeat with the silent switch on.
   - Check whether the preview freezes while a cue speaks.
4. **Camera lifecycle:**
   - Background mid-session → Camera paused → Resume. Note whether it re-prompts. Repeat after a screen
     lock.
   - Check the portrait `track` size and whether the video is rotated.
   - Back (link and swipe) turns the camera light off.
   - Deny, then allow → Try again works.
5. **Exercises:** one set each of cervical-rotation, chin-tuck, deep-neck-flexor, joint-position-sense
   and gaze-stability; upper-trap on both sides.
6. **Roll tie:** link a Roll in Settings → pick it → the first set starts the rep (check Home's Right now)
   → Stop → DoneForm → Mark done → the contact sheet fills.

## 8. Known limits and follow-ups

- **WebGL2 is required on both delegates.** MediaPipe's web runtime uploads every input image through a
  GL context even on the CPU delegate. Probed on 2026-10-08 against the built worker with a synthetic frame:
  - Headless Chromium: GPU ready in 0.3 s, samples flow; CPU ready in 0.2 s, samples flow.
  - Headless Linux WebKit: GPU init fails (`emscripten_webgl_create_context() returned error 0`); CPU
    boots, but every detect throws `GLctx.activeTexture`, so Flux shows "Tracking stopped working".

  **macOS Safari verified 2026-10-09** (local dev test): GPU, about 23 fps. iOS is still unverified;
  phase-8 checklist item 1 settles it. If real Safari fails both delegates, the follow-up is inference on the main thread.

- **Clinical honesty:** angles are relative to a per-session neutral. Exercise parameters are flux's
  except the hold times (D31), with no clinical claim.
- **Ducking:** iOS lowers other audio while a cue speaks. Can't be fixed from the web.
- **The wasm is served uncompressed:** CloudFront won't compress files over 10 MB. It's a one-time
  download per device, so precompressing is a follow-up only if first load bothers.
- **Next PR (history):** `FluxSetDraft` (`useFluxEngine.ts`; it carries the condition chip and the
  set's duration) is what `recordFluxSet` will persist (a `flux#` single-table row), plus a `repTaskId`
  linking the Roll rep the set counted toward. Also in that PR:
  - a History tab under the `FluxPage` layout;
  - a night-home line;
  - MCP `list_flux_sets` / `list_flux_exercises`;
  - a Haiku-written weekly trend note (an Aperture task).
- **Other follow-ups:**
  - pre-recorded cue clips, if iOS speech fails on-device;
  - Pose Landmarker for shoulders and posture, and DTW form matching (flux's roadmap).
