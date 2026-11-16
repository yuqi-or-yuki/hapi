import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('guard', Path(__file__).with_name('hapi-hub-guard.py'))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class GuardTests(unittest.TestCase):
    def tick(self, state, now, memory=0, slow=False, pid=42):
        return guard.decision(state, pid, memory, slow, now)

    def ready(self):
        return {'pid': 42, 'first_seen': 1000, 'checked_at': 1400}

    def test_sustained_memory_only(self):
        state = self.ready()
        for now in (1400, 1460):
            state, reason = self.tick(state, now, guard.MEMORY_LIMIT)
            self.assertIsNone(reason)
        self.assertIsNotNone(self.tick(state, 1520, guard.MEMORY_LIMIT)[1])

    def test_transient_recovers(self):
        state, _ = self.tick(self.ready(), 1400, guard.MEMORY_LIMIT, True)
        state, reason = self.tick(state, 1460)
        self.assertIsNone(reason)
        self.assertEqual(state['memory_strikes'], 0)
        self.assertEqual(state['slow_strikes'], 0)

    def test_slow_requires_three_checks(self):
        state, reason = self.tick(self.ready(), 1400, slow=True)
        self.assertIsNone(reason)
        state, reason = self.tick(state, 1460, slow=True)
        self.assertIsNone(reason)
        self.assertIsNotNone(self.tick(state, 1520, slow=True)[1])

    def test_idle_main_thread_detected_from_sample(self):
        import tempfile
        sample = (
            "    680 Thread_1   DispatchQueue_1: com.apple.main-thread  (serial)\n"
            "    + 680 start  (in dyld)\n"
            "    +   548 kevent64  (in libsystem_kernel.dylib)\n"
            "    +   132 sqlite3_step  (in libsqlite3.dylib)\n"
            "    5 Thread_2\n"
            "    + 5 kevent64  (in libsystem_kernel.dylib)\n"
        )
        busy = sample.replace('548 kevent64', '10 kevent64')
        with tempfile.NamedTemporaryFile('w', suffix='.txt', delete=False) as f:
            f.write(sample)
        self.assertTrue(guard.main_thread_idle(f.name))
        with tempfile.NamedTemporaryFile('w', suffix='.txt', delete=False) as f:
            f.write(busy)
        self.assertFalse(guard.main_thread_idle(f.name))
        self.assertFalse(guard.main_thread_idle('/nonexistent/sample.txt'))

    def test_new_pid_startup_grace(self):
        state, _ = self.tick(self.ready(), 1400, guard.MEMORY_LIMIT, True, pid=43)
        for now in (1460, 1520, 1580, 1640):
            state, reason = self.tick(state, now, guard.MEMORY_LIMIT, True, pid=43)
            self.assertIsNone(reason)

    def test_cooldown(self):
        state = dict(self.ready(), last_restart=1350, memory_strikes=3, slow_strikes=3)
        self.assertIsNone(self.tick(state, 1400, guard.MEMORY_LIMIT, True)[1])

    def test_gap_resets_strikes(self):
        state = dict(self.ready(), memory_strikes=3, slow_strikes=3)
        state, reason = self.tick(state, 1700, guard.MEMORY_LIMIT, True)
        self.assertIsNone(reason)
        self.assertEqual(state['memory_strikes'], 1)


if __name__ == '__main__':
    unittest.main()
