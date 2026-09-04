const configuration = await import('../.railway/railway.ts')
const graph = await configuration.default({ environment: 'staging' })
process.stdout.write(JSON.stringify(graph))
