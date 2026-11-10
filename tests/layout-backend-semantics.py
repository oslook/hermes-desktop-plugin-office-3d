#!/usr/bin/env python3
"""Verify UI labels against actual backend SQL using isolated recorded-session data."""
from pathlib import Path
import importlib.util, sqlite3, tempfile, time, json, os, sys
from unittest.mock import patch
try:  # Needs a Hermes checkout for the plugin's core imports.
    import hermes_constants
    import gateway.status  # noqa: F401
except ImportError:
    print('SKIP layout-backend-semantics: needs a Hermes checkout')
    raise SystemExit(0)
repo=Path(__file__).resolve().parents[1]
backend=Path(sys.argv[1]) if len(sys.argv)>1 else repo/'dashboard/plugin_api.py'
# `TMPDIR` is POSIX-shell only; gettempdir() works on Windows and bare CI too.
with tempfile.TemporaryDirectory(prefix='office-layout-sql-',dir=tempfile.gettempdir()) as home:
    db=sqlite3.connect(str(Path(home)/'state.db'))
    db.execute('CREATE TABLE sessions(last_activity_at REAL, ended_at REAL, input_tokens INTEGER, output_tokens INTEGER, actual_cost_usd REAL, estimated_cost_usd REAL)')
    now=time.time()
    db.executemany('INSERT INTO sessions VALUES(?,?,?,?,?,?)',[(now,None,100,20,1,9),(now-3600,now-3000,200,30,None,2),(now-86400,None,10,5,0,8)])
    db.commit();db.close()
    fixture_db=Path(home)/'state.db'
    connect=sqlite3.connect
    def fixture_connect(database, *args, **kwargs):
        assert database == f'file:{fixture_db}?mode=ro', f'non-fixture DB forbidden: {database}'
        return connect(database, *args, **kwargs)
    with patch.object(hermes_constants, 'get_default_hermes_root', return_value=Path(home)), patch.object(sqlite3, 'connect', side_effect=fixture_connect):
        spec=importlib.util.spec_from_file_location('office_layout_backend',backend)
        assert spec is not None and spec.loader is not None
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        try:
            assert Path(module._db_path('default')) == fixture_db
            actual=module._read_session_stats('default')
            assert actual['active_sessions']==1,actual
            assert actual['open_sessions']==2,actual
            assert actual['tokens_total']==365,actual
            assert actual['cost_total']==3,actual
        finally:
            module._close_all_ro_conns()
    print(json.dumps({'ok':True,'stats':actual,'meaning':'All recorded rows, including ended and old sessions; input+output; actual cost including zero wins over estimated fallback. Active is last_activity_at >= now-90; open is ended_at IS NULL.'},indent=2))
