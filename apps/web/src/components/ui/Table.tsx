import type { ReactNode } from "react";
import styles from "./ui.module.css";

export function Table(props: { header?: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.tableWrap}>
      {props.header ? <div className={styles.tableHeader}>{props.header}</div> : null}
      <div className={styles.tableScroll}>
        <table className={styles.table}>{props.children}</table>
      </div>
    </div>
  );
}

