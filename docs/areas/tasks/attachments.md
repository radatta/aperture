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

The Lambda only ever handles the metadata plane. The bytes plane is browser↔S3 directly, authorized by a short-lived presigned URL the Lambda *signs* but never carries. That's what keeps the RPC edge JSON-only. Its one call into the bytes plane is the delete (D7): a control call that moves no bytes.

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
The Lambda gets `s3:PutObject/GetObject/DeleteObject` on `arnForObjects('u/*')` only — never bucket-level, never List, never `DeleteObjectVersion` (D7). The presigned PUT signs **content-length** (the size cap is cryptographic — a client can't lie about size). The presigned GET forces `ResponseContentType` + `ResponseContentDisposition`: **`inline` for browser-renderable, script-free types** (`viewableInline` — image, PDF, `text/*`, audio, video), and **`attachment; filename*=…` for `text/html`, SVG / anything `xml`, and unknown binaries**. So markdown/PDF/images open in the tab, while active content is forced to a download — even though bytes serve from a separate S3 origin with no app session, that carve-out is cheap defense-in-depth.
*Why:* a presigned URL acts with the *signer's* permissions, so the IAM scope is the blast radius of a leaked URL — bounded to object keys under `u/`. Forcing the download disposition means SVG/HTML/PDF-with-JS never render inline from the S3 origin, so a malicious upload can't run as script.
*↳ Reality check (found in build):* the AWS SDK signs **content-length but NOT content-type** into the PUT (verified in `presigner.test.ts` — `SignedHeaders` is `content-length;host`). So the *size* is cryptographically fixed; the content-type is set on the object but not signature-bound. That's fine: serving safety comes from the forced `ResponseContentType`/`Disposition` on the GET (server-controlled), not from the stored type. The plan had claimed both were signed; corrected here.

**D7 — On delete: the bytes go first, then the metadata is tombstoned. And cancel ≠ delete.**
*Revised 2026-11-01 (branch `attachment-s3-delete`).* Until then the bytes were orphaned: the metadata was tombstoned and the S3 object left in place, with a sweeper deferred.
`deleteAttachment` and `deleteTask` delete each attachment's S3 object (`ObjectStore.deleteObject`, `lambdas/src/s3/objects.ts`), **then** tombstone its row. `deleteTask`'s cascade covers every attachment on the task in any status (a never-confirmed `pending` upload too) and, through the parts recursion, every part's attachments. **Cancelling** a task (`transitionTask → 'cancelled'`) does **not** touch attachments — a cancelled task is still a record.
*Order and failure:* bytes first. A failed S3 delete throws: the row stays live and still points at real bytes, so a retry works (the panel and the task editor both show the error; never a silent skip), and the live store logs one `s3_delete_failed` line. Tombstone-first would strand the bytes where nothing can reach them. If the S3 delete lands and the put fails, the row briefly points at missing bytes until the retry: `DeleteObject` on a missing key is a 204 (one more free delete marker), then the tombstone lands. `deleteTask` removes the bytes of the task and every part **before** any other cascade step, so a failure there leaves the task, its parts, plans and calendar event untouched; only the files already removed are gone, and a retry finishes.
*The undo:* the Files bucket is versioned (D5), so a plain `DeleteObject` writes a delete marker and the bytes stay as a noncurrent version for 30 days. That needs only `s3:DeleteObject`.
*Gating:* the store is a gateway like Google/Plaid. `handleRpc` pins `noopObjectStore()` in testMode, so a smoke run deletes nothing, and a handler built without one throws on delete rather than skipping the bytes. The BFF and MCP (`delete_attachment`, `delete_task`) both get the store and the grant (`grantBackendData`). The stub's twin drops the in-memory blob (`forgetStubBlob`).
*Pinned by:* `backend.test.ts` (`backend attachments`, `backend task delete`), `handler.test.ts` (testMode), `mcp/tools.test.ts`, `cdk/src/stacks.test.ts` (both roles, `u/*` only), and the devcheck scenario `attachment-delete` (a presigned GET is 200 before the delete, 403/404 after). See [TECH.md §2.2 tasks](../../arch/TECH.md#22-entities).
*Rejected:* swallowing the S3 error like `deleteCalendarEvent` does, which leaves a permanent orphan; folding the delete into the DynamoDB `Writes` object, which would thread a second store through ~20 `liveWrites` call sites.

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
- `deleteAttachment(id) → void` — deletes the S3 object, then soft-deletes the row (re-put with `deletedAt`); D7.

The presigning lives behind a `Presigner` seam (`lambdas/src/s3/presigner.ts`) so the contract suite + unit tests inject a `fakePresigner()`; the real one (`createS3Presigner`) is built once at cold start from `FILES_BUCKET`. The delete goes through the `ObjectStore` seam (`lambdas/src/s3/objects.ts`) the same way: `fakeObjectStore()` in tests, `createS3ObjectStore` at cold start.

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

- **Backfill pre-existing orphans** — a delete has removed the bytes since 2026-11-01 (D7), but objects under rows tombstoned before then are still in the bucket, and so are the bytes of an expired `pending` upload until its task is deleted, and of an upload (or MCP `attach_file`) whose PUT lands after its task was deleted. The sweep is §9 (operator, Mac). **Record:** run 2026-11-05 (dry run, steps 1–4) — dev 0 orphans (no objects under the sub) · prod 0 orphans (2 objects, both live); nothing deleted; the devcheck user's sub not swept.
- **Delete-marker tidy-up** — deleting a never-uploaded `pending` key leaves a free delete marker. An `expiredObjectDeleteMarker` lifecycle rule would tidy them, but lifecycle rules are frozen on dev's bot lane (`docs/ops/CI-BOT.md`), so it would need main's lane or an opened freeze.
- **`deleteTask` cascade** — ✅ landed (D7), bytes included since 2026-11-01.
- **HEAD-on-confirm** — `confirmAttachment` trusts the client that the PUT succeeded; a HEAD to verify the object exists would add an S3 call. Low value at single-user scale.
- **Multipart / resumable uploads** — a single XHR PUT is fine at 20 MB; revisit only if the cap rises to large video.
- **Bytes in the export** — metadata only for now (D8).

## 9. Orphan sweep (operator runbook)

Removes Files-bucket objects that no live attachment row points at: the pre-D7 deletes (§8), expired `pending` uploads, and uploads whose PUT landed after their task was deleted. It runs on the Mac with the aws CLI and jq — the Lambdas have object-level Put/Get/Delete only and no `ListBucket` (`cdk/src/lib/app-stack.ts`), by design, so this never becomes app code. Dev first, then prod. Bytes cost pennies, so there is no schedule; run it when §8's record is stale enough to bother.

**What counts as live.** A row at `SK = attach#<taskId>#<id>` with no `deletedAt` number and either `status = ready` or `createdAt` in the last 24 h — a 24 h grace in place of the cap's 15 min (`countsTowardCap`). Step 2 also skips any object modified in the last 24 h, so an upload in flight is never touched from either side. Keys are `u/<sub>/<taskId>/<attachmentId>`, so one Cognito sub per run: `SUB` is your own sub (the `DEVICE_USER_ID_<STAGE>` repository variable); on dev run it again with the devcheck user's (`DEVCHECK_SUB` in `.secrets/devcheck.dev.env`). The bucket is versioned, so a delete only adds a delete marker; step 7 undoes it for 30 days (the noncurrent-version expiry). Only totals go into §8 — never keys.

Each block is one shell session from `cd /Users/rahuldatta/Coding/Personal/aperture`; set `S` and `P` first — `S=dev P=aperture-dev`, then `S=prod P=<prod profile>` (empty `P` means the default profile).

1. **Names.** The data stack's outputs, and the sub:

   ```sh
   A() { aws "$@" ${P:+--profile $P} --region us-west-1; }
   O() { A cloudformation describe-stacks --stack-name ApertureData-$S --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
   B=$(O FilesBucket); T=$(O TableName); SUB=<sub>; echo "$B $T $SUB"
   ```

2. **Keys older than 24 h** under the sub, with sizes (`date -v-24H` is BSD date — the Mac's). An empty listing prints `None` in text output (it counted as one key on the first dev run), so keep only two-column lines:

   ```sh
   A s3api list-objects-v2 --bucket $B --prefix u/$SUB/ --query "Contents[?LastModified<='$(date -u -v-24H +%FT%TZ)'].[Key,Size]" --output text | awk 'NF == 2' | sort > keys.tsv
   cut -f1 keys.tsv > keys.txt; wc -l keys.txt
   ```

3. **Live rows** — one Query on the user's partition (`PK = u#<sub>`), projected to the four attributes the rule reads; a row with no `deletedAt` number is alive:

   ```sh
   A dynamodb query --table-name $T --key-condition-expression 'PK = :pk AND begins_with(SK, :p)' --expression-attribute-values "{\":pk\":{\"S\":\"u#$SUB\"},\":p\":{\"S\":\"attach#\"}}" --projection-expression 's3Key,#s,createdAt,deletedAt' --expression-attribute-names '{"#s":"status"}' \
     | jq -r --argjson c $(( $(date +%s) * 1000 - 86400000 )) '.Items[] | select(.deletedAt.N == null) | select(.status.S == "ready" or (.createdAt.N | tonumber) > $c) | .s3Key.S' | sort > live.txt
   wc -l live.txt
   ```

4. **Dry run** — the orphans are keys with no live row. Paste the totals line to Claude and spot-check three keys against the app before deleting anything:

   ```sh
   comm -23 keys.txt live.txt > orphans.txt
   grep -F -f orphans.txt keys.tsv | awk '{ n++; s += $2 } END { print n " objects, " s / 1e6 " MB" }'
   head -3 orphans.txt
   ```

5. **Delete**, at most 1,000 keys per call (the `DeleteObjects` limit):

   ```sh
   split -l 1000 orphans.txt batch.
   for f in batch.??; do jq -R -s 'split("\n") | map(select(length > 0)) | {Objects: map({Key: .}), Quiet: true}' "$f" > "$f.json" && A s3api delete-objects --bucket $B --delete "file://$f.json"; done
   ```

6. **Verify** — rerun steps 2–4: `orphans.txt` is empty. Open an existing attachment in the app (a live key was never a candidate, but look). On dev, the next full devcheck's `attachment-delete` rows (`neighbour`, `reload`) pass. Then write the totals into §8's record and remove `keys.* live.txt orphans.txt batch.*`.

7. **Undo inside 30 days** — delete the delete markers (needs `s3:DeleteObjectVersion`, which the operator has and the Lambdas don't); the objects become current again:

   ```sh
   A s3api list-object-versions --bucket $B --prefix u/$SUB/ --query "{Objects: DeleteMarkers[?IsLatest].{Key: Key, VersionId: VersionId}, Quiet: \`true\`}" > undo.json
   A s3api delete-objects --bucket $B --delete file://undo.json
   ```

   This reverses every delete marker under the prefix, the sweep's included; an attachment the app deleted in the same window would come back as bytes without a row — harmless, and the next sweep removes it.
