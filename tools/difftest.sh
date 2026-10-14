#!/bin/sh
# Runs tools/difftest.mjs against a fresh PHP server (needs the old lib/ and app/ in $QN_PHP).
set -e
QN_PHP=${QN_PHP:-/home/claude/phptest}
JS_DATA=${JS_DATA:-/tmp/qn-js-data}
rm -rf "$QN_PHP/data" "$QN_PHP/tmp" "$JS_DATA"; mkdir -p "$QN_PHP/data" "$QN_PHP/tmp" "$JS_DATA"
QUADERNONE_ROOT="$QN_PHP" php -S 127.0.0.1:8099 -t "$QN_PHP/app" "$QN_PHP/router.php" >/tmp/php-server.log 2>&1 &
PID=$!
sleep 1
TZ=Europe/Rome node "$(dirname "$0")/difftest.mjs" "$QN_PHP" "$JS_DATA" http://127.0.0.1:8099 || RC=$?
kill $PID
exit ${RC:-0}
