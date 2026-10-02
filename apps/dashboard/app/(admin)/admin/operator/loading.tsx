import { OperatorAdminView } from '../../../../components/operator/OperatorAdminView'

export default function OperatorLoading() {
  return (
    <OperatorAdminView tab={null} inboxCount={null}>
      <div
        role="status"
        aria-busy="true"
        className="min-h-48 border-t border-slate-200 py-8 text-sm text-slate-700"
      >
        Loading operator information…
      </div>
    </OperatorAdminView>
  )
}
