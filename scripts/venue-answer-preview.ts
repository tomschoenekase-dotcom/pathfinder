import { readFileSync } from 'node:fs'
import { previewVenuePackageGuide } from '../packages/api/src/lib/venue-package-guide-preview'

const [, , file, date] = process.argv
if (!file || !date) throw new Error('Package path and YYYY-MM-DD required')
const preview = previewVenuePackageGuide(
  JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/u, '')),
  date,
)
process.stdout.write(JSON.stringify(preview))
