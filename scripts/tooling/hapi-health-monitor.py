#!/usr/bin/env python3
"""HAPI end-to-end health monitor. Run once per minute via launchd; stdlib only.

Unlike hapi-hub-guard (which only pings /health and restarts the hub), this walks
the same path the web app takes and never restarts anything:

  1. synthetic probes   /health -> POST /api/auth -> GET /api/sessions ->
                        GET /api/machines -> session detail + messages ->
                        SSE handshake on /api/events -> web bundle (/)
  2. real traffic       every /api and /cli request the hub logged since the
                        last run: error rate, slow requests, worst routes
  3. host scheduling    hub/runner priority (a launchd Background clamp shows
                        up as PRI 4 and starves the hub), load average

Writes ~/.hapi/health-monitor-status.json (latest), appends one JSON line per run
to ~/Library/Logs/hapi/health-monitor.log, and posts a macOS notification when the
overall state changes. `--report` prints the latest status for humans.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

HOME = Path(os.environ.get('HAPI_HOME', Path.home() / '.hapi'))
LOG_DIR = Path.home() / 'Library/Logs/hapi'
STATUS_PATH = HOME / 'health-monitor-status.json'
STATE_PATH = HOME / 'health-monitor-state.json'
HISTORY_PATH = LOG_DIR / 'health-monitor.log'
HUB_LOG = LOG_DIR / 'hub.log'

# (warn_ms, fail_ms) per probe. A probe slower than fail_ms counts as failed.
THRESHOLDS = {
    'health': (500, 3000),
    'auth': (1000, 5000),
    'sessions': (1500, 8000),
    'machines': (1500, 8000),
    'session': (1500, 8000),
    'messages': (2000, 8000),
    'sse': (2000, 10000),
    'web': (1000, 5000),
}
REQUEST_TIMEOUT = 15
SLOW_REQUEST_MS = 2000
# Routes that legitimately take long (uploads, agent RPC round trips, streams).
SLOW_EXEMPT = re.compile(r'/(upload|events|resume|spawn|codex-models|paths/exists|voice|abort|archive)\b')
MAX_LOG_BYTES = 8 * 1024 * 1024
NORMAL_PRIORITY = 20
ANSI = re.compile(r'\x1b\[[0-9;]*m')
UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
LOG_LINE = re.compile(r'^--> (GET|POST|PUT|PATCH|DELETE) (\S+) (\d{3}) (\d+(?:\.\d+)?)(ms|s|m)$')


def grade(name, elapsed_ms, ok, detail=''):
    warn, fail = THRESHOLDS[name]
    if not ok or elapsed_ms >= fail:
        status = 'fail'
    elif elapsed_ms >= warn:
        status = 'warn'
    else:
        status = 'ok'
    return {'name': name, 'status': status, 'ms': round(elapsed_ms, 1), 'detail': detail}


def parse_duration_ms(value, unit):
    return float(value) * {'ms': 1, 's': 1000, 'm': 60000}[unit]


def summarize_traffic(lines):
    """Aggregate hono logger response lines into what the frontend experienced."""
    total = errors = slow = 0
    routes = {}
    for raw in lines:
        match = LOG_LINE.match(ANSI.sub('', raw).strip())
        if not match:
            continue
        method, path, code, value, unit = match.groups()
        path = path.split('?', 1)[0]
        if not (path.startswith('/api/') or path.startswith('/cli/')):
            continue
        ms = parse_duration_ms(value, unit)
        route = f'{method} {UUID.sub(":id", path)}'
        total += 1
        entry = routes.setdefault(route, {'count': 0, 'errors': 0, 'slow': 0, 'max_ms': 0.0})
        entry['count'] += 1
        entry['max_ms'] = max(entry['max_ms'], ms)
        if int(code) >= 500:
            errors += 1
            entry['errors'] += 1
        if ms >= SLOW_REQUEST_MS and not SLOW_EXEMPT.search(path):
            slow += 1
            entry['slow'] += 1
    worst = sorted(
        ({'route': route, **entry} for route, entry in routes.items() if entry['errors'] or entry['slow']),
        key=lambda item: (item['errors'], item['slow'], item['max_ms']),
        reverse=True,
    )[:5]
    if total == 0:
        status = 'ok'
    elif errors / total >= 0.05 or slow / total >= 0.10:
        status = 'fail'
    elif errors or slow / total >= 0.02:
        status = 'warn'
    else:
        status = 'ok'
    return {'name': 'traffic', 'status': status, 'requests': total, 'errors': errors, 'slow': slow, 'worst': worst}


def read_new_log_lines(path, state):
    """Lines appended since the previous run (bounded; restarts on rotation)."""
    try:
        stat = path.stat()
    except OSError:
        return []
    previous = state.get('log')
    if not previous:
        offset = stat.st_size  # first run: only judge traffic from now on
    elif previous.get('inode') == stat.st_ino:
        offset = previous.get('offset', stat.st_size)
    else:
        offset = 0  # rotated
    if offset > stat.st_size:
        offset = 0
    offset = max(offset, stat.st_size - MAX_LOG_BYTES)
    with path.open('rb') as handle:
        handle.seek(offset)
        data = handle.read()
    # Keep a trailing partial line for the next run.
    cut = data.rfind(b'\n') + 1
    state['log'] = {'inode': stat.st_ino, 'offset': offset + cut}
    return data[:cut].decode('utf-8', errors='replace').splitlines()


def overall(checks):
    statuses = {check['status'] for check in checks}
    critical = {check['name'] for check in checks if check['status'] == 'fail'}
    if critical & {'health', 'auth', 'sessions', 'sse'}:
        return 'down'
    if 'fail' in statuses or 'warn' in statuses:
        return 'degraded'
    return 'ok'


class Client:
    def __init__(self, base):
        self.base = base
        self.token = None

    def call(self, method, path, body=None, timeout=REQUEST_TIMEOUT):
        headers = {'accept': 'application/json'}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers['content-type'] = 'application/json'
        if self.token:
            headers['authorization'] = f'Bearer {self.token}'
        request = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        started = time.monotonic()
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = response.read()
                code = response.status
        except urllib.error.HTTPError as error:
            payload, code = error.read(), error.code
        elapsed = (time.monotonic() - started) * 1000
        return code, payload, elapsed

    def probe(self, name, method, path, body=None, parse=True):
        try:
            code, payload, elapsed = self.call(method, path, body)
        except Exception as error:  # timeouts, refused connections
            return grade(name, THRESHOLDS[name][1], False, f'{type(error).__name__}: {error}'), None
        parsed = None
        if parse and 200 <= code < 300:
            try:
                parsed = json.loads(payload)
            except ValueError:
                return grade(name, elapsed, False, f'HTTP {code}, body is not JSON'), None
        return grade(name, elapsed, 200 <= code < 300, f'HTTP {code}'), parsed if parse else payload

    def probe_sse(self):
        """Open the live event stream and wait for the hub's handshake event."""
        fail_ms = THRESHOLDS['sse'][1]
        url = f'{self.base}/api/events?all=true&visibility=hidden&token={self.token}'
        request = urllib.request.Request(url, headers={'accept': 'text/event-stream'})
        started = time.monotonic()
        try:
            with urllib.request.urlopen(request, timeout=fail_ms / 1000) as response:
                if response.status != 200:
                    return grade('sse', fail_ms, False, f'HTTP {response.status}')
                while (time.monotonic() - started) * 1000 < fail_ms:
                    line = response.readline()
                    if not line:
                        break
                    if line.startswith(b'data:') and b'connection-changed' in line:
                        return grade('sse', (time.monotonic() - started) * 1000, True, 'handshake received')
        except Exception as error:
            return grade('sse', fail_ms, False, f'{type(error).__name__}: {error}')
        return grade('sse', fail_ms, False, 'no handshake event')


