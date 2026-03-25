import type { ReactNode } from "react";
import styles from "./ui.module.css";

export function PageHeader(props: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className={styles.pageHeader}>
      <div className={styles.pageHeaderMain}>
        <div className={styles.pageHeaderTitle}>{props.title}</div>
        {props.description ? <div className={styles.pageHeaderDesc}>{props.description}</div> : null}
      </div>
      {props.actions ? <div className={styles.pageHeaderActions}>{props.actions}</div> : null}
    </div>
  );
}

