"""Display names come from each profile's own profile.yaml — no core import.

Both the PyYAML path and the stdlib fallback must agree, a corrupt file must
never raise, and the mtime-keyed cache must pick up an edited file.
"""
import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load():
    spec = importlib.util.spec_from_file_location('office_test_api', ROOT / 'dashboard/plugin_api.py')
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    core = types.ModuleType('hermes_constants')
    setattr(core, 'get_default_hermes_root', lambda: Path(tempfile.gettempdir()))
    gateway = types.ModuleType('gateway')
    status = types.ModuleType('gateway.status')
    setattr(status, 'resolve_gateway_liveness', lambda **kwargs: types.SimpleNamespace(running=False))
    setattr(status, 'get_running_pid_cached', lambda *args, **kwargs: None)
    setattr(gateway, 'status', status)
    with patch.dict(sys.modules, {'hermes_constants': core, 'gateway': gateway, 'gateway.status': status}):
        spec.loader.exec_module(module)
    return module


class DisplayNameTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api = load()

    def write(self, directory, text):
        path = Path(directory) / 'profile.yaml'
        path.write_text(text, encoding='utf-8')
        return Path(directory)

    def test_bot_title_wins_over_display_name(self):
        text = (
            'display_name: Plain Name\n'
            'ui_meta:\n'
            '  hermes-bots:\n'
            '    title: Bot Title\n'
        )
        with tempfile.TemporaryDirectory() as d:
            home = self.write(d, text)
            self.assertEqual(self.api._read_display_name(home), 'Bot Title')
            # The stdlib fallback must reach the same answer as PyYAML.
            self.assertEqual(self.api._scan_display_name(text), 'Bot Title')

    def test_display_name_fallback(self):
        text = 'description: worker\ndisplay_name: "数据大厅"\n'
        with tempfile.TemporaryDirectory() as d:
            home = self.write(d, text)
            self.assertEqual(self.api._read_display_name(home), '数据大厅')
            self.assertEqual(self.api._scan_display_name(text), '数据大厅')

    def test_no_profile_yaml_is_empty_not_an_error(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(self.api._read_display_name(Path(d)), '')
        self.assertEqual(self.api._read_display_name(Path('/nonexistent-profile-dir')), '')

    def test_corrupt_yaml_never_raises(self):
        for text in ('ui_meta: [unclosed\n  bad: : :\n', '\t\t- oops\n', ''):
            with tempfile.TemporaryDirectory() as d:
                home = self.write(d, text)
                self.assertIsInstance(self.api._read_display_name(home), str)
            self.assertIsInstance(self.api._scan_display_name(text), str)

    def test_cache_picks_up_an_edit(self):
        with tempfile.TemporaryDirectory() as d:
            home = self.write(d, 'display_name: First\n')
            self.assertEqual(self.api._read_display_name(home), 'First')
            path = home / 'profile.yaml'
            path.write_text('display_name: Second\n', encoding='utf-8')
            # Same content, newer mtime: the cache must re-read, not serve stale.
            import os
            os.utime(path, ns=(path.stat().st_atime_ns, path.stat().st_mtime_ns + 1_000_000))
            self.assertEqual(self.api._read_display_name(home), 'Second')

    def test_no_private_core_import(self):
        source = (ROOT / 'dashboard/plugin_api.py').read_text(encoding='utf-8')
        code = [line.split('#', 1)[0].strip() for line in source.splitlines()]
        private = [
            line for line in code
            if line.startswith('from hermes_cli') or line.startswith('import hermes_cli')
        ]
        self.assertEqual(private, [], f'private core import(s): {private}')


if __name__ == '__main__':
    unittest.main()
