import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('monitor', Path(__file__).with_name('hapi-health-monitor.py'))
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)

SID = '81935080-0a31-4a12-921f-51dd8df44006'


class MonitorTests(unittest.TestCase):
    def test_grade_uses_thresholds_and_failure(self):
        self.assertEqual(monitor.grade('health', 5, True)['status'], 'ok')
        self.assertEqual(monitor.grade('health', 800, True)['status'], 'warn')
        self.assertEqual(monitor.grade('health', 4000, True)['status'], 'fail')
        self.assertEqual(monitor.grade('health', 5, False)['status'], 'fail')

    def test_traffic_counts_errors_and_slow_requests_per_route(self):
        lines = [
            '<-- GET /api/sessions',
            '--> GET /api/sessions \x1b[32m200\x1b[0m 12ms',
            f'--> GET /api/sessions/{SID}/messages?limit=50 \x1b[32m200\x1b[0m 3s',
            f'--> POST /api/sessions/{SID}/messages \x1b[31m500\x1b[0m 40ms',
            f'--> POST /api/sessions/{SID}/upload \x1b[32m200\x1b[0m 9s',
            '--> GET /assets/index.js \x1b[32m200\x1b[0m 5s',
        ]
        result = monitor.summarize_traffic(lines)
        self.assertEqual((result['requests'], result['errors'], result['slow']), (4, 1, 1))
        self.assertEqual(result['status'], 'fail')
        self.assertEqual(result['worst'][0]['route'], 'POST /api/sessions/:id/messages')

    def test_quiet_traffic_is_ok(self):
        self.assertEqual(monitor.summarize_traffic([])['status'], 'ok')

    def test_overall_is_down_only_for_core_probes(self):
        ok = {'name': 'health', 'status': 'ok'}
        self.assertEqual(monitor.overall([ok]), 'ok')
        self.assertEqual(monitor.overall([ok, {'name': 'traffic', 'status': 'fail'}]), 'degraded')
        self.assertEqual(monitor.overall([ok, {'name': 'sse', 'status': 'fail'}]), 'down')

    def test_log_reader_resumes_from_offset_and_survives_rotation(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'hub.log'
            path.write_text('old\n')
            state = {}
            self.assertEqual(monitor.read_new_log_lines(path, state), [])
            with path.open('a') as handle:
                handle.write('one\ntwo\npart')
            self.assertEqual(monitor.read_new_log_lines(path, state), ['one', 'two'])
            path.unlink()
            path.write_text('fresh\n')
            self.assertEqual(monitor.read_new_log_lines(path, state), ['fresh'])


if __name__ == '__main__':
    unittest.main()
