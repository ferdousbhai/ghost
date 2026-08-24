/**
 * Cursor agent protocol declarations used by Oh My Pi.
 *
 * Each declaration retains only fields consumed by the client or its protocol tests.
 */
import { type MessageCodec, type ProtoMessage } from "./protobuf.js";
/** Cursor agent enum CommandClassifierResult_SuggestedSandboxMode. */
export declare enum CommandClassifierResult_SuggestedSandboxMode {
    UNSPECIFIED = 0,
    SANDBOX = 1,
    NO_SANDBOX = 2,
    UNDETERMINED = 3
}
/** Cursor agent enum ConversationSearchSource. */
export declare enum ConversationSearchSource {
    UNSPECIFIED = 0,
    LOCAL = 1,
    CLOUD_CACHE = 2
}
/** Cursor agent enum DiagnosticSeverity. */
export declare enum DiagnosticSeverity {
    UNSPECIFIED = 0,
    ERROR = 1,
    WARNING = 2,
    INFORMATION = 3,
    HINT = 4
}
/** Cursor agent enum CursorRuleSource. */
export declare enum CursorRuleSource {
    UNSPECIFIED = 0,
    TEAM = 1,
    USER = 2
}
/** Cursor agent enum ForceBackgroundShellStatus. */
export declare enum ForceBackgroundShellStatus {
    UNSPECIFIED = 0,
    ACCEPTED = 1,
    NOT_FOUND = 2
}
/** Cursor agent enum ForceBackgroundSubagentStatus. */
export declare enum ForceBackgroundSubagentStatus {
    UNSPECIFIED = 0,
    ACCEPTED = 1,
    NOT_FOUND = 2
}
/** Cursor agent enum GetDiffRequest_OutputFormat. */
export declare enum GetDiffRequest_OutputFormat {
    UNSPECIFIED = 0,
    NAME_STATUS = 1,
    NAME_STATUS_AND_NUMSTAT = 2,
    FILE_DIFFS = 3,
    DIFFS_WITH_BEFORE_AND_AFTER = 4
}
/** Cursor agent enum GitDiff_DiffType. */
export declare enum GitDiff_DiffType {
    UNSPECIFIED = 0,
    DIFF_TO_HEAD = 1,
    DIFF_FROM_BRANCH_TO_MAIN = 2
}
/** Cursor agent enum ShellBackgroundReason. */
export declare enum ShellBackgroundReason {
    UNSPECIFIED = 0,
    TIMEOUT = 1,
    USER_REQUEST = 2
}
/** Cursor agent enum ShellHookApprovalRequirement_Kind. */
export declare enum ShellHookApprovalRequirement_Kind {
    UNSPECIFIED = 0,
    FORCE_PROMPT = 1
}
/** Cursor agent enum SmartModeClassifierDecision. */
export declare enum SmartModeClassifierDecision {
    UNSPECIFIED = 0,
    ALLOW = 1,
    BLOCK = 2
}
/** Cursor agent enum SubagentBackgroundReason. */
export declare enum SubagentBackgroundReason {
    UNSPECIFIED = 0,
    AGENT_REQUEST = 1,
    USER_REQUEST = 2,
    QUEUED_FOLLOW_UP = 3
}
/** Cursor agent message agent.v1.AfterAgentResponseRequestQuery. */
export interface AfterAgentResponseRequestQuery extends ProtoMessage {
}
export declare const AfterAgentResponseRequestQuerySchema: MessageCodec<AfterAgentResponseRequestQuery>;
/** Cursor agent message agent.v1.AfterAgentResponseRequestResponse. */
export interface AfterAgentResponseRequestResponse extends ProtoMessage {
}
export declare const AfterAgentResponseRequestResponseSchema: MessageCodec<AfterAgentResponseRequestResponse>;
/** Cursor agent message agent.v1.AfterAgentThoughtRequestQuery. */
export interface AfterAgentThoughtRequestQuery extends ProtoMessage {
}
export declare const AfterAgentThoughtRequestQuerySchema: MessageCodec<AfterAgentThoughtRequestQuery>;
/** Cursor agent message agent.v1.AfterAgentThoughtRequestResponse. */
export interface AfterAgentThoughtRequestResponse extends ProtoMessage {
}
export declare const AfterAgentThoughtRequestResponseSchema: MessageCodec<AfterAgentThoughtRequestResponse>;
/** Cursor agent message agent.v1.AgentClientMessage. */
export interface AgentClientMessage extends ProtoMessage {
    message: {
        case: undefined;
        value?: undefined;
    } | {
        case: "runRequest";
        value: AgentRunRequest;
    } | {
        case: "execClientMessage";
        value: ExecClientMessage;
    } | {
        case: "execClientControlMessage";
        value: ExecClientControlMessage;
    } | {
        case: "kvClientMessage";
        value: KvClientMessage;
    } | {
        case: "conversationAction";
        value: ConversationAction;
    } | {
        case: "interactionResponse";
        value: InteractionResponse;
    } | {
        case: "clientHeartbeat";
        value: ClientHeartbeat;
    } | {
        case: "prewarmRequest";
        value: PrewarmRequest;
    };
}
export declare const AgentClientMessageSchema: MessageCodec<AgentClientMessage>;
/** Cursor agent message agent.v1.AgentConversationTurnStructure. */
export interface AgentConversationTurnStructure extends ProtoMessage {
    userMessage: Uint8Array;
    steps: Uint8Array[];
    requestId?: string;
}
export declare const AgentConversationTurnStructureSchema: MessageCodec<AgentConversationTurnStructure>;
/** Cursor agent message agent.v1.AgentRunRequest. */
export interface AgentRunRequest extends ProtoMessage {
    conversationState?: ConversationStateStructure;
    action?: ConversationAction;
    modelDetails?: ModelDetails;
    requestedModel?: RequestedModel;
    mcpTools?: McpTools;
    conversationId?: string;
    mcpFileSystemOptions?: McpFileSystemOptions;
    skillOptions?: SkillOptions;
    customSystemPrompt?: string;
}
export declare const AgentRunRequestSchema: MessageCodec<AgentRunRequest>;
/** Cursor agent message agent.v1.AgentServerMessage. */
export interface AgentServerMessage extends ProtoMessage {
    message: {
        case: undefined;
        value?: undefined;
    } | {
        case: "interactionUpdate";
        value: InteractionUpdate;
    } | {
        case: "execServerMessage";
        value: ExecServerMessage;
    } | {
        case: "execServerControlMessage";
        value: ExecServerControlMessage;
    } | {
        case: "conversationCheckpointUpdate";
        value: ConversationStateStructure;
    } | {
        case: "kvServerMessage";
        value: KvServerMessage;
    } | {
        case: "interactionQuery";
        value: InteractionQuery;
    };
}
export declare const AgentServerMessageSchema: MessageCodec<AgentServerMessage>;
/** Cursor agent message agent.v1.AgentStoreConflictArgs. */
export interface AgentStoreConflictArgs extends ProtoMessage {
    cursor?: AgentStoreConflictCursor;
    advance?: boolean;
}
export declare const AgentStoreConflictArgsSchema: MessageCodec<AgentStoreConflictArgs>;
/** Cursor agent message agent.v1.AgentStoreConflictCursor. */
export interface AgentStoreConflictCursor extends ProtoMessage {
    journalEpoch: string;
    seq: bigint;
    lastEventId: string;
}
export declare const AgentStoreConflictCursorSchema: MessageCodec<AgentStoreConflictCursor>;
/** Cursor agent message agent.v1.AgentStoreConflictError. */
export interface AgentStoreConflictError extends ProtoMessage {
    error: string;
}
export declare const AgentStoreConflictErrorSchema: MessageCodec<AgentStoreConflictError>;
/** Cursor agent message agent.v1.AgentStoreConflictEvent. */
export interface AgentStoreConflictEvent extends ProtoMessage {
    v: number;
    eventId: string;
    journalEpoch: string;
    seq: bigint;
    tsMs: bigint;
    kind: string;
    storeId?: string;
    originalRelPath?: string;
    conflictRelPath?: string;
    originalAbsPath?: string;
    conflictAbsPath?: string;
    preservedBytes?: bigint;
}
export declare const AgentStoreConflictEventSchema: MessageCodec<AgentStoreConflictEvent>;
/** Cursor agent message agent.v1.AgentStoreConflictResult. */
export interface AgentStoreConflictResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: AgentStoreConflictSuccess;
    } | {
        case: "error";
        value: AgentStoreConflictError;
    };
}
export declare const AgentStoreConflictResultSchema: MessageCodec<AgentStoreConflictResult>;
/** Cursor agent message agent.v1.AgentStoreConflictSuccess. */
export interface AgentStoreConflictSuccess extends ProtoMessage {
    events: AgentStoreConflictEvent[];
    nextCursor?: AgentStoreConflictCursor;
    gap: boolean;
}
export declare const AgentStoreConflictSuccessSchema: MessageCodec<AgentStoreConflictSuccess>;
/** Cursor agent message agent.v1.ApiKeyCredentials. */
export interface ApiKeyCredentials extends ProtoMessage {
    apiKey: string;
    baseUrl?: string;
}
export declare const ApiKeyCredentialsSchema: MessageCodec<ApiKeyCredentials>;
/** Cursor agent message agent.v1.AppliedAgentChange. */
export interface AppliedAgentChange extends ProtoMessage {
    path: string;
    changeType: number;
    beforeContent?: string;
    afterContent?: string;
    error?: string;
    messageForModel?: string;
}
export declare const AppliedAgentChangeSchema: MessageCodec<AppliedAgentChange>;
/** Cursor agent message agent.v1.ApplyAgentDiffArgs. */
export interface ApplyAgentDiffArgs extends ProtoMessage {
    agentId: string;
}
export declare const ApplyAgentDiffArgsSchema: MessageCodec<ApplyAgentDiffArgs>;
/** Cursor agent message agent.v1.ApplyAgentDiffError. */
export interface ApplyAgentDiffError extends ProtoMessage {
    error: string;
    appliedChanges: AppliedAgentChange[];
}
export declare const ApplyAgentDiffErrorSchema: MessageCodec<ApplyAgentDiffError>;
/** Cursor agent message agent.v1.ApplyAgentDiffResult. */
export interface ApplyAgentDiffResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: ApplyAgentDiffSuccess;
    } | {
        case: "error";
        value: ApplyAgentDiffError;
    };
}
export declare const ApplyAgentDiffResultSchema: MessageCodec<ApplyAgentDiffResult>;
/** Cursor agent message agent.v1.ApplyAgentDiffSuccess. */
export interface ApplyAgentDiffSuccess extends ProtoMessage {
    appliedChanges: AppliedAgentChange[];
}
export declare const ApplyAgentDiffSuccessSchema: MessageCodec<ApplyAgentDiffSuccess>;
/** Cursor agent message agent.v1.ApplyAgentDiffToolCall. */
export interface ApplyAgentDiffToolCall extends ProtoMessage {
    args?: ApplyAgentDiffArgs;
    result?: ApplyAgentDiffResult;
}
export declare const ApplyAgentDiffToolCallSchema: MessageCodec<ApplyAgentDiffToolCall>;
/** Cursor agent message agent.v1.AskQuestionArgs. */
export interface AskQuestionArgs extends ProtoMessage {
    title: string;
    questions: AskQuestionArgs_Question[];
    runAsync: boolean;
    asyncOriginalToolCallId: string;
}
export declare const AskQuestionArgsSchema: MessageCodec<AskQuestionArgs>;
/** Cursor agent message agent.v1.AskQuestionArgs_Option. */
export interface AskQuestionArgs_Option extends ProtoMessage {
    id: string;
    label: string;
}
export declare const AskQuestionArgs_OptionSchema: MessageCodec<AskQuestionArgs_Option>;
/** Cursor agent message agent.v1.AskQuestionArgs_Question. */
export interface AskQuestionArgs_Question extends ProtoMessage {
    id: string;
    prompt: string;
    options: AskQuestionArgs_Option[];
    allowMultiple: boolean;
}
export declare const AskQuestionArgs_QuestionSchema: MessageCodec<AskQuestionArgs_Question>;
/** Cursor agent message agent.v1.AskQuestionAsync. */
export interface AskQuestionAsync extends ProtoMessage {
}
export declare const AskQuestionAsyncSchema: MessageCodec<AskQuestionAsync>;
/** Cursor agent message agent.v1.AskQuestionError. */
export interface AskQuestionError extends ProtoMessage {
    errorMessage: string;
}
export declare const AskQuestionErrorSchema: MessageCodec<AskQuestionError>;
/** Cursor agent message agent.v1.AskQuestionInteractionQuery. */
export interface AskQuestionInteractionQuery extends ProtoMessage {
    args?: AskQuestionArgs;
    toolCallId: string;
}
export declare const AskQuestionInteractionQuerySchema: MessageCodec<AskQuestionInteractionQuery>;
/** Cursor agent message agent.v1.AskQuestionInteractionResponse. */
export interface AskQuestionInteractionResponse extends ProtoMessage {
    result?: AskQuestionResult;
}
export declare const AskQuestionInteractionResponseSchema: MessageCodec<AskQuestionInteractionResponse>;
/** Cursor agent message agent.v1.AskQuestionRejected. */
export interface AskQuestionRejected extends ProtoMessage {
    reason: string;
}
export declare const AskQuestionRejectedSchema: MessageCodec<AskQuestionRejected>;
/** Cursor agent message agent.v1.AskQuestionResult. */
export interface AskQuestionResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: AskQuestionSuccess;
    } | {
        case: "error";
        value: AskQuestionError;
    } | {
        case: "rejected";
        value: AskQuestionRejected;
    } | {
        case: "async";
        value: AskQuestionAsync;
    };
}
export declare const AskQuestionResultSchema: MessageCodec<AskQuestionResult>;
/** Cursor agent message agent.v1.AskQuestionSuccess. */
export interface AskQuestionSuccess extends ProtoMessage {
    answers: AskQuestionSuccess_Answer[];
}
export declare const AskQuestionSuccessSchema: MessageCodec<AskQuestionSuccess>;
/** Cursor agent message agent.v1.AskQuestionSuccess_Answer. */
export interface AskQuestionSuccess_Answer extends ProtoMessage {
    questionId: string;
    selectedOptionIds: string[];
}
export declare const AskQuestionSuccess_AnswerSchema: MessageCodec<AskQuestionSuccess_Answer>;
/** Cursor agent message agent.v1.AskQuestionToolCall. */
export interface AskQuestionToolCall extends ProtoMessage {
    args?: AskQuestionArgs;
    result?: AskQuestionResult;
}
export declare const AskQuestionToolCallSchema: MessageCodec<AskQuestionToolCall>;
/** Cursor agent message agent.v1.AssistantMessage. */
export interface AssistantMessage extends ProtoMessage {
    text: string;
}
export declare const AssistantMessageSchema: MessageCodec<AssistantMessage>;
/** Cursor agent message agent.v1.AsyncAskQuestionCompletionAction. */
export interface AsyncAskQuestionCompletionAction extends ProtoMessage {
    originalToolCallId: string;
    originalArgs?: AskQuestionArgs;
    result?: AskQuestionResult;
}
export declare const AsyncAskQuestionCompletionActionSchema: MessageCodec<AsyncAskQuestionCompletionAction>;
/** Cursor agent message agent.v1.AzureCredentials. */
export interface AzureCredentials extends ProtoMessage {
    apiKey: string;
    baseUrl: string;
    deployment: string;
}
export declare const AzureCredentialsSchema: MessageCodec<AzureCredentials>;
/** Cursor agent message agent.v1.BackgroundShellSpawnArgs. */
export interface BackgroundShellSpawnArgs extends ProtoMessage {
    command: string;
    workingDirectory: string;
    toolCallId: string;
    parsingResult?: ShellCommandParsingResult;
    sandboxPolicy?: SandboxPolicy;
    enableWriteShellStdinTool: boolean;
    description?: string;
    classifierResult?: CommandClassifierResult;
    outputNotification?: ShellOutputNotificationConfig;
    smartModeApproval?: SmartModeApproval;
    hookApprovalRequirement?: ShellHookApprovalRequirement;
    skipApproval: boolean;
    conversationId?: string;
}
export declare const BackgroundShellSpawnArgsSchema: MessageCodec<BackgroundShellSpawnArgs>;
/** Cursor agent message agent.v1.BackgroundShellSpawnError. */
export interface BackgroundShellSpawnError extends ProtoMessage {
    command: string;
    workingDirectory: string;
    error: string;
}
export declare const BackgroundShellSpawnErrorSchema: MessageCodec<BackgroundShellSpawnError>;
/** Cursor agent message agent.v1.BackgroundShellSpawnResult. */
export interface BackgroundShellSpawnResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: BackgroundShellSpawnSuccess;
    } | {
        case: "error";
        value: BackgroundShellSpawnError;
    } | {
        case: "rejected";
        value: ShellRejected;
    } | {
        case: "permissionDenied";
        value: ShellPermissionDenied;
    };
}
export declare const BackgroundShellSpawnResultSchema: MessageCodec<BackgroundShellSpawnResult>;
/** Cursor agent message agent.v1.BackgroundShellSpawnSuccess. */
export interface BackgroundShellSpawnSuccess extends ProtoMessage {
    shellId: number;
    command: string;
    workingDirectory: string;
    pid?: number;
}
export declare const BackgroundShellSpawnSuccessSchema: MessageCodec<BackgroundShellSpawnSuccess>;
/** Cursor agent message agent.v1.BedrockCredentials. */
export interface BedrockCredentials extends ProtoMessage {
    accessKey: string;
    secretKey: string;
    region: string;
    sessionToken?: string;
}
export declare const BedrockCredentialsSchema: MessageCodec<BedrockCredentials>;
/** Cursor agent message agent.v1.BeforeSubmitPromptRequestQuery. */
export interface BeforeSubmitPromptRequestQuery extends ProtoMessage {
}
export declare const BeforeSubmitPromptRequestQuerySchema: MessageCodec<BeforeSubmitPromptRequestQuery>;
/** Cursor agent message agent.v1.BeforeSubmitPromptRequestResponse. */
export interface BeforeSubmitPromptRequestResponse extends ProtoMessage {
    continue?: boolean;
    userMessage?: string;
    additionalContext?: string;
}
export declare const BeforeSubmitPromptRequestResponseSchema: MessageCodec<BeforeSubmitPromptRequestResponse>;
/** Cursor agent message agent.v1.CallFrame. */
export interface CallFrame extends ProtoMessage {
    functionName?: string;
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
}
export declare const CallFrameSchema: MessageCodec<CallFrame>;
/** Cursor agent message agent.v1.CancelAction. */
export interface CancelAction extends ProtoMessage {
}
export declare const CancelActionSchema: MessageCodec<CancelAction>;
/** Cursor agent message agent.v1.CanvasDiagnosticsArgs. */
export interface CanvasDiagnosticsArgs extends ProtoMessage {
    path: string;
    toolCallId: string;
}
export declare const CanvasDiagnosticsArgsSchema: MessageCodec<CanvasDiagnosticsArgs>;
/** Cursor agent message agent.v1.CanvasDiagnosticsError. */
export interface CanvasDiagnosticsError extends ProtoMessage {
    path: string;
    error: string;
}
export declare const CanvasDiagnosticsErrorSchema: MessageCodec<CanvasDiagnosticsError>;
/** Cursor agent message agent.v1.CanvasDiagnosticsResult. */
export interface CanvasDiagnosticsResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: CanvasDiagnosticsSuccess;
    } | {
        case: "error";
        value: CanvasDiagnosticsError;
    };
}
export declare const CanvasDiagnosticsResultSchema: MessageCodec<CanvasDiagnosticsResult>;
/** Cursor agent message agent.v1.CanvasDiagnosticsSuccess. */
export interface CanvasDiagnosticsSuccess extends ProtoMessage {
    path: string;
    diagnostics: Diagnostic[];
}
export declare const CanvasDiagnosticsSuccessSchema: MessageCodec<CanvasDiagnosticsSuccess>;
/** Cursor agent message agent.v1.ClickAction. */
export interface ClickAction extends ProtoMessage {
    coordinate?: Coordinate;
    button: number;
    count: number;
    modifierKeys?: string;
}
export declare const ClickActionSchema: MessageCodec<ClickAction>;
/** Cursor agent message agent.v1.ClientHeartbeat. */
export interface ClientHeartbeat extends ProtoMessage {
}
export declare const ClientHeartbeatSchema: MessageCodec<ClientHeartbeat>;
/** Cursor agent message agent.v1.CommandClassifierResult. */
export interface CommandClassifierResult extends ProtoMessage {
    commands: CommandClassifierResult_ClassifiedCommand[];
    suggestedSandboxMode: CommandClassifierResult_SuggestedSandboxMode;
    classificationFailed: boolean;
}
export declare const CommandClassifierResultSchema: MessageCodec<CommandClassifierResult>;
/** Cursor agent message agent.v1.CommandClassifierResult_ClassifiedCommand. */
export interface CommandClassifierResult_ClassifiedCommand extends ProtoMessage {
    name: string;
    arguments: string[];
    suggestedAllowlistEntry?: string;
    subcommandTokens: string[];
}
export declare const CommandClassifierResult_ClassifiedCommandSchema: MessageCodec<CommandClassifierResult_ClassifiedCommand>;
/** Cursor agent message agent.v1.ComputerUseAction. */
export interface ComputerUseAction extends ProtoMessage {
    action: {
        case: undefined;
        value?: undefined;
    } | {
        case: "mouseMove";
        value: MouseMoveAction;
    } | {
        case: "click";
        value: ClickAction;
    } | {
        case: "mouseDown";
        value: MouseDownAction;
    } | {
        case: "mouseUp";
        value: MouseUpAction;
    } | {
        case: "drag";
        value: DragAction;
    } | {
        case: "scroll";
        value: ScrollAction;
    } | {
        case: "type";
        value: TypeAction;
    } | {
        case: "key";
        value: KeyAction;
    } | {
        case: "wait";
        value: WaitAction;
    } | {
        case: "screenshot";
        value: ScreenshotAction;
    } | {
        case: "cursorPosition";
        value: CursorPositionAction;
    };
}
export declare const ComputerUseActionSchema: MessageCodec<ComputerUseAction>;
/** Cursor agent message agent.v1.ComputerUseArgs. */
export interface ComputerUseArgs extends ProtoMessage {
    toolCallId: string;
    actions: ComputerUseAction[];
}
export declare const ComputerUseArgsSchema: MessageCodec<ComputerUseArgs>;
/** Cursor agent message agent.v1.ComputerUseError. */
export interface ComputerUseError extends ProtoMessage {
    error: string;
    actionCount: number;
    durationMs: number;
    log?: string;
    screenshot?: string;
    screenshotPath?: string;
}
export declare const ComputerUseErrorSchema: MessageCodec<ComputerUseError>;
/** Cursor agent message agent.v1.ComputerUseResult. */
export interface ComputerUseResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: ComputerUseSuccess;
    } | {
        case: "error";
        value: ComputerUseError;
    };
}
export declare const ComputerUseResultSchema: MessageCodec<ComputerUseResult>;
/** Cursor agent message agent.v1.ComputerUseSuccess. */
export interface ComputerUseSuccess extends ProtoMessage {
    actionCount: number;
    durationMs: number;
    screenshot?: string;
    log?: string;
    screenshotPath?: string;
    cursorPosition?: Coordinate;
}
export declare const ComputerUseSuccessSchema: MessageCodec<ComputerUseSuccess>;
/** Cursor agent message agent.v1.ComputerUseToolCall. */
export interface ComputerUseToolCall extends ProtoMessage {
    args?: ComputerUseArgs;
    result?: ComputerUseResult;
}
export declare const ComputerUseToolCallSchema: MessageCodec<ComputerUseToolCall>;
/** Cursor agent message agent.v1.ConnectScmArgs. */
export interface ConnectScmArgs extends ProtoMessage {
    toolCallId: string;
    target: {
        case: undefined;
        value?: undefined;
    } | {
        case: "github";
        value: ConnectScmGithub;
    };
}
export declare const ConnectScmArgsSchema: MessageCodec<ConnectScmArgs>;
/** Cursor agent message agent.v1.ConnectScmError. */
export interface ConnectScmError extends ProtoMessage {
    error: string;
}
export declare const ConnectScmErrorSchema: MessageCodec<ConnectScmError>;
/** Cursor agent message agent.v1.ConnectScmGithub. */
export interface ConnectScmGithub extends ProtoMessage {
    repository?: ConnectScmGithubRepository;
    gheApplication?: string;
}
export declare const ConnectScmGithubSchema: MessageCodec<ConnectScmGithub>;
/** Cursor agent message agent.v1.ConnectScmGithubRepository. */
export interface ConnectScmGithubRepository extends ProtoMessage {
    owner: string;
    repo: string;
}
export declare const ConnectScmGithubRepositorySchema: MessageCodec<ConnectScmGithubRepository>;
/** Cursor agent message agent.v1.ConnectScmRejected. */
export interface ConnectScmRejected extends ProtoMessage {
    reason: string;
}
export declare const ConnectScmRejectedSchema: MessageCodec<ConnectScmRejected>;
/** Cursor agent message agent.v1.ConnectScmResult. */
export interface ConnectScmResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: ConnectScmSuccess;
    } | {
        case: "error";
        value: ConnectScmError;
    } | {
        case: "rejected";
        value: ConnectScmRejected;
    };
}
export declare const ConnectScmResultSchema: MessageCodec<ConnectScmResult>;
/** Cursor agent message agent.v1.ConnectScmSuccess. */
export interface ConnectScmSuccess extends ProtoMessage {
}
export declare const ConnectScmSuccessSchema: MessageCodec<ConnectScmSuccess>;
/** Cursor agent message agent.v1.ConnectScmToolCall. */
export interface ConnectScmToolCall extends ProtoMessage {
    args?: ConnectScmArgs;
    result?: ConnectScmResult;
}
export declare const ConnectScmToolCallSchema: MessageCodec<ConnectScmToolCall>;
/** Cursor agent message agent.v1.ConversationAction. */
export interface ConversationAction extends ProtoMessage {
    action: {
        case: undefined;
        value?: undefined;
    } | {
        case: "userMessageAction";
        value: UserMessageAction;
    } | {
        case: "resumeAction";
        value: ResumeAction;
    } | {
        case: "cancelAction";
        value: CancelAction;
    } | {
        case: "summarizeAction";
        value: SummarizeAction;
    } | {
        case: "shellCommandAction";
        value: ShellCommandAction;
    } | {
        case: "startPlanAction";
        value: StartPlanAction;
    } | {
        case: "executePlanAction";
        value: ExecutePlanAction;
    } | {
        case: "asyncAskQuestionCompletionAction";
        value: AsyncAskQuestionCompletionAction;
    };
}
export declare const ConversationActionSchema: MessageCodec<ConversationAction>;
/** Cursor agent message agent.v1.ConversationPlan. */
export interface ConversationPlan extends ProtoMessage {
    plan: string;
}
export declare const ConversationPlanSchema: MessageCodec<ConversationPlan>;
/** Cursor agent message agent.v1.ConversationSearchArgs. */
export interface ConversationSearchArgs extends ProtoMessage {
    query: string;
    toolCallId: string;
    limit?: number;
}
export declare const ConversationSearchArgsSchema: MessageCodec<ConversationSearchArgs>;
/** Cursor agent message agent.v1.ConversationSearchError. */
export interface ConversationSearchError extends ProtoMessage {
    error: string;
}
export declare const ConversationSearchErrorSchema: MessageCodec<ConversationSearchError>;
/** Cursor agent message agent.v1.ConversationSearchHit. */
export interface ConversationSearchHit extends ProtoMessage {
    conversationId: string;
    title: string;
    source: ConversationSearchSource;
    updatedAtMs: bigint;
    snippet?: string;
}
export declare const ConversationSearchHitSchema: MessageCodec<ConversationSearchHit>;
/** Cursor agent message agent.v1.ConversationSearchResult. */
export interface ConversationSearchResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: ConversationSearchSuccess;
    } | {
        case: "error";
        value: ConversationSearchError;
    };
}
export declare const ConversationSearchResultSchema: MessageCodec<ConversationSearchResult>;
/** Cursor agent message agent.v1.ConversationSearchSuccess. */
export interface ConversationSearchSuccess extends ProtoMessage {
    hits: ConversationSearchHit[];
    truncated: boolean;
    partial: boolean;
    rebuilding: boolean;
}
export declare const ConversationSearchSuccessSchema: MessageCodec<ConversationSearchSuccess>;
/** Cursor agent message agent.v1.ConversationStateStructure. */
export interface ConversationStateStructure extends ProtoMessage {
    turnsOld: Uint8Array[];
    rootPromptMessagesJson: Uint8Array[];
    turns: Uint8Array[];
    todos: Uint8Array[];
    pendingToolCalls: string[];
    tokenDetails?: ConversationTokenDetails;
    summary?: Uint8Array;
    plan?: Uint8Array;
    previousWorkspaceUris: string[];
    mode?: number;
    summaryArchive?: Uint8Array;
    fileStates: Record<string, Uint8Array>;
    fileStatesV2: Record<string, FileStateStructure>;
    summaryArchives: Uint8Array[];
    turnTimings: StepTiming[];
    subagentStates: Record<string, SubagentPersistedState>;
    selfSummaryCount: number;
    readPaths: string[];
}
export declare const ConversationStateStructureSchema: MessageCodec<ConversationStateStructure>;
/** Cursor agent message agent.v1.ConversationStep. */
export interface ConversationStep extends ProtoMessage {
    message: {
        case: undefined;
        value?: undefined;
    } | {
        case: "assistantMessage";
        value: AssistantMessage;
    } | {
        case: "toolCall";
        value: ToolCall;
    } | {
        case: "thinkingMessage";
        value: ThinkingMessage;
    };
}
export declare const ConversationStepSchema: MessageCodec<ConversationStep>;
/** Cursor agent message agent.v1.ConversationTokenDetails. */
export interface ConversationTokenDetails extends ProtoMessage {
    usedTokens: number;
    maxTokens: number;
}
export declare const ConversationTokenDetailsSchema: MessageCodec<ConversationTokenDetails>;
/** Cursor agent message agent.v1.ConversationTurnStructure. */
export interface ConversationTurnStructure extends ProtoMessage {
    turn: {
        case: undefined;
        value?: undefined;
    } | {
        case: "agentConversationTurn";
        value: AgentConversationTurnStructure;
    } | {
        case: "shellConversationTurn";
        value: ShellConversationTurnStructure;
    };
}
export declare const ConversationTurnStructureSchema: MessageCodec<ConversationTurnStructure>;
/** Cursor agent message agent.v1.Coordinate. */
export interface Coordinate extends ProtoMessage {
    x: number;
    y: number;
}
export declare const CoordinateSchema: MessageCodec<Coordinate>;
/** Cursor agent message agent.v1.CreatePlanArgs. */
export interface CreatePlanArgs extends ProtoMessage {
    plan: string;
    todos: TodoItem[];
    overview: string;
    name: string;
    isProject: boolean;
    phases: Phase[];
}
export declare const CreatePlanArgsSchema: MessageCodec<CreatePlanArgs>;
/** Cursor agent message agent.v1.CreatePlanError. */
export interface CreatePlanError extends ProtoMessage {
    error: string;
}
export declare const CreatePlanErrorSchema: MessageCodec<CreatePlanError>;
/** Cursor agent message agent.v1.CreatePlanRequestQuery. */
export interface CreatePlanRequestQuery extends ProtoMessage {
    args?: CreatePlanArgs;
    toolCallId: string;
}
export declare const CreatePlanRequestQuerySchema: MessageCodec<CreatePlanRequestQuery>;
/** Cursor agent message agent.v1.CreatePlanRequestResponse. */
export interface CreatePlanRequestResponse extends ProtoMessage {
    result?: CreatePlanResult;
}
export declare const CreatePlanRequestResponseSchema: MessageCodec<CreatePlanRequestResponse>;
/** Cursor agent message agent.v1.CreatePlanResult. */
export interface CreatePlanResult extends ProtoMessage {
    planUri: string;
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: CreatePlanSuccess;
    } | {
        case: "error";
        value: CreatePlanError;
    };
}
export declare const CreatePlanResultSchema: MessageCodec<CreatePlanResult>;
/** Cursor agent message agent.v1.CreatePlanSuccess. */
export interface CreatePlanSuccess extends ProtoMessage {
}
export declare const CreatePlanSuccessSchema: MessageCodec<CreatePlanSuccess>;
/** Cursor agent message agent.v1.CreatePlanToolCall. */
export interface CreatePlanToolCall extends ProtoMessage {
    args?: CreatePlanArgs;
    result?: CreatePlanResult;
}
export declare const CreatePlanToolCallSchema: MessageCodec<CreatePlanToolCall>;
/** Cursor agent message agent.v1.CursorPositionAction. */
export interface CursorPositionAction extends ProtoMessage {
}
export declare const CursorPositionActionSchema: MessageCodec<CursorPositionAction>;
/** Cursor agent message agent.v1.CursorRule. */
export interface CursorRule extends ProtoMessage {
    fullPath: string;
    content: string;
    type?: CursorRuleType;
    source: number;
    gitRemoteOrigin?: string;
    parseError?: string;
}
export declare const CursorRuleSchema: MessageCodec<CursorRule>;
/** Cursor agent message agent.v1.CursorRuleType. */
export interface CursorRuleType extends ProtoMessage {
    type: {
        case: undefined;
        value?: undefined;
    } | {
        case: "global";
        value: CursorRuleTypeGlobal;
    } | {
        case: "fileGlobbed";
        value: CursorRuleTypeFileGlobs;
    } | {
        case: "agentFetched";
        value: CursorRuleTypeAgentFetched;
    } | {
        case: "manuallyAttached";
        value: CursorRuleTypeManuallyAttached;
    };
}
export declare const CursorRuleTypeSchema: MessageCodec<CursorRuleType>;
/** Cursor agent message agent.v1.CursorRuleTypeAgentFetched. */
export interface CursorRuleTypeAgentFetched extends ProtoMessage {
    description: string;
}
export declare const CursorRuleTypeAgentFetchedSchema: MessageCodec<CursorRuleTypeAgentFetched>;
/** Cursor agent message agent.v1.CursorRuleTypeFileGlobs. */
export interface CursorRuleTypeFileGlobs extends ProtoMessage {
    globs: string[];
}
export declare const CursorRuleTypeFileGlobsSchema: MessageCodec<CursorRuleTypeFileGlobs>;
/** Cursor agent message agent.v1.CursorRuleTypeGlobal. */
export interface CursorRuleTypeGlobal extends ProtoMessage {
}
export declare const CursorRuleTypeGlobalSchema: MessageCodec<CursorRuleTypeGlobal>;
/** Cursor agent message agent.v1.CursorRuleTypeManuallyAttached. */
export interface CursorRuleTypeManuallyAttached extends ProtoMessage {
}
export declare const CursorRuleTypeManuallyAttachedSchema: MessageCodec<CursorRuleTypeManuallyAttached>;
/** Cursor agent message agent.v1.CustomSubagent. */
export interface CustomSubagent extends ProtoMessage {
    fullPath: string;
    name: string;
    description: string;
    tools: string[];
    model: string;
    prompt: string;
    permissionMode: number;
}
export declare const CustomSubagentSchema: MessageCodec<CustomSubagent>;
/** Cursor agent message agent.v1.DebugModeConfig. */
export interface DebugModeConfig extends ProtoMessage {
    logPath: string;
    serverEndpoint: string;
}
export declare const DebugModeConfigSchema: MessageCodec<DebugModeConfig>;
/** Cursor agent message agent.v1.DeleteArgs. */
export interface DeleteArgs extends ProtoMessage {
    path: string;
    toolCallId: string;
}
export declare const DeleteArgsSchema: MessageCodec<DeleteArgs>;
/** Cursor agent message agent.v1.DeleteError. */
export interface DeleteError extends ProtoMessage {
    path: string;
    error: string;
}
export declare const DeleteErrorSchema: MessageCodec<DeleteError>;
/** Cursor agent message agent.v1.DeleteFileBusy. */
export interface DeleteFileBusy extends ProtoMessage {
    path: string;
}
export declare const DeleteFileBusySchema: MessageCodec<DeleteFileBusy>;
/** Cursor agent message agent.v1.DeleteFileNotFound. */
export interface DeleteFileNotFound extends ProtoMessage {
    path: string;
}
export declare const DeleteFileNotFoundSchema: MessageCodec<DeleteFileNotFound>;
/** Cursor agent message agent.v1.DeleteNotFile. */
export interface DeleteNotFile extends ProtoMessage {
    path: string;
    actualType: string;
}
export declare const DeleteNotFileSchema: MessageCodec<DeleteNotFile>;
/** Cursor agent message agent.v1.DeletePermissionDenied. */
export interface DeletePermissionDenied extends ProtoMessage {
    path: string;
    clientVisibleError: string;
    isReadonly: boolean;
}
export declare const DeletePermissionDeniedSchema: MessageCodec<DeletePermissionDenied>;
/** Cursor agent message agent.v1.DeleteRejected. */
export interface DeleteRejected extends ProtoMessage {
    path: string;
    reason: string;
}
export declare const DeleteRejectedSchema: MessageCodec<DeleteRejected>;
/** Cursor agent message agent.v1.DeleteResult. */
export interface DeleteResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: DeleteSuccess;
    } | {
        case: "fileNotFound";
        value: DeleteFileNotFound;
    } | {
        case: "notFile";
        value: DeleteNotFile;
    } | {
        case: "permissionDenied";
        value: DeletePermissionDenied;
    } | {
        case: "fileBusy";
        value: DeleteFileBusy;
    } | {
        case: "rejected";
        value: DeleteRejected;
    } | {
        case: "error";
        value: DeleteError;
    };
}
export declare const DeleteResultSchema: MessageCodec<DeleteResult>;
/** Cursor agent message agent.v1.DeleteSuccess. */
export interface DeleteSuccess extends ProtoMessage {
    path: string;
    deletedFile: string;
    fileSize: bigint;
    prevContent: string;
}
export declare const DeleteSuccessSchema: MessageCodec<DeleteSuccess>;
/** Cursor agent message agent.v1.DeleteToolCall. */
export interface DeleteToolCall extends ProtoMessage {
    args?: DeleteArgs;
    result?: DeleteResult;
}
export declare const DeleteToolCallSchema: MessageCodec<DeleteToolCall>;
/** Cursor agent message agent.v1.Diagnostic. */
export interface Diagnostic extends ProtoMessage {
    severity: number;
    range?: Range;
    message: string;
    source: string;
    code: string;
    isStale: boolean;
}
export declare const DiagnosticSchema: MessageCodec<Diagnostic>;
/** Cursor agent message agent.v1.DiagnosticItem. */
export interface DiagnosticItem extends ProtoMessage {
    severity: DiagnosticSeverity;
    range?: DiagnosticRange;
    message: string;
    source: string;
    code: string;
    isStale: boolean;
}
export declare const DiagnosticItemSchema: MessageCodec<DiagnosticItem>;
/** Cursor agent message agent.v1.DiagnosticRange. */
export interface DiagnosticRange extends ProtoMessage {
    start?: Position;
    end?: Position;
}
export declare const DiagnosticRangeSchema: MessageCodec<DiagnosticRange>;
/** Cursor agent message agent.v1.DiagnosticsArgs. */
export interface DiagnosticsArgs extends ProtoMessage {
    path: string;
    toolCallId: string;
}
export declare const DiagnosticsArgsSchema: MessageCodec<DiagnosticsArgs>;
/** Cursor agent message agent.v1.DiagnosticsError. */
export interface DiagnosticsError extends ProtoMessage {
    path: string;
    error: string;
}
export declare const DiagnosticsErrorSchema: MessageCodec<DiagnosticsError>;
/** Cursor agent message agent.v1.DiagnosticsFileNotFound. */
export interface DiagnosticsFileNotFound extends ProtoMessage {
    path: string;
}
export declare const DiagnosticsFileNotFoundSchema: MessageCodec<DiagnosticsFileNotFound>;
/** Cursor agent message agent.v1.DiagnosticsPermissionDenied. */
export interface DiagnosticsPermissionDenied extends ProtoMessage {
    path: string;
}
export declare const DiagnosticsPermissionDeniedSchema: MessageCodec<DiagnosticsPermissionDenied>;
/** Cursor agent message agent.v1.DiagnosticsRejected. */
export interface DiagnosticsRejected extends ProtoMessage {
    path: string;
    reason: string;
}
export declare const DiagnosticsRejectedSchema: MessageCodec<DiagnosticsRejected>;
/** Cursor agent message agent.v1.DiagnosticsResult. */
export interface DiagnosticsResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: DiagnosticsSuccess;
    } | {
        case: "error";
        value: DiagnosticsError;
    } | {
        case: "rejected";
        value: DiagnosticsRejected;
    } | {
        case: "fileNotFound";
        value: DiagnosticsFileNotFound;
    } | {
        case: "permissionDenied";
        value: DiagnosticsPermissionDenied;
    };
}
export declare const DiagnosticsResultSchema: MessageCodec<DiagnosticsResult>;
/** Cursor agent message agent.v1.DiagnosticsSuccess. */
export interface DiagnosticsSuccess extends ProtoMessage {
    path: string;
    diagnostics: Diagnostic[];
    totalDiagnostics: number;
}
export declare const DiagnosticsSuccessSchema: MessageCodec<DiagnosticsSuccess>;
/** Cursor agent message agent.v1.DragAction. */
export interface DragAction extends ProtoMessage {
    path: Coordinate[];
    button: number;
}
export declare const DragActionSchema: MessageCodec<DragAction>;
/** Cursor agent message agent.v1.EditArgs. */
export interface EditArgs extends ProtoMessage {
    path: string;
    streamContent?: string;
}
export declare const EditArgsSchema: MessageCodec<EditArgs>;
/** Cursor agent message agent.v1.EditError. */
export interface EditError extends ProtoMessage {
    path: string;
    error: string;
    modelVisibleError?: string;
}
export declare const EditErrorSchema: MessageCodec<EditError>;
/** Cursor agent message agent.v1.EditFileNotFound. */
export interface EditFileNotFound extends ProtoMessage {
    path: string;
}
export declare const EditFileNotFoundSchema: MessageCodec<EditFileNotFound>;
/** Cursor agent message agent.v1.EditReadPermissionDenied. */
export interface EditReadPermissionDenied extends ProtoMessage {
    path: string;
}
export declare const EditReadPermissionDeniedSchema: MessageCodec<EditReadPermissionDenied>;
/** Cursor agent message agent.v1.EditRejected. */
export interface EditRejected extends ProtoMessage {
    path: string;
    reason: string;
}
export declare const EditRejectedSchema: MessageCodec<EditRejected>;
/** Cursor agent message agent.v1.EditResult. */
export interface EditResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: EditSuccess;
    } | {
        case: "fileNotFound";
        value: EditFileNotFound;
    } | {
        case: "readPermissionDenied";
        value: EditReadPermissionDenied;
    } | {
        case: "writePermissionDenied";
        value: EditWritePermissionDenied;
    } | {
        case: "rejected";
        value: EditRejected;
    } | {
        case: "error";
        value: EditError;
    };
}
export declare const EditResultSchema: MessageCodec<EditResult>;
/** Cursor agent message agent.v1.EditSuccess. */
export interface EditSuccess extends ProtoMessage {
    path: string;
    linesAdded?: number;
    linesRemoved?: number;
    diffString?: string;
    beforeFullFileContent?: string;
    afterFullFileContent: string;
    message?: string;
}
export declare const EditSuccessSchema: MessageCodec<EditSuccess>;
/** Cursor agent message agent.v1.EditToolCall. */
export interface EditToolCall extends ProtoMessage {
    args?: EditArgs;
    result?: EditResult;
}
export declare const EditToolCallSchema: MessageCodec<EditToolCall>;
/** Cursor agent message agent.v1.EditToolCallDelta. */
export interface EditToolCallDelta extends ProtoMessage {
    streamContentDelta: string;
}
export declare const EditToolCallDeltaSchema: MessageCodec<EditToolCallDelta>;
/** Cursor agent message agent.v1.EditWritePermissionDenied. */
export interface EditWritePermissionDenied extends ProtoMessage {
    path: string;
    error: string;
    isReadonly: boolean;
}
export declare const EditWritePermissionDeniedSchema: MessageCodec<EditWritePermissionDenied>;
/** Cursor agent message agent.v1.Error. */
export interface Error extends ProtoMessage {
    message: string;
}
export declare const ErrorSchema: MessageCodec<Error>;
/** Cursor agent message agent.v1.ExaFetchArgs. */
export interface ExaFetchArgs extends ProtoMessage {
    ids: string[];
    toolCallId: string;
}
export declare const ExaFetchArgsSchema: MessageCodec<ExaFetchArgs>;
/** Cursor agent message agent.v1.ExaFetchContent. */
export interface ExaFetchContent extends ProtoMessage {
    title: string;
    url: string;
    text: string;
    publishedDate: string;
}
export declare const ExaFetchContentSchema: MessageCodec<ExaFetchContent>;
/** Cursor agent message agent.v1.ExaFetchError. */
export interface ExaFetchError extends ProtoMessage {
    error: string;
}
export declare const ExaFetchErrorSchema: MessageCodec<ExaFetchError>;
/** Cursor agent message agent.v1.ExaFetchRejected. */
export interface ExaFetchRejected extends ProtoMessage {
    reason: string;
}
export declare const ExaFetchRejectedSchema: MessageCodec<ExaFetchRejected>;
/** Cursor agent message agent.v1.ExaFetchRequestQuery. */
export interface ExaFetchRequestQuery extends ProtoMessage {
    args?: ExaFetchArgs;
}
export declare const ExaFetchRequestQuerySchema: MessageCodec<ExaFetchRequestQuery>;
/** Cursor agent message agent.v1.ExaFetchRequestResponse. */
export interface ExaFetchRequestResponse extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "approved";
        value: ExaFetchRequestResponse_Approved;
    } | {
        case: "rejected";
        value: ExaFetchRequestResponse_Rejected;
    };
}
export declare const ExaFetchRequestResponseSchema: MessageCodec<ExaFetchRequestResponse>;
/** Cursor agent message agent.v1.ExaFetchRequestResponse_Approved. */
export interface ExaFetchRequestResponse_Approved extends ProtoMessage {
}
export declare const ExaFetchRequestResponse_ApprovedSchema: MessageCodec<ExaFetchRequestResponse_Approved>;
/** Cursor agent message agent.v1.ExaFetchRequestResponse_Rejected. */
export interface ExaFetchRequestResponse_Rejected extends ProtoMessage {
    reason: string;
}
export declare const ExaFetchRequestResponse_RejectedSchema: MessageCodec<ExaFetchRequestResponse_Rejected>;
/** Cursor agent message agent.v1.ExaFetchResult. */
export interface ExaFetchResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: ExaFetchSuccess;
    } | {
        case: "error";
        value: ExaFetchError;
    } | {
        case: "rejected";
        value: ExaFetchRejected;
    };
}
export declare const ExaFetchResultSchema: MessageCodec<ExaFetchResult>;
/** Cursor agent message agent.v1.ExaFetchSuccess. */
export interface ExaFetchSuccess extends ProtoMessage {
    contents: ExaFetchContent[];
}
export declare const ExaFetchSuccessSchema: MessageCodec<ExaFetchSuccess>;
/** Cursor agent message agent.v1.ExaFetchToolCall. */
export interface ExaFetchToolCall extends ProtoMessage {
    args?: ExaFetchArgs;
    result?: ExaFetchResult;
}
export declare const ExaFetchToolCallSchema: MessageCodec<ExaFetchToolCall>;
/** Cursor agent message agent.v1.ExaSearchArgs. */
export interface ExaSearchArgs extends ProtoMessage {
    query: string;
    type: string;
    numResults: number;
    toolCallId: string;
}
export declare const ExaSearchArgsSchema: MessageCodec<ExaSearchArgs>;
/** Cursor agent message agent.v1.ExaSearchError. */
export interface ExaSearchError extends ProtoMessage {
    error: string;
}
export declare const ExaSearchErrorSchema: MessageCodec<ExaSearchError>;
/** Cursor agent message agent.v1.ExaSearchReference. */
export interface ExaSearchReference extends ProtoMessage {
    title: string;
    url: string;
    text: string;
    publishedDate: string;
}
export declare const ExaSearchReferenceSchema: MessageCodec<ExaSearchReference>;
/** Cursor agent message agent.v1.ExaSearchRejected. */
export interface ExaSearchRejected extends ProtoMessage {
    reason: string;
}
export declare const ExaSearchRejectedSchema: MessageCodec<ExaSearchRejected>;
/** Cursor agent message agent.v1.ExaSearchRequestQuery. */
export interface ExaSearchRequestQuery extends ProtoMessage {
    args?: ExaSearchArgs;
}
export declare const ExaSearchRequestQuerySchema: MessageCodec<ExaSearchRequestQuery>;
/** Cursor agent message agent.v1.ExaSearchRequestResponse. */
export interface ExaSearchRequestResponse extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "approved";
        value: ExaSearchRequestResponse_Approved;
    } | {
        case: "rejected";
        value: ExaSearchRequestResponse_Rejected;
    };
}
export declare const ExaSearchRequestResponseSchema: MessageCodec<ExaSearchRequestResponse>;
/** Cursor agent message agent.v1.ExaSearchRequestResponse_Approved. */
export interface ExaSearchRequestResponse_Approved extends ProtoMessage {
}
export declare const ExaSearchRequestResponse_ApprovedSchema: MessageCodec<ExaSearchRequestResponse_Approved>;
/** Cursor agent message agent.v1.ExaSearchRequestResponse_Rejected. */
export interface ExaSearchRequestResponse_Rejected extends ProtoMessage {
    reason: string;
}
export declare const ExaSearchRequestResponse_RejectedSchema: MessageCodec<ExaSearchRequestResponse_Rejected>;
/** Cursor agent message agent.v1.ExaSearchResult. */
export interface ExaSearchResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: ExaSearchSuccess;
    } | {
        case: "error";
        value: ExaSearchError;
    } | {
        case: "rejected";
        value: ExaSearchRejected;
    };
}
export declare const ExaSearchResultSchema: MessageCodec<ExaSearchResult>;
/** Cursor agent message agent.v1.ExaSearchSuccess. */
export interface ExaSearchSuccess extends ProtoMessage {
    references: ExaSearchReference[];
}
export declare const ExaSearchSuccessSchema: MessageCodec<ExaSearchSuccess>;
/** Cursor agent message agent.v1.ExaSearchToolCall. */
export interface ExaSearchToolCall extends ProtoMessage {
    args?: ExaSearchArgs;
    result?: ExaSearchResult;
}
export declare const ExaSearchToolCallSchema: MessageCodec<ExaSearchToolCall>;
/** Cursor agent message agent.v1.ExecClientControlMessage. */
export interface ExecClientControlMessage extends ProtoMessage {
    message: {
        case: undefined;
        value?: undefined;
    } | {
        case: "streamClose";
        value: ExecClientStreamClose;
    } | {
        case: "throw";
        value: ExecClientThrow;
    } | {
        case: "heartbeat";
        value: ExecClientHeartbeat;
    };
}
export declare const ExecClientControlMessageSchema: MessageCodec<ExecClientControlMessage>;
/** Cursor agent message agent.v1.ExecClientHeartbeat. */
export interface ExecClientHeartbeat extends ProtoMessage {
    id: number;
}
export declare const ExecClientHeartbeatSchema: MessageCodec<ExecClientHeartbeat>;
/** Cursor agent message agent.v1.ExecClientMessage. */
export interface ExecClientMessage extends ProtoMessage {
    id: number;
    execId: string;
    localExecutionTimeMs?: number;
    hookAdditionalContexts: HookAdditionalContext[];
    message: {
        case: undefined;
        value?: undefined;
    } | {
        case: "shellResult";
        value: ShellResult;
    } | {
        case: "writeResult";
        value: WriteResult;
    } | {
        case: "deleteResult";
        value: DeleteResult;
    } | {
        case: "grepResult";
        value: GrepResult;
    } | {
        case: "readResult";
        value: ReadResult;
    } | {
        case: "lsResult";
        value: LsResult;
    } | {
        case: "diagnosticsResult";
        value: DiagnosticsResult;
    } | {
        case: "requestContextResult";
        value: RequestContextResult;
    } | {
        case: "mcpResult";
        value: McpResult;
    } | {
        case: "shellStream";
        value: ShellStream;
    } | {
        case: "backgroundShellSpawnResult";
        value: BackgroundShellSpawnResult;
    } | {
        case: "listMcpResourcesExecResult";
        value: ListMcpResourcesExecResult;
    } | {
        case: "readMcpResourceExecResult";
        value: ReadMcpResourceExecResult;
    } | {
        case: "fetchResult";
        value: FetchResult;
    } | {
        case: "recordScreenResult";
        value: RecordScreenResult;
    } | {
        case: "computerUseResult";
        value: ComputerUseResult;
    } | {
        case: "writeShellStdinResult";
        value: WriteShellStdinResult;
    } | {
        case: "redactedReadResult";
        value: ReadResult;
    } | {
        case: "mcpStateExecResult";
        value: McpStateExecResult;
    } | {
        case: "executeHookResult";
        value: ExecuteHookResult;
    } | {
        case: "subagentResult";
        value: SubagentResult;
    } | {
        case: "forceBackgroundShellResult";
        value: ForceBackgroundShellResult;
    } | {
        case: "forceBackgroundSubagentResult";
        value: ForceBackgroundSubagentResult;
    } | {
        case: "subagentAwaitResult";
        value: SubagentAwaitResult;
    } | {
        case: "smartModeClassifierResult";
        value: SmartModeClassifierResult;
    } | {
        case: "canvasDiagnosticsResult";
        value: CanvasDiagnosticsResult;
    } | {
        case: "shellAllowlistPrecheckResult";
        value: ShellAllowlistPrecheckResult;
    } | {
        case: "mcpAllowlistPrecheckResult";
        value: McpAllowlistPrecheckResult;
    } | {
        case: "webFetchAllowlistPrecheckResult";
        value: WebFetchAllowlistPrecheckResult;
    } | {
        case: "gitDiffResponse";
        value: GetDiffResponse;
    } | {
        case: "piReadResult";
        value: PiReadExecResult;
    } | {
        case: "piBashResult";
        value: PiBashExecResult;
    } | {
        case: "piEditResult";
        value: PiEditExecResult;
    } | {
        case: "piWriteResult";
        value: PiWriteExecResult;
    } | {
        case: "piGrepResult";
        value: PiGrepExecResult;
    } | {
        case: "piFindResult";
        value: PiFindExecResult;
    } | {
        case: "piLsResult";
        value: PiLsExecResult;
    } | {
        case: "conversationSearchResult";
        value: ConversationSearchResult;
    } | {
        case: "agentStoreConflictResult";
        value: AgentStoreConflictResult;
    } | {
        case: "miniSweAgentBashResult";
        value: ShellResult;
    };
}
export declare const ExecClientMessageSchema: MessageCodec<ExecClientMessage>;
/** Cursor agent message agent.v1.ExecClientStreamClose. */
export interface ExecClientStreamClose extends ProtoMessage {
    id: number;
}
export declare const ExecClientStreamCloseSchema: MessageCodec<ExecClientStreamClose>;
/** Cursor agent message agent.v1.ExecClientThrow. */
export interface ExecClientThrow extends ProtoMessage {
    id: number;
    error: string;
    stackTrace?: string;
    errorCode?: string;
}
export declare const ExecClientThrowSchema: MessageCodec<ExecClientThrow>;
/** Cursor agent message agent.v1.ExecServerAbort. */
export interface ExecServerAbort extends ProtoMessage {
    id: number;
}
export declare const ExecServerAbortSchema: MessageCodec<ExecServerAbort>;
/** Cursor agent message agent.v1.ExecServerControlMessage. */
export interface ExecServerControlMessage extends ProtoMessage {
    message: {
        case: undefined;
        value?: undefined;
    } | {
        case: "abort";
        value: ExecServerAbort;
    };
}
export declare const ExecServerControlMessageSchema: MessageCodec<ExecServerControlMessage>;
/** Cursor agent message agent.v1.ExecServerMessage. */
export interface ExecServerMessage extends ProtoMessage {
    id: number;
    execId: string;
    spanContext?: SpanContext;
    acceptHookAdditionalContexts?: boolean;
    message: {
        case: undefined;
        value?: undefined;
    } | {
        case: "shellArgs";
        value: ShellArgs;
    } | {
        case: "writeArgs";
        value: WriteArgs;
    } | {
        case: "deleteArgs";
        value: DeleteArgs;
    } | {
        case: "grepArgs";
        value: GrepArgs;
    } | {
        case: "readArgs";
        value: ReadArgs;
    } | {
        case: "lsArgs";
        value: LsArgs;
    } | {
        case: "diagnosticsArgs";
        value: DiagnosticsArgs;
    } | {
        case: "requestContextArgs";
        value: RequestContextArgs;
    } | {
        case: "mcpArgs";
        value: McpArgs;
    } | {
        case: "shellStreamArgs";
        value: ShellArgs;
    } | {
        case: "backgroundShellSpawnArgs";
        value: BackgroundShellSpawnArgs;
    } | {
        case: "listMcpResourcesExecArgs";
        value: ListMcpResourcesExecArgs;
    } | {
        case: "readMcpResourceExecArgs";
        value: ReadMcpResourceExecArgs;
    } | {
        case: "fetchArgs";
        value: FetchArgs;
    } | {
        case: "recordScreenArgs";
        value: RecordScreenArgs;
    } | {
        case: "computerUseArgs";
        value: ComputerUseArgs;
    } | {
        case: "writeShellStdinArgs";
        value: WriteShellStdinArgs;
    } | {
        case: "redactedReadArgs";
        value: ReadArgs;
    } | {
        case: "mcpStateExecArgs";
        value: McpStateExecArgs;
    } | {
        case: "executeHookArgs";
        value: ExecuteHookArgs;
    } | {
        case: "subagentArgs";
        value: SubagentArgs;
    } | {
        case: "forceBackgroundShellArgs";
        value: ForceBackgroundShellArgs;
    } | {
        case: "forceBackgroundSubagentArgs";
        value: ForceBackgroundSubagentArgs;
    } | {
        case: "subagentAwaitArgs";
        value: SubagentAwaitArgs;
    } | {
        case: "smartModeClassifierArgs";
        value: SmartModeClassifierArgs;
    } | {
        case: "canvasDiagnosticsArgs";
        value: CanvasDiagnosticsArgs;
    } | {
        case: "shellAllowlistPrecheckArgs";
        value: ShellAllowlistPrecheckArgs;
    } | {
        case: "mcpAllowlistPrecheckArgs";
        value: McpAllowlistPrecheckArgs;
    } | {
        case: "webFetchAllowlistPrecheckArgs";
        value: WebFetchAllowlistPrecheckArgs;
    } | {
        case: "gitDiffRequest";
        value: GetDiffRequest;
    } | {
        case: "piReadArgs";
        value: PiReadExecArgs;
    } | {
        case: "piBashArgs";
        value: PiBashExecArgs;
    } | {
        case: "piEditArgs";
        value: PiEditExecArgs;
    } | {
        case: "piWriteArgs";
        value: PiWriteExecArgs;
    } | {
        case: "piGrepArgs";
        value: PiGrepExecArgs;
    } | {
        case: "piFindArgs";
        value: PiFindExecArgs;
    } | {
        case: "piLsArgs";
        value: PiLsExecArgs;
    } | {
        case: "miniSweAgentBashArgs";
        value: ShellArgs;
    } | {
        case: "conversationSearchArgs";
        value: ConversationSearchArgs;
    } | {
        case: "agentStoreConflictArgs";
        value: AgentStoreConflictArgs;
    };
}
export declare const ExecServerMessageSchema: MessageCodec<ExecServerMessage>;
/** Cursor agent message agent.v1.ExecuteHookArgs. */
export interface ExecuteHookArgs extends ProtoMessage {
    request?: ExecuteHookRequest;
}
export declare const ExecuteHookArgsSchema: MessageCodec<ExecuteHookArgs>;
/** Cursor agent message agent.v1.ExecuteHookRequest. */
export interface ExecuteHookRequest extends ProtoMessage {
    request: {
        case: undefined;
        value?: undefined;
    } | {
        case: "preCompact";
        value: PreCompactRequestQuery;
    } | {
        case: "subagentStart";
        value: SubagentStartRequestQuery;
    } | {
        case: "subagentStop";
        value: SubagentStopRequestQuery;
    } | {
        case: "preToolUse";
        value: PreToolUseRequestQuery;
    } | {
        case: "postToolUse";
        value: PostToolUseRequestQuery;
    } | {
        case: "postToolUseFailure";
        value: PostToolUseFailureRequestQuery;
    } | {
        case: "beforeSubmitPrompt";
        value: BeforeSubmitPromptRequestQuery;
    } | {
        case: "afterAgentResponse";
        value: AfterAgentResponseRequestQuery;
    } | {
        case: "afterAgentThought";
        value: AfterAgentThoughtRequestQuery;
    } | {
        case: "stop";
        value: StopRequestQuery;
    };
}
export declare const ExecuteHookRequestSchema: MessageCodec<ExecuteHookRequest>;
/** Cursor agent message agent.v1.ExecuteHookResponse. */
export interface ExecuteHookResponse extends ProtoMessage {
    response: {
        case: undefined;
        value?: undefined;
    } | {
        case: "preCompact";
        value: PreCompactRequestResponse;
    } | {
        case: "subagentStart";
        value: SubagentStartRequestResponse;
    } | {
        case: "subagentStop";
        value: SubagentStopRequestResponse;
    } | {
        case: "preToolUse";
        value: PreToolUseRequestResponse;
    } | {
        case: "postToolUse";
        value: PostToolUseRequestResponse;
    } | {
        case: "postToolUseFailure";
        value: PostToolUseFailureRequestResponse;
    } | {
        case: "beforeSubmitPrompt";
        value: BeforeSubmitPromptRequestResponse;
    } | {
        case: "afterAgentResponse";
        value: AfterAgentResponseRequestResponse;
    } | {
        case: "afterAgentThought";
        value: AfterAgentThoughtRequestResponse;
    } | {
        case: "stop";
        value: StopRequestResponse;
    };
}
export declare const ExecuteHookResponseSchema: MessageCodec<ExecuteHookResponse>;
/** Cursor agent message agent.v1.ExecuteHookResult. */
export interface ExecuteHookResult extends ProtoMessage {
    response?: ExecuteHookResponse;
}
export declare const ExecuteHookResultSchema: MessageCodec<ExecuteHookResult>;
/** Cursor agent message agent.v1.ExecutePlanAction. */
export interface ExecutePlanAction extends ProtoMessage {
    requestContext?: RequestContext;
    plan?: ConversationPlan;
    planFileUri?: string;
    planFileContent?: string;
}
export declare const ExecutePlanActionSchema: MessageCodec<ExecutePlanAction>;
/** Cursor agent message agent.v1.ExtraContextEntry. */
export interface ExtraContextEntry extends ProtoMessage {
    dataOrBlobId: {
        case: undefined;
        value?: undefined;
    } | {
        case: "data";
        value: string;
    } | {
        case: "blobId";
        value: Uint8Array;
    };
}
export declare const ExtraContextEntrySchema: MessageCodec<ExtraContextEntry>;
/** Cursor agent message agent.v1.FetchArgs. */
export interface FetchArgs extends ProtoMessage {
    url: string;
    toolCallId: string;
}
export declare const FetchArgsSchema: MessageCodec<FetchArgs>;
/** Cursor agent message agent.v1.FetchError. */
export interface FetchError extends ProtoMessage {
    url: string;
    error: string;
}
export declare const FetchErrorSchema: MessageCodec<FetchError>;
/** Cursor agent message agent.v1.FetchResult. */
export interface FetchResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: FetchSuccess;
    } | {
        case: "error";
        value: FetchError;
    };
}
export declare const FetchResultSchema: MessageCodec<FetchResult>;
/** Cursor agent message agent.v1.FetchSuccess. */
export interface FetchSuccess extends ProtoMessage {
    url: string;
    content: string;
    statusCode: number;
    contentType: string;
}
export declare const FetchSuccessSchema: MessageCodec<FetchSuccess>;
/** Cursor agent message agent.v1.FetchToolCall. */
export interface FetchToolCall extends ProtoMessage {
    args?: FetchArgs;
    result?: FetchResult;
}
export declare const FetchToolCallSchema: MessageCodec<FetchToolCall>;
/** Cursor agent message agent.v1.FileDiagnostics. */
export interface FileDiagnostics extends ProtoMessage {
    path: string;
    diagnostics: DiagnosticItem[];
    diagnosticsCount: number;
}
export declare const FileDiagnosticsSchema: MessageCodec<FileDiagnostics>;
/** Cursor agent message agent.v1.FileDiff. */
export interface FileDiff extends ProtoMessage {
    added: number;
    removed: number;
    from: string;
    to: string;
    chunks: FileDiff_Chunk[];
    beforeFileContents?: string;
    afterFileContents?: string;
    isGenerated?: boolean;
}
export declare const FileDiffSchema: MessageCodec<FileDiff>;
/** Cursor agent message agent.v1.FileDiff_Chunk. */
export interface FileDiff_Chunk extends ProtoMessage {
    content: string;
    lines: string[];
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
}
export declare const FileDiff_ChunkSchema: MessageCodec<FileDiff_Chunk>;
/** Cursor agent message agent.v1.FileStateStructure. */
export interface FileStateStructure extends ProtoMessage {
    content?: Uint8Array;
    initialContent?: Uint8Array;
}
export declare const FileStateStructureSchema: MessageCodec<FileStateStructure>;
/** Cursor agent message agent.v1.ForceBackgroundShellArgs. */
export interface ForceBackgroundShellArgs extends ProtoMessage {
    toolCallId: string;
}
export declare const ForceBackgroundShellArgsSchema: MessageCodec<ForceBackgroundShellArgs>;
/** Cursor agent message agent.v1.ForceBackgroundShellResult. */
export interface ForceBackgroundShellResult extends ProtoMessage {
    status: ForceBackgroundShellStatus;
    shellResult?: ShellResult;
}
export declare const ForceBackgroundShellResultSchema: MessageCodec<ForceBackgroundShellResult>;
/** Cursor agent message agent.v1.ForceBackgroundSubagentArgs. */
export interface ForceBackgroundSubagentArgs extends ProtoMessage {
    toolCallId: string;
}
export declare const ForceBackgroundSubagentArgsSchema: MessageCodec<ForceBackgroundSubagentArgs>;
/** Cursor agent message agent.v1.ForceBackgroundSubagentResult. */
export interface ForceBackgroundSubagentResult extends ProtoMessage {
    status: ForceBackgroundSubagentStatus;
}
export declare const ForceBackgroundSubagentResultSchema: MessageCodec<ForceBackgroundSubagentResult>;
/** Cursor agent message agent.v1.GenerateImageArgs. */
export interface GenerateImageArgs extends ProtoMessage {
    description: string;
    filePath?: string;
    referenceImagePaths: string[];
}
export declare const GenerateImageArgsSchema: MessageCodec<GenerateImageArgs>;
/** Cursor agent message agent.v1.GenerateImageError. */
export interface GenerateImageError extends ProtoMessage {
    error: string;
}
export declare const GenerateImageErrorSchema: MessageCodec<GenerateImageError>;
/** Cursor agent message agent.v1.GenerateImageResult. */
export interface GenerateImageResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: GenerateImageSuccess;
    } | {
        case: "error";
        value: GenerateImageError;
    };
}
export declare const GenerateImageResultSchema: MessageCodec<GenerateImageResult>;
/** Cursor agent message agent.v1.GenerateImageSuccess. */
export interface GenerateImageSuccess extends ProtoMessage {
    filePath: string;
    imageData: string;
}
export declare const GenerateImageSuccessSchema: MessageCodec<GenerateImageSuccess>;
/** Cursor agent message agent.v1.GenerateImageToolCall. */
export interface GenerateImageToolCall extends ProtoMessage {
    args?: GenerateImageArgs;
    result?: GenerateImageResult;
}
export declare const GenerateImageToolCallSchema: MessageCodec<GenerateImageToolCall>;
/** Cursor agent message agent.v1.GetBlobArgs. */
export interface GetBlobArgs extends ProtoMessage {
    blobId: Uint8Array;
}
export declare const GetBlobArgsSchema: MessageCodec<GetBlobArgs>;
/** Cursor agent message agent.v1.GetBlobResult. */
export interface GetBlobResult extends ProtoMessage {
    blobData?: Uint8Array;
}
export declare const GetBlobResultSchema: MessageCodec<GetBlobResult>;
/** Cursor agent message agent.v1.GetDiffRequest. */
export interface GetDiffRequest extends ProtoMessage {
    cwd: string;
    ref: string;
    baseRef: string;
    mergeBase: boolean;
    targetPaths: string[];
    unifiedContextLines?: number;
    maxUntrackedFiles: number;
    submoduleRecurseDepth: number;
    includeSpaceChanges: boolean;
    committedOnly: boolean;
    computePatchId: boolean;
    returnHeadSha?: boolean;
    maxResponseBytes?: number;
    outputFormat?: GetDiffRequest_OutputFormat;
}
export declare const GetDiffRequestSchema: MessageCodec<GetDiffRequest>;
/** Cursor agent message agent.v1.GetDiffResponse. */
export interface GetDiffResponse extends ProtoMessage {
    diff?: GitDiff;
    submoduleDiffs: GetDiffResponse_SubmoduleDiff[];
    patchId?: string;
    headSha?: string;
    hasUncommittedChanges?: boolean;
}
export declare const GetDiffResponseSchema: MessageCodec<GetDiffResponse>;
/** Cursor agent message agent.v1.GetDiffResponse_SubmoduleDiff. */
export interface GetDiffResponse_SubmoduleDiff extends ProtoMessage {
    relativePath: string;
    diff?: GitDiff;
    errored: boolean;
}
export declare const GetDiffResponse_SubmoduleDiffSchema: MessageCodec<GetDiffResponse_SubmoduleDiff>;
/** Cursor agent message agent.v1.GetUsableModelsRequest. */
export interface GetUsableModelsRequest extends ProtoMessage {
    customModelIds: string[];
}
export declare const GetUsableModelsRequestSchema: MessageCodec<GetUsableModelsRequest>;
/** Cursor agent message agent.v1.GetUsableModelsResponse. */
export interface GetUsableModelsResponse extends ProtoMessage {
    models: ModelDetails[];
}
export declare const GetUsableModelsResponseSchema: MessageCodec<GetUsableModelsResponse>;
/** Cursor agent message agent.v1.GitDiff. */
export interface GitDiff extends ProtoMessage {
    diffs: FileDiff[];
    diffType: GitDiff_DiffType;
}
export declare const GitDiffSchema: MessageCodec<GitDiff>;
/** Cursor agent message agent.v1.GitRepoInfo. */
export interface GitRepoInfo extends ProtoMessage {
    path: string;
    status: string;
    branchName: string;
    remoteUrl?: string;
}
export declare const GitRepoInfoSchema: MessageCodec<GitRepoInfo>;
/** Cursor agent message agent.v1.GlobToolCall. */
export interface GlobToolCall extends ProtoMessage {
    args: Uint8Array;
    result?: GlobToolResult;
}
export declare const GlobToolCallSchema: MessageCodec<GlobToolCall>;
/** Cursor agent message agent.v1.GlobToolError. */
export interface GlobToolError extends ProtoMessage {
    error: string;
}
export declare const GlobToolErrorSchema: MessageCodec<GlobToolError>;
/** Cursor agent message agent.v1.GlobToolResult. */
export interface GlobToolResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: GlobToolSuccess;
    } | {
        case: "error";
        value: GlobToolError;
    };
}
export declare const GlobToolResultSchema: MessageCodec<GlobToolResult>;
/** Cursor agent message agent.v1.GlobToolSuccess. */
export interface GlobToolSuccess extends ProtoMessage {
    pattern: string;
    path: string;
    files: string[];
    totalFiles: number;
    clientTruncated: boolean;
    ripgrepTruncated: boolean;
}
export declare const GlobToolSuccessSchema: MessageCodec<GlobToolSuccess>;
/** Cursor agent message agent.v1.GrepArgs. */
export interface GrepArgs extends ProtoMessage {
    pattern: string;
    path?: string;
    glob?: string;
    outputMode?: string;
    contextBefore?: number;
    contextAfter?: number;
    context?: number;
    caseInsensitive?: boolean;
    type?: string;
    headLimit?: number;
    multiline?: boolean;
    sort?: string;
    sortAscending?: boolean;
    toolCallId: string;
    sandboxPolicy?: SandboxPolicy;
    offset?: number;
}
export declare const GrepArgsSchema: MessageCodec<GrepArgs>;
/** Cursor agent message agent.v1.GrepContentMatch. */
export interface GrepContentMatch extends ProtoMessage {
    lineNumber: number;
    content: string;
    contentTruncated: boolean;
    isContextLine: boolean;
}
export declare const GrepContentMatchSchema: MessageCodec<GrepContentMatch>;
/** Cursor agent message agent.v1.GrepContentResult. */
export interface GrepContentResult extends ProtoMessage {
    matches: GrepFileMatch[];
    totalLines: number;
    totalMatchedLines: number;
    clientTruncated: boolean;
    ripgrepTruncated: boolean;
    headLimitApplied?: number;
    offsetApplied?: number;
}
export declare const GrepContentResultSchema: MessageCodec<GrepContentResult>;
/** Cursor agent message agent.v1.GrepCountResult. */
export interface GrepCountResult extends ProtoMessage {
    counts: GrepFileCount[];
    totalFiles: number;
    totalMatches: number;
    clientTruncated: boolean;
    ripgrepTruncated: boolean;
    headLimitApplied?: number;
    offsetApplied?: number;
}
export declare const GrepCountResultSchema: MessageCodec<GrepCountResult>;
/** Cursor agent message agent.v1.GrepError. */
export interface GrepError extends ProtoMessage {
    error: string;
}
export declare const GrepErrorSchema: MessageCodec<GrepError>;
/** Cursor agent message agent.v1.GrepFileCount. */
export interface GrepFileCount extends ProtoMessage {
    file: string;
    count: number;
}
export declare const GrepFileCountSchema: MessageCodec<GrepFileCount>;
/** Cursor agent message agent.v1.GrepFileMatch. */
export interface GrepFileMatch extends ProtoMessage {
    file: string;
    matches: GrepContentMatch[];
}
export declare const GrepFileMatchSchema: MessageCodec<GrepFileMatch>;
/** Cursor agent message agent.v1.GrepFilesResult. */
export interface GrepFilesResult extends ProtoMessage {
    files: string[];
    totalFiles: number;
    clientTruncated: boolean;
    ripgrepTruncated: boolean;
    headLimitApplied?: number;
    offsetApplied?: number;
}
export declare const GrepFilesResultSchema: MessageCodec<GrepFilesResult>;
/** Cursor agent message agent.v1.GrepResult. */
export interface GrepResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: GrepSuccess;
    } | {
        case: "error";
        value: GrepError;
    };
}
export declare const GrepResultSchema: MessageCodec<GrepResult>;
/** Cursor agent message agent.v1.GrepSuccess. */
export interface GrepSuccess extends ProtoMessage {
    pattern: string;
    path: string;
    outputMode: string;
    workspaceResults: Record<string, GrepUnionResult>;
    activeEditorResult?: GrepUnionResult;
}
export declare const GrepSuccessSchema: MessageCodec<GrepSuccess>;
/** Cursor agent message agent.v1.GrepToolCall. */
export interface GrepToolCall extends ProtoMessage {
    args?: GrepArgs;
    result?: GrepResult;
}
export declare const GrepToolCallSchema: MessageCodec<GrepToolCall>;
/** Cursor agent message agent.v1.GrepUnionResult. */
export interface GrepUnionResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "count";
        value: GrepCountResult;
    } | {
        case: "files";
        value: GrepFilesResult;
    } | {
        case: "content";
        value: GrepContentResult;
    };
}
export declare const GrepUnionResultSchema: MessageCodec<GrepUnionResult>;
/** Cursor agent message agent.v1.HeartbeatUpdate. */
export interface HeartbeatUpdate extends ProtoMessage {
}
export declare const HeartbeatUpdateSchema: MessageCodec<HeartbeatUpdate>;
/** Cursor agent message agent.v1.HookAdditionalContext. */
export interface HookAdditionalContext extends ProtoMessage {
    hookEventName: string;
    content: string;
}
export declare const HookAdditionalContextSchema: MessageCodec<HookAdditionalContext>;
/** Cursor agent message agent.v1.InteractionQuery. */
export interface InteractionQuery extends ProtoMessage {
    id: number;
    query: {
        case: undefined;
        value?: undefined;
    } | {
        case: "webSearchRequestQuery";
        value: WebSearchRequestQuery;
    } | {
        case: "askQuestionInteractionQuery";
        value: AskQuestionInteractionQuery;
    } | {
        case: "switchModeRequestQuery";
        value: SwitchModeRequestQuery;
    } | {
        case: "exaSearchRequestQuery";
        value: ExaSearchRequestQuery;
    } | {
        case: "exaFetchRequestQuery";
        value: ExaFetchRequestQuery;
    } | {
        case: "createPlanRequestQuery";
        value: CreatePlanRequestQuery;
    } | {
        case: "setupVmEnvironmentArgs";
        value: SetupVmEnvironmentArgs;
    } | {
        case: "webFetchRequestQuery";
        value: WebFetchRequestQuery;
    };
}
export declare const InteractionQuerySchema: MessageCodec<InteractionQuery>;
/** Cursor agent message agent.v1.InteractionResponse. */
export interface InteractionResponse extends ProtoMessage {
    id: number;
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "webSearchRequestResponse";
        value: WebSearchRequestResponse;
    } | {
        case: "askQuestionInteractionResponse";
        value: AskQuestionInteractionResponse;
    } | {
        case: "switchModeRequestResponse";
        value: SwitchModeRequestResponse;
    } | {
        case: "exaSearchRequestResponse";
        value: ExaSearchRequestResponse;
    } | {
        case: "exaFetchRequestResponse";
        value: ExaFetchRequestResponse;
    } | {
        case: "createPlanRequestResponse";
        value: CreatePlanRequestResponse;
    } | {
        case: "setupVmEnvironmentResult";
        value: SetupVmEnvironmentResult;
    } | {
        case: "webFetchRequestResponse";
        value: WebFetchRequestResponse;
    };
}
export declare const InteractionResponseSchema: MessageCodec<InteractionResponse>;
/** Cursor agent message agent.v1.InteractionUpdate. */
export interface InteractionUpdate extends ProtoMessage {
    message: {
        case: undefined;
        value?: undefined;
    } | {
        case: "textDelta";
        value: TextDeltaUpdate;
    } | {
        case: "partialToolCall";
        value: PartialToolCallUpdate;
    } | {
        case: "toolCallDelta";
        value: ToolCallDeltaUpdate;
    } | {
        case: "toolCallStarted";
        value: ToolCallStartedUpdate;
    } | {
        case: "toolCallCompleted";
        value: ToolCallCompletedUpdate;
    } | {
        case: "thinkingDelta";
        value: ThinkingDeltaUpdate;
    } | {
        case: "thinkingCompleted";
        value: ThinkingCompletedUpdate;
    } | {
        case: "userMessageAppended";
        value: UserMessageAppendedUpdate;
    } | {
        case: "tokenDelta";
        value: TokenDeltaUpdate;
    } | {
        case: "summary";
        value: SummaryUpdate;
    } | {
        case: "summaryStarted";
        value: SummaryStartedUpdate;
    } | {
        case: "summaryCompleted";
        value: SummaryCompletedUpdate;
    } | {
        case: "shellOutputDelta";
        value: ShellOutputDeltaUpdate;
    } | {
        case: "heartbeat";
        value: HeartbeatUpdate;
    } | {
        case: "turnEnded";
        value: TurnEndedUpdate;
    } | {
        case: "stepStarted";
        value: StepStartedUpdate;
    } | {
        case: "stepCompleted";
        value: StepCompletedUpdate;
    };
}
export declare const InteractionUpdateSchema: MessageCodec<InteractionUpdate>;
/** Cursor agent message agent.v1.InvocationContext. */
export interface InvocationContext extends ProtoMessage {
    data: {
        case: undefined;
        value?: undefined;
    } | {
        case: "slackThread";
        value: InvocationContext_SlackThread;
    } | {
        case: "githubPr";
        value: InvocationContext_GithubPR;
    } | {
        case: "ideState";
        value: InvocationContext_IdeState;
    } | {
        case: "blobId";
        value: Uint8Array;
    };
}
export declare const InvocationContextSchema: MessageCodec<InvocationContext>;
/** Cursor agent message agent.v1.InvocationContext_GithubPR. */
export interface InvocationContext_GithubPR extends ProtoMessage {
    title: string;
    description: string;
    comments: string;
    ciFailures?: string;
}
export declare const InvocationContext_GithubPRSchema: MessageCodec<InvocationContext_GithubPR>;
/** Cursor agent message agent.v1.InvocationContext_IdeState. */
export interface InvocationContext_IdeState extends ProtoMessage {
    visibleFiles: InvocationContext_IdeState_File[];
    recentlyViewedFiles: InvocationContext_IdeState_File[];
    currentlyViewedPrs: InvocationContext_IdeState_ViewedPullRequest[];
}
export declare const InvocationContext_IdeStateSchema: MessageCodec<InvocationContext_IdeState>;
/** Cursor agent message agent.v1.InvocationContext_IdeState_File. */
export interface InvocationContext_IdeState_File extends ProtoMessage {
    path: string;
    relativePath?: string;
    cursorPosition?: InvocationContext_IdeState_File_CursorPosition;
    totalLines: number;
    activeCommand?: string;
}
export declare const InvocationContext_IdeState_FileSchema: MessageCodec<InvocationContext_IdeState_File>;
/** Cursor agent message agent.v1.InvocationContext_IdeState_File_CursorPosition. */
export interface InvocationContext_IdeState_File_CursorPosition extends ProtoMessage {
    line: number;
    text: string;
}
export declare const InvocationContext_IdeState_File_CursorPositionSchema: MessageCodec<InvocationContext_IdeState_File_CursorPosition>;
/** Cursor agent message agent.v1.InvocationContext_IdeState_ViewedPullRequest. */
export interface InvocationContext_IdeState_ViewedPullRequest extends ProtoMessage {
    number: number;
    url: string;
    title?: string;
    folderPath?: string;
    summaryJson?: string;
    description?: string;
}
export declare const InvocationContext_IdeState_ViewedPullRequestSchema: MessageCodec<InvocationContext_IdeState_ViewedPullRequest>;
/** Cursor agent message agent.v1.InvocationContext_SlackThread. */
export interface InvocationContext_SlackThread extends ProtoMessage {
    thread: string;
    channelName?: string;
    channelPurpose?: string;
    channelTopic?: string;
}
export declare const InvocationContext_SlackThreadSchema: MessageCodec<InvocationContext_SlackThread>;
/** Cursor agent message agent.v1.KeyAction. */
export interface KeyAction extends ProtoMessage {
    key: string;
    holdDurationMs?: number;
}
export declare const KeyActionSchema: MessageCodec<KeyAction>;
/** Cursor agent message agent.v1.KvClientMessage. */
export interface KvClientMessage extends ProtoMessage {
    id: number;
    message: {
        case: undefined;
        value?: undefined;
    } | {
        case: "getBlobResult";
        value: GetBlobResult;
    } | {
        case: "setBlobResult";
        value: SetBlobResult;
    };
}
export declare const KvClientMessageSchema: MessageCodec<KvClientMessage>;
/** Cursor agent message agent.v1.KvServerMessage. */
export interface KvServerMessage extends ProtoMessage {
    id: number;
    spanContext?: SpanContext;
    message: {
        case: undefined;
        value?: undefined;
    } | {
        case: "getBlobArgs";
        value: GetBlobArgs;
    } | {
        case: "setBlobArgs";
        value: SetBlobArgs;
    };
}
export declare const KvServerMessageSchema: MessageCodec<KvServerMessage>;
/** Cursor agent message agent.v1.ListMcpResourcesError. */
export interface ListMcpResourcesError extends ProtoMessage {
    error: string;
}
export declare const ListMcpResourcesErrorSchema: MessageCodec<ListMcpResourcesError>;
/** Cursor agent message agent.v1.ListMcpResourcesExecArgs. */
export interface ListMcpResourcesExecArgs extends ProtoMessage {
    server?: string;
}
export declare const ListMcpResourcesExecArgsSchema: MessageCodec<ListMcpResourcesExecArgs>;
/** Cursor agent message agent.v1.ListMcpResourcesExecResult. */
export interface ListMcpResourcesExecResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: ListMcpResourcesSuccess;
    } | {
        case: "error";
        value: ListMcpResourcesError;
    } | {
        case: "rejected";
        value: ListMcpResourcesRejected;
    };
}
export declare const ListMcpResourcesExecResultSchema: MessageCodec<ListMcpResourcesExecResult>;
/** Cursor agent message agent.v1.ListMcpResourcesExecResult_McpResource. */
export interface ListMcpResourcesExecResult_McpResource extends ProtoMessage {
    uri: string;
    name?: string;
    description?: string;
    mimeType?: string;
    server: string;
    annotations: Record<string, string>;
}
export declare const ListMcpResourcesExecResult_McpResourceSchema: MessageCodec<ListMcpResourcesExecResult_McpResource>;
/** Cursor agent message agent.v1.ListMcpResourcesRejected. */
export interface ListMcpResourcesRejected extends ProtoMessage {
    reason: string;
}
export declare const ListMcpResourcesRejectedSchema: MessageCodec<ListMcpResourcesRejected>;
/** Cursor agent message agent.v1.ListMcpResourcesSuccess. */
export interface ListMcpResourcesSuccess extends ProtoMessage {
    resources: ListMcpResourcesExecResult_McpResource[];
}
export declare const ListMcpResourcesSuccessSchema: MessageCodec<ListMcpResourcesSuccess>;
/** Cursor agent message agent.v1.ListMcpResourcesToolCall. */
export interface ListMcpResourcesToolCall extends ProtoMessage {
    args?: ListMcpResourcesExecArgs;
    result?: ListMcpResourcesExecResult;
}
export declare const ListMcpResourcesToolCallSchema: MessageCodec<ListMcpResourcesToolCall>;
/** Cursor agent message agent.v1.LsArgs. */
export interface LsArgs extends ProtoMessage {
    path: string;
    ignore: string[];
    toolCallId: string;
    sandboxPolicy?: SandboxPolicy;
    timeoutMs?: number;
}
export declare const LsArgsSchema: MessageCodec<LsArgs>;
/** Cursor agent message agent.v1.LsDirectoryTreeNode. */
export interface LsDirectoryTreeNode extends ProtoMessage {
    absPath: string;
    childrenDirs: LsDirectoryTreeNode[];
    childrenFiles: LsDirectoryTreeNode_File[];
    childrenWereProcessed: boolean;
    fullSubtreeExtensionCounts: Record<string, number>;
    numFiles: number;
}
export declare const LsDirectoryTreeNodeSchema: MessageCodec<LsDirectoryTreeNode>;
/** Cursor agent message agent.v1.LsDirectoryTreeNode_File. */
export interface LsDirectoryTreeNode_File extends ProtoMessage {
    name: string;
    terminalMetadata?: TerminalMetadata;
}
export declare const LsDirectoryTreeNode_FileSchema: MessageCodec<LsDirectoryTreeNode_File>;
/** Cursor agent message agent.v1.LsError. */
export interface LsError extends ProtoMessage {
    path: string;
    error: string;
}
export declare const LsErrorSchema: MessageCodec<LsError>;
/** Cursor agent message agent.v1.LsRejected. */
export interface LsRejected extends ProtoMessage {
    path: string;
    reason: string;
}
export declare const LsRejectedSchema: MessageCodec<LsRejected>;
/** Cursor agent message agent.v1.LsResult. */
export interface LsResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: LsSuccess;
    } | {
        case: "error";
        value: LsError;
    } | {
        case: "rejected";
        value: LsRejected;
    } | {
        case: "timeout";
        value: LsTimeout;
    };
}
export declare const LsResultSchema: MessageCodec<LsResult>;
/** Cursor agent message agent.v1.LsSuccess. */
export interface LsSuccess extends ProtoMessage {
    directoryTreeRoot?: LsDirectoryTreeNode;
}
export declare const LsSuccessSchema: MessageCodec<LsSuccess>;
/** Cursor agent message agent.v1.LsTimeout. */
export interface LsTimeout extends ProtoMessage {
    directoryTreeRoot?: LsDirectoryTreeNode;
}
export declare const LsTimeoutSchema: MessageCodec<LsTimeout>;
/** Cursor agent message agent.v1.LsToolCall. */
export interface LsToolCall extends ProtoMessage {
    args?: LsArgs;
    result?: LsResult;
}
export declare const LsToolCallSchema: MessageCodec<LsToolCall>;
/** Cursor agent message agent.v1.McpAllowlistPrecheckArgs. */
export interface McpAllowlistPrecheckArgs extends ProtoMessage {
    providerIdentifier: string;
    toolName: string;
    toolCallId?: string;
}
export declare const McpAllowlistPrecheckArgsSchema: MessageCodec<McpAllowlistPrecheckArgs>;
/** Cursor agent message agent.v1.McpAllowlistPrecheckResult. */
export interface McpAllowlistPrecheckResult extends ProtoMessage {
    allowlisted: boolean;
}
export declare const McpAllowlistPrecheckResultSchema: MessageCodec<McpAllowlistPrecheckResult>;
/** Cursor agent message agent.v1.McpApproved. */
export interface McpApproved extends ProtoMessage {
}
export declare const McpApprovedSchema: MessageCodec<McpApproved>;
/** Cursor agent message agent.v1.McpArgs. */
export interface McpArgs extends ProtoMessage {
    name: string;
    args: Record<string, Uint8Array>;
    toolCallId: string;
    providerIdentifier: string;
    toolName: string;
    smartModeApproval?: SmartModeApproval;
    smartModeApprovalOnly: boolean;
    skipApproval: boolean;
    serverIdentifier: string;
}
export declare const McpArgsSchema: MessageCodec<McpArgs>;
/** Cursor agent message agent.v1.McpDescriptor. */
export interface McpDescriptor extends ProtoMessage {
    serverName: string;
    serverIdentifier: string;
    folderPath?: string;
    serverUseInstructions?: string;
    tools: McpToolDescriptor[];
    plugin?: string;
    marketplace?: string;
    pluginDbId?: string;
    marketplaceId?: string;
}
export declare const McpDescriptorSchema: MessageCodec<McpDescriptor>;
/** Cursor agent message agent.v1.McpError. */
export interface McpError extends ProtoMessage {
    error: string;
}
export declare const McpErrorSchema: MessageCodec<McpError>;
/** Cursor agent message agent.v1.McpFileSystemOptions. */
export interface McpFileSystemOptions extends ProtoMessage {
    enabled: boolean;
    workspaceProjectDir: string;
    mcpDescriptors: McpDescriptor[];
}
export declare const McpFileSystemOptionsSchema: MessageCodec<McpFileSystemOptions>;
/** Cursor agent message agent.v1.McpImageContent. */
export interface McpImageContent extends ProtoMessage {
    data: Uint8Array;
    mimeType: string;
}
export declare const McpImageContentSchema: MessageCodec<McpImageContent>;
/** Cursor agent message agent.v1.McpInstructions. */
export interface McpInstructions extends ProtoMessage {
    serverName: string;
    instructions: string;
    serverIdentifier: string;
}
export declare const McpInstructionsSchema: MessageCodec<McpInstructions>;
/** Cursor agent message agent.v1.McpPermissionDenied. */
export interface McpPermissionDenied extends ProtoMessage {
    error: string;
    isReadonly: boolean;
}
export declare const McpPermissionDeniedSchema: MessageCodec<McpPermissionDenied>;
/** Cursor agent message agent.v1.McpRejected. */
export interface McpRejected extends ProtoMessage {
    reason: string;
    isReadonly: boolean;
}
export declare const McpRejectedSchema: MessageCodec<McpRejected>;
/** Cursor agent message agent.v1.McpResult. */
export interface McpResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: McpSuccess;
    } | {
        case: "error";
        value: McpError;
    } | {
        case: "rejected";
        value: McpRejected;
    } | {
        case: "permissionDenied";
        value: McpPermissionDenied;
    } | {
        case: "toolNotFound";
        value: McpToolNotFound;
    } | {
        case: "serverNotFound";
        value: McpServerNotFound;
    } | {
        case: "approved";
        value: McpApproved;
    };
}
export declare const McpResultSchema: MessageCodec<McpResult>;
/** Cursor agent message agent.v1.McpServerNotFound. */
export interface McpServerNotFound extends ProtoMessage {
    name: string;
    availableServers: string[];
}
export declare const McpServerNotFoundSchema: MessageCodec<McpServerNotFound>;
/** Cursor agent message agent.v1.McpStateError. */
export interface McpStateError extends ProtoMessage {
    error: string;
}
export declare const McpStateErrorSchema: MessageCodec<McpStateError>;
/** Cursor agent message agent.v1.McpStateExecArgs. */
export interface McpStateExecArgs extends ProtoMessage {
    serverIdentifiers: string[];
    kickOnly: boolean;
}
export declare const McpStateExecArgsSchema: MessageCodec<McpStateExecArgs>;
/** Cursor agent message agent.v1.McpStateExecResult. */
export interface McpStateExecResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: McpStateSuccess;
    } | {
        case: "error";
        value: McpStateError;
    } | {
        case: "rejected";
        value: McpStateRejected;
    };
}
export declare const McpStateExecResultSchema: MessageCodec<McpStateExecResult>;
/** Cursor agent message agent.v1.McpStateRejected. */
export interface McpStateRejected extends ProtoMessage {
    reason: string;
}
export declare const McpStateRejectedSchema: MessageCodec<McpStateRejected>;
/** Cursor agent message agent.v1.McpStateServer. */
export interface McpStateServer extends ProtoMessage {
    serverName: string;
    serverIdentifier: string;
    plugin?: string;
    marketplace?: string;
    tools: McpToolDefinition[];
    instructions: McpInstructions[];
    status?: string;
}
export declare const McpStateServerSchema: MessageCodec<McpStateServer>;
/** Cursor agent message agent.v1.McpStateSuccess. */
export interface McpStateSuccess extends ProtoMessage {
    servers: McpStateServer[];
}
export declare const McpStateSuccessSchema: MessageCodec<McpStateSuccess>;
/** Cursor agent message agent.v1.McpSuccess. */
export interface McpSuccess extends ProtoMessage {
    content: McpToolResultContentItem[];
    isError: boolean;
}
export declare const McpSuccessSchema: MessageCodec<McpSuccess>;
/** Cursor agent message agent.v1.McpTextContent. */
export interface McpTextContent extends ProtoMessage {
    text: string;
    outputLocation?: OutputLocation;
}
export declare const McpTextContentSchema: MessageCodec<McpTextContent>;
/** Cursor agent message agent.v1.McpToolCall. */
export interface McpToolCall extends ProtoMessage {
    args?: McpArgs;
    result?: McpToolResult;
    description?: string;
}
export declare const McpToolCallSchema: MessageCodec<McpToolCall>;
/** Cursor agent message agent.v1.McpToolDefinition. */
export interface McpToolDefinition extends ProtoMessage {
    name: string;
    providerIdentifier: string;
    toolName: string;
    description: string;
    inputSchema: Uint8Array;
    inputSchemaJson?: string;
}
export declare const McpToolDefinitionSchema: MessageCodec<McpToolDefinition>;
/** Cursor agent message agent.v1.McpToolDescriptor. */
export interface McpToolDescriptor extends ProtoMessage {
    toolName: string;
    definitionPath?: string;
    description?: string;
    inputSchemaJson?: string;
}
export declare const McpToolDescriptorSchema: MessageCodec<McpToolDescriptor>;
/** Cursor agent message agent.v1.McpToolError. */
export interface McpToolError extends ProtoMessage {
    error: string;
    readToolDefReminder: string;
}
export declare const McpToolErrorSchema: MessageCodec<McpToolError>;
/** Cursor agent message agent.v1.McpToolNotFound. */
export interface McpToolNotFound extends ProtoMessage {
    name: string;
    availableTools: string[];
}
export declare const McpToolNotFoundSchema: MessageCodec<McpToolNotFound>;
/** Cursor agent message agent.v1.McpToolResult. */
export interface McpToolResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: McpSuccess;
    } | {
        case: "error";
        value: McpToolError;
    } | {
        case: "rejected";
        value: McpRejected;
    } | {
        case: "permissionDenied";
        value: McpPermissionDenied;
    };
}
export declare const McpToolResultSchema: MessageCodec<McpToolResult>;
/** Cursor agent message agent.v1.McpToolResultContentItem. */
export interface McpToolResultContentItem extends ProtoMessage {
    content: {
        case: undefined;
        value?: undefined;
    } | {
        case: "text";
        value: McpTextContent;
    } | {
        case: "image";
        value: McpImageContent;
    };
}
export declare const McpToolResultContentItemSchema: MessageCodec<McpToolResultContentItem>;
/** Cursor agent message agent.v1.McpTools. */
export interface McpTools extends ProtoMessage {
    mcpTools: McpToolDefinition[];
}
export declare const McpToolsSchema: MessageCodec<McpTools>;
/** Cursor agent message agent.v1.ModelDetails. */
export interface ModelDetails extends ProtoMessage {
    modelId: string;
    displayModelId: string;
    displayName: string;
    displayNameShort: string;
    aliases: string[];
    thinkingDetails?: ThinkingDetails;
    maxMode?: boolean;
    credentials: {
        case: undefined;
        value?: undefined;
    } | {
        case: "apiKeyCredentials";
        value: ApiKeyCredentials;
    } | {
        case: "azureCredentials";
        value: AzureCredentials;
    } | {
        case: "bedrockCredentials";
        value: BedrockCredentials;
    };
}
export declare const ModelDetailsSchema: MessageCodec<ModelDetails>;
/** Cursor agent message agent.v1.MouseDownAction. */
export interface MouseDownAction extends ProtoMessage {
    button: number;
}
export declare const MouseDownActionSchema: MessageCodec<MouseDownAction>;
/** Cursor agent message agent.v1.MouseMoveAction. */
export interface MouseMoveAction extends ProtoMessage {
    coordinate?: Coordinate;
}
export declare const MouseMoveActionSchema: MessageCodec<MouseMoveAction>;
/** Cursor agent message agent.v1.MouseUpAction. */
export interface MouseUpAction extends ProtoMessage {
    button: number;
}
export declare const MouseUpActionSchema: MessageCodec<MouseUpAction>;
/** Cursor agent message agent.v1.OutputLocation. */
export interface OutputLocation extends ProtoMessage {
    filePath: string;
    sizeBytes: bigint;
    lineCount: bigint;
}
export declare const OutputLocationSchema: MessageCodec<OutputLocation>;
/** Cursor agent message agent.v1.PartialToolCallUpdate. */
export interface PartialToolCallUpdate extends ProtoMessage {
    callId: string;
    toolCall?: ToolCall;
    argsTextDelta: string;
    modelCallId: string;
}
export declare const PartialToolCallUpdateSchema: MessageCodec<PartialToolCallUpdate>;
/** Cursor agent message agent.v1.Phase. */
export interface Phase extends ProtoMessage {
    name: string;
    todos: TodoItem[];
}
export declare const PhaseSchema: MessageCodec<Phase>;
/** Cursor agent message agent.v1.PiBashExecArgs. */
export interface PiBashExecArgs extends ProtoMessage {
    command: string;
    timeout?: number;
}
export declare const PiBashExecArgsSchema: MessageCodec<PiBashExecArgs>;
/** Cursor agent message agent.v1.PiBashExecError. */
export interface PiBashExecError extends ProtoMessage {
    error: string;
    truncation?: PiTruncation;
    fullOutputPath?: string;
}
export declare const PiBashExecErrorSchema: MessageCodec<PiBashExecError>;
/** Cursor agent message agent.v1.PiBashExecResult. */
export interface PiBashExecResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: PiBashExecSuccess;
    } | {
        case: "error";
        value: PiBashExecError;
    };
}
export declare const PiBashExecResultSchema: MessageCodec<PiBashExecResult>;
/** Cursor agent message agent.v1.PiBashExecSuccess. */
export interface PiBashExecSuccess extends ProtoMessage {
    output: string;
    truncation?: PiTruncation;
    fullOutputPath?: string;
}
export declare const PiBashExecSuccessSchema: MessageCodec<PiBashExecSuccess>;
/** Cursor agent message agent.v1.PiBashToolCall. */
export interface PiBashToolCall extends ProtoMessage {
    args?: PiBashExecArgs;
    result?: PiBashExecResult;
}
export declare const PiBashToolCallSchema: MessageCodec<PiBashToolCall>;
/** Cursor agent message agent.v1.PiEditExecArgs. */
export interface PiEditExecArgs extends ProtoMessage {
    path: string;
    edits: PiEditReplacement[];
}
export declare const PiEditExecArgsSchema: MessageCodec<PiEditExecArgs>;
/** Cursor agent message agent.v1.PiEditExecError. */
export interface PiEditExecError extends ProtoMessage {
    error: string;
}
export declare const PiEditExecErrorSchema: MessageCodec<PiEditExecError>;
/** Cursor agent message agent.v1.PiEditExecRejected. */
export interface PiEditExecRejected extends ProtoMessage {
    reason: string;
}
export declare const PiEditExecRejectedSchema: MessageCodec<PiEditExecRejected>;
/** Cursor agent message agent.v1.PiEditExecResult. */
export interface PiEditExecResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: PiEditExecSuccess;
    } | {
        case: "error";
        value: PiEditExecError;
    } | {
        case: "rejected";
        value: PiEditExecRejected;
    };
}
export declare const PiEditExecResultSchema: MessageCodec<PiEditExecResult>;
/** Cursor agent message agent.v1.PiEditExecSuccess. */
export interface PiEditExecSuccess extends ProtoMessage {
    output: string;
    diff: string;
    patch: string;
    firstChangedLine?: number;
}
export declare const PiEditExecSuccessSchema: MessageCodec<PiEditExecSuccess>;
/** Cursor agent message agent.v1.PiEditReplacement. */
export interface PiEditReplacement extends ProtoMessage {
    oldText: string;
    newText: string;
}
export declare const PiEditReplacementSchema: MessageCodec<PiEditReplacement>;
/** Cursor agent message agent.v1.PiEditToolCall. */
export interface PiEditToolCall extends ProtoMessage {
    args?: PiEditExecArgs;
    result?: PiEditExecResult;
}
export declare const PiEditToolCallSchema: MessageCodec<PiEditToolCall>;
/** Cursor agent message agent.v1.PiFindExecArgs. */
export interface PiFindExecArgs extends ProtoMessage {
    pattern: string;
    path?: string;
    limit?: number;
}
export declare const PiFindExecArgsSchema: MessageCodec<PiFindExecArgs>;
/** Cursor agent message agent.v1.PiFindExecError. */
export interface PiFindExecError extends ProtoMessage {
    error: string;
}
export declare const PiFindExecErrorSchema: MessageCodec<PiFindExecError>;
/** Cursor agent message agent.v1.PiFindExecResult. */
export interface PiFindExecResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: PiFindExecSuccess;
    } | {
        case: "error";
        value: PiFindExecError;
    };
}
export declare const PiFindExecResultSchema: MessageCodec<PiFindExecResult>;
/** Cursor agent message agent.v1.PiFindExecSuccess. */
export interface PiFindExecSuccess extends ProtoMessage {
    output: string;
    truncation?: PiTruncation;
    resultLimitReached?: number;
}
export declare const PiFindExecSuccessSchema: MessageCodec<PiFindExecSuccess>;
/** Cursor agent message agent.v1.PiFindToolCall. */
export interface PiFindToolCall extends ProtoMessage {
    args?: PiFindExecArgs;
    result?: PiFindExecResult;
}
export declare const PiFindToolCallSchema: MessageCodec<PiFindToolCall>;
/** Cursor agent message agent.v1.PiGrepExecArgs. */
export interface PiGrepExecArgs extends ProtoMessage {
    pattern: string;
    path?: string;
    glob?: string;
    ignoreCase?: boolean;
    literal?: boolean;
    context?: number;
    limit?: number;
}
export declare const PiGrepExecArgsSchema: MessageCodec<PiGrepExecArgs>;
/** Cursor agent message agent.v1.PiGrepExecError. */
export interface PiGrepExecError extends ProtoMessage {
    error: string;
}
export declare const PiGrepExecErrorSchema: MessageCodec<PiGrepExecError>;
/** Cursor agent message agent.v1.PiGrepExecResult. */
export interface PiGrepExecResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: PiGrepExecSuccess;
    } | {
        case: "error";
        value: PiGrepExecError;
    };
}
export declare const PiGrepExecResultSchema: MessageCodec<PiGrepExecResult>;
/** Cursor agent message agent.v1.PiGrepExecSuccess. */
export interface PiGrepExecSuccess extends ProtoMessage {
    output: string;
    truncation?: PiTruncation;
    matchLimitReached?: number;
    linesTruncated: boolean;
}
export declare const PiGrepExecSuccessSchema: MessageCodec<PiGrepExecSuccess>;
/** Cursor agent message agent.v1.PiGrepToolCall. */
export interface PiGrepToolCall extends ProtoMessage {
    args?: PiGrepExecArgs;
    result?: PiGrepExecResult;
}
export declare const PiGrepToolCallSchema: MessageCodec<PiGrepToolCall>;
/** Cursor agent message agent.v1.PiLsExecArgs. */
export interface PiLsExecArgs extends ProtoMessage {
    path?: string;
    limit?: number;
}
export declare const PiLsExecArgsSchema: MessageCodec<PiLsExecArgs>;
/** Cursor agent message agent.v1.PiLsExecError. */
export interface PiLsExecError extends ProtoMessage {
    error: string;
}
export declare const PiLsExecErrorSchema: MessageCodec<PiLsExecError>;
/** Cursor agent message agent.v1.PiLsExecResult. */
export interface PiLsExecResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: PiLsExecSuccess;
    } | {
        case: "error";
        value: PiLsExecError;
    };
}
export declare const PiLsExecResultSchema: MessageCodec<PiLsExecResult>;
/** Cursor agent message agent.v1.PiLsExecSuccess. */
export interface PiLsExecSuccess extends ProtoMessage {
    output: string;
    truncation?: PiTruncation;
    entryLimitReached?: number;
}
export declare const PiLsExecSuccessSchema: MessageCodec<PiLsExecSuccess>;
/** Cursor agent message agent.v1.PiLsToolCall. */
export interface PiLsToolCall extends ProtoMessage {
    args?: PiLsExecArgs;
    result?: PiLsExecResult;
}
export declare const PiLsToolCallSchema: MessageCodec<PiLsToolCall>;
/** Cursor agent message agent.v1.PiReadExecArgs. */
export interface PiReadExecArgs extends ProtoMessage {
    path: string;
    offset?: number;
    limit?: number;
}
export declare const PiReadExecArgsSchema: MessageCodec<PiReadExecArgs>;
/** Cursor agent message agent.v1.PiReadExecError. */
export interface PiReadExecError extends ProtoMessage {
    error: string;
}
export declare const PiReadExecErrorSchema: MessageCodec<PiReadExecError>;
/** Cursor agent message agent.v1.PiReadExecResult. */
export interface PiReadExecResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: PiReadExecSuccess;
    } | {
        case: "error";
        value: PiReadExecError;
    };
}
export declare const PiReadExecResultSchema: MessageCodec<PiReadExecResult>;
/** Cursor agent message agent.v1.PiReadExecSuccess. */
export interface PiReadExecSuccess extends ProtoMessage {
    output: string;
    truncation?: PiTruncation;
}
export declare const PiReadExecSuccessSchema: MessageCodec<PiReadExecSuccess>;
/** Cursor agent message agent.v1.PiReadToolCall. */
export interface PiReadToolCall extends ProtoMessage {
    args?: PiReadExecArgs;
    result?: PiReadExecResult;
}
export declare const PiReadToolCallSchema: MessageCodec<PiReadToolCall>;
/** Cursor agent message agent.v1.PiTruncation. */
export interface PiTruncation extends ProtoMessage {
    truncated: boolean;
    truncatedBy: string;
    totalLines: number;
    outputLines: number;
    outputBytes: number;
    maxLines?: number;
    maxBytes?: number;
    firstLineExceedsLimit: boolean;
    lastLinePartial: boolean;
}
export declare const PiTruncationSchema: MessageCodec<PiTruncation>;
/** Cursor agent message agent.v1.PiWriteExecArgs. */
export interface PiWriteExecArgs extends ProtoMessage {
    path: string;
    content: string;
}
export declare const PiWriteExecArgsSchema: MessageCodec<PiWriteExecArgs>;
/** Cursor agent message agent.v1.PiWriteExecError. */
export interface PiWriteExecError extends ProtoMessage {
    error: string;
}
export declare const PiWriteExecErrorSchema: MessageCodec<PiWriteExecError>;
/** Cursor agent message agent.v1.PiWriteExecRejected. */
export interface PiWriteExecRejected extends ProtoMessage {
    reason: string;
}
export declare const PiWriteExecRejectedSchema: MessageCodec<PiWriteExecRejected>;
/** Cursor agent message agent.v1.PiWriteExecResult. */
export interface PiWriteExecResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: PiWriteExecSuccess;
    } | {
        case: "error";
        value: PiWriteExecError;
    } | {
        case: "rejected";
        value: PiWriteExecRejected;
    };
}
export declare const PiWriteExecResultSchema: MessageCodec<PiWriteExecResult>;
/** Cursor agent message agent.v1.PiWriteExecSuccess. */
export interface PiWriteExecSuccess extends ProtoMessage {
    output: string;
}
export declare const PiWriteExecSuccessSchema: MessageCodec<PiWriteExecSuccess>;
/** Cursor agent message agent.v1.PiWriteToolCall. */
export interface PiWriteToolCall extends ProtoMessage {
    args?: PiWriteExecArgs;
    result?: PiWriteExecResult;
}
export declare const PiWriteToolCallSchema: MessageCodec<PiWriteToolCall>;
/** Cursor agent message agent.v1.Position. */
export interface Position extends ProtoMessage {
    line: number;
    column: number;
}
export declare const PositionSchema: MessageCodec<Position>;
/** Cursor agent message agent.v1.PostToolUseFailureRequestQuery. */
export interface PostToolUseFailureRequestQuery extends ProtoMessage {
}
export declare const PostToolUseFailureRequestQuerySchema: MessageCodec<PostToolUseFailureRequestQuery>;
/** Cursor agent message agent.v1.PostToolUseFailureRequestResponse. */
export interface PostToolUseFailureRequestResponse extends ProtoMessage {
    additionalContext?: string;
}
export declare const PostToolUseFailureRequestResponseSchema: MessageCodec<PostToolUseFailureRequestResponse>;
/** Cursor agent message agent.v1.PostToolUseRequestQuery. */
export interface PostToolUseRequestQuery extends ProtoMessage {
}
export declare const PostToolUseRequestQuerySchema: MessageCodec<PostToolUseRequestQuery>;
/** Cursor agent message agent.v1.PostToolUseRequestResponse. */
export interface PostToolUseRequestResponse extends ProtoMessage {
    additionalContext?: string;
}
export declare const PostToolUseRequestResponseSchema: MessageCodec<PostToolUseRequestResponse>;
/** Cursor agent message agent.v1.PreCompactRequestQuery. */
export interface PreCompactRequestQuery extends ProtoMessage {
}
export declare const PreCompactRequestQuerySchema: MessageCodec<PreCompactRequestQuery>;
/** Cursor agent message agent.v1.PreCompactRequestResponse. */
export interface PreCompactRequestResponse extends ProtoMessage {
    userMessage?: string;
}
export declare const PreCompactRequestResponseSchema: MessageCodec<PreCompactRequestResponse>;
/** Cursor agent message agent.v1.PreToolUseRequestQuery. */
export interface PreToolUseRequestQuery extends ProtoMessage {
}
export declare const PreToolUseRequestQuerySchema: MessageCodec<PreToolUseRequestQuery>;
/** Cursor agent message agent.v1.PreToolUseRequestResponse. */
export interface PreToolUseRequestResponse extends ProtoMessage {
    permission?: string;
    userMessage?: string;
    agentMessage?: string;
    updatedInput?: string;
    additionalContext?: string;
}
export declare const PreToolUseRequestResponseSchema: MessageCodec<PreToolUseRequestResponse>;
/** Cursor agent message agent.v1.PrewarmRequest. */
export interface PrewarmRequest extends ProtoMessage {
    modelDetails?: ModelDetails;
    requestedModel?: RequestedModel;
    conversationId?: string;
    conversationState?: ConversationStateStructure;
    mcpTools?: McpTools;
    mcpFileSystemOptions?: McpFileSystemOptions;
    bestOfNGroupId?: string;
    tryUseBestOfNPromotion?: boolean;
    customSystemPrompt?: string;
}
export declare const PrewarmRequestSchema: MessageCodec<PrewarmRequest>;
/** Cursor agent message agent.v1.Range. */
export interface Range extends ProtoMessage {
    start?: Position;
    end?: Position;
}
export declare const RangeSchema: MessageCodec<Range>;
/** Cursor agent message agent.v1.ReadArgs. */
export interface ReadArgs extends ProtoMessage {
    path: string;
    toolCallId: string;
    offset?: number;
    limit?: number;
    encodingHint?: string;
}
export declare const ReadArgsSchema: MessageCodec<ReadArgs>;
/** Cursor agent message agent.v1.ReadError. */
export interface ReadError extends ProtoMessage {
    path: string;
    error: string;
}
export declare const ReadErrorSchema: MessageCodec<ReadError>;
/** Cursor agent message agent.v1.ReadFileNotFound. */
export interface ReadFileNotFound extends ProtoMessage {
    path: string;
}
export declare const ReadFileNotFoundSchema: MessageCodec<ReadFileNotFound>;
/** Cursor agent message agent.v1.ReadInvalidFile. */
export interface ReadInvalidFile extends ProtoMessage {
    path: string;
    reason: string;
}
export declare const ReadInvalidFileSchema: MessageCodec<ReadInvalidFile>;
/** Cursor agent message agent.v1.ReadLintsToolArgs. */
export interface ReadLintsToolArgs extends ProtoMessage {
    paths: string[];
}
export declare const ReadLintsToolArgsSchema: MessageCodec<ReadLintsToolArgs>;
/** Cursor agent message agent.v1.ReadLintsToolCall. */
export interface ReadLintsToolCall extends ProtoMessage {
    args?: ReadLintsToolArgs;
    result?: ReadLintsToolResult;
}
export declare const ReadLintsToolCallSchema: MessageCodec<ReadLintsToolCall>;
/** Cursor agent message agent.v1.ReadLintsToolError. */
export interface ReadLintsToolError extends ProtoMessage {
    errorMessage: string;
}
export declare const ReadLintsToolErrorSchema: MessageCodec<ReadLintsToolError>;
/** Cursor agent message agent.v1.ReadLintsToolResult. */
export interface ReadLintsToolResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: ReadLintsToolSuccess;
    } | {
        case: "error";
        value: ReadLintsToolError;
    };
}
export declare const ReadLintsToolResultSchema: MessageCodec<ReadLintsToolResult>;
/** Cursor agent message agent.v1.ReadLintsToolSuccess. */
export interface ReadLintsToolSuccess extends ProtoMessage {
    fileDiagnostics: FileDiagnostics[];
    totalFiles: number;
    totalDiagnostics: number;
}
export declare const ReadLintsToolSuccessSchema: MessageCodec<ReadLintsToolSuccess>;
/** Cursor agent message agent.v1.ReadMcpResourceError. */
export interface ReadMcpResourceError extends ProtoMessage {
    uri: string;
    error: string;
}
export declare const ReadMcpResourceErrorSchema: MessageCodec<ReadMcpResourceError>;
/** Cursor agent message agent.v1.ReadMcpResourceExecArgs. */
export interface ReadMcpResourceExecArgs extends ProtoMessage {
    server: string;
    uri: string;
    downloadPath?: string;
    toolCallId: string;
    smartModeApproval?: SmartModeApproval;
}
export declare const ReadMcpResourceExecArgsSchema: MessageCodec<ReadMcpResourceExecArgs>;
/** Cursor agent message agent.v1.ReadMcpResourceExecResult. */
export interface ReadMcpResourceExecResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: ReadMcpResourceSuccess;
    } | {
        case: "error";
        value: ReadMcpResourceError;
    } | {
        case: "rejected";
        value: ReadMcpResourceRejected;
    } | {
        case: "notFound";
        value: ReadMcpResourceNotFound;
    };
}
export declare const ReadMcpResourceExecResultSchema: MessageCodec<ReadMcpResourceExecResult>;
/** Cursor agent message agent.v1.ReadMcpResourceNotFound. */
export interface ReadMcpResourceNotFound extends ProtoMessage {
    uri: string;
}
export declare const ReadMcpResourceNotFoundSchema: MessageCodec<ReadMcpResourceNotFound>;
/** Cursor agent message agent.v1.ReadMcpResourceRejected. */
export interface ReadMcpResourceRejected extends ProtoMessage {
    uri: string;
    reason: string;
}
export declare const ReadMcpResourceRejectedSchema: MessageCodec<ReadMcpResourceRejected>;
/** Cursor agent message agent.v1.ReadMcpResourceSuccess. */
export interface ReadMcpResourceSuccess extends ProtoMessage {
    uri: string;
    name?: string;
    description?: string;
    mimeType?: string;
    annotations: Record<string, string>;
    downloadPath?: string;
    outputLocation?: OutputLocation;
    content: {
        case: undefined;
        value?: undefined;
    } | {
        case: "text";
        value: string;
    } | {
        case: "blob";
        value: Uint8Array;
    };
}
export declare const ReadMcpResourceSuccessSchema: MessageCodec<ReadMcpResourceSuccess>;
/** Cursor agent message agent.v1.ReadMcpResourceToolCall. */
export interface ReadMcpResourceToolCall extends ProtoMessage {
    args?: ReadMcpResourceExecArgs;
    result?: ReadMcpResourceExecResult;
}
export declare const ReadMcpResourceToolCallSchema: MessageCodec<ReadMcpResourceToolCall>;
/** Cursor agent message agent.v1.ReadPermissionDenied. */
export interface ReadPermissionDenied extends ProtoMessage {
    path: string;
}
export declare const ReadPermissionDeniedSchema: MessageCodec<ReadPermissionDenied>;
/** Cursor agent message agent.v1.ReadRange. */
export interface ReadRange extends ProtoMessage {
    startLine: number;
    endLine: number;
}
export declare const ReadRangeSchema: MessageCodec<ReadRange>;
/** Cursor agent message agent.v1.ReadRejected. */
export interface ReadRejected extends ProtoMessage {
    path: string;
    reason: string;
}
export declare const ReadRejectedSchema: MessageCodec<ReadRejected>;
/** Cursor agent message agent.v1.ReadResult. */
export interface ReadResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: ReadSuccess;
    } | {
        case: "error";
        value: ReadError;
    } | {
        case: "rejected";
        value: ReadRejected;
    } | {
        case: "fileNotFound";
        value: ReadFileNotFound;
    } | {
        case: "permissionDenied";
        value: ReadPermissionDenied;
    } | {
        case: "invalidFile";
        value: ReadInvalidFile;
    };
}
export declare const ReadResultSchema: MessageCodec<ReadResult>;
/** Cursor agent message agent.v1.ReadSuccess. */
export interface ReadSuccess extends ProtoMessage {
    path: string;
    totalLines: number;
    fileSize: bigint;
    truncated: boolean;
    outputBlobId?: Uint8Array;
    rangeApplied: boolean;
    output: {
        case: undefined;
        value?: undefined;
    } | {
        case: "content";
        value: string;
    } | {
        case: "data";
        value: Uint8Array;
    };
}
export declare const ReadSuccessSchema: MessageCodec<ReadSuccess>;
/** Cursor agent message agent.v1.ReadTodosArgs. */
export interface ReadTodosArgs extends ProtoMessage {
    statusFilter: number[];
    idFilter: string[];
}
export declare const ReadTodosArgsSchema: MessageCodec<ReadTodosArgs>;
/** Cursor agent message agent.v1.ReadTodosError. */
export interface ReadTodosError extends ProtoMessage {
    error: string;
}
export declare const ReadTodosErrorSchema: MessageCodec<ReadTodosError>;
/** Cursor agent message agent.v1.ReadTodosResult. */
export interface ReadTodosResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: ReadTodosSuccess;
    } | {
        case: "error";
        value: ReadTodosError;
    };
}
export declare const ReadTodosResultSchema: MessageCodec<ReadTodosResult>;
/** Cursor agent message agent.v1.ReadTodosSuccess. */
export interface ReadTodosSuccess extends ProtoMessage {
    todos: TodoItem[];
    totalCount: number;
}
export declare const ReadTodosSuccessSchema: MessageCodec<ReadTodosSuccess>;
/** Cursor agent message agent.v1.ReadTodosToolCall. */
export interface ReadTodosToolCall extends ProtoMessage {
    args?: ReadTodosArgs;
    result?: ReadTodosResult;
}
export declare const ReadTodosToolCallSchema: MessageCodec<ReadTodosToolCall>;
/** Cursor agent message agent.v1.ReadToolArgs. */
export interface ReadToolArgs extends ProtoMessage {
    path: string;
    offset?: number;
    limit?: number;
}
export declare const ReadToolArgsSchema: MessageCodec<ReadToolArgs>;
/** Cursor agent message agent.v1.ReadToolCall. */
export interface ReadToolCall extends ProtoMessage {
    args?: ReadToolArgs;
    result?: ReadToolResult;
}
export declare const ReadToolCallSchema: MessageCodec<ReadToolCall>;
/** Cursor agent message agent.v1.ReadToolError. */
export interface ReadToolError extends ProtoMessage {
    errorMessage: string;
}
export declare const ReadToolErrorSchema: MessageCodec<ReadToolError>;
/** Cursor agent message agent.v1.ReadToolResult. */
export interface ReadToolResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: ReadToolSuccess;
    } | {
        case: "error";
        value: ReadToolError;
    };
}
export declare const ReadToolResultSchema: MessageCodec<ReadToolResult>;
/** Cursor agent message agent.v1.ReadToolSuccess. */
export interface ReadToolSuccess extends ProtoMessage {
    isEmpty: boolean;
    exceededLimit: boolean;
    totalLines: number;
    fileSize: number;
    path: string;
    readRange?: ReadRange;
    output: {
        case: undefined;
        value?: undefined;
    } | {
        case: "content";
        value: string;
    } | {
        case: "data";
        value: Uint8Array;
    } | {
        case: "dataBlobId";
        value: Uint8Array;
    } | {
        case: "contentBlobId";
        value: Uint8Array;
    };
}
export declare const ReadToolSuccessSchema: MessageCodec<ReadToolSuccess>;
/** Cursor agent message agent.v1.RecordScreenArgs. */
export interface RecordScreenArgs extends ProtoMessage {
    mode: number;
    toolCallId: string;
    saveAsFilename?: string;
}
export declare const RecordScreenArgsSchema: MessageCodec<RecordScreenArgs>;
/** Cursor agent message agent.v1.RecordScreenDiscardSuccess. */
export interface RecordScreenDiscardSuccess extends ProtoMessage {
}
export declare const RecordScreenDiscardSuccessSchema: MessageCodec<RecordScreenDiscardSuccess>;
/** Cursor agent message agent.v1.RecordScreenFailure. */
export interface RecordScreenFailure extends ProtoMessage {
    error: string;
}
export declare const RecordScreenFailureSchema: MessageCodec<RecordScreenFailure>;
/** Cursor agent message agent.v1.RecordScreenResult. */
export interface RecordScreenResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "startSuccess";
        value: RecordScreenStartSuccess;
    } | {
        case: "saveSuccess";
        value: RecordScreenSaveSuccess;
    } | {
        case: "discardSuccess";
        value: RecordScreenDiscardSuccess;
    } | {
        case: "failure";
        value: RecordScreenFailure;
    };
}
export declare const RecordScreenResultSchema: MessageCodec<RecordScreenResult>;
/** Cursor agent message agent.v1.RecordScreenSaveSuccess. */
export interface RecordScreenSaveSuccess extends ProtoMessage {
    path: string;
    recordingDurationMs: bigint;
    requestedFilePathRejectedReason?: number;
}
export declare const RecordScreenSaveSuccessSchema: MessageCodec<RecordScreenSaveSuccess>;
/** Cursor agent message agent.v1.RecordScreenStartSuccess. */
export interface RecordScreenStartSuccess extends ProtoMessage {
    wasPriorRecordingCancelled: boolean;
    wasSaveAsFilenameIgnored: boolean;
}
export declare const RecordScreenStartSuccessSchema: MessageCodec<RecordScreenStartSuccess>;
/** Cursor agent message agent.v1.RecordScreenToolCall. */
export interface RecordScreenToolCall extends ProtoMessage {
    args?: RecordScreenArgs;
    result?: RecordScreenResult;
}
export declare const RecordScreenToolCallSchema: MessageCodec<RecordScreenToolCall>;
/** Cursor agent message agent.v1.ReflectArgs. */
export interface ReflectArgs extends ProtoMessage {
    unexpectedActionOutcomes: string;
    relevantInstructions: string;
    scenarioAnalysis: string;
    criticalSynthesis: string;
    nextSteps: string;
    toolCallId: string;
}
export declare const ReflectArgsSchema: MessageCodec<ReflectArgs>;
/** Cursor agent message agent.v1.ReflectError. */
export interface ReflectError extends ProtoMessage {
    error: string;
}
export declare const ReflectErrorSchema: MessageCodec<ReflectError>;
/** Cursor agent message agent.v1.ReflectResult. */
export interface ReflectResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: ReflectSuccess;
    } | {
        case: "error";
        value: ReflectError;
    };
}
export declare const ReflectResultSchema: MessageCodec<ReflectResult>;
/** Cursor agent message agent.v1.ReflectSuccess. */
export interface ReflectSuccess extends ProtoMessage {
}
export declare const ReflectSuccessSchema: MessageCodec<ReflectSuccess>;
/** Cursor agent message agent.v1.ReflectToolCall. */
export interface ReflectToolCall extends ProtoMessage {
    args?: ReflectArgs;
    result?: ReflectResult;
}
export declare const ReflectToolCallSchema: MessageCodec<ReflectToolCall>;
/** Cursor agent message agent.v1.RepositoryIndexingInfo. */
export interface RepositoryIndexingInfo extends ProtoMessage {
    relativeWorkspacePath: string;
    remoteUrls: string[];
    remoteNames: string[];
    repoName: string;
    repoOwner: string;
    isTracked: boolean;
    isLocal: boolean;
    orthogonalTransformSeed?: number;
    workspaceUri: string;
    pathEncryptionKey: string;
}
export declare const RepositoryIndexingInfoSchema: MessageCodec<RepositoryIndexingInfo>;
/** Cursor agent message agent.v1.RequestContext. */
export interface RequestContext extends ProtoMessage {
    rules: CursorRule[];
    env?: RequestContextEnv;
    repositoryInfo: RepositoryIndexingInfo[];
    tools: McpToolDefinition[];
    conversationNotesListing?: string;
    sharedNotesListing?: string;
    gitRepos: GitRepoInfo[];
    projectLayouts: LsDirectoryTreeNode[];
    mcpInstructions: McpInstructions[];
    debugModeConfig?: DebugModeConfig;
    cloudRule?: string;
    webSearchEnabled?: boolean;
    skillOptions?: SkillOptions;
    repositoryInfoShouldQueryProd?: boolean;
    fileContents: Record<string, string>;
    userIntentSummary?: string;
    customSubagents: CustomSubagent[];
    mcpFileSystemOptions?: McpFileSystemOptions;
}
export declare const RequestContextSchema: MessageCodec<RequestContext>;
/** Cursor agent message agent.v1.RequestContextArgs. */
export interface RequestContextArgs extends ProtoMessage {
    notesSessionId?: string;
    workspaceId?: string;
    readOnlyPinnedTreeSha?: string;
    readOnlyPluginCacheRoot?: string;
    useCached?: boolean;
}
export declare const RequestContextArgsSchema: MessageCodec<RequestContextArgs>;
/** Cursor agent message agent.v1.RequestContextEnv. */
export interface RequestContextEnv extends ProtoMessage {
    osVersion: string;
    workspacePaths: string[];
    shell: string;
    sandboxEnabled: boolean;
    terminalsFolder: string;
    agentSharedNotesFolder: string;
    agentConversationNotesFolder: string;
    timeZone: string;
    projectFolder: string;
    agentTranscriptsFolder: string;
}
export declare const RequestContextEnvSchema: MessageCodec<RequestContextEnv>;
/** Cursor agent message agent.v1.RequestContextError. */
export interface RequestContextError extends ProtoMessage {
    error: string;
}
export declare const RequestContextErrorSchema: MessageCodec<RequestContextError>;
/** Cursor agent message agent.v1.RequestContextRejected. */
export interface RequestContextRejected extends ProtoMessage {
    reason: string;
}
export declare const RequestContextRejectedSchema: MessageCodec<RequestContextRejected>;
/** Cursor agent message agent.v1.RequestContextResult. */
export interface RequestContextResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: RequestContextSuccess;
    } | {
        case: "error";
        value: RequestContextError;
    } | {
        case: "rejected";
        value: RequestContextRejected;
    };
}
export declare const RequestContextResultSchema: MessageCodec<RequestContextResult>;
/** Cursor agent message agent.v1.RequestContextSuccess. */
export interface RequestContextSuccess extends ProtoMessage {
    requestContext?: RequestContext;
    servedFromDiskCache?: boolean;
}
export declare const RequestContextSuccessSchema: MessageCodec<RequestContextSuccess>;
/** Cursor agent message agent.v1.RequestedModel. */
export interface RequestedModel extends ProtoMessage {
    modelId: string;
    maxMode: boolean;
    parameters: RequestedModel_ModelParameterbytes[];
    credentials: {
        case: undefined;
        value?: undefined;
    } | {
        case: "apiKeyCredentials";
        value: ApiKeyCredentials;
    } | {
        case: "azureCredentials";
        value: AzureCredentials;
    } | {
        case: "bedrockCredentials";
        value: BedrockCredentials;
    };
}
export declare const RequestedModelSchema: MessageCodec<RequestedModel>;
/** Cursor agent message agent.v1.RequestedModel_ModelParameterbytes. */
export interface RequestedModel_ModelParameterbytes extends ProtoMessage {
    id: string;
    value: string;
}
export declare const RequestedModel_ModelParameterbytesSchema: MessageCodec<RequestedModel_ModelParameterbytes>;
/** Cursor agent message agent.v1.ResumeAction. */
export interface ResumeAction extends ProtoMessage {
    requestContext?: RequestContext;
}
export declare const ResumeActionSchema: MessageCodec<ResumeAction>;
/** Cursor agent message agent.v1.SandboxPolicy. */
export interface SandboxPolicy extends ProtoMessage {
    type: number;
    networkAccess?: boolean;
    additionalReadwritePaths: string[];
    additionalReadonlyPaths: string[];
    debugOutputDir?: string;
    blockGitWrites?: boolean;
    disableTmpWrite?: boolean;
}
export declare const SandboxPolicySchema: MessageCodec<SandboxPolicy>;
/** Cursor agent message agent.v1.ScreenshotAction. */
export interface ScreenshotAction extends ProtoMessage {
}
export declare const ScreenshotActionSchema: MessageCodec<ScreenshotAction>;
/** Cursor agent message agent.v1.ScrollAction. */
export interface ScrollAction extends ProtoMessage {
    coordinate?: Coordinate;
    direction: number;
    amount: number;
    modifierKeys?: string;
}
export declare const ScrollActionSchema: MessageCodec<ScrollAction>;
/** Cursor agent message agent.v1.SearchConversationsToolCall. */
export interface SearchConversationsToolCall extends ProtoMessage {
    args?: ConversationSearchArgs;
    result?: ConversationSearchResult;
}
export declare const SearchConversationsToolCallSchema: MessageCodec<SearchConversationsToolCall>;
/** Cursor agent message agent.v1.SelectedCodeSelection. */
export interface SelectedCodeSelection extends ProtoMessage {
    content: string;
    path: string;
    relativePath?: string;
    range?: Range;
}
export declare const SelectedCodeSelectionSchema: MessageCodec<SelectedCodeSelection>;
/** Cursor agent message agent.v1.SelectedConsoleLog. */
export interface SelectedConsoleLog extends ProtoMessage {
    message: string;
    timestamp: number;
    level: string;
    clientName: string;
    sessionId: string;
    stackTrace?: StackTrace;
    objectDataJson?: string;
}
export declare const SelectedConsoleLogSchema: MessageCodec<SelectedConsoleLog>;
/** Cursor agent message agent.v1.SelectedContext. */
export interface SelectedContext extends ProtoMessage {
    selectedImages: SelectedImage[];
    invocationContext?: InvocationContext;
    extraContext: string[];
    extraContextEntries: ExtraContextEntry[];
    files: SelectedFile[];
    codeSelections: SelectedCodeSelection[];
    terminals: SelectedTerminal[];
    terminalSelections: SelectedTerminalSelection[];
    folders: SelectedFolder[];
    externalLinks: SelectedExternalLink[];
    cursorRules: SelectedCursorRule[];
    gitDiff?: SelectedGitDiff;
    gitDiffFromBranchToMain?: SelectedGitDiffFromBranchToMain;
    cursorCommands: SelectedCursorCommand[];
    documentations: SelectedDocumentation[];
    uiElements: SelectedUIElement[];
    consoleLogs: SelectedConsoleLog[];
    gitCommits: SelectedGitCommit[];
    pastChats: SelectedPastChat[];
    gitPrDiffSelections: SelectedGitPRDiffSelection[];
    selectedPullRequests: SelectedPullRequest[];
    selectedSubagents: SelectedSubagent[];
}
export declare const SelectedContextSchema: MessageCodec<SelectedContext>;
/** Cursor agent message agent.v1.SelectedCursorCommand. */
export interface SelectedCursorCommand extends ProtoMessage {
    name: string;
    content: string;
}
export declare const SelectedCursorCommandSchema: MessageCodec<SelectedCursorCommand>;
/** Cursor agent message agent.v1.SelectedCursorRule. */
export interface SelectedCursorRule extends ProtoMessage {
    rule?: CursorRule;
}
export declare const SelectedCursorRuleSchema: MessageCodec<SelectedCursorRule>;
/** Cursor agent message agent.v1.SelectedDocumentation. */
export interface SelectedDocumentation extends ProtoMessage {
    docId: string;
    name: string;
}
export declare const SelectedDocumentationSchema: MessageCodec<SelectedDocumentation>;
/** Cursor agent message agent.v1.SelectedExternalLink. */
export interface SelectedExternalLink extends ProtoMessage {
    url: string;
    uuid: string;
    pdfContent?: string;
    isPdf?: boolean;
    filename?: string;
}
export declare const SelectedExternalLinkSchema: MessageCodec<SelectedExternalLink>;
/** Cursor agent message agent.v1.SelectedFile. */
export interface SelectedFile extends ProtoMessage {
    content: string;
    path: string;
    relativePath?: string;
}
export declare const SelectedFileSchema: MessageCodec<SelectedFile>;
/** Cursor agent message agent.v1.SelectedFolder. */
export interface SelectedFolder extends ProtoMessage {
    path: string;
    relativePath?: string;
    directoryTree?: LsDirectoryTreeNode;
}
export declare const SelectedFolderSchema: MessageCodec<SelectedFolder>;
/** Cursor agent message agent.v1.SelectedGitCommit. */
export interface SelectedGitCommit extends ProtoMessage {
    sha: string;
    message: string;
    description?: string;
    diff: string;
}
export declare const SelectedGitCommitSchema: MessageCodec<SelectedGitCommit>;
/** Cursor agent message agent.v1.SelectedGitDiff. */
export interface SelectedGitDiff extends ProtoMessage {
    content: string;
}
export declare const SelectedGitDiffSchema: MessageCodec<SelectedGitDiff>;
/** Cursor agent message agent.v1.SelectedGitDiffFromBranchToMain. */
export interface SelectedGitDiffFromBranchToMain extends ProtoMessage {
    content: string;
}
export declare const SelectedGitDiffFromBranchToMainSchema: MessageCodec<SelectedGitDiffFromBranchToMain>;
/** Cursor agent message agent.v1.SelectedGitPRDiffSelection. */
export interface SelectedGitPRDiffSelection extends ProtoMessage {
    prUrl: string;
    filePath: string;
    startLine: number;
    endLine: number;
    diffContent?: string;
    blobId?: Uint8Array;
}
export declare const SelectedGitPRDiffSelectionSchema: MessageCodec<SelectedGitPRDiffSelection>;
/** Cursor agent message agent.v1.SelectedImage. */
export interface SelectedImage extends ProtoMessage {
    uuid: string;
    path: string;
    dimension?: SelectedImage_Dimension;
    mimeType: string;
    dataOrBlobId: {
        case: undefined;
        value?: undefined;
    } | {
        case: "blobId";
        value: Uint8Array;
    } | {
        case: "data";
        value: Uint8Array;
    } | {
        case: "blobIdWithData";
        value: SelectedImage_BlobIdWithData;
    };
}
export declare const SelectedImageSchema: MessageCodec<SelectedImage>;
/** Cursor agent message agent.v1.SelectedImage_BlobIdWithData. */
export interface SelectedImage_BlobIdWithData extends ProtoMessage {
    blobId: Uint8Array;
    data: Uint8Array;
}
export declare const SelectedImage_BlobIdWithDataSchema: MessageCodec<SelectedImage_BlobIdWithData>;
/** Cursor agent message agent.v1.SelectedImage_Dimension. */
export interface SelectedImage_Dimension extends ProtoMessage {
    width: number;
    height: number;
}
export declare const SelectedImage_DimensionSchema: MessageCodec<SelectedImage_Dimension>;
/** Cursor agent message agent.v1.SelectedPastChat. */
export interface SelectedPastChat extends ProtoMessage {
    agentId: string;
    name: string;
}
export declare const SelectedPastChatSchema: MessageCodec<SelectedPastChat>;
/** Cursor agent message agent.v1.SelectedPullRequest. */
export interface SelectedPullRequest extends ProtoMessage {
    number: number;
    url: string;
    title?: string;
    folderPath: string;
    summaryJson?: string;
    description?: string;
    blobId?: Uint8Array;
}
export declare const SelectedPullRequestSchema: MessageCodec<SelectedPullRequest>;
/** Cursor agent message agent.v1.SelectedSubagent. */
export interface SelectedSubagent extends ProtoMessage {
    name: string;
}
export declare const SelectedSubagentSchema: MessageCodec<SelectedSubagent>;
/** Cursor agent message agent.v1.SelectedTerminal. */
export interface SelectedTerminal extends ProtoMessage {
    content: string;
    title?: string;
    path?: string;
}
export declare const SelectedTerminalSchema: MessageCodec<SelectedTerminal>;
/** Cursor agent message agent.v1.SelectedTerminalSelection. */
export interface SelectedTerminalSelection extends ProtoMessage {
    content: string;
    title?: string;
    path?: string;
    range?: Range;
}
export declare const SelectedTerminalSelectionSchema: MessageCodec<SelectedTerminalSelection>;
/** Cursor agent message agent.v1.SelectedUIElement. */
export interface SelectedUIElement extends ProtoMessage {
    element: string;
    xpath: string;
    textContent: string;
    extra: string;
    component?: string;
    componentPropsJson?: string;
}
export declare const SelectedUIElementSchema: MessageCodec<SelectedUIElement>;
/** Cursor agent message agent.v1.SemSearchToolArgs. */
export interface SemSearchToolArgs extends ProtoMessage {
    query: string;
    targetDirectories: string[];
    explanation: string;
}
export declare const SemSearchToolArgsSchema: MessageCodec<SemSearchToolArgs>;
/** Cursor agent message agent.v1.SemSearchToolCall. */
export interface SemSearchToolCall extends ProtoMessage {
    args?: SemSearchToolArgs;
    result?: SemSearchToolResult;
}
export declare const SemSearchToolCallSchema: MessageCodec<SemSearchToolCall>;
/** Cursor agent message agent.v1.SemSearchToolError. */
export interface SemSearchToolError extends ProtoMessage {
    errorMessage: string;
}
export declare const SemSearchToolErrorSchema: MessageCodec<SemSearchToolError>;
/** Cursor agent message agent.v1.SemSearchToolResult. */
export interface SemSearchToolResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: SemSearchToolSuccess;
    } | {
        case: "error";
        value: SemSearchToolError;
    };
}
export declare const SemSearchToolResultSchema: MessageCodec<SemSearchToolResult>;
/** Cursor agent message agent.v1.SemSearchToolSuccess. */
export interface SemSearchToolSuccess extends ProtoMessage {
    results: string;
    codeResults: Uint8Array[];
}
export declare const SemSearchToolSuccessSchema: MessageCodec<SemSearchToolSuccess>;
/** Cursor agent message agent.v1.SetBlobArgs. */
export interface SetBlobArgs extends ProtoMessage {
    blobId: Uint8Array;
    blobData: Uint8Array;
}
export declare const SetBlobArgsSchema: MessageCodec<SetBlobArgs>;
/** Cursor agent message agent.v1.SetBlobResult. */
export interface SetBlobResult extends ProtoMessage {
    error?: Error;
}
export declare const SetBlobResultSchema: MessageCodec<SetBlobResult>;
/** Cursor agent message agent.v1.SetupVmEnvironmentArgs. */
export interface SetupVmEnvironmentArgs extends ProtoMessage {
    installCommand: string;
    startCommand: string;
}
export declare const SetupVmEnvironmentArgsSchema: MessageCodec<SetupVmEnvironmentArgs>;
/** Cursor agent message agent.v1.SetupVmEnvironmentResult. */
export interface SetupVmEnvironmentResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: SetupVmEnvironmentSuccess;
    };
}
export declare const SetupVmEnvironmentResultSchema: MessageCodec<SetupVmEnvironmentResult>;
/** Cursor agent message agent.v1.SetupVmEnvironmentSuccess. */
export interface SetupVmEnvironmentSuccess extends ProtoMessage {
}
export declare const SetupVmEnvironmentSuccessSchema: MessageCodec<SetupVmEnvironmentSuccess>;
/** Cursor agent message agent.v1.SetupVmEnvironmentToolCall. */
export interface SetupVmEnvironmentToolCall extends ProtoMessage {
    args?: SetupVmEnvironmentArgs;
    result?: SetupVmEnvironmentResult;
}
export declare const SetupVmEnvironmentToolCallSchema: MessageCodec<SetupVmEnvironmentToolCall>;
/** Cursor agent message agent.v1.ShellAllowlistPrecheckArgs. */
export interface ShellAllowlistPrecheckArgs extends ProtoMessage {
    command: string;
    workingDirectory: string;
    parsingResult?: ShellCommandParsingResult;
    classifierResult?: CommandClassifierResult;
    toolCallId?: string;
}
export declare const ShellAllowlistPrecheckArgsSchema: MessageCodec<ShellAllowlistPrecheckArgs>;
/** Cursor agent message agent.v1.ShellAllowlistPrecheckResult. */
export interface ShellAllowlistPrecheckResult extends ProtoMessage {
    allowlisted: boolean;
}
export declare const ShellAllowlistPrecheckResultSchema: MessageCodec<ShellAllowlistPrecheckResult>;
/** Cursor agent message agent.v1.ShellArgs. */
export interface ShellArgs extends ProtoMessage {
    command: string;
    workingDirectory: string;
    timeout: number;
    toolCallId: string;
    simpleCommands: string[];
    hasInputRedirect: boolean;
    hasOutputRedirect: boolean;
    parsingResult?: ShellCommandParsingResult;
    requestedSandboxPolicy?: SandboxPolicy;
    fileOutputThresholdBytes?: bigint;
    isBackground: boolean;
    skipApproval: boolean;
    timeoutBehavior: number;
    hardTimeout?: number;
    description?: string;
    classifierResult?: CommandClassifierResult;
    closeStdin: boolean;
    outputNotification?: ShellOutputNotificationConfig;
    smartModeApproval?: SmartModeApproval;
    hookApprovalRequirement?: ShellHookApprovalRequirement;
    conversationId?: string;
}
export declare const ShellArgsSchema: MessageCodec<ShellArgs>;
/** Cursor agent message agent.v1.ShellCommand. */
export interface ShellCommand extends ProtoMessage {
    command: string;
}
export declare const ShellCommandSchema: MessageCodec<ShellCommand>;
/** Cursor agent message agent.v1.ShellCommandAction. */
export interface ShellCommandAction extends ProtoMessage {
    shellCommand?: ShellCommand;
    execId: string;
}
export declare const ShellCommandActionSchema: MessageCodec<ShellCommandAction>;
/** Cursor agent message agent.v1.ShellCommandParsingResult. */
export interface ShellCommandParsingResult extends ProtoMessage {
    parsingFailed: boolean;
    executableCommands: ShellCommandParsingResult_ExecutableCommand[];
    hasRedirects: boolean;
    hasCommandSubstitution: boolean;
    allRedirectsAreDevNull?: boolean;
    redirects: ShellCommandParsingResult_Redirect[];
}
export declare const ShellCommandParsingResultSchema: MessageCodec<ShellCommandParsingResult>;
/** Cursor agent message agent.v1.ShellCommandParsingResult_ExecutableCommand. */
export interface ShellCommandParsingResult_ExecutableCommand extends ProtoMessage {
    name: string;
    args: ShellCommandParsingResult_ExecutableCommandArg[];
    fullText: string;
}
export declare const ShellCommandParsingResult_ExecutableCommandSchema: MessageCodec<ShellCommandParsingResult_ExecutableCommand>;
/** Cursor agent message agent.v1.ShellCommandParsingResult_ExecutableCommandArg. */
export interface ShellCommandParsingResult_ExecutableCommandArg extends ProtoMessage {
    type: string;
    value: string;
}
export declare const ShellCommandParsingResult_ExecutableCommandArgSchema: MessageCodec<ShellCommandParsingResult_ExecutableCommandArg>;
/** Cursor agent message agent.v1.ShellCommandParsingResult_Redirect. */
export interface ShellCommandParsingResult_Redirect extends ProtoMessage {
    operator: string;
    destinationFds: number[];
    targetNodeType: string;
    targetText?: string;
}
export declare const ShellCommandParsingResult_RedirectSchema: MessageCodec<ShellCommandParsingResult_Redirect>;
/** Cursor agent message agent.v1.ShellConversationTurnStructure. */
export interface ShellConversationTurnStructure extends ProtoMessage {
    shellCommand: Uint8Array;
    shellOutput: Uint8Array;
}
export declare const ShellConversationTurnStructureSchema: MessageCodec<ShellConversationTurnStructure>;
/** Cursor agent message agent.v1.ShellFailure. */
export interface ShellFailure extends ProtoMessage {
    command: string;
    workingDirectory: string;
    exitCode: number;
    signal: string;
    stdout: string;
    stderr: string;
    executionTime: number;
    outputLocation?: OutputLocation;
    interleavedOutput?: string;
    abortReason?: number;
    aborted: boolean;
    localExecutionTimeMs?: number;
    outputHead?: string;
    outputTail?: string;
    elidedChars?: number;
}
export declare const ShellFailureSchema: MessageCodec<ShellFailure>;
/** Cursor agent message agent.v1.ShellHookApprovalRequirement. */
export interface ShellHookApprovalRequirement extends ProtoMessage {
    kind: ShellHookApprovalRequirement_Kind;
    reason?: string;
}
export declare const ShellHookApprovalRequirementSchema: MessageCodec<ShellHookApprovalRequirement>;
/** Cursor agent message agent.v1.ShellOutputDeltaUpdate. */
export interface ShellOutputDeltaUpdate extends ProtoMessage {
    event: {
        case: undefined;
        value?: undefined;
    } | {
        case: "stdout";
        value: ShellStreamStdout;
    } | {
        case: "stderr";
        value: ShellStreamStderr;
    } | {
        case: "exit";
        value: ShellStreamExit;
    } | {
        case: "start";
        value: ShellStreamStart;
    };
}
export declare const ShellOutputDeltaUpdateSchema: MessageCodec<ShellOutputDeltaUpdate>;
/** Cursor agent message agent.v1.ShellOutputNotificationConfig. */
export interface ShellOutputNotificationConfig extends ProtoMessage {
    pattern: string;
    reason: string;
    debounce?: number;
    notificationLimit?: number;
}
export declare const ShellOutputNotificationConfigSchema: MessageCodec<ShellOutputNotificationConfig>;
/** Cursor agent message agent.v1.ShellPermissionDenied. */
export interface ShellPermissionDenied extends ProtoMessage {
    command: string;
    workingDirectory: string;
    error: string;
    isReadonly: boolean;
}
export declare const ShellPermissionDeniedSchema: MessageCodec<ShellPermissionDenied>;
/** Cursor agent message agent.v1.ShellRejected. */
export interface ShellRejected extends ProtoMessage {
    command: string;
    workingDirectory: string;
    reason: string;
    isReadonly: boolean;
}
export declare const ShellRejectedSchema: MessageCodec<ShellRejected>;
/** Cursor agent message agent.v1.ShellResult. */
export interface ShellResult extends ProtoMessage {
    sandboxPolicy?: SandboxPolicy;
    isBackground?: boolean;
    terminalsFolder?: string;
    pid?: number;
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: ShellSuccess;
    } | {
        case: "failure";
        value: ShellFailure;
    } | {
        case: "timeout";
        value: ShellTimeout;
    } | {
        case: "rejected";
        value: ShellRejected;
    } | {
        case: "spawnError";
        value: ShellSpawnError;
    } | {
        case: "permissionDenied";
        value: ShellPermissionDenied;
    };
}
export declare const ShellResultSchema: MessageCodec<ShellResult>;
/** Cursor agent message agent.v1.ShellSpawnError. */
export interface ShellSpawnError extends ProtoMessage {
    command: string;
    workingDirectory: string;
    error: string;
}
export declare const ShellSpawnErrorSchema: MessageCodec<ShellSpawnError>;
/** Cursor agent message agent.v1.ShellStream. */
export interface ShellStream extends ProtoMessage {
    event: {
        case: undefined;
        value?: undefined;
    } | {
        case: "stdout";
        value: ShellStreamStdout;
    } | {
        case: "stderr";
        value: ShellStreamStderr;
    } | {
        case: "exit";
        value: ShellStreamExit;
    } | {
        case: "start";
        value: ShellStreamStart;
    } | {
        case: "rejected";
        value: ShellRejected;
    } | {
        case: "permissionDenied";
        value: ShellPermissionDenied;
    } | {
        case: "backgrounded";
        value: ShellStreamBackgrounded;
    } | {
        case: "hookContext";
        value: ShellStreamHookContext;
    };
}
export declare const ShellStreamSchema: MessageCodec<ShellStream>;
/** Cursor agent message agent.v1.ShellStreamBackgrounded. */
export interface ShellStreamBackgrounded extends ProtoMessage {
    shellId: number;
    command: string;
    workingDirectory: string;
    pid?: number;
    msToWait?: number;
    reason?: ShellBackgroundReason;
}
export declare const ShellStreamBackgroundedSchema: MessageCodec<ShellStreamBackgrounded>;
/** Cursor agent message agent.v1.ShellStreamExit. */
export interface ShellStreamExit extends ProtoMessage {
    code: number;
    cwd: string;
    outputLocation?: OutputLocation;
    aborted: boolean;
    abortReason?: number;
    localExecutionTimeMs?: number;
}
export declare const ShellStreamExitSchema: MessageCodec<ShellStreamExit>;
/** Cursor agent message agent.v1.ShellStreamHookContext. */
export interface ShellStreamHookContext extends ProtoMessage {
    hookAdditionalContexts: HookAdditionalContext[];
}
export declare const ShellStreamHookContextSchema: MessageCodec<ShellStreamHookContext>;
/** Cursor agent message agent.v1.ShellStreamStart. */
export interface ShellStreamStart extends ProtoMessage {
    sandboxPolicy?: SandboxPolicy;
}
export declare const ShellStreamStartSchema: MessageCodec<ShellStreamStart>;
/** Cursor agent message agent.v1.ShellStreamStderr. */
export interface ShellStreamStderr extends ProtoMessage {
    data: string;
}
export declare const ShellStreamStderrSchema: MessageCodec<ShellStreamStderr>;
/** Cursor agent message agent.v1.ShellStreamStdout. */
export interface ShellStreamStdout extends ProtoMessage {
    data: string;
}
export declare const ShellStreamStdoutSchema: MessageCodec<ShellStreamStdout>;
/** Cursor agent message agent.v1.ShellSuccess. */
export interface ShellSuccess extends ProtoMessage {
    command: string;
    workingDirectory: string;
    exitCode: number;
    signal: string;
    stdout: string;
    stderr: string;
    executionTime: number;
    outputLocation?: OutputLocation;
    shellId?: number;
    interleavedOutput?: string;
    pid?: number;
    msToWait?: number;
    localExecutionTimeMs?: number;
    backgroundReason?: ShellBackgroundReason;
    outputHead?: string;
    outputTail?: string;
    elidedChars?: number;
}
export declare const ShellSuccessSchema: MessageCodec<ShellSuccess>;
/** Cursor agent message agent.v1.ShellTimeout. */
export interface ShellTimeout extends ProtoMessage {
    command: string;
    workingDirectory: string;
    timeoutMs: number;
}
export declare const ShellTimeoutSchema: MessageCodec<ShellTimeout>;
/** Cursor agent message agent.v1.ShellToolCall. */
export interface ShellToolCall extends ProtoMessage {
    args?: ShellArgs;
    result?: ShellResult;
}
export declare const ShellToolCallSchema: MessageCodec<ShellToolCall>;
/** Cursor agent message agent.v1.ShellToolCallDelta. */
export interface ShellToolCallDelta extends ProtoMessage {
    delta: {
        case: undefined;
        value?: undefined;
    } | {
        case: "stdout";
        value: ShellToolCallStdoutDelta;
    } | {
        case: "stderr";
        value: ShellToolCallStderrDelta;
    };
}
export declare const ShellToolCallDeltaSchema: MessageCodec<ShellToolCallDelta>;
/** Cursor agent message agent.v1.ShellToolCallStderrDelta. */
export interface ShellToolCallStderrDelta extends ProtoMessage {
    content: string;
}
export declare const ShellToolCallStderrDeltaSchema: MessageCodec<ShellToolCallStderrDelta>;
/** Cursor agent message agent.v1.ShellToolCallStdoutDelta. */
export interface ShellToolCallStdoutDelta extends ProtoMessage {
    content: string;
}
export declare const ShellToolCallStdoutDeltaSchema: MessageCodec<ShellToolCallStdoutDelta>;
/** Cursor agent message agent.v1.SkillDescriptor. */
export interface SkillDescriptor extends ProtoMessage {
    name: string;
    description: string;
    folderPath: string;
    enabled: boolean;
    parseError?: string;
    readmeFilePath: string;
    packageType: number;
}
export declare const SkillDescriptorSchema: MessageCodec<SkillDescriptor>;
/** Cursor agent message agent.v1.SkillOptions. */
export interface SkillOptions extends ProtoMessage {
    skillDescriptors: SkillDescriptor[];
}
export declare const SkillOptionsSchema: MessageCodec<SkillOptions>;
/** Cursor agent message agent.v1.SmartModeApproval. */
export interface SmartModeApproval extends ProtoMessage {
    requestId: string;
    reason: string;
}
export declare const SmartModeApprovalSchema: MessageCodec<SmartModeApproval>;
/** Cursor agent message agent.v1.SmartModeClassifierArgs. */
export interface SmartModeClassifierArgs extends ProtoMessage {
    toolCallId: string;
    parentConversationId?: string;
    target?: SmartModeRiskTarget;
    conversationContext: SmartModeClassifierConversationMessage[];
}
export declare const SmartModeClassifierArgsSchema: MessageCodec<SmartModeClassifierArgs>;
/** Cursor agent message agent.v1.SmartModeClassifierConversationMessage. */
export interface SmartModeClassifierConversationMessage extends ProtoMessage {
    role: string;
    content: string;
}
export declare const SmartModeClassifierConversationMessageSchema: MessageCodec<SmartModeClassifierConversationMessage>;
/** Cursor agent message agent.v1.SmartModeClassifierError. */
export interface SmartModeClassifierError extends ProtoMessage {
    error: string;
}
export declare const SmartModeClassifierErrorSchema: MessageCodec<SmartModeClassifierError>;
/** Cursor agent message agent.v1.SmartModeClassifierResult. */
export interface SmartModeClassifierResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: SmartModeClassifierSuccess;
    } | {
        case: "error";
        value: SmartModeClassifierError;
    };
}
export declare const SmartModeClassifierResultSchema: MessageCodec<SmartModeClassifierResult>;
/** Cursor agent message agent.v1.SmartModeClassifierSuccess. */
export interface SmartModeClassifierSuccess extends ProtoMessage {
    decision: SmartModeClassifierDecision;
    blockReason?: string;
}
export declare const SmartModeClassifierSuccessSchema: MessageCodec<SmartModeClassifierSuccess>;
/** Cursor agent message agent.v1.SmartModeRiskTarget. */
export interface SmartModeRiskTarget extends ProtoMessage {
    action: string;
}
export declare const SmartModeRiskTargetSchema: MessageCodec<SmartModeRiskTarget>;
/** Cursor agent message agent.v1.SpanContext. */
export interface SpanContext extends ProtoMessage {
    traceId: string;
    spanId: string;
    traceFlags?: number;
    traceState?: string;
}
export declare const SpanContextSchema: MessageCodec<SpanContext>;
/** Cursor agent message agent.v1.StackTrace. */
export interface StackTrace extends ProtoMessage {
    callFrames: CallFrame[];
    rawStackTrace?: string;
}
export declare const StackTraceSchema: MessageCodec<StackTrace>;
/** Cursor agent message agent.v1.StartGrindExecutionArgs. */
export interface StartGrindExecutionArgs extends ProtoMessage {
    explanation?: string;
    toolCallId: string;
}
export declare const StartGrindExecutionArgsSchema: MessageCodec<StartGrindExecutionArgs>;
/** Cursor agent message agent.v1.StartGrindExecutionError. */
export interface StartGrindExecutionError extends ProtoMessage {
    error: string;
}
export declare const StartGrindExecutionErrorSchema: MessageCodec<StartGrindExecutionError>;
/** Cursor agent message agent.v1.StartGrindExecutionResult. */
export interface StartGrindExecutionResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: StartGrindExecutionSuccess;
    } | {
        case: "error";
        value: StartGrindExecutionError;
    };
}
export declare const StartGrindExecutionResultSchema: MessageCodec<StartGrindExecutionResult>;
/** Cursor agent message agent.v1.StartGrindExecutionSuccess. */
export interface StartGrindExecutionSuccess extends ProtoMessage {
}
export declare const StartGrindExecutionSuccessSchema: MessageCodec<StartGrindExecutionSuccess>;
/** Cursor agent message agent.v1.StartGrindExecutionToolCall. */
export interface StartGrindExecutionToolCall extends ProtoMessage {
    args?: StartGrindExecutionArgs;
    result?: StartGrindExecutionResult;
}
export declare const StartGrindExecutionToolCallSchema: MessageCodec<StartGrindExecutionToolCall>;
/** Cursor agent message agent.v1.StartGrindPlanningArgs. */
export interface StartGrindPlanningArgs extends ProtoMessage {
    explanation?: string;
    toolCallId: string;
}
export declare const StartGrindPlanningArgsSchema: MessageCodec<StartGrindPlanningArgs>;
/** Cursor agent message agent.v1.StartGrindPlanningError. */
export interface StartGrindPlanningError extends ProtoMessage {
    error: string;
}
export declare const StartGrindPlanningErrorSchema: MessageCodec<StartGrindPlanningError>;
/** Cursor agent message agent.v1.StartGrindPlanningResult. */
export interface StartGrindPlanningResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: StartGrindPlanningSuccess;
    } | {
        case: "error";
        value: StartGrindPlanningError;
    };
}
export declare const StartGrindPlanningResultSchema: MessageCodec<StartGrindPlanningResult>;
/** Cursor agent message agent.v1.StartGrindPlanningSuccess. */
export interface StartGrindPlanningSuccess extends ProtoMessage {
}
export declare const StartGrindPlanningSuccessSchema: MessageCodec<StartGrindPlanningSuccess>;
/** Cursor agent message agent.v1.StartGrindPlanningToolCall. */
export interface StartGrindPlanningToolCall extends ProtoMessage {
    args?: StartGrindPlanningArgs;
    result?: StartGrindPlanningResult;
}
export declare const StartGrindPlanningToolCallSchema: MessageCodec<StartGrindPlanningToolCall>;
/** Cursor agent message agent.v1.StartPlanAction. */
export interface StartPlanAction extends ProtoMessage {
    userMessage?: UserMessage;
    requestContext?: RequestContext;
    isSpec: boolean;
}
export declare const StartPlanActionSchema: MessageCodec<StartPlanAction>;
/** Cursor agent message agent.v1.StepCompletedUpdate. */
export interface StepCompletedUpdate extends ProtoMessage {
    stepId: bigint;
    stepDurationMs: bigint;
}
export declare const StepCompletedUpdateSchema: MessageCodec<StepCompletedUpdate>;
/** Cursor agent message agent.v1.StepStartedUpdate. */
export interface StepStartedUpdate extends ProtoMessage {
    stepId: bigint;
}
export declare const StepStartedUpdateSchema: MessageCodec<StepStartedUpdate>;
/** Cursor agent message agent.v1.StepTiming. */
export interface StepTiming extends ProtoMessage {
    durationMs: bigint;
    timestampMs: bigint;
}
export declare const StepTimingSchema: MessageCodec<StepTiming>;
/** Cursor agent message agent.v1.StopRequestQuery. */
export interface StopRequestQuery extends ProtoMessage {
}
export declare const StopRequestQuerySchema: MessageCodec<StopRequestQuery>;
/** Cursor agent message agent.v1.StopRequestResponse. */
export interface StopRequestResponse extends ProtoMessage {
    followupMessage?: string;
}
export declare const StopRequestResponseSchema: MessageCodec<StopRequestResponse>;
/** Cursor agent message agent.v1.SubagentArgs. */
export interface SubagentArgs extends ProtoMessage {
    toolCallId: string;
    subagentType: string;
    prompt: string;
}
export declare const SubagentArgsSchema: MessageCodec<SubagentArgs>;
/** Cursor agent message agent.v1.SubagentAwaitArgs. */
export interface SubagentAwaitArgs extends ProtoMessage {
    agentId: string;
    timeoutMs: number;
}
export declare const SubagentAwaitArgsSchema: MessageCodec<SubagentAwaitArgs>;
/** Cursor agent message agent.v1.SubagentAwaitComplete. */
export interface SubagentAwaitComplete extends ProtoMessage {
    agentId: string;
    transcriptPath?: string;
    toolCallCount: number;
    finalMessage?: string;
}
export declare const SubagentAwaitCompleteSchema: MessageCodec<SubagentAwaitComplete>;
/** Cursor agent message agent.v1.SubagentAwaitError. */
export interface SubagentAwaitError extends ProtoMessage {
    agentId?: string;
    error: string;
}
export declare const SubagentAwaitErrorSchema: MessageCodec<SubagentAwaitError>;
/** Cursor agent message agent.v1.SubagentAwaitNotFound. */
export interface SubagentAwaitNotFound extends ProtoMessage {
    agentId: string;
}
export declare const SubagentAwaitNotFoundSchema: MessageCodec<SubagentAwaitNotFound>;
/** Cursor agent message agent.v1.SubagentAwaitResult. */
export interface SubagentAwaitResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "complete";
        value: SubagentAwaitComplete;
    } | {
        case: "stillRunning";
        value: SubagentAwaitStillRunning;
    } | {
        case: "notFound";
        value: SubagentAwaitNotFound;
    } | {
        case: "error";
        value: SubagentAwaitError;
    };
}
export declare const SubagentAwaitResultSchema: MessageCodec<SubagentAwaitResult>;
/** Cursor agent message agent.v1.SubagentAwaitStillRunning. */
export interface SubagentAwaitStillRunning extends ProtoMessage {
    agentId: string;
    transcriptPath?: string;
}
export declare const SubagentAwaitStillRunningSchema: MessageCodec<SubagentAwaitStillRunning>;
/** Cursor agent message agent.v1.SubagentError. */
export interface SubagentError extends ProtoMessage {
    agentId?: string;
    error: string;
}
export declare const SubagentErrorSchema: MessageCodec<SubagentError>;
/** Cursor agent message agent.v1.SubagentPersistedState. */
export interface SubagentPersistedState extends ProtoMessage {
    conversationState?: ConversationStateStructure;
    createdTimestampMs: bigint;
    lastUsedTimestampMs: bigint;
    subagentType?: SubagentType;
}
export declare const SubagentPersistedStateSchema: MessageCodec<SubagentPersistedState>;
/** Cursor agent message agent.v1.SubagentResult. */
export interface SubagentResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: SubagentSuccess;
    } | {
        case: "error";
        value: SubagentError;
    };
}
export declare const SubagentResultSchema: MessageCodec<SubagentResult>;
/** Cursor agent message agent.v1.SubagentStartRequestQuery. */
export interface SubagentStartRequestQuery extends ProtoMessage {
}
export declare const SubagentStartRequestQuerySchema: MessageCodec<SubagentStartRequestQuery>;
/** Cursor agent message agent.v1.SubagentStartRequestResponse. */
export interface SubagentStartRequestResponse extends ProtoMessage {
    permission?: string;
    userMessage?: string;
    additionalContext?: string;
}
export declare const SubagentStartRequestResponseSchema: MessageCodec<SubagentStartRequestResponse>;
/** Cursor agent message agent.v1.SubagentStopRequestQuery. */
export interface SubagentStopRequestQuery extends ProtoMessage {
}
export declare const SubagentStopRequestQuerySchema: MessageCodec<SubagentStopRequestQuery>;
/** Cursor agent message agent.v1.SubagentStopRequestResponse. */
export interface SubagentStopRequestResponse extends ProtoMessage {
    followupMessage?: string;
    additionalContext?: string;
}
export declare const SubagentStopRequestResponseSchema: MessageCodec<SubagentStopRequestResponse>;
/** Cursor agent message agent.v1.SubagentSuccess. */
export interface SubagentSuccess extends ProtoMessage {
    agentId: string;
    finalMessage?: string;
    toolCallCount: number;
    backgroundReason: SubagentBackgroundReason;
    transcriptPath?: string;
}
export declare const SubagentSuccessSchema: MessageCodec<SubagentSuccess>;
/** Cursor agent message agent.v1.SubagentType. */
export interface SubagentType extends ProtoMessage {
    type: {
        case: undefined;
        value?: undefined;
    } | {
        case: "unspecified";
        value: SubagentTypeUnspecified;
    } | {
        case: "computerUse";
        value: SubagentTypeComputerUse;
    } | {
        case: "custom";
        value: SubagentTypeCustom;
    } | {
        case: "explore";
        value: SubagentTypeExplore;
    };
}
export declare const SubagentTypeSchema: MessageCodec<SubagentType>;
/** Cursor agent message agent.v1.SubagentTypeComputerUse. */
export interface SubagentTypeComputerUse extends ProtoMessage {
}
export declare const SubagentTypeComputerUseSchema: MessageCodec<SubagentTypeComputerUse>;
/** Cursor agent message agent.v1.SubagentTypeCustom. */
export interface SubagentTypeCustom extends ProtoMessage {
    name: string;
}
export declare const SubagentTypeCustomSchema: MessageCodec<SubagentTypeCustom>;
/** Cursor agent message agent.v1.SubagentTypeExplore. */
export interface SubagentTypeExplore extends ProtoMessage {
}
export declare const SubagentTypeExploreSchema: MessageCodec<SubagentTypeExplore>;
/** Cursor agent message agent.v1.SubagentTypeUnspecified. */
export interface SubagentTypeUnspecified extends ProtoMessage {
}
export declare const SubagentTypeUnspecifiedSchema: MessageCodec<SubagentTypeUnspecified>;
/** Cursor agent message agent.v1.SummarizeAction. */
export interface SummarizeAction extends ProtoMessage {
}
export declare const SummarizeActionSchema: MessageCodec<SummarizeAction>;
/** Cursor agent message agent.v1.SummaryCompletedUpdate. */
export interface SummaryCompletedUpdate extends ProtoMessage {
}
export declare const SummaryCompletedUpdateSchema: MessageCodec<SummaryCompletedUpdate>;
/** Cursor agent message agent.v1.SummaryStartedUpdate. */
export interface SummaryStartedUpdate extends ProtoMessage {
}
export declare const SummaryStartedUpdateSchema: MessageCodec<SummaryStartedUpdate>;
/** Cursor agent message agent.v1.SummaryUpdate. */
export interface SummaryUpdate extends ProtoMessage {
    summary: string;
}
export declare const SummaryUpdateSchema: MessageCodec<SummaryUpdate>;
/** Cursor agent message agent.v1.SwitchModeArgs. */
export interface SwitchModeArgs extends ProtoMessage {
    targetModeId: string;
    explanation?: string;
    toolCallId: string;
}
export declare const SwitchModeArgsSchema: MessageCodec<SwitchModeArgs>;
/** Cursor agent message agent.v1.SwitchModeError. */
export interface SwitchModeError extends ProtoMessage {
    error: string;
}
export declare const SwitchModeErrorSchema: MessageCodec<SwitchModeError>;
/** Cursor agent message agent.v1.SwitchModeRejected. */
export interface SwitchModeRejected extends ProtoMessage {
    reason: string;
}
export declare const SwitchModeRejectedSchema: MessageCodec<SwitchModeRejected>;
/** Cursor agent message agent.v1.SwitchModeRequestQuery. */
export interface SwitchModeRequestQuery extends ProtoMessage {
    args?: SwitchModeArgs;
}
export declare const SwitchModeRequestQuerySchema: MessageCodec<SwitchModeRequestQuery>;
/** Cursor agent message agent.v1.SwitchModeRequestResponse. */
export interface SwitchModeRequestResponse extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "approved";
        value: SwitchModeRequestResponse_Approved;
    } | {
        case: "rejected";
        value: SwitchModeRequestResponse_Rejected;
    };
}
export declare const SwitchModeRequestResponseSchema: MessageCodec<SwitchModeRequestResponse>;
/** Cursor agent message agent.v1.SwitchModeRequestResponse_Approved. */
export interface SwitchModeRequestResponse_Approved extends ProtoMessage {
}
export declare const SwitchModeRequestResponse_ApprovedSchema: MessageCodec<SwitchModeRequestResponse_Approved>;
/** Cursor agent message agent.v1.SwitchModeRequestResponse_Rejected. */
export interface SwitchModeRequestResponse_Rejected extends ProtoMessage {
    reason: string;
}
export declare const SwitchModeRequestResponse_RejectedSchema: MessageCodec<SwitchModeRequestResponse_Rejected>;
/** Cursor agent message agent.v1.SwitchModeResult. */
export interface SwitchModeResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: SwitchModeSuccess;
    } | {
        case: "error";
        value: SwitchModeError;
    } | {
        case: "rejected";
        value: SwitchModeRejected;
    };
}
export declare const SwitchModeResultSchema: MessageCodec<SwitchModeResult>;
/** Cursor agent message agent.v1.SwitchModeSuccess. */
export interface SwitchModeSuccess extends ProtoMessage {
    fromModeId: string;
    toModeId: string;
}
export declare const SwitchModeSuccessSchema: MessageCodec<SwitchModeSuccess>;
/** Cursor agent message agent.v1.SwitchModeToolCall. */
export interface SwitchModeToolCall extends ProtoMessage {
    args?: SwitchModeArgs;
    result?: SwitchModeResult;
}
export declare const SwitchModeToolCallSchema: MessageCodec<SwitchModeToolCall>;
/** Cursor agent message agent.v1.TaskArgs. */
export interface TaskArgs extends ProtoMessage {
    description: string;
    prompt: string;
    subagentType?: SubagentType;
    model?: string;
    resume?: string;
}
export declare const TaskArgsSchema: MessageCodec<TaskArgs>;
/** Cursor agent message agent.v1.TaskError. */
export interface TaskError extends ProtoMessage {
    error: string;
}
export declare const TaskErrorSchema: MessageCodec<TaskError>;
/** Cursor agent message agent.v1.TaskResult. */
export interface TaskResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: TaskSuccess;
    } | {
        case: "error";
        value: TaskError;
    };
}
export declare const TaskResultSchema: MessageCodec<TaskResult>;
/** Cursor agent message agent.v1.TaskSuccess. */
export interface TaskSuccess extends ProtoMessage {
    conversationSteps: ConversationStep[];
    agentId?: string;
    isBackground: boolean;
    durationMs?: bigint;
}
export declare const TaskSuccessSchema: MessageCodec<TaskSuccess>;
/** Cursor agent message agent.v1.TaskToolCall. */
export interface TaskToolCall extends ProtoMessage {
    args?: TaskArgs;
    result?: TaskResult;
}
export declare const TaskToolCallSchema: MessageCodec<TaskToolCall>;
/** Cursor agent message agent.v1.TaskToolCallDelta. */
export interface TaskToolCallDelta extends ProtoMessage {
    interactionUpdate?: InteractionUpdate;
}
export declare const TaskToolCallDeltaSchema: MessageCodec<TaskToolCallDelta>;
/** Cursor agent message agent.v1.TerminalMetadata. */
export interface TerminalMetadata extends ProtoMessage {
    cwd?: string;
    lastCommands: TerminalMetadata_Command[];
    lastModifiedMs?: bigint;
    currentCommand?: TerminalMetadata_Command;
}
export declare const TerminalMetadataSchema: MessageCodec<TerminalMetadata>;
/** Cursor agent message agent.v1.TerminalMetadata_Command. */
export interface TerminalMetadata_Command extends ProtoMessage {
    command: string;
    exitCode?: number;
    timestampMs?: bigint;
    durationMs?: bigint;
}
export declare const TerminalMetadata_CommandSchema: MessageCodec<TerminalMetadata_Command>;
/** Cursor agent message agent.v1.TextDeltaUpdate. */
export interface TextDeltaUpdate extends ProtoMessage {
    text: string;
}
export declare const TextDeltaUpdateSchema: MessageCodec<TextDeltaUpdate>;
/** Cursor agent message agent.v1.ThinkingCompletedUpdate. */
export interface ThinkingCompletedUpdate extends ProtoMessage {
    thinkingDurationMs: number;
}
export declare const ThinkingCompletedUpdateSchema: MessageCodec<ThinkingCompletedUpdate>;
/** Cursor agent message agent.v1.ThinkingDeltaUpdate. */
export interface ThinkingDeltaUpdate extends ProtoMessage {
    text: string;
}
export declare const ThinkingDeltaUpdateSchema: MessageCodec<ThinkingDeltaUpdate>;
/** Cursor agent message agent.v1.ThinkingDetails. */
export interface ThinkingDetails extends ProtoMessage {
}
export declare const ThinkingDetailsSchema: MessageCodec<ThinkingDetails>;
/** Cursor agent message agent.v1.ThinkingMessage. */
export interface ThinkingMessage extends ProtoMessage {
    text: string;
    durationMs: number;
}
export declare const ThinkingMessageSchema: MessageCodec<ThinkingMessage>;
/** Cursor agent message agent.v1.TodoItem. */
export interface TodoItem extends ProtoMessage {
    id: string;
    content: string;
    status: number;
    createdAt: bigint;
    updatedAt: bigint;
    dependencies: string[];
}
export declare const TodoItemSchema: MessageCodec<TodoItem>;
/** Cursor agent message agent.v1.TokenDeltaUpdate. */
export interface TokenDeltaUpdate extends ProtoMessage {
    tokens: number;
}
export declare const TokenDeltaUpdateSchema: MessageCodec<TokenDeltaUpdate>;
/** Cursor agent message agent.v1.ToolCall. */
export interface ToolCall extends ProtoMessage {
    toolCallId?: string;
    tool: {
        case: undefined;
        value?: undefined;
    } | {
        case: "shellToolCall";
        value: ShellToolCall;
    } | {
        case: "deleteToolCall";
        value: DeleteToolCall;
    } | {
        case: "globToolCall";
        value: GlobToolCall;
    } | {
        case: "grepToolCall";
        value: GrepToolCall;
    } | {
        case: "readToolCall";
        value: ReadToolCall;
    } | {
        case: "updateTodosToolCall";
        value: UpdateTodosToolCall;
    } | {
        case: "readTodosToolCall";
        value: ReadTodosToolCall;
    } | {
        case: "editToolCall";
        value: EditToolCall;
    } | {
        case: "lsToolCall";
        value: LsToolCall;
    } | {
        case: "readLintsToolCall";
        value: ReadLintsToolCall;
    } | {
        case: "mcpToolCall";
        value: McpToolCall;
    } | {
        case: "semSearchToolCall";
        value: SemSearchToolCall;
    } | {
        case: "createPlanToolCall";
        value: CreatePlanToolCall;
    } | {
        case: "webSearchToolCall";
        value: WebSearchToolCall;
    } | {
        case: "taskToolCall";
        value: TaskToolCall;
    } | {
        case: "listMcpResourcesToolCall";
        value: ListMcpResourcesToolCall;
    } | {
        case: "readMcpResourceToolCall";
        value: ReadMcpResourceToolCall;
    } | {
        case: "applyAgentDiffToolCall";
        value: ApplyAgentDiffToolCall;
    } | {
        case: "askQuestionToolCall";
        value: AskQuestionToolCall;
    } | {
        case: "fetchToolCall";
        value: FetchToolCall;
    } | {
        case: "switchModeToolCall";
        value: SwitchModeToolCall;
    } | {
        case: "exaSearchToolCall";
        value: ExaSearchToolCall;
    } | {
        case: "exaFetchToolCall";
        value: ExaFetchToolCall;
    } | {
        case: "generateImageToolCall";
        value: GenerateImageToolCall;
    } | {
        case: "recordScreenToolCall";
        value: RecordScreenToolCall;
    } | {
        case: "computerUseToolCall";
        value: ComputerUseToolCall;
    } | {
        case: "writeShellStdinToolCall";
        value: WriteShellStdinToolCall;
    } | {
        case: "reflectToolCall";
        value: ReflectToolCall;
    } | {
        case: "setupVmEnvironmentToolCall";
        value: SetupVmEnvironmentToolCall;
    } | {
        case: "truncatedToolCall";
        value: TruncatedToolCall;
    } | {
        case: "startGrindExecutionToolCall";
        value: StartGrindExecutionToolCall;
    } | {
        case: "startGrindPlanningToolCall";
        value: StartGrindPlanningToolCall;
    } | {
        case: "piReadToolCall";
        value: PiReadToolCall;
    } | {
        case: "piBashToolCall";
        value: PiBashToolCall;
    } | {
        case: "piEditToolCall";
        value: PiEditToolCall;
    } | {
        case: "piWriteToolCall";
        value: PiWriteToolCall;
    } | {
        case: "piGrepToolCall";
        value: PiGrepToolCall;
    } | {
        case: "piFindToolCall";
        value: PiFindToolCall;
    } | {
        case: "piLsToolCall";
        value: PiLsToolCall;
    } | {
        case: "connectScmToolCall";
        value: ConnectScmToolCall;
    } | {
        case: "searchConversationsToolCall";
        value: SearchConversationsToolCall;
    } | {
        case: "webFetchToolCall";
        value: FetchToolCall;
    };
}
export declare const ToolCallSchema: MessageCodec<ToolCall>;
/** Cursor agent message agent.v1.ToolCallCompletedUpdate. */
export interface ToolCallCompletedUpdate extends ProtoMessage {
    callId: string;
    toolCall?: ToolCall;
    modelCallId: string;
}
export declare const ToolCallCompletedUpdateSchema: MessageCodec<ToolCallCompletedUpdate>;
/** Cursor agent message agent.v1.ToolCallDelta. */
export interface ToolCallDelta extends ProtoMessage {
    delta: {
        case: undefined;
        value?: undefined;
    } | {
        case: "shellToolCallDelta";
        value: ShellToolCallDelta;
    } | {
        case: "taskToolCallDelta";
        value: TaskToolCallDelta;
    } | {
        case: "editToolCallDelta";
        value: EditToolCallDelta;
    };
}
export declare const ToolCallDeltaSchema: MessageCodec<ToolCallDelta>;
/** Cursor agent message agent.v1.ToolCallDeltaUpdate. */
export interface ToolCallDeltaUpdate extends ProtoMessage {
    callId: string;
    toolCallDelta?: ToolCallDelta;
    modelCallId: string;
}
export declare const ToolCallDeltaUpdateSchema: MessageCodec<ToolCallDeltaUpdate>;
/** Cursor agent message agent.v1.ToolCallStartedUpdate. */
export interface ToolCallStartedUpdate extends ProtoMessage {
    callId: string;
    toolCall?: ToolCall;
    modelCallId: string;
}
export declare const ToolCallStartedUpdateSchema: MessageCodec<ToolCallStartedUpdate>;
/** Cursor agent message agent.v1.TruncatedToolCall. */
export interface TruncatedToolCall extends ProtoMessage {
    originalStepBlobId: Uint8Array;
    args?: TruncatedToolCallArgs;
    result?: TruncatedToolCallResult;
}
export declare const TruncatedToolCallSchema: MessageCodec<TruncatedToolCall>;
/** Cursor agent message agent.v1.TruncatedToolCallArgs. */
export interface TruncatedToolCallArgs extends ProtoMessage {
}
export declare const TruncatedToolCallArgsSchema: MessageCodec<TruncatedToolCallArgs>;
/** Cursor agent message agent.v1.TruncatedToolCallError. */
export interface TruncatedToolCallError extends ProtoMessage {
    error: string;
}
export declare const TruncatedToolCallErrorSchema: MessageCodec<TruncatedToolCallError>;
/** Cursor agent message agent.v1.TruncatedToolCallResult. */
export interface TruncatedToolCallResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: TruncatedToolCallSuccess;
    } | {
        case: "error";
        value: TruncatedToolCallError;
    };
}
export declare const TruncatedToolCallResultSchema: MessageCodec<TruncatedToolCallResult>;
/** Cursor agent message agent.v1.TruncatedToolCallSuccess. */
export interface TruncatedToolCallSuccess extends ProtoMessage {
}
export declare const TruncatedToolCallSuccessSchema: MessageCodec<TruncatedToolCallSuccess>;
/** Cursor agent message agent.v1.TurnEndedUpdate. */
export interface TurnEndedUpdate extends ProtoMessage {
}
export declare const TurnEndedUpdateSchema: MessageCodec<TurnEndedUpdate>;
/** Cursor agent message agent.v1.TypeAction. */
export interface TypeAction extends ProtoMessage {
    text: string;
}
export declare const TypeActionSchema: MessageCodec<TypeAction>;
/** Cursor agent message agent.v1.UpdateTodosArgs. */
export interface UpdateTodosArgs extends ProtoMessage {
    todos: TodoItem[];
    merge: boolean;
}
export declare const UpdateTodosArgsSchema: MessageCodec<UpdateTodosArgs>;
/** Cursor agent message agent.v1.UpdateTodosError. */
export interface UpdateTodosError extends ProtoMessage {
    error: string;
}
export declare const UpdateTodosErrorSchema: MessageCodec<UpdateTodosError>;
/** Cursor agent message agent.v1.UpdateTodosResult. */
export interface UpdateTodosResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: UpdateTodosSuccess;
    } | {
        case: "error";
        value: UpdateTodosError;
    };
}
export declare const UpdateTodosResultSchema: MessageCodec<UpdateTodosResult>;
/** Cursor agent message agent.v1.UpdateTodosSuccess. */
export interface UpdateTodosSuccess extends ProtoMessage {
    todos: TodoItem[];
    totalCount: number;
    wasMerge: boolean;
}
export declare const UpdateTodosSuccessSchema: MessageCodec<UpdateTodosSuccess>;
/** Cursor agent message agent.v1.UpdateTodosToolCall. */
export interface UpdateTodosToolCall extends ProtoMessage {
    args?: UpdateTodosArgs;
    result?: UpdateTodosResult;
}
export declare const UpdateTodosToolCallSchema: MessageCodec<UpdateTodosToolCall>;
/** Cursor agent message agent.v1.UserMessage. */
export interface UserMessage extends ProtoMessage {
    text: string;
    messageId: string;
    selectedContext?: SelectedContext;
    mode: number;
    isSimulatedMsg?: boolean;
    bestOfNGroupId?: string;
    tryUseBestOfNPromotion?: boolean;
    richText?: string;
}
export declare const UserMessageSchema: MessageCodec<UserMessage>;
/** Cursor agent message agent.v1.UserMessageAction. */
export interface UserMessageAction extends ProtoMessage {
    userMessage?: UserMessage;
    requestContext?: RequestContext;
    sendToInteractionListener?: boolean;
}
export declare const UserMessageActionSchema: MessageCodec<UserMessageAction>;
/** Cursor agent message agent.v1.UserMessageAppendedUpdate. */
export interface UserMessageAppendedUpdate extends ProtoMessage {
    userMessage?: UserMessage;
}
export declare const UserMessageAppendedUpdateSchema: MessageCodec<UserMessageAppendedUpdate>;
/** Cursor agent message agent.v1.WaitAction. */
export interface WaitAction extends ProtoMessage {
    durationMs: number;
}
export declare const WaitActionSchema: MessageCodec<WaitAction>;
/** Cursor agent message agent.v1.WebFetchAllowlistPrecheckArgs. */
export interface WebFetchAllowlistPrecheckArgs extends ProtoMessage {
    url: string;
    toolCallId?: string;
}
export declare const WebFetchAllowlistPrecheckArgsSchema: MessageCodec<WebFetchAllowlistPrecheckArgs>;
/** Cursor agent message agent.v1.WebFetchAllowlistPrecheckResult. */
export interface WebFetchAllowlistPrecheckResult extends ProtoMessage {
    allowlisted: boolean;
}
export declare const WebFetchAllowlistPrecheckResultSchema: MessageCodec<WebFetchAllowlistPrecheckResult>;
/** Cursor agent message agent.v1.WebFetchRequestQuery. */
export interface WebFetchRequestQuery extends ProtoMessage {
    args?: FetchArgs;
}
export declare const WebFetchRequestQuerySchema: MessageCodec<WebFetchRequestQuery>;
/** Cursor agent message agent.v1.WebFetchRequestResponse. */
export interface WebFetchRequestResponse extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "approved";
        value: WebFetchRequestResponse_Approved;
    } | {
        case: "rejected";
        value: WebFetchRequestResponse_Rejected;
    };
}
export declare const WebFetchRequestResponseSchema: MessageCodec<WebFetchRequestResponse>;
/** Cursor agent message agent.v1.WebFetchRequestResponse_Approved. */
export interface WebFetchRequestResponse_Approved extends ProtoMessage {
}
export declare const WebFetchRequestResponse_ApprovedSchema: MessageCodec<WebFetchRequestResponse_Approved>;
/** Cursor agent message agent.v1.WebFetchRequestResponse_Rejected. */
export interface WebFetchRequestResponse_Rejected extends ProtoMessage {
    reason: string;
}
export declare const WebFetchRequestResponse_RejectedSchema: MessageCodec<WebFetchRequestResponse_Rejected>;
/** Cursor agent message agent.v1.WebSearchArgs. */
export interface WebSearchArgs extends ProtoMessage {
    searchTerm: string;
    toolCallId: string;
}
export declare const WebSearchArgsSchema: MessageCodec<WebSearchArgs>;
/** Cursor agent message agent.v1.WebSearchError. */
export interface WebSearchError extends ProtoMessage {
    error: string;
}
export declare const WebSearchErrorSchema: MessageCodec<WebSearchError>;
/** Cursor agent message agent.v1.WebSearchReference. */
export interface WebSearchReference extends ProtoMessage {
    title: string;
    url: string;
    chunk: string;
}
export declare const WebSearchReferenceSchema: MessageCodec<WebSearchReference>;
/** Cursor agent message agent.v1.WebSearchRejected. */
export interface WebSearchRejected extends ProtoMessage {
    reason: string;
}
export declare const WebSearchRejectedSchema: MessageCodec<WebSearchRejected>;
/** Cursor agent message agent.v1.WebSearchRequestQuery. */
export interface WebSearchRequestQuery extends ProtoMessage {
    args?: WebSearchArgs;
}
export declare const WebSearchRequestQuerySchema: MessageCodec<WebSearchRequestQuery>;
/** Cursor agent message agent.v1.WebSearchRequestResponse. */
export interface WebSearchRequestResponse extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "approved";
        value: WebSearchRequestResponse_Approved;
    } | {
        case: "rejected";
        value: WebSearchRequestResponse_Rejected;
    };
}
export declare const WebSearchRequestResponseSchema: MessageCodec<WebSearchRequestResponse>;
/** Cursor agent message agent.v1.WebSearchRequestResponse_Approved. */
export interface WebSearchRequestResponse_Approved extends ProtoMessage {
}
export declare const WebSearchRequestResponse_ApprovedSchema: MessageCodec<WebSearchRequestResponse_Approved>;
/** Cursor agent message agent.v1.WebSearchRequestResponse_Rejected. */
export interface WebSearchRequestResponse_Rejected extends ProtoMessage {
    reason: string;
}
export declare const WebSearchRequestResponse_RejectedSchema: MessageCodec<WebSearchRequestResponse_Rejected>;
/** Cursor agent message agent.v1.WebSearchResult. */
export interface WebSearchResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: WebSearchSuccess;
    } | {
        case: "error";
        value: WebSearchError;
    } | {
        case: "rejected";
        value: WebSearchRejected;
    };
}
export declare const WebSearchResultSchema: MessageCodec<WebSearchResult>;
/** Cursor agent message agent.v1.WebSearchSuccess. */
export interface WebSearchSuccess extends ProtoMessage {
    references: WebSearchReference[];
}
export declare const WebSearchSuccessSchema: MessageCodec<WebSearchSuccess>;
/** Cursor agent message agent.v1.WebSearchToolCall. */
export interface WebSearchToolCall extends ProtoMessage {
    args?: WebSearchArgs;
    result?: WebSearchResult;
}
export declare const WebSearchToolCallSchema: MessageCodec<WebSearchToolCall>;
/** Cursor agent message agent.v1.WriteArgs. */
export interface WriteArgs extends ProtoMessage {
    path: string;
    fileText: string;
    toolCallId: string;
    returnFileContentAfterWrite: boolean;
    fileBytes: Uint8Array;
    encodingHint?: string;
}
export declare const WriteArgsSchema: MessageCodec<WriteArgs>;
/** Cursor agent message agent.v1.WriteError. */
export interface WriteError extends ProtoMessage {
    path: string;
    error: string;
}
export declare const WriteErrorSchema: MessageCodec<WriteError>;
/** Cursor agent message agent.v1.WriteNoSpace. */
export interface WriteNoSpace extends ProtoMessage {
    path: string;
}
export declare const WriteNoSpaceSchema: MessageCodec<WriteNoSpace>;
/** Cursor agent message agent.v1.WritePermissionDenied. */
export interface WritePermissionDenied extends ProtoMessage {
    path: string;
    directory: string;
    operation: string;
    error: string;
    isReadonly: boolean;
}
export declare const WritePermissionDeniedSchema: MessageCodec<WritePermissionDenied>;
/** Cursor agent message agent.v1.WriteRejected. */
export interface WriteRejected extends ProtoMessage {
    path: string;
    reason: string;
}
export declare const WriteRejectedSchema: MessageCodec<WriteRejected>;
/** Cursor agent message agent.v1.WriteResult. */
export interface WriteResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: WriteSuccess;
    } | {
        case: "permissionDenied";
        value: WritePermissionDenied;
    } | {
        case: "noSpace";
        value: WriteNoSpace;
    } | {
        case: "error";
        value: WriteError;
    } | {
        case: "rejected";
        value: WriteRejected;
    };
}
export declare const WriteResultSchema: MessageCodec<WriteResult>;
/** Cursor agent message agent.v1.WriteShellStdinArgs. */
export interface WriteShellStdinArgs extends ProtoMessage {
    shellId: number;
    chars: string;
}
export declare const WriteShellStdinArgsSchema: MessageCodec<WriteShellStdinArgs>;
/** Cursor agent message agent.v1.WriteShellStdinError. */
export interface WriteShellStdinError extends ProtoMessage {
    error: string;
}
export declare const WriteShellStdinErrorSchema: MessageCodec<WriteShellStdinError>;
/** Cursor agent message agent.v1.WriteShellStdinResult. */
export interface WriteShellStdinResult extends ProtoMessage {
    result: {
        case: undefined;
        value?: undefined;
    } | {
        case: "success";
        value: WriteShellStdinSuccess;
    } | {
        case: "error";
        value: WriteShellStdinError;
    };
}
export declare const WriteShellStdinResultSchema: MessageCodec<WriteShellStdinResult>;
/** Cursor agent message agent.v1.WriteShellStdinSuccess. */
export interface WriteShellStdinSuccess extends ProtoMessage {
    shellId: number;
    terminalFileLengthBeforeInputWritten: number;
}
export declare const WriteShellStdinSuccessSchema: MessageCodec<WriteShellStdinSuccess>;
/** Cursor agent message agent.v1.WriteShellStdinToolCall. */
export interface WriteShellStdinToolCall extends ProtoMessage {
    args?: WriteShellStdinArgs;
    result?: WriteShellStdinResult;
}
export declare const WriteShellStdinToolCallSchema: MessageCodec<WriteShellStdinToolCall>;
/** Cursor agent message agent.v1.WriteSuccess. */
export interface WriteSuccess extends ProtoMessage {
    path: string;
    linesCreated: number;
    fileSize: number;
    fileContentAfterWrite?: string;
}
export declare const WriteSuccessSchema: MessageCodec<WriteSuccess>;
