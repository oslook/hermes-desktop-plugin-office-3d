# Windows support — what changed and what was measured

Upstream declared `platforms: [linux, macos]` and refused the liveness check on
Windows. The only platform-specific code path in the package was that probe:

```python
if os.name == "nt":
    return False          # refuse: os.kill(pid, 0) would KILL the target
```

`os.kill(pid, 0)` on Windows is routed through `TerminateProcess`, so a bare
liveness probe could terminate the gateway it is asking about. Everything else —
profile discovery, the read-only `state.db` aggregates, gateway resolution and the
plugin SDK surface — is portable.

## The change

- **`_windows_pid_alive()`** (`__init__.py`, `dashboard/plugin_api.py`):
  `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` + `GetExitCodeProcess` via
  `ctypes` — the same technique Hermes' own `pid_exists_stdlib` uses, kept local
  so the plugin imports no private core module. It never signals the target.
  `ERROR_ACCESS_DENIED (5)` counts as alive (the process exists but is not ours).
- **`_pid_alive()`** routes `os.name == "nt"` to that probe instead of returning
  `False`. The POSIX branch is unchanged.
- **`plugin.yaml`**: `platforms: [linux, macos, windows]`.

Measurement note for the rationale above: on CPython 3.11.15 / Windows 11,
`os.kill(pid, 0)` left a live process alive in three trials while `SIGTERM (15)`
killed it immediately — the documented `TerminateProcess` behaviour does not
reproduce for signal 0 on that build. The explicit probe is still the right shape
(it cannot depend on that behaviour staying true), but the refuse-the-check branch
was over-cautious rather than load-bearing.

## Verified on

- Windows 11, CPython 3.11.15, Hermes Desktop 0.23.0, dashboard backend running.
- `hermes plugins validate <dir>` → `Validation passed` (single warning about an
  upstream-private import in `dashboard/plugin_api.py` that predates this change).
- `hermes plugins doctor office-3d` → `registration passed · 1 tool`.
- `office_status` returns live fleet data (`N profile(s): … tokens, cost`).
- The isometric page renders: `Total/Working/Idle/Offline` counters, desks named
  per profile, idle avatars in the lounge, and the `Recorded-session usage` bar.
- `sqlite3` read-only URIs (`file:<path>?mode=ro`) work with Windows backslash
  paths — checked against a copy of a live `state.db`.

## Known test-suite limitation

`tests/` assumes POSIX: 7 of 16 tests fail on Windows **before and after this
change, identically**, because the fixture teardown cannot delete an open sqlite
file (`WinError 32`) and symlink creation needs a privilege (`WinError 1314`).
They are not a regression signal here; the platform-neutral tests pass.
