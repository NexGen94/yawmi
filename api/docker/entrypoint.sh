#!/bin/sh
# Builds YAWMI_DATABASE_URL from the generated password file plus non-secret variables, then
# runs its arguments. The password therefore never sits in an image layer, in the compose file
# or in `docker inspect`; it is read from the read-only secrets volume at every start.
#
#   YAWMI_DB_HOST            required: the Postgres host on the shared network
#   YAWMI_DB_NAME            default raqib
#   YAWMI_DB_USER            default yawmi_api
#   YAWMI_DB_PORT            default 5432
#   YAWMI_DB_PASSWORD_FILE   default /run/yawmi/yawmi_api_pw
#
# A ready YAWMI_DATABASE_URL in the environment wins (local runs and tests).
set -eu

if [ -z "${YAWMI_DATABASE_URL:-}" ]; then
    : "${YAWMI_DB_HOST:?yawmi-entrypoint: YAWMI_DB_HOST is not set}"
    pw_file="${YAWMI_DB_PASSWORD_FILE:-/run/yawmi/yawmi_api_pw}"
    if [ ! -r "$pw_file" ]; then
        echo "yawmi-entrypoint: password file is missing or unreadable" >&2
        exit 1
    fi
    # The path goes in argv, the password does not. quote(safe="") escapes every reserved char.
    password="$(python -I -c 'import sys, urllib.parse; print(urllib.parse.quote(open(sys.argv[1], encoding="utf-8").read().strip(), safe=""))' "$pw_file")"
    if [ -z "$password" ]; then
        echo "yawmi-entrypoint: password file is empty" >&2
        exit 1
    fi
    YAWMI_DATABASE_URL="postgresql://${YAWMI_DB_USER:-yawmi_api}:${password}@${YAWMI_DB_HOST}:${YAWMI_DB_PORT:-5432}/${YAWMI_DB_NAME:-raqib}"
    export YAWMI_DATABASE_URL
fi

exec "$@"
