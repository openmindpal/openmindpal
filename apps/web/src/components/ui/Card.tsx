import type { ReactNode } from "react";
import styles from "./ui.module.css";

export function Card(props: { title?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <section className={styles.card}>
      {props.title ? <div className={styles.cardTitle}>{props.title}</div> : null}
      <div className={styles.cardBody}>{props.children}</div>
      {props.footer ? <div className={styles.cardFooter}>{props.footer}</div> : null}
    </section>
  );
}

