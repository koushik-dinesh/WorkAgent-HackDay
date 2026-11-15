#!/bin/sh
# Backs up the local development database into ../backups (gitignored) and checks the dump is
# complete. Usage (from backend/): npm run db:backup:dev
# Prints the path of the backup on the last line (pass it to db:reset:dev --backup).
set -eu

CONTAINER="${MYSQL_CONTAINER:-meeting-action-mysql-1}"
DB_NAME="$(grep -E '^DB_NAME=' .env | tail -1 | cut -d= -f2)"
case "$DB_NAME" in
  ''|*prod*|*live*) echo "Refusing: DB_NAME '$DB_NAME' is not a development database" >&2; exit 1 ;;
esac

mkdir -p ../backups
FILE="../backups/${DB_NAME}-pre-reset-$(date +%Y%m%d-%H%M%S).sql"
docker exec "$CONTAINER" sh -c "MYSQL_PWD=\$MYSQL_ROOT_PASSWORD mysqldump -uroot --single-transaction --routines --triggers --no-tablespaces --set-gtid-purged=OFF $DB_NAME" > "$FILE"

if ! tail -1 "$FILE" | grep -q -- '-- Dump completed'; then
  echo "Backup is incomplete: $FILE" >&2
  exit 1
fi
echo "Backup complete: $(wc -c < "$FILE" | tr -d ' ') bytes, $(grep -c '^CREATE TABLE' "$FILE") tables"
echo "$(cd "$(dirname "$FILE")" && pwd)/$(basename "$FILE")"
