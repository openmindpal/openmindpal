"use client";

import { useState, type ReactNode } from "react";
import styles from "./ui.module.css";

export type TabItem = { key: string; label: string; content: ReactNode };

export function TabNav(props: { tabs: TabItem[]; defaultTab?: string }) {
  const [active, setActive] = useState(props.defaultTab ?? props.tabs[0]?.key ?? "");
  const current = props.tabs.find((t) => t.key === active) ?? props.tabs[0];

  return (
    <div>
      <div className={styles.tabBar}>
        {props.tabs.map((tab) => (
          <button
            key={tab.key}
            className={`${styles.tabBtn} ${tab.key === active ? styles.tabBtnActive : ""}`}
            onClick={() => setActive(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className={styles.tabContent}>{current?.content}</div>
    </div>
  );
}
