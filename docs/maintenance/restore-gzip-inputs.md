# Bounded gzip restore inputs — S05 prerequisite

This focused branch builds on large restore upload PR184 (d2811a7) and targets dev. It adds gzip input normalization before the existing native SQLite preflight/migration preparation and durable restore transaction. Daily compressed snapshot publication, retention and scheduler retry work remains a separate S05 slice; this is not completed S05/v1.

## Behavior and format

Settings accepts .db, .db.gz and .gz. Actual format is detected from gzip magic, not filename. Legacy raw backups keep the same validated path. Gzip data streams to a private DATA expansion job before SQLite validation; no whole-archive or expanded-file buffer is created. Archive CRC/truncation errors and invalid expanded SQLite fail before live closure. Existing file and snapshot restore functions share normalization; new gzip snapshot name discovery/publication is still pending.

A valid SQLite backup can compress to fewer than512bytes, so upload declaration/admission and durable status accept positive input lengths. This changes only transport input accounting; raw SQLite preflight still requires at least512bytes and validates real schema, file size and integrity. Chunk bounds, small JSON and multipart limits stay unchanged.

## Space bound

The compressed source is already allocated and counted by statfs. At expansion start:

`maxExpanded = floor((availableDATA - applianceFloor - currentDB -32MiB) /3)`

Before forwarding each bounded decompressed chunk, the prospective total must not exceed that ceiling. Fresh measured admission requires:

`availableDATA - applianceFloor - currentDB -32MiB >=3*prospectiveExpanded - bytesAlreadyWritten`

Count bytes written from the output file's current size, capped by emitted count, so pending stream buffers are not credited as disk allocation. This reserves the remaining expanded input plus two candidate/migration allowances; live/retained files are never credited as deletable space. Unused ceiling space is not speculatively reserved. Actual native preparation and migrated candidate admission still run afterward. Generic deployments keep existing floor compatibility.

No gzip ISIZE footer, declared expanded byte count or compression ratio is trusted. A highly compressible archive can therefore fail safely at its measured expanded-size/DATA bound. These checks are conservative allocation admission, not filesystem quotas against unrelated concurrent writers; production-sized device memory/disk-full tests remain required.

## Ownership, cancellation and recovery

The shared maintenance lease spans upload, expansion, native preparation and cleanup. Expansion uses0700 `.restore-expand-XXXXXX`,0600 `expanded.db`, existing owner metadata and a closed role-specific allowlist. The expansion descriptor is inherited by native validation/preparation children alongside upload ownership and host maintenance. Parent death cannot free these leases while the native reader is still alive. The existing collector can reap only proven inactive expansion jobs; unknown files/links and uncertain ownership are preserved.

Abort during decompression destroys/awaits the pipeline before cleanup. Source must be a separate regular file without SQLite sidecars and retain device/inode/size/mtime through expansion. Completed output is fsynced and then enters the unchanged preflight/preparation/transaction. Gzip adds no journal, selection or recovery authority. Activation/session/outcome behavior is the same as PR184.

## Evidence

Focused tests: real gzip/raw byte equivalence; a gzip backup smaller than512bytes through native restore and durable restart status; corrupt CRC/truncation/invalid SQLite keeping original data; a2MiB archive expansion rejected by an injected1MiB DATA ceiling; cancellation after real output writes; source mtime change during streaming; unknown-file preservation on failure; active/inactive expansion ownership; authenticated real-server gzip upload with session/settings access. Existing raw55MB HTTP upload and the separate50MiB JSON limit remain covered.

First normalization tests failed due to missing module, then passed after implementation. The small-gzip native integration test failed before normalization was connected, then passed through the real native transaction. Focused49/49 checks passed before final whole-branch review. Final full-suite/review evidence is recorded in the PR and execution ledger. These are host native/process/HTTP tests, not physical Pi power-cut or production-size hardware acceptance.
