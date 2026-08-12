import { PacketRouteLoading } from '../../../components/PacketRouteState'

export default function WeeklyReportsLoading() {
  return (
    <main className="min-h-screen bg-pf-surface px-6 py-10 lg:px-10">
      <div className="mx-auto max-w-6xl">
        <PacketRouteLoading label="weekly reports" />
      </div>
    </main>
  )
}
