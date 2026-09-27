# Task Attachments

**Area:** tasks · **Branch:** `task-attachments`

**Status: built 2026-09-17** (branch `task-attachments`, forked from `main` after the CI-pipeline refactor #15). Page-first: UI validated on the stub (headless pass, zero console errors) before the Lambda + S3 were wired. Gate green: typecheck (6 projects) · lint · tests (app 200 · lambdas 79 · shared 33 · cdk 21 · scripts 12) · headless UI pass · `cdk synth` clean (cdk-nag). **Dev-validated** — the presigned round-trip against real S3 + CORS was confirmed on `dev`; the polish that followed landed in `b6ed97e` (2026-09-19, §7 Phase 6).

Attach files to a task — a receipt, a spec, a screenshot. This is the first feature in Aperture that stores **bytes**, not just JSON rows, so most of its weight is infrastructure: a new S3 bucket, presigned-URL transport, and an IAM grant. The task model itself gains only a lightweight metadata child.

Permanent design-of-record: §3 is the decision log, §7 the build record. Where this doc and the code disagree, fix whichever is wrong and say so here.

---

## 1. Why

Two of the three life-buckets Aperture serves generate artifacts: an assignment has a PDF spec, an application has a screenshot of the portal, a reimbursement has a receipt. Until now a task could only hold text. Attachments let the thing a task is *about* live on the task, instead of in a folder you have to go find.

The hard part isn't the UI — it's that Aperture's BFF is a strictly-JSON RPC edge with **no binary path**, and there was **zero blob storage**. Doing this without turning the clean JSON Lambda into a file-proxy, and without a `DESTROY`-policy bucket touching user data, is the whole design.

## 2. Two planes: metadata vs bytes

Everything about an attachment splits across two stores, and the split is the design:

```
ATTACHMENT
   │
   ├─ metadata  →  DynamoDB   (attach#<taskId>#<id> under the user's partition)
   │                filename · contentType · size · s3Key · status · tombstone
   │
   └─ bytes     →  S3         (u/<userId>/<taskId>/<id> in the precious Files bucket)
                    never in DynamoDB (400 KB item cap), never through the Lambda
```

The Lambda only ever handles the metadata plane. The bytes plane is browser↔S3 directly, authorized by a short-lived presigned URL the Lambda *signs* but never carries. That's what keeps the RPC edge JSON-only.

## 3. Decision log

Every decision we made, the reasoning, and the alternative turned down. Locked unless revisited here (with a date).

**D1 — Presigned URLs; bytes never cross the BFF.**
The Lambda mints a presigned PUT (upload) / GET (download); the browser transfers bytes straight to/from S3.
*Why:* the handler is a small JSON-RPC edge (`JSON.parse(event.body)`, always `JSON.stringify` back). A binary/base64 path would bloat every request, hit the 6 MB Lambda payload cap, and pay to stream bytes through compute. Presigning keeps the Lambda a pure control plane.
*Rejected:* proxying uploads through the Lambda (base64 body). Simpler client, but caps file size at ~4.5 MB, doubles egress cost, and puts bytes in a place that only needed to sign a URL.

**D2 — Any file type, not photos-only.**
Any MIME type is accepted; a **web-renderable** image (`isImage`: jpeg/png/gif/webp/avif) renders a thumbnail, everything else — including images browsers can't decode (HEIC/HEIF/TIFF) — a generic file chip.
*Why:* the real uses (PDF spec, receipt, screenshot) are mixed. Photos-only would force "print to image" workarounds.
*Rejected:* an image allow-list. It would reject the most common artifact (a PDF) for no safety gain, since serving safety comes from D6, not from the stored type.

**D3 — Caps: 20 MB/file, 10 files/task; 15-min upload TTL, 5-min download TTL.**
Constants in `packages/shared/src/attachments.ts`, read by stub, backend, and the UI pre-check.
*Why:* 20 MB covers phone photos / PDFs / screenshots and a short clip, while staying small enough for a single XHR PUT (no multipart) on mobile; worst case is 200 MB/task ≈ $0.005/mo. 10 files keeps the card a strip, not a file manager. 15 min absorbs a slow mobile PUT; the download link is minted per view and short-lived.
*Rejected:* no cap (abuse + unbounded cost); a global quota (more state for no real gain at single-user scale).

**D4 — A `pending → ready` status; a row isn't listed until its bytes exist.**
Metadata is written at **presign time** (so the server owns size/type and can verify ownership on confirm/delete), but `listAttachments` returns only `ready` rows. The browser flips it to `ready` via `confirmAttachment` after the PUT succeeds.
*Why:* if we wrote metadata only after upload, the server couldn't scope/validate the presign; if we listed pending rows, a failed upload would show a broken file. A pending row whose upload TTL has elapsed can never become ready — `confirmAttachment` **rejects** past the TTL — so it stops counting toward the cap (`countsTowardCap`) without being resurrectable: a harmless orphan, same class as its never-uploaded bytes.
*↳ Fixed in review:* the first cut let `confirmAttachment` flip *any* pending row to ready, so an expired-and-discounted row could be confirmed → cap bypass + a byte-less `ready` row. `confirmAttachment` now enforces the TTL in both impls, pinned by a contract test.
*Rejected:* write-after-upload (loses server authority over the presign); a client-generated id (server must own the key).

**D5 — A new *precious* Files bucket, not the Site bucket.**
`ApertureData` (the RETAIN/PITR stack) gains a `Files` bucket: `RETAIN`, versioned, `BLOCK_ALL` public, `enforceSSL`, `BUCKET_OWNER_ENFORCED`, **no** `autoDeleteObjects`.
*Why:* the existing `Site` bucket is `DESTROY` + `autoDeleteObjects` — correct for re-syncable build assets, catastrophic for user data. User bytes belong beside the DynamoDB table, under the same "never destroyed by a deploy" policy. Versioning is the undo for an overwritten/deleted object (noncurrent versions expire after 30 days to bound cost).
*Rejected:* reusing the Site bucket (data loss on the next app-stack destroy); a bucket in the app stack (a deploy could delete it).

**D6 — Object-scoped IAM; size signed; serving forced.**
The Lambda gets `s3:PutObject/GetObject` on `arnForObjects('u/*')` only — never bucket-level, never List. The presigned PUT signs **content-length** (the size cap is cryptographic — a client can't lie about size). The presigned GET forces `ResponseContentType` + `ResponseContentDisposition`: **`inline` for browser-renderable, script-free types** (`viewableInline` — image, PDF, `text/*`, audio, video), and **`attachment; filename*=…` for `text/html`, SVG / anything `xml`, and unknown binaries**. So markdown/PDF/images open in the tab, while active content is forced to a download — even though bytes serve from a separate S3 origin with no app session, that carve-out is cheap defense-in-depth.
*Why:* a presigned URL acts with the *signer's* permissions, so the IAM scope is the blast radius of a leaked URL — bounded to object keys under `u/`. Forcing the download disposition means SVG/HTML/PDF-with-JS never render inline from the S3 origin, so a malicious upload can't run as script.
*↳ Reality check (found in build):* the AWS SDK signs **content-length but NOT content-type** into the PUT (verified in `presigner.test.ts` — `SignedHeaders` is `content-length;host`). So the *size* is cryptographically fixed; the content-type is set on the object but not signature-bound. That's fine: serving safety comes from the forced `ResponseContentType`/`Disposition` on the GET (server-controlled), not from the stored type. The plan had claimed both were signed; corrected here.

**D7 — On task delete: tombstone metadata, orphan bytes. And cancel ≠ delete.**
When a task is deleted (`deleteTask`), its attachment *metadata* is tombstoned; the S3 objects are left in place (no sweeper). **Cancelling** a task (`transitionTask → 'cancelled'`) does **not** touch attachments — a cancelled task is still a record.
*Why:* orphaned bytes cost pennies and a sweeper is real complexity + a destructive code path we don't need yet. Cancel is a lifecycle state, not a deletion, so its files stay.
*Landed:* `deleteTask` now honors this — it tombstones the task's attachment metadata (via `repo.listAttachmentsForTask`) alongside its plan rows, orphaning the bytes. Pinned by `backend.test.ts` (`backend task delete` tombstones metadata; `cancel ≠ delete` covers the other side). See [TECH.md §2.2 tasks](../../arch/TECH.md#22-entities).
*Deferred (not rejected):* a bytes-cleanup sweeper (a scheduled job over tombstoned/pending keys).

**D8 — Export carries metadata only, never bytes.**
`ExportBundle.attachments` holds the `ready` metadata rows; the bytes are never in the JSON export.
*Why:* the export is a one-way JSON download of the user's data; the `s3Key` is the handle a future bytes-export would need. Including metadata is also *compile-forced* — adding `attachments` to the stub `Store` makes `exportData`'s `satisfies Record<keyof Store, unknown>` fail until it's in `ExportBundle` and both impls, so "should it be in the export?" is answered by the mechanism.
*Rejected:* base64 bytes in the export (could be gigabytes; the download is meant to be small + inspectable).

**D9 — CORS origin = the custom domain; no new CloudFront behavior.**
The Files bucket's CORS `allowedOrigins` is the stage's custom domain (`https://…`), or `*` before a domain is wired. Presigned PUT/GET go **straight to S3**, bypassing CloudFront.
*Why:* because the transfer bypasses CloudFront, no new distribution behavior is needed — only bucket CORS. The presigned URL is the real credential; CORS is a browser courtesy, so `*` pre-domain is acceptable. The origin is derived from `domainConfigFor(stage)` in `bin/aperture.ts` and passed **into** the data stack (app depends on data — deriving it in the app stack and mutating the data bucket would be a stack cycle).
*Rejected:* a second CloudFront behavior + OAC origin for `/uploads/*` (more infra, and OAC can't sign the browser's PUT); CORS off the CloudFront default domain (it wouldn't match the app's origin on a domained stage).

## 4. Data model

A metadata child of the task, keyed under the user's partition:

```ts
Attachment extends BaseEntity {
  taskId; filename; contentType; size; s3Key; status: 'pending' | 'ready'
}
```

- **Key:** `attach#<taskId>#<id>` (ULID `id`). A task's files are one `begins_with` query, in upload order (ULIDs sort by time); `attach#` spans all tasks (export, find-by-id, future task-delete cascade).
- **S3 key:** `u/<userId>/<taskId>/<id>` — scoped by the Cognito `sub`, never the filename (the filename is display-only, sanitized, and goes into `Content-Disposition` on download).
- **Persists for free:** stored via the generic `entityItem` (`{ PK, SK, ...entity }`); `toEntity` strips key attrs. No mapping change (unlike `taskItem`, which is special-cased for the GSI).
- `alive()` filters tombstones on every read; the public list additionally filters `status === 'ready'`.

## 5. RPC surface

Five methods on `ApiClient`, registered in `API_METHODS` after the story methods (the BFF is RPC, not REST):

- `createAttachmentUploadUrl(input) → { attachment, uploadUrl }` — validates the task exists, enforces size + per-task count caps server-side (`assertAttachmentAllowed` over `countsTowardCap`), writes the `pending` row, returns a presigned PUT.
- `confirmAttachment(id) → Attachment` — `pending → ready`; idempotent; throws on a tombstoned id.
- `listAttachments(taskId?) → Attachment[]` — `ready` + alive, upload-order; all tasks when `taskId` omitted (one cached read feeds every card).
- `getAttachmentDownloadUrl(id) → string` — a short-lived presigned GET, minted per view.
- `deleteAttachment(id) → void` — soft-delete (re-put with `deletedAt`); the S3 object is orphaned.

The presigning lives behind a `Presigner` seam (`lambdas/src/s3/presigner.ts`) so the contract suite + unit tests inject a `fakePresigner()`; the real one (`createS3Presigner`) is built once at cold start from `FILES_BUCKET`.

## 6. How it's wired

Top-down; each layer talks only to the one below it. (Diagram is single-column on purpose — it must survive a proportional-font renderer, so no boxes / aligned columns.)

```
FRONTEND · app/  —  AttachmentsPanel.tsx (opened from TaskCard "Files…")
   │  useUploadAttachment → createAttachmentUploadUrl (RPC, JSON)
   ▼
CONTRACT · packages/shared  —  ApiClient · API_METHODS · Attachment · caps
   │  { args } → backend[method]
   ▼
BACKEND · lambdas/  —  BackendClient (metadata) + Presigner (signs URLs)
   │  writes metadata to DynamoDB · signs a presigned PUT/GET
   ▼
STORAGE
   ├─ metadata → DynamoDB  (PK u#<userId> · SK attach#<taskId>#<id>)
   └─ bytes    → S3        browser PUTs/GETs the presigned URL DIRECTLY,
                            never through the Lambda (the dotted line the JSON edge never crosses)
```

The upload is a three-step dance the client orchestrates: **presign** (RPC) → **PUT bytes** (browser→S3, XHR with progress) → **confirm** (RPC). The `attachmentTransport.ts` module is the only place that knows a URL might be a `stub:` sentinel (page-first) vs. a real presigned URL.

## 7. Build record

Ordered, page-first. Each phase names the files it touches; `↳` notes record divergences from the plan. Built 2026-09-17. ~38 files — the count is driven by the infra (a new bucket, IAM, stack tests) and the double-entry contract, not by the UI.

- [x] **Phase 0 — shared contract** (one atomic set; the tree is intentionally red until the stub lands)
  - `packages/shared/src/attachments.ts` — caps + `AttachmentStatus` + `normalizeContentType`/`sanitizeFilename`/`isImage`/`viewableInline`/`assertAttachmentAllowed`/`countsTowardCap`.
  - `types.ts` (`Attachment`), `api.ts` (`CreateAttachmentInput`, 5 methods, `ExportBundle.attachments`), `rpc.ts`, `index.ts`, `contractTests.ts` (lifecycle + caps tests, `attachments` in the export key-set, a tombstoned + a pending row excluded).
    - ↳ *The existing "excludes soft-deleted rows" test only covered categories + plans; extended it to attachments (tombstoned AND never-confirmed both absent from the export).*

- [x] **Phase 1 — stub + app UI (page-first)**
  - `stubClient.ts` (`Store.attachments`, methods, export filter), `attachmentTransport.ts` (stub blob map + XHR PUT), `useAttachments.ts` + query keys, `lib/format.ts` (`fmtBytes`), `components/icons.tsx` (`PaperclipIcon`), `AttachmentsPanel.tsx`, `TaskCard.tsx` ("Files…" overflow at every status + a paperclip count on the meta line).
  - Tests: `attachmentTransport.test.ts`, `AttachmentsPanel.test.tsx` (upload happy path, cap rejection, delete-confirm).

- [x] **Phase 2 — headless UI pass** (`run-app`, stub)
  - Drove `/tasks` → Backlog → a card's "Files…" → uploaded a PNG + a PDF → thumbnail vs chip, sizes, the `📎 2` meta count, the inline delete-confirm strip. Zero console errors.
    - ↳ *No UI fixes needed. The stub's `stub:` URLs resolve to in-memory object URLs; jsdom-safe because `resolveViewUrl` guards `createObjectURL`.*

- [x] **Phase 3 — backend**
  - Deps `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` `@3.1102.0` (**dependency discipline: category B** — SigV4 query-string presigning is security-critical / subtle-correctness we must not hand-roll; the rejected roll-our-own is ~200 lines of signing + canonicalization. Pinned to the existing DynamoDB SDK line, externalized in the Lambda runtime → zero bundle impact; the only new transitives are a few `@smithy/*` the DynamoDB client already pulls). `s3/presigner.ts` (seam + fake), `ddb/keys.ts` (`attach#`), `ddb/repo.ts` (list/find/put), `backend.ts` (5 methods + export), `handler.ts`/`index.ts` (presigner injected via `RpcDeps`), `backend.contract.test.ts` (fake presigner in both passes). Tests: `keys.test.ts`, `presigner.test.ts`, `backend.test.ts` (tombstone survives, S3-key scheme, cancel ≠ delete, cross-user 404). `scripts/src/smoke.ts` gains `listAttachments` (also proves the S3 SDK loaded at cold start).
    - ↳ *`presigner.test.ts` revealed content-type is not signed into the PUT — the security story was adjusted in D6's reality check.*

- [x] **Phase 4 — CDK / infra**
  - `data-stack.ts` — the `Files` bucket (RETAIN, versioned, BLOCK_ALL, CORS PUT/GET/HEAD, lifecycle) + `allowedOrigins` prop. `app-stack.ts` — `filesBucket` prop, `FILES_BUCKET` env, the object-scoped `s3:PutObject/GetObject` grant, a granular IAM5 ack. `bin/aperture.ts` — derive `allowedOrigins` from `domainConfigFor` and pass it into the data stack (before the app stack, to avoid the cross-stack cycle); a data-stack `AwsSolutions-S1` ack. `stacks.test.ts` — thread `filesBucket`/`allowedOrigins`; assert the bucket + the scoped grant + the env var. `cdk synth` clean.
    - ↳ *The IAM5 finding id embeds the Files bucket's logical-id hash (`…Files8E6940B8Arn…`), read verbatim from synth's "Acknowledge with '…'" hint — same brittleness as the existing table IAM5 ack.*
    - ↳ *`AwsSolutions-S1` is already acked at app-stack scope for the Site bucket, but the new Files bucket is in the DATA stack, so it needed its own `ack(data, …)`.*
    - ↳ *`cdk synth` proves the template only; the real presigned round-trip was confirmed later on `dev` (Phase 6); CORS from the domained origin and the runtime S3 SDK at cold start are exercised by that round-trip.*

- [x] **Phase 5 — docs + gate**
  - `docs/areas/tasks/attachments.md` (this doc), `docs/index.md`, `docs/arch/TECH.md` (entity + key line), `docs/arch/INFRA.md` (the files bucket in the data stack).

- [x] **Phase 6 — polish (after dev validation)** — three small frontend-light changes once the round-trip was confirmed on dev:
  - **Inline viewing** — `viewableInline()` widens the GET disposition beyond images (D6). `text/xml`/`application/xml` are excluded alongside `+xml` (XSLT-via-PI can execute in some browsers).
    - ↳ *Dev found a HEIC bug: `isImage` was "any `image/*`", so an iPhone `.heic` rendered a broken `<img>` (Firefox can't decode HEIC → `NS_ERROR_DOM_NETWORK_ERROR`) and inline-then-downloaded. `isImage` is now a web-renderable allow-list (jpeg/png/gif/webp/avif); HEIC/HEIF/TIFF → file chip + clean forced-download. Viewing HEIC in-browser isn't fixable (no Firefox codec).*
  - **Mint-on-click** — the download URL is now minted **fresh at click time**, not reused from mount; fixes a real dev bug where a panel open >5 min opened an expired presigned GET (`Request has expired`). `useAttachmentUrl` is now **thumbnail-only** (passed `enabled = isImage`, so a panel of PDFs mints zero GETs on mount).
    - ↳ *`window.open(url, '_blank', 'noopener')` returns **null** by spec, which would have routed every click to the fallback. Fixed: open `window.open('', '_blank')` (no `noopener`), set `tab.opener = null`, then redirect after the presign resolves. If a blocker still eats the pre-opened tab, `window.location.href` downloads in place (attachment types) or navigates (inline) — rare.*
  - **Drag-and-drop** — the panel is a drop zone (`onDragOver`/`onDrop` → the existing `onFiles`, so the cap pre-check is shared); `relatedTarget` containment stops the highlight flickering over child rows. No dependency.

## 8. Deferred / out of scope

- **Bytes-cleanup sweeper** — a scheduled job to delete orphaned S3 objects (tombstoned metadata, expired-pending uploads). Bytes cost pennies; skip until it matters.
- **`deleteTask` cascade** — ✅ landed (D7); the bytes sweeper above stays deferred.
- **HEAD-on-confirm** — `confirmAttachment` trusts the client that the PUT succeeded; a HEAD to verify the object exists would be the Lambda's first S3 call. Low value at single-user scale.
- **Multipart / resumable uploads** — a single XHR PUT is fine at 20 MB; revisit only if the cap rises to large video.
- **Bytes in the export** — metadata only for now (D8).
