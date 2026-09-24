"""Run task-owned serial checks with explicit disk/RAM admission and retained exits."""
from pathlib import Path
import argparse, datetime as dt, json, os, shutil, subprocess, time
ROOT = Path(__file__).resolve().parents[2]
GROUPS = {
 'types': [(ROOT / p, ['pnpm.cmd','exec','tsc','--noEmit','--incremental','false','--pretty','false']) for p in ('packages/db','packages/api','apps/dashboard','apps/workers')],
 'contracts': [(ROOT/'packages/api',['pnpm.cmd','exec','vitest','run','src/prospect-writer-contract.test.ts','src/prospect-first-send-contract.test.ts','--maxWorkers=2','--minWorkers=1'])],
 'origin': [(ROOT/'packages/db',['pnpm.cmd','exec','vitest','run','src/helpers/prospect-native-origin.test.ts','--maxWorkers=2','--minWorkers=1'])],
 'provider': [(ROOT/'packages/api',['pnpm.cmd','exec','vitest','run','src/correspondence/first-send-boundary.test.ts','src/correspondence/gmail-http-client.test.ts','src/correspondence/inbound-sync.test.ts','--maxWorkers=2','--minWorkers=1'])],
 'worker': [(ROOT/'apps/workers',['pnpm.cmd','exec','vitest','run','src/processors/send-prospect-outreach.test.ts','--maxWorkers=2','--minWorkers=1'])],
 'ui': [(ROOT/'apps/dashboard',['pnpm.cmd','exec','vitest','run','components/admin/ProspectWriterRoundtrip.test.tsx','--maxWorkers=2','--minWorkers=1'])],
 'python': [(ROOT,['python','-B','-m','unittest','discover','-s','scripts/crm-sales','-p','test_first_send_components.py','-v'])],
 'boundaries': [(ROOT,['node','scripts/'+p]) for p in ('verify-raw-sql-boundary.mjs','verify-tenant-bypass-boundary.mjs','verify-public-surface-boundary.mjs')],
}
p=argparse.ArgumentParser();p.add_argument('group',choices=GROUPS);args=p.parse_args()
out=ROOT/'artifacts/crm-first-send-20260921-r001'/('checks-'+args.group+'-'+str(time.time_ns()));out.mkdir(exist_ok=False)
rows=[]
for i,(cwd,cmd) in enumerate(GROUPS[args.group]):
 mem=subprocess.run(['powershell.exe','-NoProfile','-Command','[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB,3)'],capture_output=True,text=True,timeout=20,check=True)
 ram=float(mem.stdout.strip());disk=shutil.disk_usage(ROOT).free
 if ram<4 or disk<5*1024**3:
  rows.append({'command':cmd,'exitCode':None,'deferred':'RAM>=4 GiB and disk reserve>=5 GiB required','freeRamGiB':ram,'freeDisk':disk});break
 start=time.monotonic()
 with (out/f'{i}.log').open('xb') as stream:
  try: code=subprocess.run(cmd,cwd=cwd,stdout=stream,stderr=subprocess.STDOUT,timeout=240,check=False).returncode
  except Exception as e: stream.write(str(e).encode());code=-1
 row={'command':cmd,'cwd':str(cwd),'exitCode':code,'seconds':round(time.monotonic()-start,3),'freeRamGiB':ram,'freeDiskBefore':disk,'freeDiskAfter':shutil.disk_usage(ROOT).free}
 rows.append(row);print(json.dumps(row),flush=True)
 if code:break
receipt={'group':args.group,'steps':rows,'passed':len(rows)==len(GROUPS[args.group]) and all(r['exitCode']==0 for r in rows),'observedAt':dt.datetime.now(dt.timezone.utc).isoformat(),'liveSend':False}
(out/'receipt.json').write_text(json.dumps(receipt,indent=2),encoding='utf-8')
print(json.dumps({'output':str(out),**receipt}),flush=True)
raise SystemExit(0 if receipt['passed'] else 1)
