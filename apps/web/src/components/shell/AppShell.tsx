import type { ReactNode } from "react";
import styles from "./AppShell.module.css";

export function AppShell(props: { header?: ReactNode; sideNav?: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.root}>
      <header className={styles.header}>{props.header}</header>
      <aside className={styles.sideNav}>{props.sideNav}</aside>
      <main className={styles.content}>{props.children}</main>
    </div>
  );
}

export function AppShellHeader(props: { children: ReactNode }) {
  return <div className={styles.headerInner}>{props.children}</div>;
}

export function AppShellSideNav(props: { children: ReactNode }) {
  return <nav className={styles.sideNavInner}>{props.children}</nav>;
}

export function AppShellContent(props: { children: ReactNode }) {
  return <div className={styles.contentInner}>{props.children}</div>;
}

