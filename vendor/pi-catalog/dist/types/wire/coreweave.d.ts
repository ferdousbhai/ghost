export declare const COREWEAVE_PROJECT_HEADER: "OpenAI-Project";
export interface CoreWeaveProjectEnv {
    [key: string]: string | undefined;
    COREWEAVE_PROJECT?: string;
    WANDB_INFERENCE_PROJECT?: string;
    WANDB_ENTITY?: string;
    WANDB_PROJECT?: string;
}
export declare function resolveCoreWeaveProject(env: CoreWeaveProjectEnv): string | undefined;
export declare function coreWeaveProjectHeaders(env: CoreWeaveProjectEnv): Record<string, string> | undefined;
export declare function hasCoreWeaveProjectHeader(headers: Record<string, string>): boolean;
export declare function removeBlankCoreWeaveProjectHeaders(headers: Record<string, string>): void;
