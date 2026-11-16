#!/usr/bin/env python3
"""macOS hub-only recovery. Run once per minute via launchd; stdlib only."""
import argparse
import ctypes
import json
import os
from pathlib import Path
import struct
import subprocess
import time
import urllib.request

MEMORY_LIMIT = 4 * 1024 ** 3
SLOW_SECONDS = 30
SLOW_STRIKES = 3
HEALTH_TIMEOUT = 45
COOLDOWN = 15 * 60
STARTUP_GRACE = 5 * 60


def decision(previous, pid, footprint, slow, now):
    """Require consecutive observations of the same process; never count RSS."""
    same = previous.get('pid') == pid
    state = {
        'pid': pid,
        'first_seen': previous.get('first_seen', now) if same else now,
        'memory_strikes': previous.get('memory_strikes', 0) + 1 if same and footprint >= MEMORY_LIMIT else int(footprint >= MEMORY_LIMIT),
        'slow_strikes': previous.get('slow_strikes', 0) + 1 if same and slow else int(slow),
        'last_restart': previous.get('last_restart', 0),
        'checked_at': now,
        'footprint_bytes': footprint,
    }
    # Gaps are not evidence of sustained degradation.
    if now - previous.get('checked_at', now) > 150:
        state['memory_strikes'] = int(footprint >= MEMORY_LIMIT)
        state['slow_strikes'] = int(slow)
    reason = None
    if now - state['first_seen'] >= STARTUP_GRACE and now - state['last_restart'] >= COOLDOWN:
        if state['memory_strikes'] >= 3:
            reason = 'physical footprint >= 4 GiB for consecutive checks'
        elif state['slow_strikes'] >= SLOW_STRIKES:
            reason = 'health response slow or unavailable for consecutive checks'
    return state, reason


def main_thread_idle(sample_path):
    """True when the sampled main thread mostly sits in kevent64 (event loop idle).

    A hub whose main thread is idle but whose /health answers slowly is paged out
    or starved by host memory pressure; restarting it only adds a reconnect storm.
    Returns False when the sample cannot be read, so the restart still happens.
    """
    try:
        lines = Path(sample_path).read_text(errors='replace').splitlines()
    except OSError:
        return False
    total = idle = None
    in_main = False
    for line in lines:
        if 'com.apple.main-thread' in line:
            in_main = True
            try:
                total = int(line.split()[0])
            except (IndexError, ValueError):
                return False
            continue
        if in_main and ' Thread_' in line and 'main-thread' not in line:
            break
        if in_main and 'kevent64' in line and idle is None:
            try:
                idle = int(line.strip().lstrip('+!:| ').split()[0])
            except (IndexError, ValueError):
                return False
    return bool(total) and idle is not None and idle / total >= 0.5


def physical_footprint(pid):
    # rusage_info_v2: UUID, then user/system time, wakeups, pageins,
    # wired_size, resident_size, phys_footprint. Buffer accommodates full ABI.
    lib = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    buf = ctypes.create_string_buffer(1024)
    if lib.proc_pid_rusage(pid, 2, ctypes.byref(buf)) != 0:
        raise OSError(ctypes.get_errno(), 'proc_pid_rusage')
    return struct.unpack_from('=Q', buf, 72)[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    home = Path.home()
    data = home / '.hapi'
    state_path = data / 'hub-guard-state.json'
    log_dir = home / 'Library/Logs/hapi'
    log_dir.mkdir(parents=True, exist_ok=True)
    # Resolve only the supervised hub, never a runner or agent wrapper.
    label = 'gui/{}/ai.hapi.hub'.format(os.getuid())
    job = subprocess.check_output(['launchctl', 'list', 'ai.hapi.hub'], text=True)
    import re
    match = re.search(r'"PID"\s*=\s*(\d+)', job)
    if not match:
        return  # Existing watchdog handles a missing hub.
    pid = int(match.group(1))
    footprint = physical_footprint(pid)
    started = time.monotonic()
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open('http://127.0.0.1:3006/health', timeout=HEALTH_TIMEOUT) as response:
            healthy = json.load(response).get('status') == 'ok'
    except (OSError, ValueError):
        healthy = False
    elapsed = time.monotonic() - started
    try:
        previous = json.loads(state_path.read_text())
    except (OSError, ValueError):
        previous = {}
    state, reason = decision(previous, pid, footprint, not healthy or elapsed > SLOW_SECONDS, time.time())
    state['health_seconds'] = round(elapsed, 3)
    state['healthy'] = healthy
    if args.dry_run:
        print(json.dumps(dict(state, would_restart=reason)))
        return
    if reason:
        stamp = time.strftime('%Y%m%d-%H%M%S')
        diagnostic = log_dir / ('hub-guard-' + stamp + '.sample.txt')
        # Bounded diagnostic time, bounded retained files; no message contents.
        try:
            subprocess.run(['sample', str(pid), '1', '-file', str(diagnostic)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
        except subprocess.TimeoutExpired:
            pass
        for old in sorted(log_dir.glob('hub-guard-*.sample.txt'))[:-5]:
            old.unlink(missing_ok=True)
        if 'slow' in reason and main_thread_idle(diagnostic):
            with (log_dir / 'hub-guard.log').open('a') as log:
                log.write('{} pid={} footprint={} skipped={} (main thread idle; host memory pressure)\n'.format(stamp, pid, footprint, reason))
            state['slow_strikes'] = 0
        else:
            with (log_dir / 'hub-guard.log').open('a') as log:
                log.write('{} pid={} footprint={} reason={}\n'.format(stamp, pid, footprint, reason))
            subprocess.run(['launchctl', 'kickstart', '-k', label], check=True, timeout=20)
            state['last_restart'] = time.time()
            state['memory_strikes'] = state['slow_strikes'] = 0
    temporary = state_path.with_suffix('.tmp')
    temporary.write_text(json.dumps(state) + '\n')
    temporary.replace(state_path)


if __name__ == '__main__':
    main()
