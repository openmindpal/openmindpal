/**
 * Builtin Optional Layer — Standard platform capabilities, can be disabled.
 *
 * These skills are registered by default but can be disabled via DISABLED_BUILTIN_SKILLS:
 * - nl2ui.generator: Natural language to UI generation
 * - ui.page.config: UI page configuration
 * - workbench.manager: Workbench management
 * - oauth.provider: OAuth authentication
 * - sso.provider: Single sign-on
 * - notification.outbox: Notification delivery
 * - subscription.runner: Subscription execution
 * - device.runtime: Device runtime management
 * - collab.runtime: Collaboration runtime
 * - sync.engine: Data synchronization
 * - agent.runtime: Agent execution runtime
 * - yjs.collab: Yjs collaboration
 * - skill.manager: Skill lifecycle management
 * - rbac.manager: Role-based access control
 */

export { default as nl2uiGenerator } from "../../nl2ui-generator";
export { default as uiPageConfig } from "../../ui-page-config";
export { default as workbenchManager } from "../../workbench-manager";
export { default as oauthProvider } from "../../oauth-provider";
export { default as ssoProvider } from "../../sso-provider";
export { default as notificationOutbox } from "../../notification-outbox";
export { default as subscriptionRunner } from "../../subscription-runner";
export { default as deviceRuntime } from "../../device-runtime";
export { default as collabRuntime } from "../../collab-runtime";
export { default as syncEngine } from "../../sync-engine";
export { default as agentRuntime } from "../../agent-runtime";
export { default as yjsCollab } from "../../yjs-collab";
export { default as skillManager } from "../../skill-manager";
export { default as rbacManager } from "../../rbac-manager";
