import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
MARKERS = ('config.yaml', '.env', 'SOUL.md', 'profile.yaml', 'auth.json', 'state.db')


def load(path, core):
    spec = importlib.util.spec_from_file_location('office_test_' + path.stem, path)
    module = importlib.util.module_from_spec(spec)
    if core is None:
        core = types.ModuleType('hermes_constants')
    core.get_default_hermes_root = lambda: Path(tempfile.gettempdir())
    with patch.dict(sys.modules, {'hermes_constants': core}):
        spec.loader.exec_module(module)
    return module


class DiscoveryTests(unittest.TestCase):
    def test_both_halves_and_compatibility(self):
        # Exercise both the canonical-helper branch and old-Hermes fallback.
        core = types.ModuleType('hermes_constants')
        import re
        core.PROFILE_ID_RE = re.compile(r'^[a-z0-9][a-z0-9_-]{0,63}$')
        def live(home):
            return (home.is_dir() and not (home.parent / '.deleted' / home.name).exists()
                    and any((home / m).is_file() or (home / m).is_symlink() for m in MARKERS))
        core.named_profile_is_live = live
        for backend in (None, core):
            for path in (ROOT / '__init__.py', ROOT / 'dashboard/plugin_api.py'):
                with self.subTest(path=path, canonical=backend is not None):
                    module = load(path, backend)
                    with tempfile.TemporaryDirectory() as directory:
                        home = Path(directory)
                        module.HERMES_HOME = directory
                        self.assertEqual(module._discover_profiles(), ['default'])
                        profiles = home / 'profiles'
                        profiles.mkdir()
                        for name in ('.deleted', 'retired', 'gone', 'default', 'INVALID', '.internal'):
                            (profiles / name).mkdir()
                        (profiles / 'retired' / 'runtime').mkdir()
                        (profiles / 'retired' / '.backup.lock').touch()
                        (profiles / '.deleted' / 'gone').touch()
                        for name in ('gone', 'default', 'INVALID', '.internal'):
                            (profiles / name / 'config.yaml').touch()
                        expected = ['default']
                        for index, marker in enumerate(MARKERS):
                            name = 'offline-' + str(index)
                            (profiles / name).mkdir()
                            (profiles / name / marker).touch()
                            expected.append(name)
                        (profiles / 'linked').mkdir()
                        (profiles / 'linked' / 'config.yaml').symlink_to('missing')
                        expected = ['default'] + sorted(expected[1:] + ['linked'])
                        (profiles / 'file-only').touch()
                        self.assertEqual(module._discover_profiles(), expected)
                        with patch.object(module, 'resolve_gateway_liveness', return_value=types.SimpleNamespace(running=False, source='none')):
                            entries = module.collect() if hasattr(module, 'collect') else module._collect_state()
                        self.assertEqual([e['profile'] for e in entries], expected)
                        self.assertTrue(all(e['state'] == 'offline' for e in entries))
                        self.assertTrue((profiles / '.deleted' / 'gone').exists())
                        with patch.object(Path, 'iterdir', side_effect=OSError):
                            self.assertEqual(module._discover_profiles(), ['default'])
                        if hasattr(module, '_close_all_ro_conns'):
                            module._close_all_ro_conns()


if __name__ == '__main__':
    unittest.main()