def process_check():
    """Hub/runner scheduling priority and host load."""
    result = subprocess.run(['ps', '-axo', 'pid=,pri=,command='], capture_output=True, text=True, timeout=10)
    found = {}
    for line in result.stdout.splitlines():
        parts = line.split(None, 2)
        if len(parts) < 3:
            continue
        for role, needle in (('hub', '/hapi server'), ('runner', '/hapi runner start-sync')):
            if parts[2].rstrip().endswith(needle):
                found[role] = {'pid': int(parts[0]), 'pri': int(parts[1])}
    load = os.getloadavg()[0]
    cpus = os.cpu_count() or 1
    problems = []
    if 'hub' not in found:
        problems.append('hub process not found')
    for role, info in found.items():
        if info['pri'] < NORMAL_PRIORITY:
            problems.append(f'{role} runs at background priority {info["pri"]} (launchd ProcessType clamp)')
    status = 'fail' if any('hub' in problem for problem in problems) else 'warn' if problems else 'ok'
    if status == 'ok' and load > cpus * 4:
        status = 'warn'
        problems.append(f'load average {load:.0f} on {cpus} cpus')
    return {'name': 'process', 'status': status, 'processes': found, 'load1': round(load, 1), 'detail': '; '.join(problems)}


def run_checks(base, access_token, state):
    client = Client(base)
    checks = []
    check, _ = client.probe('health', 'GET', '/health')
    checks.append(check)
    check, auth = client.probe('auth', 'POST', '/api/auth', {'accessToken': access_token})
    checks.append(check)
    client.token = (auth or {}).get('token')
    if client.token:
        check, sessions = client.probe('sessions', 'GET', '/api/sessions')
        listed = (sessions or {}).get('sessions') or []
        check['detail'] += f', {len(listed)} sessions'
        checks.append(check)
        checks.append(client.probe('machines', 'GET', '/api/machines')[0])
        if listed:
            newest = max(listed, key=lambda item: item.get('updatedAt') or 0)
            sid = newest.get('id')
            checks.append(client.probe('session', 'GET', f'/api/sessions/{sid}')[0])
            checks.append(client.probe('messages', 'GET', f'/api/sessions/{sid}/messages?limit=20')[0])
        checks.append(client.probe_sse())
    else:
        checks.append(grade('sessions', THRESHOLDS['sessions'][1], False, 'skipped: no auth token'))
        checks.append(grade('sse', THRESHOLDS['sse'][1], False, 'skipped: no auth token'))
    client.token = None
    check, body = client.probe('web', 'GET', '/', parse=False)
    if check['status'] != 'fail' and b'<html' not in (body or b'').lower():
        check = grade('web', check['ms'], False, 'index is not HTML')
    checks.append(check)
    checks.append(summarize_traffic(read_new_log_lines(HUB_LOG, state)))
    checks.append(process_check())
    return checks


