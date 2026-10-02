#!/bin/sh
# Container entrypoint: make /app/data writable, then run the app as `node`.
#
# On a fresh install the host's ./data does not exist yet, so Docker creates
# it as root:root 755 and the unprivileged `node` user cannot write the
# database, session secret or settings password (EACCES / SQLITE_CANTOPEN).
# The container therefore starts as root only long enough to hand /app/data
# to `node`, then drops privileges for the app itself.
set -e

DATA_DIR=/app/data
APP_USER=node

if [ "$(id -u)" = "0" ]; then
	mkdir -p "$DATA_DIR"
	# Only touch entries that are not already owned by the app user, so a
	# restart with an existing (large) database does no extra work.
	if ! find "$DATA_DIR" ! -user "$APP_USER" -exec chown "$APP_USER:$APP_USER" {} + 2>/dev/null; then
		echo "epilykos: could not hand $DATA_DIR to $APP_USER (read-only or root-squashed mount?)." >&2
		echo "epilykos: fix on the host with: sudo chown -R 1000:1000 ./data" >&2
	fi
	# Keep the compose group_add entries Docker gave this process (dialout for
	# serial, the host bluetooth group for BlueZ) but not root's own group 0.
	groups=$(id -G | tr ' ' '\n' | grep -vx 0 | paste -sd, -)
	if [ -n "$groups" ]; then
		exec setpriv --reuid="$APP_USER" --regid="$APP_USER" --groups="$groups" "$@"
	fi
	exec setpriv --reuid="$APP_USER" --regid="$APP_USER" --clear-groups "$@"
fi

# Already started as a non-root user (compose `user:`): nothing to fix here.
exec "$@"
