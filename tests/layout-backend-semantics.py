#!/usr/bin/env python3
"""Verify UI labels against actual backend SQL using isolated recorded-session data."""
from pathlib import Path
import importlib.util, sqlite3, tempfile, time, json, os, sys
repo=Path(__file__).resolve().parents[1]
backend=Path(sys.argv[1]) if len(sys.argv)>1 else repo/'dashboard/plugin_api.py'
with tempfile.TemporaryDirectory(prefix='office-layout-sql-',dir=Path.home()/'.hermes/cache/scratch') as home:
    previous=os.environ.get('HERMES_HOME');os.environ['HERMES_HOME']=home
    spec=importlib.util.spec_from_file_location('office_layout_backend',backend)
    assert spec is not None and spec.loader is not None
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    db=sqlite3.connect(str(Path(home)/'state.db'))
    db.execute('CREATE TABLE sessions(last_activity_at REAL, ended_at REAL, input_tokens INTEGER, output_tokens INTEGER, actual_cost_usd REAL, estimated_cost_usd REAL)')
    now=time.time()
    db.executemany('INSERT INTO sessions VALUES(?,?,?,?,?,?)',[(now,None,100,20,1,9),(now-3600,now-3000,200,30,None,2),(now-86400,None,10,5,0,8)])
    db.commit();db.close()
    actual=module._read_session_stats('default')
    assert actual['active_sessions']==1,actual
    assert actual['open_sessions']==2,actual
    assert actual['tokens_total']==365,actual
    assert actual['cost_total']==3,actual
    module._close_all_ro_conns()
    if previous is None:os.environ.pop('HERMES_HOME',None)
    else:os.environ['HERMES_HOME']=previous
    print(json.dumps({'ok':True,'stats':actual,'meaning':'All recorded rows, including ended and old sessions; input+output; actual cost including zero wins over estimated fallback. Active is last_activity_at >= now-90; open is ended_at IS NULL.'},indent=2))
