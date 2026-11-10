import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
MARKERS = ('config.yaml', '.env', 'SOUL.md', 'profile.yaml', 'auth.json', 'state.db')


def _gateway_stub():
    """Stub ``gateway.status`` so the plugin imports without a Hermes checkout.

    Both halves read gateway liveness from the core package; the tests exercise
    profile discovery only, so a running=False stub keeps the import graph local
    (and lets the suite run on a bare clone).
    """
    gateway = types.ModuleType('gateway')
    status = types.ModuleType('gateway.status')
    setattr(status, 'resolve_gateway_liveness', lambda **kwargs: types.SimpleNamespace(
        running=False, pid=None, source='none'
    ))
    setattr(status, 'get_running_pid_cached', lambda *args, **kwargs: None)
    setattr(gateway, 'status', status)
    return gateway, status


def load(path, core):
    spec = importlib.util.spec_from_file_location('office_test_' + path.stem, path)
    module = importlib.util.module_from_spec(spec)
    if core is None:
        core = types.ModuleType('hermes_constants')
    core.get_default_hermes_root = lambda: Path(tempfile.gettempdir())
    gateway, status = _gateway_stub()
    with patch.dict(sys.modules, {'hermes_constants': core, 'gateway': gateway, 'gateway.status': status}):
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
                        # A marker that is a dangling symlink still marks a live
                        # profile. Creating the link needs
                        # SeCreateSymbolicLinkPrivilege on Windows (developer mode
                        # or admin), so where the OS refuses, drop this sub-case
                        # instead of failing the suite; the empty dir then has no
                        # marker and must not be discovered.
                        linked = []
                        try:
                            (profiles / 'linked').mkdir()
                            (profiles / 'linked' / 'config.yaml').symlink_to('missing')
                            linked = ['linked']
                        except (OSError, NotImplementedError):
                            pass
                        expected = ['default'] + sorted(expected[1:] + linked)
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
