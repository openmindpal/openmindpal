"use client";

import Link from "next/link";
import { type ReactNode, Suspense, useCallback, useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { t } from "@/lib/i18n";
import { AppShell, AppShellContent, AppShellHeader, AppShellSideNav } from "./AppShell";
import { CommandPalette, useCommandPaletteShortcut, type CommandItem } from "./CommandPalette";
import styles from "./ConsoleShell.module.css";

const NAV_VISITS_KEY = "openslin_nav_visits";
const MAX_RECENT_NAV = 5;

function parseKeywords(locale: string, key: string): string[] {
  const raw = t(locale, key);
  return raw
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ─── Nav link with hover description ─── */

function NavLink(props: { href: string; label: string; desc?: string; pathname?: string }) {
  const hrefPath = props.href.split("?")[0];
  const isActive = props.pathname === hrefPath;
  const cls = isActive ? `${styles.navLink} ${styles.navLinkActive}` : styles.navLink;
  return (
    <Link className={cls} href={props.href}>
      {props.label}
      {props.desc ? <div className={styles.navLinkDesc}>{props.desc}</div> : null}
    </Link>
  );
}

/* ─── Collapsible sub-group ─── */

const SUBGROUP_STORAGE_KEY = "openslin_nav_subgroups";

function NavSubGroup(props: { groupKey: string; label: string; defaultOpen?: boolean; forceOpen?: boolean; children: ReactNode }) {
  const defaultValue = props.forceOpen ? true : (props.defaultOpen ?? false);
  const [open, setOpen] = useState(defaultValue);

  // Sync the expanded state from localStorage after hydration to avoid SSR mismatch.
  useEffect(() => {
    if (props.forceOpen) return;
    const timer = setTimeout(() => {
      try {
        const raw = localStorage.getItem(SUBGROUP_STORAGE_KEY);
        if (raw) {
          const map: Record<string, boolean> = JSON.parse(raw);
          if (typeof map[props.groupKey] === "boolean") {
            setOpen(map[props.groupKey]);
          }
        }
      } catch { /* ignore */ }
    }, 0);
    return () => clearTimeout(timer);
  }, [props.groupKey, props.forceOpen]);

  const toggle = useCallback(() => {
    if (props.forceOpen) return;
    setOpen((prev) => {
      const next = !prev;
      try {
        const raw = localStorage.getItem(SUBGROUP_STORAGE_KEY);
        const map: Record<string, boolean> = raw ? JSON.parse(raw) : {};
        map[props.groupKey] = next;
        localStorage.setItem(SUBGROUP_STORAGE_KEY, JSON.stringify(map));
      } catch { /* ignore */ }
      return next;
    });
  }, [props.groupKey, props.forceOpen]);

  const effectiveOpen = props.forceOpen ? true : open;

  return (
    <div className={`${styles.navSubGroup} ${effectiveOpen ? styles.navSubGroupOpen : ""}`}>
      <button className={styles.navSubGroupToggle} onClick={toggle} type="button" disabled={!!props.forceOpen}>
        <span>{props.label}</span>
        <span className={styles.navSubGroupArrow}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
        </span>
      </button>
      <ul className={styles.navSubGroupBody}>
        {props.children}
      </ul>
    </div>
  );
}

function RecentNavSection(props: { items: CommandItem[]; locale: string; pathname: string }) {
  const [recentHrefs, setRecentHrefs] = useState<string[]>([]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const raw = localStorage.getItem(NAV_VISITS_KEY);
      if (!raw) return;
      const visits: Record<string, number> = JSON.parse(raw);
      const sorted = Object.entries(visits)
        .filter(([, count]) => count > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_RECENT_NAV)
        .map(([href]) => href);
      timer = setTimeout(() => setRecentHrefs(sorted), 0);
    } catch { /* ignore */ }
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, []);

  const recentItems = recentHrefs
    .map((href) => props.items.find((i) => i.href === href))
    .filter(Boolean) as CommandItem[];

  if (recentItems.length === 0) return null;
  const label = t(props.locale, "recentNav.titleCaps");
  return (
    <div className={styles.navGroup}>
      <div className={styles.navGroupTitle}>{label}</div>
      <ul className={styles.navList}>
        {recentItems.map((item) => (
          <li key={item.id}>
            <NavLink href={item.href} label={item.label} pathname={props.pathname} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function ConsoleShellInner(props: { children: ReactNode }) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const locale = searchParams.get("lang") || "zh-CN";
  const homeHref = `/?lang=${encodeURIComponent(locale)}`;
  const docsHref = `/docs?lang=${encodeURIComponent(locale)}`;
  const settingsHref = `/settings?lang=${encodeURIComponent(locale)}`;
  const runsHref = `/runs?lang=${encodeURIComponent(locale)}`;
  const tasksHref = `/tasks?lang=${encodeURIComponent(locale)}`;
  const orchestratorHref = `/orchestrator?lang=${encodeURIComponent(locale)}`;
  const adminRbacHref = `/admin/rbac?lang=${encodeURIComponent(locale)}`;
  const govChangeSetsHref = `/gov/changesets?lang=${encodeURIComponent(locale)}`;
  const govSchemasHref = `/gov/schemas?lang=${encodeURIComponent(locale)}`;
  const govToolsHref = `/gov/tools?lang=${encodeURIComponent(locale)}`;
  const govSafetyPoliciesHref = `/gov/safety-policies?lang=${encodeURIComponent(locale)}`;
  const govApprovalsHref = `/gov/approvals?lang=${encodeURIComponent(locale)}`;
  const govWorkflowDeadlettersHref = `/gov/workflow/deadletters?lang=${encodeURIComponent(locale)}`;
  const govAuditHref = `/gov/audit?lang=${encodeURIComponent(locale)}`;
  const govObservabilityHref = `/gov/observability?lang=${encodeURIComponent(locale)}`;
  const govPolicySnapshotsHref = `/gov/policy-snapshots?lang=${encodeURIComponent(locale)}`;
  const govPolicyDebuggerHref = `/gov/policy-debugger?lang=${encodeURIComponent(locale)}`;
  const govSyncConflictsHref = `/gov/sync-conflicts?lang=${encodeURIComponent(locale)}`;
  const govSkillPackagesHref = `/gov/skill-packages?lang=${encodeURIComponent(locale)}`;
  const govSkillRuntimeHref = `/gov/skill-runtime?lang=${encodeURIComponent(locale)}`;
  const govArtifactPolicyHref = `/gov/artifact-policy?lang=${encodeURIComponent(locale)}`;
  const govModelsHref = `/gov/models?lang=${encodeURIComponent(locale)}`;
  const govChannelsHref = `/gov/channels?lang=${encodeURIComponent(locale)}`;
  const govNotificationsHref = `/gov/notifications?lang=${encodeURIComponent(locale)}`;
  const govDevicesHref = `/gov/devices?lang=${encodeURIComponent(locale)}`;
  const govTriggersHref = `/gov/triggers?lang=${encodeURIComponent(locale)}`;
  const govKnowledgeLogsHref = `/gov/knowledge/retrieval-logs?lang=${encodeURIComponent(locale)}`;
  const govKnowledgeJobsHref = `/gov/knowledge/jobs?lang=${encodeURIComponent(locale)}`;
  const govKnowledgeQualityHref = `/gov/knowledge/quality?lang=${encodeURIComponent(locale)}`;
  const govSyncHref = `/gov/sync?lang=${encodeURIComponent(locale)}`;
  const govIntegrationsHref = `/gov/integrations?lang=${encodeURIComponent(locale)}`;
  const govWorkbenchesHref = `/gov/workbenches?lang=${encodeURIComponent(locale)}`;
  const govUiPagesHref = `/gov/ui-pages?lang=${encodeURIComponent(locale)}`;

  const [paletteOpen, setPaletteOpen] = useState(false);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  useCommandPaletteShortcut(openPalette);

  const paletteItems: CommandItem[] = [
    { id: "home", label: t(locale, "app.title"), group: t(locale, "shell.nav.console"), href: homeHref, keywords: parseKeywords(locale, "shell.keywords.home") },
    { id: "docs", label: t(locale, "shell.nav.docs"), group: t(locale, "shell.nav.console"), href: docsHref, keywords: parseKeywords(locale, "shell.keywords.docs") },
    { id: "runs", label: t(locale, "shell.nav.runs"), group: t(locale, "shell.nav.console"), href: runsHref, keywords: parseKeywords(locale, "shell.keywords.runs") },
    { id: "tasks", label: t(locale, "shell.nav.tasks"), group: t(locale, "shell.nav.console"), href: tasksHref, keywords: parseKeywords(locale, "shell.keywords.tasks") },
    { id: "orchestrator", label: t(locale, "shell.nav.orchestrator"), group: t(locale, "shell.nav.console"), href: orchestratorHref, keywords: parseKeywords(locale, "shell.keywords.orchestrator") },
    { id: "settings", label: t(locale, "shell.nav.settings"), group: t(locale, "shell.nav.console"), href: settingsHref, keywords: parseKeywords(locale, "shell.keywords.settings") },
    { id: "gov-changesets", label: t(locale, "gov.nav.changesets"), group: t(locale, "shell.nav.governance"), href: govChangeSetsHref, keywords: parseKeywords(locale, "shell.keywords.gov.changesets") },
    { id: "gov-schemas", label: t(locale, "gov.nav.schemas"), group: t(locale, "shell.nav.governance"), href: govSchemasHref, keywords: parseKeywords(locale, "shell.keywords.gov.schemas") },
    { id: "gov-tools", label: t(locale, "gov.nav.tools"), group: t(locale, "shell.nav.governance"), href: govToolsHref, keywords: parseKeywords(locale, "shell.keywords.gov.tools") },
    { id: "gov-workbenches", label: t(locale, "gov.nav.workbenches"), group: t(locale, "shell.nav.governance"), href: govWorkbenchesHref, keywords: parseKeywords(locale, "shell.keywords.gov.workbenches") },
    { id: "gov-ui-pages", label: t(locale, "gov.nav.uiPages"), group: t(locale, "shell.nav.governance"), href: govUiPagesHref, keywords: parseKeywords(locale, "shell.keywords.gov.uiPages") },
    { id: "gov-safety", label: t(locale, "gov.nav.safetyPolicies"), group: t(locale, "shell.nav.governance"), href: govSafetyPoliciesHref, keywords: parseKeywords(locale, "shell.keywords.gov.safetyPolicies") },
    { id: "gov-approvals", label: t(locale, "gov.nav.approvals"), group: t(locale, "shell.nav.governance"), href: govApprovalsHref, keywords: parseKeywords(locale, "shell.keywords.gov.approvals") },
    { id: "gov-audit", label: t(locale, "gov.nav.audit"), group: t(locale, "shell.nav.governance"), href: govAuditHref, keywords: parseKeywords(locale, "shell.keywords.gov.audit") },
    { id: "gov-observability", label: t(locale, "gov.nav.observability"), group: t(locale, "shell.nav.governance"), href: govObservabilityHref, keywords: parseKeywords(locale, "shell.keywords.gov.observability") },
    { id: "gov-policy-snapshots", label: t(locale, "gov.nav.policySnapshots"), group: t(locale, "shell.nav.governance"), href: govPolicySnapshotsHref, keywords: parseKeywords(locale, "shell.keywords.gov.policySnapshots") },
    { id: "gov-policy-debugger", label: t(locale, "gov.nav.policyDebugger"), group: t(locale, "shell.nav.governance"), href: govPolicyDebuggerHref, keywords: parseKeywords(locale, "shell.keywords.gov.policyDebugger") },
    { id: "gov-skill-packages", label: t(locale, "gov.nav.skillPackages"), group: t(locale, "shell.nav.governance"), href: govSkillPackagesHref, keywords: parseKeywords(locale, "shell.keywords.gov.skillPackages") },
    { id: "gov-skill-runtime", label: t(locale, "gov.nav.skillRuntime"), group: t(locale, "shell.nav.governance"), href: govSkillRuntimeHref, keywords: parseKeywords(locale, "shell.keywords.gov.skillRuntime") },
    { id: "gov-models", label: t(locale, "gov.nav.models"), group: t(locale, "shell.nav.governance"), href: govModelsHref, keywords: parseKeywords(locale, "shell.keywords.gov.models") },
    { id: "gov-channels", label: t(locale, "gov.nav.channels"), group: t(locale, "shell.nav.governance"), href: govChannelsHref, keywords: parseKeywords(locale, "shell.keywords.gov.channels") },
    { id: "gov-notifications", label: t(locale, "gov.nav.notifications"), group: t(locale, "shell.nav.governance"), href: govNotificationsHref, keywords: parseKeywords(locale, "shell.keywords.gov.notifications") },
    { id: "gov-devices", label: t(locale, "gov.nav.devices"), group: t(locale, "shell.nav.governance"), href: govDevicesHref, keywords: parseKeywords(locale, "shell.keywords.gov.devices") },
    { id: "gov-triggers", label: t(locale, "gov.nav.triggers"), group: t(locale, "shell.nav.governance"), href: govTriggersHref, keywords: parseKeywords(locale, "shell.keywords.gov.triggers") },
    { id: "gov-sync-conflicts", label: t(locale, "gov.nav.syncConflicts"), group: t(locale, "shell.nav.governance"), href: govSyncConflictsHref, keywords: parseKeywords(locale, "shell.keywords.gov.syncConflicts") },
    { id: "gov-knowledge-logs", label: t(locale, "gov.nav.knowledgeLogs"), group: t(locale, "shell.nav.governance"), href: govKnowledgeLogsHref, keywords: parseKeywords(locale, "shell.keywords.gov.knowledgeLogs") },
    { id: "gov-knowledge-jobs", label: t(locale, "gov.nav.knowledgeJobs"), group: t(locale, "shell.nav.governance"), href: govKnowledgeJobsHref, keywords: parseKeywords(locale, "shell.keywords.gov.knowledgeJobs") },
    { id: "gov-knowledge-quality", label: t(locale, "gov.nav.knowledgeQuality"), group: t(locale, "shell.nav.governance"), href: govKnowledgeQualityHref, keywords: parseKeywords(locale, "shell.keywords.gov.knowledgeQuality") },
    { id: "gov-sync", label: t(locale, "gov.nav.sync"), group: t(locale, "shell.nav.governance"), href: govSyncHref, keywords: parseKeywords(locale, "shell.keywords.gov.sync") },
    { id: "gov-integrations", label: t(locale, "gov.nav.integrations"), group: t(locale, "shell.nav.governance"), href: govIntegrationsHref, keywords: parseKeywords(locale, "shell.keywords.gov.integrations") },
    { id: "gov-deadletters", label: t(locale, "gov.nav.workflowDeadletters"), group: t(locale, "shell.nav.governance"), href: govWorkflowDeadlettersHref, keywords: parseKeywords(locale, "shell.keywords.gov.workflowDeadletters") },
    { id: "gov-artifact-policy", label: t(locale, "gov.nav.artifactPolicy"), group: t(locale, "shell.nav.governance"), href: govArtifactPolicyHref, keywords: parseKeywords(locale, "shell.keywords.gov.artifactPolicy") },
    { id: "admin-rbac", label: t(locale, "home.adminRbac"), group: t(locale, "home.adminRbac"), href: adminRbacHref, keywords: parseKeywords(locale, "shell.keywords.admin.rbac") },
  ];

  return (
    <AppShell
      header={
        <AppShellHeader>
          <div className={styles.headerRow}>
            <div className={styles.headerLeft}>
              <Link className={styles.appTitle} href={homeHref}>
                {t(locale, "app.title")}
              </Link>
            </div>
            <div className={styles.headerRight}>
              <details className={styles.mobileMenu}>
                <summary>{t(locale, "shell.nav.menu")}</summary>
                <div className={styles.mobileMenuPanel}>
                  <Link href={runsHref}>{t(locale, "shell.nav.runs")}</Link>
                  <Link href={tasksHref}>{t(locale, "shell.nav.tasks")}</Link>
                  <Link href={govChangeSetsHref}>{t(locale, "gov.nav.changesets")}</Link>
                  <Link href={govSchemasHref}>{t(locale, "gov.nav.schemas")}</Link>
                  <Link href={govSafetyPoliciesHref}>{t(locale, "gov.nav.safetyPolicies")}</Link>
                  <Link href={govToolsHref}>{t(locale, "gov.nav.tools")}</Link>
                  <Link href={govWorkbenchesHref}>{t(locale, "gov.nav.workbenches")}</Link>
                  <Link href={govUiPagesHref}>{t(locale, "gov.nav.uiPages")}</Link>
                  <Link href={govSkillPackagesHref}>{t(locale, "gov.nav.skillPackages")}</Link>
                  <Link href={govModelsHref}>{t(locale, "gov.nav.models")}</Link>
                  <Link href={govChannelsHref}>{t(locale, "gov.nav.channels")}</Link>
                  <Link href={govObservabilityHref}>{t(locale, "gov.nav.observability")}</Link>
                  <Link href={govPolicyDebuggerHref}>{t(locale, "gov.nav.policyDebugger")}</Link>
                  <Link href={orchestratorHref}>{t(locale, "shell.nav.orchestrator")}</Link>
                  <Link href={adminRbacHref}>{t(locale, "home.adminRbac")}</Link>
                  <Link href={settingsHref}>{t(locale, "home.settings")}</Link>
                </div>
              </details>
              <Link href={docsHref}>{t(locale, "shell.nav.docs")}</Link>
              <Link href={settingsHref}>{t(locale, "home.settings")}</Link>
              <Link href={govChangeSetsHref}>{t(locale, "home.governanceConsole")}</Link>
              <button className={styles.paletteBtn} onClick={openPalette} type="button" title="Ctrl+K">
                {t(locale, "cmdPalette.openButton")}
                <span className={styles.paletteBtnKbd}>⌘K</span>
              </button>
            </div>
          </div>
        </AppShellHeader>
      }
      sideNav={
        <AppShellSideNav>
          <RecentNavSection items={paletteItems} locale={locale} pathname={pathname} />

          <div className={styles.navGroup}>
            <div className={styles.navGroupTitle}>{t(locale, "shell.nav.console")}</div>
            <ul className={styles.navList}>
              <li><NavLink href={runsHref} label={t(locale, "shell.nav.runs")} desc={t(locale, "shell.desc.runs")} pathname={pathname} /></li>
              <li><NavLink href={tasksHref} label={t(locale, "shell.nav.tasks")} desc={t(locale, "shell.desc.tasks")} pathname={pathname} /></li>
              <li><NavLink href={settingsHref} label={t(locale, "shell.nav.settings")} desc={t(locale, "shell.desc.settings")} pathname={pathname} /></li>
            </ul>
          </div>

          <div className={styles.navGroup}>
            <div className={styles.navGroupTitle}>{t(locale, "shell.nav.governance")}</div>

            <NavSubGroup groupKey="gov-data" label={t(locale, "gov.group.dataModel")} defaultOpen forceOpen={pathname.startsWith("/gov/changesets") || pathname.startsWith("/gov/schemas")}>
              <li><NavLink href={govChangeSetsHref} label={t(locale, "gov.nav.changesets")} desc={t(locale, "gov.desc.changesets")} pathname={pathname} /></li>
              <li><NavLink href={govSchemasHref} label={t(locale, "gov.nav.schemas")} desc={t(locale, "gov.desc.schemas")} pathname={pathname} /></li>
            </NavSubGroup>

            <NavSubGroup groupKey="gov-security" label={t(locale, "gov.group.security")} forceOpen={pathname.startsWith("/gov/safety-policies") || pathname.startsWith("/gov/policy-snapshots") || pathname.startsWith("/gov/policy-debugger") || pathname.startsWith("/gov/artifact-policy")}>
              <li><NavLink href={govSafetyPoliciesHref} label={t(locale, "gov.nav.safetyPolicies")} desc={t(locale, "gov.desc.safetyPolicies")} pathname={pathname} /></li>
              <li><NavLink href={govPolicySnapshotsHref} label={t(locale, "gov.nav.policySnapshots")} desc={t(locale, "gov.desc.policySnapshots")} pathname={pathname} /></li>
              <li><NavLink href={govPolicyDebuggerHref} label={t(locale, "gov.nav.policyDebugger")} desc={t(locale, "gov.desc.policyDebugger")} pathname={pathname} /></li>
              <li><NavLink href={govArtifactPolicyHref} label={t(locale, "gov.nav.artifactPolicy")} desc={t(locale, "gov.desc.artifactPolicy")} pathname={pathname} /></li>
            </NavSubGroup>

            <NavSubGroup groupKey="gov-tools" label={t(locale, "gov.group.toolsSkills")} forceOpen={pathname.startsWith("/gov/tools") || pathname.startsWith("/gov/workbenches") || pathname.startsWith("/gov/ui-pages") || pathname.startsWith("/gov/skill-packages") || pathname.startsWith("/gov/skill-runtime")}>
              <li><NavLink href={govToolsHref} label={t(locale, "gov.nav.tools")} desc={t(locale, "gov.desc.tools")} pathname={pathname} /></li>
              <li><NavLink href={govWorkbenchesHref} label={t(locale, "gov.nav.workbenches")} desc={t(locale, "gov.desc.workbenches")} pathname={pathname} /></li>
              <li><NavLink href={govUiPagesHref} label={t(locale, "gov.nav.uiPages")} desc={t(locale, "gov.desc.uiPages")} pathname={pathname} /></li>
              <li><NavLink href={govSkillPackagesHref} label={t(locale, "gov.nav.skillPackages")} desc={t(locale, "gov.desc.skillPackages")} pathname={pathname} /></li>
              <li><NavLink href={govSkillRuntimeHref} label={t(locale, "gov.nav.skillRuntime")} desc={t(locale, "gov.desc.skillRuntime")} pathname={pathname} /></li>
            </NavSubGroup>

            <NavSubGroup groupKey="gov-connectivity" label={t(locale, "gov.group.modelChannel")} forceOpen={pathname.startsWith("/gov/models") || pathname.startsWith("/gov/channels") || pathname.startsWith("/gov/triggers") || pathname.startsWith("/gov/notifications") || pathname.startsWith("/gov/integrations")}>
              <li><NavLink href={govModelsHref} label={t(locale, "gov.nav.models")} desc={t(locale, "gov.desc.models")} pathname={pathname} /></li>
              <li><NavLink href={govChannelsHref} label={t(locale, "gov.nav.channels")} desc={t(locale, "gov.desc.channels")} pathname={pathname} /></li>
              <li><NavLink href={govTriggersHref} label={t(locale, "gov.nav.triggers")} desc={t(locale, "gov.desc.triggers")} pathname={pathname} /></li>
              <li><NavLink href={govNotificationsHref} label={t(locale, "gov.nav.notifications")} desc={t(locale, "gov.desc.notifications")} pathname={pathname} /></li>
              <li><NavLink href={govIntegrationsHref} label={t(locale, "gov.nav.integrations")} desc={t(locale, "gov.desc.integrations")} pathname={pathname} /></li>
            </NavSubGroup>

            <NavSubGroup groupKey="gov-audit" label={t(locale, "gov.group.auditOps")} forceOpen={pathname.startsWith("/gov/approvals") || pathname.startsWith("/gov/workflow") || pathname.startsWith("/gov/audit") || pathname.startsWith("/gov/observability") || pathname.startsWith("/gov/devices") || pathname.startsWith("/gov/sync") || pathname.startsWith("/gov/knowledge") || pathname.startsWith("/orchestrator")}>
              <li><NavLink href={govApprovalsHref} label={t(locale, "gov.nav.approvals")} desc={t(locale, "gov.desc.approvals")} pathname={pathname} /></li>
              <li><NavLink href={govWorkflowDeadlettersHref} label={t(locale, "gov.nav.workflowDeadletters")} desc={t(locale, "gov.desc.workflowDeadletters")} pathname={pathname} /></li>
              <li><NavLink href={govAuditHref} label={t(locale, "gov.nav.audit")} desc={t(locale, "gov.desc.audit")} pathname={pathname} /></li>
              <li><NavLink href={govObservabilityHref} label={t(locale, "gov.nav.observability")} desc={t(locale, "gov.desc.observability")} pathname={pathname} /></li>
              <li><NavLink href={govDevicesHref} label={t(locale, "gov.nav.devices")} desc={t(locale, "gov.desc.devices")} pathname={pathname} /></li>
              <li><NavLink href={govSyncHref} label={t(locale, "gov.nav.sync")} desc={t(locale, "gov.desc.sync")} pathname={pathname} /></li>
              <li><NavLink href={govSyncConflictsHref} label={t(locale, "gov.nav.syncConflicts")} desc={t(locale, "gov.desc.syncConflicts")} pathname={pathname} /></li>
              <li><NavLink href={govKnowledgeLogsHref} label={t(locale, "gov.nav.knowledgeLogs")} desc={t(locale, "gov.desc.knowledgeLogs")} pathname={pathname} /></li>
              <li><NavLink href={govKnowledgeJobsHref} label={t(locale, "gov.nav.knowledgeJobs")} desc={t(locale, "gov.desc.knowledgeJobs")} pathname={pathname} /></li>
              <li><NavLink href={govKnowledgeQualityHref} label={t(locale, "gov.nav.knowledgeQuality")} desc={t(locale, "gov.desc.knowledgeQuality")} pathname={pathname} /></li>
              <li><NavLink href={orchestratorHref} label={t(locale, "shell.nav.orchestrator")} desc={t(locale, "shell.desc.orchestrator")} pathname={pathname} /></li>
            </NavSubGroup>
          </div>

          <div className={styles.navGroup}>
            <div className={styles.navGroupTitle}>{t(locale, "home.adminRbac")}</div>
            <ul className={styles.navList}>
              <li>
                <NavLink href={adminRbacHref} label={t(locale, "home.adminRbac")} pathname={pathname} />
              </li>
            </ul>
          </div>
        </AppShellSideNav>
      }
    >
      <AppShellContent>{props.children}</AppShellContent>
      <CommandPalette items={paletteItems} locale={locale} open={paletteOpen} onClose={closePalette} />
    </AppShell>
  );
}

export function ConsoleShell(props: { locale?: string; children: ReactNode }) {
  return (
    <Suspense>
      <ConsoleShellInner>{props.children}</ConsoleShellInner>
    </Suspense>
  );
}
