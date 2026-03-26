/**
 * Extension Layer — Optional upper-layer capabilities, loaded on demand.
 *
 * These skills are not loaded by default and must be explicitly enabled
 * via ENABLED_EXTENSIONS environment variable:
 * - media.pipeline: Media processing
 * - backup.manager: Backup management
 * - replay.viewer: Replay visualization
 * - artifact.manager: Artifact storage
 * - analytics.engine: Analytics processing
 * - identity.link: Identity linking
 * - user.view.prefs: User view preferences
 * - ai.event.reasoning: AI-powered event reasoning
 */

export { default as mediaPipeline } from "../media-pipeline";
export { default as backupManager } from "../backup-manager";
export { default as replayViewer } from "../replay-viewer";
export { default as artifactManager } from "../artifact-manager";
export { default as analyticsEngine } from "../analytics-engine";
export { default as identityLink } from "../identity-link";
export { default as userViewPrefs } from "../user-view-prefs";
export { default as aiEventReasoning } from "../ai-event-reasoning";
