"""Create-only, read-only dependency/dirty-file fingerprints for this local lane."""
from __future__ import annotations
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import subprocess

os.environ.setdefault('TORCHIKO_CRM_VAULT', str(Path.home() / 'Downloads/AwesomeVault'))
import component_bridge as bridge


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--compare', type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    output = args.output.resolve()
    if not output.is_relative_to(root / 'artifacts') or output.exists():
        raise ValueError('A new receipt inside this worktree artifacts directory is required')
    owners = bridge.owners()
    sources = owners['common'].protected_hashes()
    # Entire upstream source code is read-only too, not merely the selected contracts.
    for owner_root in owners['roots'].values():
        for path in sorted((owner_root / 'implementation').glob('*.py')):
            sources[path.relative_to(owners['vault']).as_posix()] = bridge.sha(path.read_bytes())
    preserved = {name: bridge.sha((root / name).read_bytes()) for name in (
        'apps/dashboard/next-env.d.ts', 'apps/dashboard/tsconfig.json')}
    git = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=root, capture_output=True,
                         text=True, timeout=10, check=True).stdout.strip()
    result = {'schema': 'torchiko.meaning-dependency-boundary/1',
              'observedAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'head': git,
              'upstreamFiles': sources, 'preservedGeneratedFiles': preserved,
              'SEND_AUTHORIZED': False}
    if args.compare:
        before = json.loads(args.compare.read_text(encoding='utf-8-sig'))
        result['upstreamUnchanged'] = before['upstreamFiles'] == sources
        result['generatedUnchanged'] = before['preservedGeneratedFiles'] == preserved
        result['changedUpstreamPaths'] = [key for key in set(before['upstreamFiles']) | set(sources)
                                         if before['upstreamFiles'].get(key) != sources.get(key)]
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('x', encoding='utf-8') as stream:
        json.dump(result, stream, indent=2, ensure_ascii=False)
    print(json.dumps({'output': str(output), 'upstreamFiles': len(sources),
                      'upstreamUnchanged': result.get('upstreamUnchanged'),
                      'generatedUnchanged': result.get('generatedUnchanged'),
                      'changedUpstreamPaths': result.get('changedUpstreamPaths', [])}))
    if result.get('upstreamUnchanged') is False or result.get('generatedUnchanged') is False:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
