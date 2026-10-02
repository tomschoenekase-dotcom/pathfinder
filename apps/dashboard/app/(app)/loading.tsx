import { TorchikoWordmark } from '../../components/TorchikoWordmark'
import styles from './ClientPortalLoading.module.css'

export default function ClientPortalLoading() {
  return (
    <div className={styles.page} role="status" aria-busy="true">
      <div className={styles.field}>
        <div>
          <TorchikoWordmark inverse height={38} />
          <p className={styles.eyebrow}>Client portal</p>
          <h1>Bringing your Torchiko workspace into focus.</h1>
        </div>
      </div>
      <span className="sr-only">Loading your Torchiko portal…</span>
    </div>
  )
}
