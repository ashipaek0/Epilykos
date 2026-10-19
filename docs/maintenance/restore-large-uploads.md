# Large SQLite restore uploads (S03)

This branch builds on restore preflight, offline migration preparation, durable swap recovery, runtime handover and owned staging (app PRs179–183). It targets `dev`; no merge or publication is included.

## User behavior

Settings → Backup file → Restore from file now uploads sequential binary chunks directly to private DATA staging. It does not put the backup into a whole-file JavaScript buffer or the legacy Multer/tmpfs path. The UI reports accepted bytes plus current XHR upload progress, preparation, activation and the durable result after reconnect. Cancellation works before activation; closing a browser does not cancel a completed upload's preparation. Abandoned/partial transfers expire after 60 seconds without received data. Interrupted upload file re-selection/resume is not implemented; cancel and select the file again.

Only one job exists at a time. The shared maintenance lease remains held from creation through upload, preparation, activation and cleanup; conflicting snapshots, restores and host maintenance wait or return busy. Normal monitoring continues until the existing short synchronous activation boundary. There is no invented fixed multi-GiB upload limit: admission uses measured DATA availability. Existing small JSON envelopes and 50MiB multipart JSON imports keep their independent limits. Legacy SQLite multipart restore remains compatible with its previous cap.

## Transport

All routes require the existing authenticated session and CSRF checks:

| Method/path | Input / result |
| --- | --- |
| GET /api/restore-jobs | Current admissible maxBytes, chunkBytes, latest status |
| POST /api/restore-jobs | JSON `{bytes,name}` → 201 generated job ID, counters |
| PUT /api/restore-jobs/:id/chunks | application/octet-stream; X-Restore-Offset exact accepted offset; optional Content-Length must equal expected chunk size |
| GET /api/restore-jobs/:id | Current or last status |
| POST /api/restore-jobs/:id/cancel | Abort and await writes/native workers before releasing ownership |

Chunks are 4MiB except the last. Exact offsets, declared length, streamed count and total count must match. Short/excessive chunks fail the job and keep the original database. A repeat/out-of-order offset returns 409; concurrent chunks/jobs return 409. Invalid declarations return 400; insufficient measured DATA returns 507. No client path is used as a filename.

The browser spaces chunk starts at least one second apart (about 4MiB/s ceiling on a fast network), fitting long uploads within the existing2,000 requests / 15 minutes global limiter while leaving room for other requests. Preparation status polls every 2 seconds. The existing 5 minute server request timeout is unchanged; it applies to each chunk, not the entire file.

## DATA and ownership

At admission and while writing, remaining input plus rollback/migration allowance must fit actual free DATA:

`available - OS maintenance floor - currentDB -32MiB >=3*declaredInput - receivedInput`

The appliance floor is existing policy; generic installs keep the existing scratch admission without requiring host metadata. Preparation repeats its own measured admission and monitors owned allocations. These checks are not filesystem quotas and cannot prevent unrelated writers exhausting DATA between checks.

Upload jobs use 0700 `.restore-upload-XXXXXX` directories, 0600 input/metadata, the existing inherited kernel ownership lease, and a closed role-specific file allowlist. Native SQLite workers inherit both upload ownership and the host maintenance descriptor. Startup/hourly/pre-admission reaping removes only proven inactive, known contents; uncertain or journal-owned data remains preserved. Generic deployments without Linux/flock retain normal restore support but uncertain orphan cleanup is skipped.

## Activation, authorization and result

After the final input fsync, background preparation uses a fresh databaseWork scope and the existing validated candidate/migration/swap transaction. Cancel signals preparation and awaits its worker before cleanup. Activation is synchronous and cancellation is rejected once it starts.

Immediately before live close, a synchronous hook captures only the initiating session still authenticated and unexpired in the original database, retaining its exact expiry. Logout/expiry during preparation cannot resurrect that session. The approved restore can finish even if that browser disconnects or logs out. After opening the candidate, this captured authorization is copied before transaction confirmation; a copy failure rolls back. Legacy file/snapshot restore now uses the same boundary, rather than trying to save an old response session after activation.

A bounded 0600 DATA `.restore-upload-status.json` is atomically replaced and fsynced. It contains the last job's counters/result and, at activation, old/prepared device+inode identities; no session authorization. Persisting activation identity must succeed before live closure. Startup first uses the existing durable transaction recovery, then compares the selected live identity to report selected/recovered/unknown. The status file never authorizes recovery, deletion or database selection. Interrupted pre-activation statuses become failed, original retained. Only the last job is recorded; this is not an audit history.

## Evidence and limits

Automated tests cover actual native SQLite preparation across chunk boundaries; an authenticated real-server 55MB streamed backup exceeding the old 50MiB cap; auth/CSRF and JSON bounds; offset errors; short/excessive/disconnected/slow chunks; cancellation while native preparation owns DATA; idle expiry; process SIGKILL during upload and restart status; old/prepared/unknown identity classification; authorization expiry/logout capture; before/after-activation hook failure; selected DB/session access after restart; browser slice bounds, progress and duplicate-click suppression. Existing inherited-worker ownership/journal recovery suites run as regression coverage.

The full-suite result and any final review fixes are recorded in the PR and execution ledger. This is host-side native/process/HTTP evidence, not physical Pi power-cut testing, a filesystem quota test, production-size multi-GiB device verification or proof that every v1 requirement is complete. Gzip snapshot publication and compressed restore are the next S05 slice and are not implemented by this branch.

Final review found two client error paths: failed admission after a previous terminal job left controls disabled, and401/403 status failures looked like endless connection outages. Regression tests reproduced both before the fix. Controls now restore according to job state; expired authorization stops polling, offers a sign-in link, and rechecks status when the tab regains focus. A further test covers signing in when no job was created. No deferred minor findings.
