import type { FetchImpl, ModelSpec } from "../types.js";
type GitLabDuoWorkflowCandidateSource = "override" | "project" | "remote" | "group";
export interface GitLabDuoWorkflowModelRef {
    name: string;
    ref: string;
}
/**
 * GitLab Duo Workflow model/namespace discovery configuration.
 */
export interface GitLabDuoWorkflowDiscoveryConfig {
    apiKey: string;
    baseUrl?: string;
    fetch?: FetchImpl;
    namespaceId?: string;
    projectId?: string;
    projectPath?: string;
    cwd?: string;
}
export interface GitLabDuoWorkflowNamespaceSelection {
    rootNamespaceId: string;
    namespacePath?: string;
    projectPath?: string;
    source: GitLabDuoWorkflowCandidateSource;
}
export declare function discoverGitLabDuoWorkflowNamespace(config: GitLabDuoWorkflowDiscoveryConfig): Promise<GitLabDuoWorkflowNamespaceSelection>;
export declare function discoverGitLabDuoWorkflowRuntimeNamespace(config: GitLabDuoWorkflowDiscoveryConfig): Promise<GitLabDuoWorkflowNamespaceSelection>;
export declare function fetchGitLabDuoWorkflowModels(config: GitLabDuoWorkflowDiscoveryConfig): Promise<readonly ModelSpec<"gitlab-duo-agent">[] | null>;
export declare function buildGitLabDuoWorkflowModelSpec(model: GitLabDuoWorkflowModelRef, baseUrl?: string, rootNamespaceId?: string): ModelSpec<"gitlab-duo-agent">;
export declare function buildGitLabDuoWorkflowFallbackModel(id?: string, name?: string, baseUrl?: string): ModelSpec<"gitlab-duo-agent">;
export {};
