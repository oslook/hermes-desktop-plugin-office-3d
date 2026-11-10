"""Synthetic fleet regression: no real profile or message data is accessed."""
import contextlib
import importlib.util
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
import sys
import types
from unittest.mock import patch
try:  # These tests exercise Hermes' own liveness ladder, so they need a checkout.
    import hermes_constants
    import gateway.status  # noqa: F401
    HERMES_AVAILABLE = True
except ImportError:  # pragma: no cover - bare clone / CI without Hermes
    hermes_constants = None
    HERMES_AVAILABLE = False

REPO = Path(__file__).resolve().parents[1]

# `TMPDIR` only exists on POSIX shells; Windows puts its temp root elsewhere.
TEMP_ROOT = tempfile.gettempdir()


@unittest.skipUnless(HERMES_AVAILABLE, 'needs a Hermes checkout')
class FleetRootTest(unittest.TestCase):
    def test_dashboard_bot_names_and_refresh(self):
        with tempfile.TemporaryDirectory(prefix='office-names-', dir=TEMP_ROOT) as tmp:
            root = Path(tmp)
            alpha = root / 'profiles' / 'alpha'
            alpha.mkdir(parents=True)
            (root / 'profile.yaml').write_text('display_name: Root Name\n', encoding='utf-8')
            (alpha / 'profile.yaml').write_text('display_name: Person\nui_meta:\n  hermes-bots:\n    title: "  白銀結音  "\n', encoding='utf-8')
            spec = importlib.util.spec_from_file_location('synthetic_names', REPO / 'dashboard/plugin_api.py')
            assert spec is not None and spec.loader is not None
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            with patch.object(module, 'HERMES_HOME', str(root)), patch.object(module, 'resolve_gateway_liveness', return_value=types.SimpleNamespace(running=False, source=None)):
                first = {e['profile']: e for e in module._collect_state()}
                self.assertEqual(first['default']['display_name'], 'Root Name')
                self.assertEqual(first['alpha']['display_name'], '白銀結音')
                (alpha / 'profile.yaml').write_text('display_name: Renamed Person\n', encoding='utf-8')
                self.assertEqual(module._collect_state()[1]['display_name'], '白銀結音')
                setattr(module, '_state_cache', None)  # represents expiry of the normal two-second TTL
                self.assertEqual(module._collect_state()[1]['display_name'], 'Renamed Person')
                (alpha / 'profile.yaml').write_text('not: [valid', encoding='utf-8')
                setattr(module, '_state_cache', None)
                self.assertEqual(module._collect_state()[1]['display_name'], '')

    def test_missing_root_helper_fails_explicitly(self):
        for file in ['__init__.py', 'dashboard/plugin_api.py']:
            with self.subTest(file=file), patch.dict(sys.modules, {'hermes_constants': types.ModuleType('hermes_constants')}):
                spec = importlib.util.spec_from_file_location('synthetic_old_hermes', REPO / file)
                assert spec is not None and spec.loader is not None
                module = importlib.util.module_from_spec(spec)
                with self.assertRaisesRegex(RuntimeError, 'get_default_hermes_root'):
                    spec.loader.exec_module(module)

    def test_default_named_and_custom_root(self):
        with tempfile.TemporaryDirectory(prefix='office-fleet-', dir=TEMP_ROOT) as tmp:
            root = Path(tmp) / 'custom-hermes'
            for name, count in [('default', 1), ('alpha', 2), ('beta', 3)]:
                home = root if name == 'default' else root / 'profiles' / name
                home.mkdir(parents=True, exist_ok=True)
                # `with sqlite3.connect(...)` commits but does NOT close, and an
                # open handle blocks TemporaryDirectory cleanup on Windows
                # (WinError 32). closing() releases it before teardown.
                with contextlib.closing(sqlite3.connect(home / 'state.db')) as db:
                    db.execute('CREATE TABLE sessions(last_activity_at REAL, ended_at REAL, input_tokens INTEGER, output_tokens INTEGER, actual_cost_usd REAL, estimated_cost_usd REAL)')
                    db.executemany('INSERT INTO sessions VALUES (0, 1, 10, 1, 0, 0)', [()] * count)
                    db.commit()
            for runtime_home in [None, root, root / 'profiles' / 'alpha', root / 'profiles' / 'beta']:
                for file in ['__init__.py', 'dashboard/plugin_api.py']:
                    environment = {'HERMES_HOME': str(runtime_home)} if runtime_home else {}
                    native = Path(tmp) / 'native-home' if runtime_home else root
                    with self.subTest(home=runtime_home, file=file), patch.dict(os.environ, environment, clear=True), patch.object(hermes_constants, '_get_platform_default_hermes_home', return_value=native):
                        spec = importlib.util.spec_from_file_location('synthetic_office', REPO / file)
                        assert spec is not None and spec.loader is not None
                        module = importlib.util.module_from_spec(spec)
                        spec.loader.exec_module(module)
                        try:
                            self.assertEqual(module._discover_profiles(), ['default', 'alpha', 'beta'])
                            for name, count in [('default', 1), ('alpha', 2), ('beta', 3)]:
                                home = root if name == 'default' else root / 'profiles' / name
                                self.assertEqual(Path(module._db_path(name)), home / 'state.db')
                                self.assertEqual(Path(module._state_path(name)), home / 'gateway_state.json')
                                self.assertEqual(module._read_session_stats(name)['tokens_total'], count * 11)
                                self.assertEqual(module._read_profile(name)['profile'], name)
                        finally:
                            if hasattr(module, '_close_all_ro_conns'):
                                module._close_all_ro_conns()

if __name__ == '__main__':
    unittest.main()
