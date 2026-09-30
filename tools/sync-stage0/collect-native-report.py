#!/usr/bin/env python3
"""Read only this spike's report from its current Android process, including release."""
import json
import subprocess
import sys
import time
from pathlib import Path
if len(sys.argv) != 4:
    raise SystemExit('Usage: collect-native-report.py /absolute/adb emulator-serial output.json')
adb, serial, target = sys.argv[1:]
base = [adb, '-s', serial]
package = 'com.lionpocketmobile.cryptospike'
# PID filtering prevents accepting the previous build's successful report.
for attempt in range(30):
    pid = subprocess.run(base + ['shell', 'pidof', package], capture_output=True, text=True).stdout.strip()
    if pid:
        lines = subprocess.check_output(base + ['logcat', '--pid=' + pid, '-d', '-v', 'raw', '-s', 'LionCryptoSpike:I'], text=True).splitlines()
        for line in reversed(lines):
            if line.startswith('{'):
                report = json.loads(line)
                Path(target).write_text(json.dumps(report, indent=2) + '\n')
                print(json.dumps({k: v for k, v in report.items() if k != 'sealedBox'}))
                if report.get('result') != 'PASS': raise SystemExit(1)
                raise SystemExit(0)
    time.sleep(1)
raise SystemExit('No current-process native report in 30 seconds; do not reuse an earlier PASS.')
