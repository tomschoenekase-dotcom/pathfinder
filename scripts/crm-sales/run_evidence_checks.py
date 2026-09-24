"""Serial bounded checks with create-only exit/log/resource receipts."""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

ROOT=Path(__file__).resolve().parents[2]
groups={
 'composer':[(Path.home()/'Downloads/AwesomeVault/95 AI Staging/Torchiko Outreach Composer 2026-09-20', ['python','-B','-m','unittest','discover','-s','tests','-p','test_native_catalog.py','-v'])],
 'boundaries':[(ROOT,['node','scripts/'+name]) for name in ('verify-raw-sql-boundary.mjs','verify-tenant-bypass-boundary.mjs','verify-public-surface-boundary.mjs')],
 'python':[(ROOT,['python','-B','-m','unittest','discover','-s','scripts/crm-sales','-p','test_*.py','-v'])],
 'db':[(ROOT/'packages/db',['pnpm.cmd','exec','vitest','run','src/helpers/prospect-sales-actions.test.ts','src/helpers/prospect-sales-meaning.test.ts','src/helpers/prospect-source-admission.test.ts','--maxWorkers=2','--minWorkers=1'])],
 'api':[(ROOT/'packages/api',['pnpm.cmd','exec','vitest','run','src/prospect-meaning-contract.test.ts','src/prospect-evidence-contract.test.ts','src/routers/admin/prospect-crm-sales.test.ts','--maxWorkers=2','--minWorkers=1'])],
 'ui':[(ROOT/'apps/dashboard',['pnpm.cmd','exec','vitest','run','components/admin/ProspectSalesReviewPanel.test.tsx','components/admin/ProspectClaimMeaningReview.test.tsx','components/admin/ProspectEvidenceAdmission.test.tsx','--maxWorkers=2','--minWorkers=1'])],
 'types':[(ROOT/p,['pnpm.cmd','exec','tsc','--noEmit','--incremental','false','--pretty','false']) for p in ('packages/db','packages/api','apps/dashboard')],
}
p=argparse.ArgumentParser();p.add_argument('group',choices=groups);a=p.parse_args()
out=ROOT/'artifacts/crm-evidence-admission-20260921-r001'/('checks-'+a.group+'-'+str(time.time_ns()))
out.mkdir(exist_ok=False)
rows=[]
for i,(cwd,cmd) in enumerate(groups[a.group]):
 free=shutil.disk_usage(ROOT).free
 if free<5*1024**3:
  rows.append({'command':cmd,'skipped':'5 GiB reserve','exitCode':None});break
 start=time.monotonic()
 with (out/f'{i}.log').open('xb') as stream:
  try:
   env=os.environ.copy()
   if a.group=='composer':
    env['TORCHIKO_NATIVE_CATALOG_FIXTURE']=str(ROOT/'artifacts/crm-evidence-admission-20260921-r001/capture-record.json')
   result=subprocess.run(cmd,cwd=cwd,env=env,stdout=stream,stderr=subprocess.STDOUT,timeout=240,check=False)
   code=result.returncode
  except Exception as error:
   stream.write(str(error).encode());code=-1
 row={'command':cmd,'cwd':str(cwd),'exitCode':code,'seconds':round(time.monotonic()-start,3),'freeDiskBefore':free,'freeDiskAfter':shutil.disk_usage(ROOT).free}
 rows.append(row);print(json.dumps(row),flush=True)
 if code:break
receipt={'group':a.group,'observedAt':dt.datetime.now(dt.timezone.utc).isoformat(),'steps':rows,'passed':len(rows)==len(groups[a.group]) and all(r['exitCode']==0 for r in rows),'SEND_AUTHORIZED':False}
with (out/'receipt.json').open('x',encoding='utf-8') as f:json.dump(receipt,f,indent=2)
print(json.dumps({'output':str(out),**receipt}),flush=True)
raise SystemExit(0 if receipt['passed'] else 1)
