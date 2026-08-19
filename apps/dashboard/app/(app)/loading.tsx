import { TorchikoCore } from '../../components/ClientPortalPrimitives'
import styles from './ClientPortalLoading.module.css'

export default function ClientPortalLoading() {
  return (
    <div className={styles.page} role="status" aria-busy="true">
      <div className={styles.field}>
        <div>
          <p>Opening today</p>
          <h1>Bringing your Torchiko workspace into focus.</h1>
          <div className={styles.lines} aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
        </div>
        <TorchikoCore state="processing" size="compact" />
      </div>
      <span className="sr-only">Loading your Torchiko portal…</span>
    </div>
  )
}