def notify(title, message):
    script = f'display notification {json.dumps(message)} with title {json.dumps(title)}'
    subprocess.run(['osascript', '-e', script], capture_output=True, timeout=10)


def describe(check):
    if check['name'] == 'traffic':
        text = f'{check["requests"]} requests, {check["errors"]} errors, {check["slow"]} slow'
        for item in check['worst'][:3]:
            text += f'\n      {item["route"]}: {item["count"]}x, {item["errors"]} err, {item["slow"]} slow, max {item["max_ms"]:.0f}ms'
        return text
    if check['name'] == 'process':
        procs = ', '.join(f'{role} pid {info["pid"]} pri {info["pri"]}' for role, info in check['processes'].items())
        return f'{procs}; load {check["load1"]}' + (f' — {check["detail"]}' if check['detail'] else '')
    return f'{check["ms"]:.0f}ms {check["detail"]}'


def report():
    try:
        status = json.loads(STATUS_PATH.read_text())
    except (OSError, ValueError):
        print('no status yet; run the monitor once')
        return 1
    age = time.time() - status['checked_at']
    print(f'HAPI health: {status["overall"].upper()}  (checked {age:.0f}s ago, {status["checked_at_iso"]})')
    for check in status['checks']:
        print(f'  [{check["status"]:>4}] {check["name"]:<9} {describe(check)}')
    return 0 if status['overall'] == 'ok' else 2


def load_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--report', action='store_true', help='print the latest status and exit')
    parser.add_argument('--print', dest='show', action='store_true', help='run now and print the result')
    parser.add_argument('--no-notify', action='store_true')
    args = parser.parse_args()
    if args.report:
        return report()

    settings = load_json(HOME / 'settings.json')
    base = os.environ.get('HAPI_MONITOR_URL') or f'http://127.0.0.1:{settings.get("listenPort", 3006)}'
    state = load_json(STATE_PATH)
    checks = run_checks(base, settings.get('cliApiToken', ''), state)
    now = time.time()
    status = {
        'overall': overall(checks),
        'checked_at': now,
        'checked_at_iso': time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(now)),
        'checks': checks,
    }

    # Two consecutive bad runs before alerting: one slow probe is not an outage.
    previous = state.get('overall', 'ok')
    streak = state.get('streak', 0) + 1 if status['overall'] == previous else 1
    alerted = state.get('alerted', 'ok')
    if not args.no_notify and streak >= 2 and status['overall'] != alerted:
        bad = [f'{check["name"]}: {check.get("detail") or check["status"]}' for check in checks if check['status'] != 'ok']
        notify(f'HAPI {status["overall"]}', '; '.join(bad)[:200] if bad else 'all checks passing again')
        alerted = status['overall']
    state.update({'overall': status['overall'], 'streak': streak, 'alerted': alerted})

    STATUS_PATH.write_text(json.dumps(status, indent=2))
    STATE_PATH.write_text(json.dumps(state))
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    with HISTORY_PATH.open('a') as handle:
        handle.write(json.dumps(status) + '\n')
    if HISTORY_PATH.stat().st_size > 20 * 1024 * 1024:
        HISTORY_PATH.replace(HISTORY_PATH.with_suffix('.log.1'))
    if args.show:
        report()
    return 0


if __name__ == '__main__':
    sys.exit(main())
