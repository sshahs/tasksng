#!/bin/sh
# Starts tasksng-server. CA certificates mounted into /certs (*.crt, PEM)
# are trusted in addition to the system ones, for a Baikal behind a private
# certificate authority.
set -e
if ls /certs/*.crt >/dev/null 2>&1; then
    cat /etc/ssl/certs/ca-certificates.crt /certs/*.crt > /tmp/ca-certificates.crt
    export SSL_CERT_FILE=/tmp/ca-certificates.crt
fi
exec tasksng-server "$@"
