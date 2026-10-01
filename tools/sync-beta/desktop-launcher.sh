#!/usr/bin/env bash
set -euo pipefail
launcher_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec "$launcher_directory/lionpocket" --private-beta "$@"
