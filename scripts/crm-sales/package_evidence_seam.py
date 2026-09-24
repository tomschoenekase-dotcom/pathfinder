"""Create-only exact Composer patch/byte identities; never stage the vault or apply the patch.

The three permitted source-catalog files remain in their existing owner. This
compact package lets the next consumer reconcile those exact bytes without
copying historical pilot/contact data or creating an alternative runtime.
"""
import datetime as dt
import difflib
import hashlib
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
ART = ROOT / 'artifacts/crm-evidence-admission-20260921-r001'
os.environ.setdefault('TORCHIKO_CRM_VAULT', str(Path.home() / 'Downloads/AwesomeVault'))
import component_bridge as bridge


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('xb') as stream:
        stream.write(data)


def main():
    owners = bridge.owners()
    upstream = owners['composer'].ROOT
    output = ART / 'composer-seam-r001'
    output.mkdir(exist_ok=False)
    before = json.loads((ART / 'dependencies-before.json').read_text(encoding='utf-8'))
    modified = '95 AI Staging/Torchiko Outreach Composer 2026-09-20/implementation/composer.py'
    original = (ART / 'composer.py.before').read_bytes()
    assert bridge.sha(original) == before['upstreamFiles'][modified]
    patches, changes = [], []
    for relative in ('implementation/composer.py', 'implementation/native_catalog.py', 'tests/test_native_catalog.py'):
        old = original if relative == 'implementation/composer.py' else b''
        new = (upstream / relative).read_bytes()
        assert b'\r' not in old and b'\r' not in new, 'Unexpected line endings; reconcile instead of normalizing captured bytes'
        if old:
            write(output / 'preimage' / relative, old)
        write(output / 'postimage' / relative, new)
        header = f'diff --git a/{relative} b/{relative}\n'
        if not old:
            header += 'new file mode 100644\n'
        diff = ''.join(difflib.unified_diff(old.decode().splitlines(keepends=True), new.decode().splitlines(keepends=True),
            fromfile='a/' + relative if old else '/dev/null', tofile='b/' + relative))
        patches.append(header + diff)
        changes.append({'path': relative, 'beforeSha256': bridge.sha(old) if old else None,
                        'afterSha256': bridge.sha(new), 'beforeBytes': len(old), 'afterBytes': len(new)})
    patch = ''.join(patches).encode('utf-8')
    patch_path = output / 'composer-native-catalog.patch'
    write(patch_path, patch)
    directory = (output / 'preimage').relative_to(ROOT).as_posix()
    command = ['git', 'apply', '--check', '--directory=' + directory, str(patch_path)]
    check = subprocess.run(command, cwd=ROOT, capture_output=True, timeout=20, check=False)
    write(output / 'apply-check.stdout.log', check.stdout)
    write(output / 'apply-check.stderr.log', check.stderr)
    receipt = {'schema': 'torchiko.native-catalog-scoped-patch/1', 'observedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
        'upstreamOwner': str(upstream), 'changedFiles': changes, 'patchSha256': bridge.sha(patch),
        'verificationCommand': command, 'gitApplyCheckExit': check.returncode,
        'patchApplied': False, 'vaultStaged': False, 'historicalSourcesModified': False, 'SEND_AUTHORIZED': False}
    write(output / 'receipt.json', (json.dumps(receipt, indent=2) + '\n').encode())
    print(json.dumps({'output': str(output), **receipt}))
    if check.returncode:
        raise SystemExit(check.returncode)


if __name__ == '__main__':
    main()
