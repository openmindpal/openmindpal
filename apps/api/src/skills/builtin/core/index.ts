/**
 * Builtin Core Layer — Essential platform capabilities, always registered.
 *
 * These skills provide critical system functionality and cannot be disabled:
 * - orchestrator: Workflow orchestration
 * - model.gateway: LLM model routing
 * - knowledge.rag: Knowledge retrieval
 * - memory.manager: Memory persistence
 * - safety.policy: Safety policy enforcement
 * - connector.manager: External connector management
 * - task.manager: Task lifecycle management
 * - channel.gateway: Channel routing
 * - trigger.engine: Trigger scheduling
 */

export { default as orchestrator } from "../../orchestrator";
export { default as modelGateway } from "../../model-gateway";
export { default as knowledgeRag } from "../../knowledge-rag";
export { default as memoryManager } from "../../memory-manager";
export { default as safetyPolicy } from "../../safety-policy";
export { default as connectorManager } from "../../connector-manager";
export { default as taskManager } from "../../task-manager";
export { default as channelGateway } from "../../channel-gateway";
export { default as triggerEngine } from "../../trigger-engine";
