import type { ReactNode } from "react";
import styles from "./ui.module.css";

export type BadgeTone = "neutral" | "success" | "warning" | "danger";

export function Badge(props: { tone?: BadgeTone; children: ReactNode }) {
  const tone = props.tone ?? "neutral";
  return (
    <span className={styles.badge} data-tone={tone}>
      {props.children}
    </span>
  );
}

