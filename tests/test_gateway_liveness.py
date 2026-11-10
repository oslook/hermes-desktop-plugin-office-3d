"""Exercise both readers against Hermes' real liveness ladder in a synthetic fleet."""
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest
import sys
import types
from unittest.mock import patch

try:  # Exercises Hermes' real liveness ladder, so it needs a checkout.
    import gateway.status as status
    import gateway.host_topology as host_topology
    import hermes_cli.gateway as cli_gateway
    import hermes_constants
    HERMES_AVAILABLE = True
except ImportError:  # pragma: no cover - bare clone / CI without Hermes
    status = host_topology = cli_gateway = hermes_constants = None  # noqa: F841
    HERMES_AVAILABLE = False

REPO = Path(__file__).resolve().parents[1]

# `TMPDIR` only exists on POSIX shells; Windows puts its temp root elsewhere.
TEMP_ROOT = tempfile.gettempdir()


@unittest.skipUnless(HERMES_AVAILABLE, 'needs a Hermes checkout')
class GatewayLivenessTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=TEMP_ROOT)
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'fleet'
        self.root.mkdir()
        self.modules = []
        with patch.object(hermes_constants, 'get_default_hermes_root', return_value=self.root):
            for index, file in enumerate(('__init__.py', 'dashboard/plugin_api.py')):
                spec = importlib.util.spec_from_file_location(f'office_liveness_{index}', REPO / file)
                assert spec is not None and spec.loader is not None
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                self.modules.append(module)
                if hasattr(module, '_close_all_ro_conns'):
                    self.addCleanup(module._close_all_ro_conns)

    def home(self, name):
        path = self.root if name == 'default' else self.root / 'profiles' / name
        path.mkdir(parents=True, exist_ok=True)
        return path

    def test_mux_served_even_with_missing_or_stale_profile_state(self):
        for name in ('missing', 'stale'):
            home = self.home(name)
            if name == 'stale':
                (home / 'gateway_state.json').write_text(json.dumps({'pid': 99999999, 'gateway_state': 'stopped'}))
            with patch.object(status, 'multiplexer_liveness_for_profile', return_value=(1234, {'gateway_state': 'running'})):
                for module in self.modules:
                    with self.subTest(name=name, backend=module.__name__):
                        entry = module._read_profile(name)
                        self.assertTrue(entry['online'])
                        self.assertFalse(entry['busy'])
                        self.assertNotEqual(entry['state'], 'stopped')

    def test_unserved_and_recycled_pid_are_offline(self):
        home = self.home('parked')
        (home / 'gateway_state.json').write_text(json.dumps({'pid': os.getpid(), 'gateway_state': 'running'}))
        with patch.object(status, 'multiplexer_liveness_for_profile', return_value=None):
            for module in self.modules:
                with self.subTest(backend=module.__name__):
                    self.assertFalse(module._read_profile('parked')['online'])

    def test_native_roster_named_host_serves_only_its_members(self):
        host = self.home('host')
        self.home('served')
        self.home('parked')
        topology = types.SimpleNamespace(pid=1234, home=host, serves=lambda name: name in {'default', 'served'})
        with patch.object(hermes_constants, 'get_default_hermes_root', return_value=self.root), \
             patch.object(host_topology, 'host_gateway_topology', return_value=topology), \
             patch.object(cli_gateway, 'named_profile_served_by_running_multiplexer', return_value=False):
            for module in self.modules:
                for name, expected in [('default', True), ('served', True), ('parked', False)]:
                    with self.subTest(backend=module.__name__, name=name):
                        self.assertEqual(module._read_profile(name)['online'], expected)

    def test_stopped_record_is_not_online_and_pid_file_not_removed(self):
        home = self.home('stopped')
        (home / 'gateway_state.json').write_text(json.dumps({'pid': os.getpid(), 'gateway_state': 'stopped'}))
        pid_path = home / 'gateway.pid'
        pid_path.write_text('{"pid": 99999999}')
        with patch.object(status, 'multiplexer_liveness_for_profile', return_value=None):
            for module in self.modules:
                with self.subTest(backend=module.__name__):
                    self.assertFalse(module._read_profile('stopped')['online'])
                    self.assertTrue(pid_path.exists())

    def test_missing_native_liveness_fails_explicitly(self):
        fake_status = types.ModuleType('gateway.status')
        for file in ('__init__.py', 'dashboard/plugin_api.py'):
            with self.subTest(file=file), patch.dict(sys.modules, {'gateway.status': fake_status}):
                spec = importlib.util.spec_from_file_location('old_gateway_office', REPO / file)
                assert spec is not None and spec.loader is not None
                with self.assertRaisesRegex(RuntimeError, 'resolve_gateway_liveness'):
                    spec.loader.exec_module(importlib.util.module_from_spec(spec))

    def test_standalone_and_named_host_mux(self):
        for name in ('default', 'host', 'served'):
            self.home(name)
        def mux(home):
            return (1234, {'gateway_state': 'running'}) if home in (self.root, self.root / 'profiles' / 'served') else None
        def pid(path, **kwargs):
            return 1234 if path.parent == self.root / 'profiles' / 'host' else None
        with patch.object(status, 'multiplexer_liveness_for_profile', side_effect=mux):
            for module in self.modules:
                with patch.object(module, 'get_running_pid_cached', side_effect=pid):
                    for name in ('default', 'host', 'served'):
                        with self.subTest(backend=module.__name__, name=name):
                            self.assertTrue(module._read_profile(name)['online'])

    def test_activity_still_marks_independent_worker_busy(self):
        home = self.home('worker')
        # closing() — a `with sqlite3.connect(...)` block commits but leaves the
        # handle open, which blocks temp cleanup on Windows (WinError 32).
        with contextlib.closing(sqlite3.connect(home / 'state.db')) as db:
            db.execute('CREATE TABLE sessions(last_activity_at REAL, ended_at REAL, input_tokens INTEGER, output_tokens INTEGER, actual_cost_usd REAL, estimated_cost_usd REAL)')
            db.execute('INSERT INTO sessions VALUES (?, NULL, 1, 2, NULL, 0)', (time.time(),))
            db.commit()
        with patch.object(status, 'multiplexer_liveness_for_profile', return_value=None):
            for module in self.modules:
                with self.subTest(backend=module.__name__):
                    entry = module._read_profile('worker')
                    self.assertEqual((entry['online'], entry['busy'], entry['state']), (True, True, 'working'))

    def test_delegation_and_discovery_with_mux_and_stale_state(self):
        worker = self.home('worker')
        (worker / 'config.yaml').touch()
        (worker / 'gateway_state.json').write_text(json.dumps({'gateway_state': 'stopped'}))
        ghost = self.home('ghost')
        (ghost / 'runtime').mkdir()
        with contextlib.closing(sqlite3.connect(self.root / 'state.db')) as db:
            db.execute('CREATE TABLE sessions(source TEXT, last_activity_at REAL, ended_at REAL, input_tokens INTEGER, output_tokens INTEGER, actual_cost_usd REAL, estimated_cost_usd REAL)')
            db.execute('INSERT INTO sessions VALUES (?, ?, NULL, 1, 2, NULL, 0)', ('subagent', time.time()))
            db.execute('CREATE TABLE async_delegations(state TEXT, task_json TEXT)')
            db.execute('INSERT INTO async_delegations VALUES (?, ?)', ('running', json.dumps({'profile': 'worker'})))
            db.commit()
        for module in self.modules:
            for source, running in [('multiplexer', True), ('none', False)]:
                with self.subTest(backend=module.__name__, source=source), \
                     patch.object(module, 'resolve_gateway_liveness', return_value=types.SimpleNamespace(source=source, running=running)):
                    entries = module.collect() if hasattr(module, 'collect') else module._collect_state()
                    self.assertEqual([e['profile'] for e in entries], ['default', 'worker'])
                    entry = entries[1]
                    self.assertEqual((entry['delegated_sessions'], entry['online'], entry['busy'], entry['state']), (1, True, True, 'working'))
                    if hasattr(module, '_state_cache'):
                        module._state_cache = None


if __name__ == '__main__':
    unittest.main()
