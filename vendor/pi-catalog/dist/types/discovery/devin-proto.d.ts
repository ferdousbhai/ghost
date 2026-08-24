/**
 * Devin protocol declarations used by Oh My Pi.
 *
 * Each declaration retains only fields consumed by the client or its protocol tests.
 */
import { type MessageCodec, type ProtoMessage } from "./protobuf.js";
/** Devin enum APIProvider. */
export declare enum APIProvider {
    UNSPECIFIED = 0,
    INTERNAL = 1,
    OPENAI = 2,
    GOOGLE_VERTEX = 3,
    ANTHROPIC = 4,
    VLLM = 5,
    TOGETHER_AI = 6,
    HUGGING_FACE = 7,
    NOMIC = 8,
    TEI = 9,
    OPENAI_COMPATIBLE_EXTERNAL = 10,
    ANTHROPIC_COMPATIBLE_EXTERNAL = 11,
    VERTEX_COMPATIBLE_EXTERNAL = 12,
    BEDROCK_COMPATIBLE_EXTERNAL = 13,
    AZURE_COMPATIBLE_EXTERNAL = 14,
    ANTHROPIC_BEDROCK = 15,
    FIREWORKS = 16,
    OPEN_ROUTER = 17,
    XAI = 18,
    ANTHROPIC_BYOK = 20,
    CEREBRAS = 21,
    XAI_BYOK = 22,
    GEMINI_OPENAI = 23,
    GOOGLE_GEMINI = 24,
    GOOGLE_GENAI_VERTEX = 25,
    ANTHROPIC_VERTEX = 26,
    DATABRICKS = 27,
    OPEN_ROUTER_BYOK = 28,
    ANTHROPIC_DEVIN = 29,
    FIREWORKS_DEVIN = 30,
    GROQ = 31,
    OPENAI_DEVIN = 32,
    LLAMA_FT_DEEPWIKI = 33,
    XAI_INTERNAL = 34,
    FLOODGATE = 36,
    ANTHROPIC_BEDROCK_US = 37,
    ANTHROPIC_BEDROCK_GLOBAL = 38,
    MODAL = 40,
    GOOGLE_GEMINI_DEVIN = 41,
    FIREWORKS_COGNITION = 42,
    GOOGLE_GENAI_VERTEX_GLOBAL = 43,
    ANTHROPIC_VERTEX_US = 44,
    ANTHROPIC_VERTEX_EU = 45,
    ANTHROPIC_VERTEX_GLOBAL = 46,
    FIREWORKS_COGNITION_INTERNAL = 47,
    ANTHROPIC_DATABRICKS = 48,
    GEMINI_DATABRICKS = 49,
    MIMIC = 50,
    ANTHROPIC_NON_ZDR = 51,
    ANTHROPIC_DEVIN_NON_ZDR = 52,
    DATA_RETENTION_WORKSPACE_ANTHROPIC = 53,
    SGLANG = 60,
    AZURE_OPENAI_FEDERATED = 61
}
/** Devin enum AuthSource. */
export declare enum AuthSource {
    CODEIUM = 0,
    DEEPNOTE = 1,
    CODESANDBOX = 2,
    STACKBLITZ = 3,
    VALTOWN = 4,
    HEX = 5,
    ZAPIER = 6,
    SUPERBLOCKS = 7,
    EMBARCADERO = 8
}
/** Devin enum CacheControlType. */
export declare enum CacheControlType {
    UNSPECIFIED = 0,
    EPHEMERAL = 1
}
/** Devin enum ChatMessageRequestType. */
export declare enum ChatMessageRequestType {
    UNSPECIFIED = 0,
    GENERAL = 1,
    CONTEXT_CHECK = 2,
    PLAN = 3,
    COMMAND = 4,
    CASCADE = 5,
    EVAL = 6,
    WINDSURF_REVIEW = 7,
    VIBE_AND_REPLACE = 8,
    DEEPWIKI = 9,
    DEVSTRAL = 10,
    CODEMAP_GENERATION = 11,
    CODEMAP_SUGGESTIONS = 12,
    SMART_FRIEND = 13,
    LIFEGUARD = 14,
    CHECKPOINT = 15
}
/** Devin enum ChatMessageSource. */
export declare enum ChatMessageSource {
    UNSPECIFIED = 0,
    USER = 1,
    SYSTEM = 2,
    UNKNOWN = 3,
    TOOL = 4,
    SYSTEM_PROMPT = 5
}
/** Devin enum ConversationalPlannerMode. */
export declare enum ConversationalPlannerMode {
    UNSPECIFIED = 0,
    DEFAULT = 1,
    READ_ONLY = 2,
    NO_TOOL = 3,
    EXPLORE = 4,
    PLANNING = 5,
    AUTO = 6
}
/** Devin enum CortexStepType. */
export declare enum CortexStepType {
    UNSPECIFIED = 0,
    DUMMY = 1,
    FINISH = 2,
    PLAN_INPUT = 3,
    MQUERY = 4,
    CODE_ACTION = 5,
    GIT_COMMIT = 6,
    GREP_SEARCH = 7,
    VIEW_FILE = 8,
    LIST_DIRECTORY = 9,
    COMPILE = 10,
    INFORM = 11,
    FILE_BREAKDOWN = 12,
    VIEW_CODE_ITEM = 13,
    USER_INPUT = 14,
    PLANNER_RESPONSE = 15,
    WRITE_TO_FILE = 16,
    ERROR_MESSAGE = 17,
    CLUSTER_QUERY = 18,
    LIST_CLUSTERS = 19,
    INSPECT_CLUSTER = 20,
    RUN_COMMAND = 21,
    RELATED_FILES = 22,
    CHECKPOINT = 23,
    PROPOSE_CODE = 24,
    FIND = 25,
    SEARCH_KNOWLEDGE_BASE = 26,
    SUGGESTED_RESPONSES = 27,
    COMMAND_STATUS = 28,
    MEMORY = 29,
    LOOKUP_KNOWLEDGE_BASE = 30,
    READ_URL_CONTENT = 31,
    VIEW_CONTENT_CHUNK = 32,
    SEARCH_WEB = 33,
    RETRIEVE_MEMORY = 34,
    AUTO_CASCADE_BROADCAST = 35,
    CUSTOM_TOOL = 36,
    CREATE_RECIPE = 37,
    MCP_TOOL = 38,
    MANAGER_FEEDBACK = 39,
    TOOL_CALL_PROPOSAL = 40,
    TOOL_CALL_CHOICE = 41,
    TRAJECTORY_CHOICE = 42,
    PROXY_WEB_SERVER = 43,
    DEPLOY_WEB_APP = 44,
    CLIPBOARD = 45,
    READ_DEPLOYMENT_CONFIG = 46,
    VIEW_FILE_OUTLINE = 47,
    CHECK_DEPLOY_STATUS = 48,
    POST_PR_REVIEW = 49,
    READ_KNOWLEDGE_BASE_ITEM = 50,
    LIST_RESOURCES = 51,
    READ_RESOURCE = 52,
    LINT_DIFF = 53,
    FIND_ALL_REFERENCES = 54,
    BRAIN_UPDATE = 55,
    RUN_EXTENSION_CODE = 57,
    ADD_ANNOTATION = 58,
    PROPOSAL_FEEDBACK = 59,
    TRAJECTORY_SEARCH = 60,
    READ_TERMINAL = 65,
    GET_DOM_TREE = 68,
    ARTIFACT_SUMMARY = 71,
    RESOLVE_TASK = 72,
    TODO_LIST = 73,
    BLOCKING = 74,
    EXPLORE_RESPONSE = 80,
    READ_NOTEBOOK = 82,
    EDIT_NOTEBOOK = 83,
    SUPERCOMPLETE_ACTIVE_DOC = 86,
    FIND_CODE_CONTEXT = 87,
    SUPERCOMPLETE_FEEDBACK = 89,
    LINT_FIX_MESSAGE = 90,
    GREP_SEARCH_V2 = 91,
    UPSERT_CODEMAP = 92,
    SUGGEST_CODEMAP = 93,
    SMART_FRIEND = 94,
    DO_TESTING = 95,
    REPORT_BUGS = 97,
    EXIT_PLAN_MODE = 99,
    ASK_USER_QUESTION = 100,
    SKILL = 101,
    SUPERCOMPLETE_EPHEMERAL_FEEDBACK = 102,
    ARENA_TRAJECTORY_CONVERGE = 103,
    TASK_SUBAGENT = 104
}
/** Devin enum CortexTrajectoryType. */
export declare enum CortexTrajectoryType {
    UNSPECIFIED = 0,
    USER_MAINLINE = 1,
    USER_GRANULAR = 2,
    SUPERCOMPLETE = 3,
    CASCADE = 4,
    BACKGROUND_RESEARCH = 5,
    CHECKPOINT = 6,
    RETRIEVE_MEMORY = 7,
    CUSTOM_TOOL = 8,
    AUTO_CASCADE = 9,
    AUTO_CASCADE_MANAGER = 10,
    APPLIER = 11,
    TOOL_CALL_PROPOSAL = 12,
    TRAJECTORY_CHOICE = 13,
    LLM_JUDGE = 14,
    ARTIFACT_SUMMARY = 19,
    PASSIVE_CODER = 15,
    INTERACTIVE_CASCADE = 17,
    BRAIN_UPDATE = 16
}
/** Devin enum DisplayOption. */
export declare enum DisplayOption {
    UNSPECIFIED = 0,
    ARENA = 1,
    BATTLE_GROUP_ONLY = 2,
    MODEL_ROUTER = 3,
    QUICK_REVIEW = 4
}
/** Devin enum ExperimentKey. */
export declare enum ExperimentKey {
    UNSPECIFIED = 0,
    USE_INTERNAL_CHAT_MODEL = 36,
    RECORD_FILES = 47,
    NO_SAMPLER_EARLY_STOP = 48,
    CM_MEMORY_TELEMETRY = 53,
    LANGUAGE_SERVER_VERSION = 55,
    LANGUAGE_SERVER_AUTO_RELOAD = 56,
    ONLY_MULTILINE = 60,
    USE_AUTOCOMPLETE_MODEL = 64,
    USE_ATTRIBUTION_FOR_INDIVIDUAL_TIER = 68,
    CHAT_MODEL_CONFIG = 78,
    COMMAND_MODEL_CONFIG = 79,
    MIN_IDE_VERSION = 81,
    API_SERVER_VERBOSE_ERRORS = 84,
    DEFAULT_ENABLE_SEARCH = 86,
    COLLECT_ONBOARDING_EVENTS = 87,
    COLLECT_EXAMPLE_COMPLETIONS = 88,
    USE_MULTILINE_MODEL = 89,
    ATTRIBUTION_KILL_SWITCH = 92,
    FAST_MULTILINE = 94,
    SINGLE_COMPLETION = 95,
    STOP_FIRST_NON_WHITESPACE_LINE = 96,
    CORTEX_CONFIG = 102,
    MODEL_CHAT_11121_VARIANTS = 103,
    INCLUDE_PROMPT_COMPONENTS = 105,
    NON_TEAMS_KILL_SWITCH = 106,
    PERSIST_CODE_TRACKER = 108,
    CHAT_COMPLETION_TOKENS_SOFT_LIMIT = 114,
    CHAT_TOKENS_SOFT_LIMIT = 115,
    DISABLE_COMPLETIONS_CACHE = 118,
    LLAMA3_405B_KILL_SWITCH = 119,
    USE_COMMAND_DOCSTRING_GENERATION = 121,
    ENABLE_SUPERCOMPLETE = 123,
    SENTRY = 136,
    FAST_SINGLELINE = 144,
    R2_LANGUAGE_SERVER_DOWNLOAD = 147,
    SPLIT_MODEL = 152,
    WINDSURF_SENTRY_SAMPLE_RATE = 198,
    API_SERVER_CUTOFF = 158,
    FAST_SPEED_KILL_SWITCH = 159,
    PREDICTIVE_MULTILINE = 160,
    SUPERCOMPLETE_FILTER_REVERT = 125,
    SUPERCOMPLETE_FILTER_PREFIX_MATCH = 126,
    SUPERCOMPLETE_FILTER_SCORE_THRESHOLD = 127,
    SUPERCOMPLETE_FILTER_INSERTION_CAP = 128,
    SUPERCOMPLETE_FILTER_DELETION_CAP = 133,
    SUPERCOMPLETE_FILTER_WHITESPACE_ONLY = 156,
    SUPERCOMPLETE_FILTER_NO_OP = 170,
    SUPERCOMPLETE_FILTER_SUFFIX_MATCH = 176,
    SUPERCOMPLETE_FILTER_PREVIOUSLY_SHOWN = 182,
    SUPERCOMPLETE_MIN_SCORE = 129,
    SUPERCOMPLETE_MAX_INSERTIONS = 130,
    SUPERCOMPLETE_LINE_RADIUS = 131,
    SUPERCOMPLETE_MAX_DELETIONS = 132,
    SUPERCOMPLETE_RECENT_STEPS_DURATION = 138,
    SUPERCOMPLETE_MAX_TRAJECTORY_STEPS = 154,
    SUPERCOMPLETE_MAX_TRAJECTORY_STEP_SIZE = 203,
    SUPERCOMPLETE_DISABLE_TYPING_CACHE = 231,
    SUPERCOMPLETE_ALWAYS_USE_CACHE_ON_EQUAL_STATE = 293,
    SUPERCOMPLETE_CACHE_ON_PARENT_ID_KILL_SWITCH = 297,
    SUPERCOMPLETE_PRUNE_RESPONSE = 140,
    SUPERCOMPLETE_PRUNE_MAX_INSERT_DELETE_LINE_DELTA = 141,
    SUPERCOMPLETE_MODEL_CONFIG = 145,
    SUPERCOMPLETE_MODEL_CONFIG_LOW = 330,
    SUPERCOMPLETE_MODEL_CONFIG_HIGH = 331,
    SUPERCOMPLETE_ON_TAB = 151,
    SUPERCOMPLETE_INLINE_PURE_DELETE = 171,
    SUPERCOMPLETE_INLINE_RICH_GHOST_TEXT_INSERTIONS = 218,
    MODEL_CHAT_19821_VARIANTS = 308,
    SUPERCOMPLETE_MAX_CONCURRENT_REQUESTS = 284,
    COMMAND_PROMPT_CACHE_CONFIG = 255,
    CUMULATIVE_PROMPT_CONFIG = 256,
    CUMULATIVE_PROMPT_CASCADE_CONFIG = 279,
    TAB_JUMP_CUMULATIVE_PROMPT_CONFIG = 301,
    COMPLETION_SPEED_SUPERCOMPLETE_CACHE = 207,
    COMPLETION_SPEED_PREDICTIVE_SUPERCOMPLETE = 208,
    COMPLETION_SPEED_TAB_JUMP_CACHE = 209,
    COMPLETION_SPEED_PREDICTIVE_TAB_JUMP = 210,
    COMPLETION_SPEED_BLOCK_TAB_JUMP_ON_PREDICTIVE_SUPERCOMPLETE = 294,
    JETBRAINS_ENABLE_ONBOARDING = 137,
    ENABLE_AUTOCOMPLETE_DURING_INTELLISENSE = 146,
    COMMAND_BOX_ON_TOP = 155,
    CONTEXT_ACTIVE_DOCUMENT_FRACTION = 149,
    CONTEXT_FORCE_LOCAL_CONTEXT = 178,
    CROSS_SELL_EXTENSION_DOWNLOAD_WINDSURF = 220,
    MODEL_LLAMA_3_1_70B_INSTRUCT_LONG_CONTEXT_VARIANTS = 295,
    USE_AUTOCOMPLETE_MODEL_SERVER_SIDE = 163,
    SUPERCOMPLETE_NO_CONTEXT = 165,
    SUPERCOMPLETE_NO_ACTIVE_NODE = 166,
    TAB_JUMP_ENABLED = 168,
    TAB_JUMP_ACCEPT_ENABLED = 169,
    TAB_JUMP_LINE_RADIUS = 177,
    TAB_JUMP_MIN_FILTER_RADIUS = 197,
    TAB_JUMP_ON_ACCEPT_ONLY = 205,
    TAB_JUMP_FILTER_IN_SELECTION = 215,
    TAB_JUMP_MODEL_CONFIG = 237,
    TAB_JUMP_FILTER_NO_OP = 238,
    TAB_JUMP_FILTER_REVERT = 239,
    TAB_JUMP_FILTER_SCORE_THRESHOLD = 240,
    TAB_JUMP_FILTER_WHITESPACE_ONLY = 241,
    TAB_JUMP_FILTER_INSERTION_CAP = 242,
    TAB_JUMP_FILTER_DELETION_CAP = 243,
    TAB_JUMP_PRUNE_RESPONSE = 260,
    TAB_JUMP_PRUNE_MAX_INSERT_DELETE_LINE_DELTA = 261,
    TAB_JUMP_STOP_TOKEN_MIDSTREAM = 317,
    VIEWED_FILE_TRACKER_CONFIG = 211,
    SNAPSHOT_TO_STEP_OPTIONS_OVERRIDE = 305,
    STREAMING_EXTERNAL_COMMAND = 172,
    USE_SPECIAL_EDIT_CODE_BLOCK = 179,
    ENABLE_SUGGESTED_RESPONSES = 187,
    CASCADE_BASE_MODEL_ID = 190,
    CASCADE_PLAN_BASED_CONFIG_OVERRIDE = 266,
    CASCADE_GLOBAL_CONFIG_OVERRIDE = 212,
    CASCADE_BACKGROUND_RESEARCH_CONFIG_OVERRIDE = 193,
    CASCADE_ENFORCE_QUOTA = 204,
    CASCADE_ENABLE_AUTOMATED_MEMORIES = 224,
    CASCADE_MEMORY_CONFIG_OVERRIDE = 314,
    CASCADE_USE_REPLACE_CONTENT_EDIT_TOOL = 228,
    CASCADE_VIEW_FILE_TOOL_CONFIG_OVERRIDE = 258,
    CASCADE_USE_EXPERIMENT_CHECKPOINTER = 247,
    CASCADE_ENABLE_MCP_TOOLS = 245,
    CASCADE_AUTO_FIX_LINTS = 275,
    USE_ANTHROPIC_TOKEN_EFFICIENT_TOOLS_BETA = 296,
    CASCADE_USER_MEMORIES_IN_SYS_PROMPT = 289,
    CASCADE_ENABLE_PROXY_WEB_SERVER = 290,
    COLLAPSE_ASSISTANT_MESSAGES = 312,
    CASCADE_DEFAULT_MODEL_OVERRIDE = 321,
    ENABLE_SMART_COPY = 181,
    ENABLE_COMMIT_MESSAGE_GENERATION = 185,
    SKIP_CONSISTENCY_MANAGER = 194,
    FIREWORKS_ON_DEMAND_DEPLOYMENT = 276,
    API_SERVER_CLIENT_USE_HTTP_2 = 202,
    AUTOCOMPLETE_DEFAULT_DEBOUNCE_MS = 213,
    AUTOCOMPLETE_FAST_DEBOUNCE_MS = 214,
    PROFILING_TELEMETRY_SAMPLE_RATE = 219,
    STREAM_USER_SHELL_COMMANDS = 225,
    API_SERVER_PROMPT_CACHE_REPLICAS = 307,
    API_SERVER_ENABLE_MORE_LOGGING = 272,
    COMMAND_INJECT_USER_MEMORIES = 233,
    AUTOCOMPLETE_HIDDEN_ERROR_REGEX = 234,
    DISABLE_IDE_COMPLETIONS_DEBOUNCE = 278,
    ENABLE_QUICK_ACTIONS = 250,
    QUICK_ACTIONS_WHITELIST_REGEX = 251,
    CASCADE_NEW_MODELS_NUX = 259,
    CASCADE_NEW_WAVE_2_MODELS_NUX = 270,
    SUPERCOMPLETE_FAST_DEBOUNCE = 262,
    SUPERCOMPLETE_REGULAR_DEBOUNCE = 263,
    XML_TOOL_PARSING_MODELS = 268,
    SUPERCOMPLETE_DONT_FILTER_MID_STREAMED = 269,
    ANNOYANCE_MANAGER_MAX_NAVIGATION_RENDERS = 285,
    ANNOYANCE_MANAGER_INLINE_PREVENTION_THRESHOLD_MS = 286,
    ANNOYANCE_MANAGER_INLINE_PREVENTION_MAX_INTENTIONAL_REJECTIONS = 287,
    ANNOYANCE_MANAGER_INLINE_PREVENTION_MAX_AUTO_REJECTIONS = 288,
    USE_CUSTOM_CHARACTER_DIFF = 292,
    FORCE_NON_OPTIMIZED_DIFF = 298,
    CASCADE_WEB_APP_DEPLOYMENTS_ENABLED = 300,
    CASCADE_RECIPES_AT_MENTION_VISIBILITY = 316,
    IMPLICIT_USES_CLIPBOARD = 310,
    DISABLE_SUPERCOMPLETE_PCW = 303,
    BLOCK_TAB_ON_SHOWN_AUTOCOMPLETE = 304,
    CASCADE_WEB_SEARCH_NUX = 311,
    MODEL_NOTIFICATIONS = 319,
    MODEL_SELECTOR_NUX_COPY = 320,
    CASCADE_TOOL_CALL_PRICING_NUX = 322,
    CASCADE_PLUGINS_TAB = 323,
    WAVE_8_RULES_ENABLED = 324,
    WAVE_8_KNOWLEDGE_ENABLED = 325,
    CASCADE_ONBOARDING = 326,
    CASCADE_ONBOARDING_REVERT = 327,
    CASCADE_WINDSURF_BROWSER_TOOLS_ENABLED = 328,
    CASCADE_MODEL_HEADER_WARNING = 329,
    TEST_ONLY = 999
}
/** Devin enum ExperimentSource. */
export declare enum ExperimentSource {
    UNSPECIFIED = 0,
    EXTENSION = 1,
    LANGUAGE_SERVER = 2,
    API_SERVER = 3
}
/** Devin enum Language. */
export declare enum Language {
    UNSPECIFIED = 0,
    C = 1,
    CLOJURE = 2,
    COFFEESCRIPT = 3,
    CPP = 4,
    CSHARP = 5,
    CSS = 6,
    CUDACPP = 7,
    DOCKERFILE = 8,
    GO = 9,
    GROOVY = 10,
    HANDLEBARS = 11,
    HASKELL = 12,
    HCL = 13,
    HTML = 14,
    INI = 15,
    JAVA = 16,
    JAVASCRIPT = 17,
    JSON = 18,
    JULIA = 19,
    KOTLIN = 20,
    LATEX = 21,
    LESS = 22,
    LUA = 23,
    MAKEFILE = 24,
    MARKDOWN = 25,
    OBJECTIVEC = 26,
    OBJECTIVECPP = 27,
    PERL = 28,
    PHP = 29,
    PLAINTEXT = 30,
    PROTOBUF = 31,
    PBTXT = 32,
    PYTHON = 33,
    R = 34,
    RUBY = 35,
    RUST = 36,
    SASS = 37,
    SCALA = 38,
    SCSS = 39,
    SHELL = 40,
    SQL = 41,
    STARLARK = 42,
    SWIFT = 43,
    TSX = 44,
    TYPESCRIPT = 45,
    VISUALBASIC = 46,
    VUE = 47,
    XML = 48,
    XSL = 49,
    YAML = 50,
    SVELTE = 51,
    TOML = 52,
    DART = 53,
    RST = 54,
    OCAML = 55,
    CMAKE = 56,
    PASCAL = 57,
    ELIXIR = 58,
    FSHARP = 59,
    LISP = 60,
    MATLAB = 61,
    POWERSHELL = 62,
    SOLIDITY = 63,
    ADA = 64,
    OCAML_INTERFACE = 65,
    TREE_SITTER_QUERY = 66,
    APL = 67,
    ASSEMBLY = 68,
    COBOL = 69,
    CRYSTAL = 70,
    EMACS_LISP = 71,
    ERLANG = 72,
    FORTRAN = 73,
    FREEFORM = 74,
    GRADLE = 75,
    HACK = 76,
    MAVEN = 77,
    M68KASSEMBLY = 78,
    SAS = 79,
    UNIXASSEMBLY = 80,
    VBA = 81,
    VIMSCRIPT = 82,
    WEBASSEMBLY = 83,
    BLADE = 84,
    ASTRO = 85,
    MUMPS = 86,
    GDSCRIPT = 87,
    NIM = 88,
    PROLOG = 89,
    MARKDOWN_INLINE = 90,
    APEX = 91,
    JUPYTER_NOTEBOOK = 92
}
/** Devin enum Model. */
export declare enum Model {
    UNSPECIFIED = 0,
    EMBED_6591 = 20,
    MODEL_8341 = 33,
    MODEL_8528 = 42,
    MODEL_9024 = 41,
    MODEL_14602 = 112,
    MODEL_15133 = 115,
    MODEL_15302 = 119,
    MODEL_15335 = 121,
    MODEL_15336 = 122,
    MODEL_15931 = 167,
    QUERY_9905 = 48,
    QUERY_11791 = 66,
    CHAT_11120 = 57,
    CHAT_11121 = 58,
    CHAT_12119 = 70,
    CHAT_12121 = 69,
    CHAT_12437 = 74,
    CHAT_12491 = 76,
    CHAT_12623 = 78,
    CHAT_12950 = 79,
    CHAT_12968 = 101,
    CHAT_13404 = 102,
    CHAT_13566 = 103,
    CHAT_13930 = 108,
    CHAT_14255 = 110,
    CHAT_14256 = 111,
    CHAT_14942 = 114,
    CHAT_15305 = 120,
    CHAT_15600 = 123,
    CHAT_16801 = 124,
    CHAT_16718 = 175,
    CHAT_15729 = 168,
    CHAT_16579 = 173,
    CHAT_16579_CRUSOE = 174,
    CHAT_18805 = 181,
    CHAT_18468 = 210,
    CHAT_19484 = 233,
    CHAT_20706 = 235,
    CHAT_21779 = 245,
    CHAT_19040 = 211,
    CHAT_19820 = 229,
    CHAT_19821 = 230,
    CHAT_19821_CRUSOE = 244,
    CHAT_23310 = 269,
    CHAT_28580 = 330,
    CHAT_28581 = 331,
    CHAT_28582 = 332,
    CHAT_28583 = 333,
    CHAT_28584 = 334,
    CHAT_19822 = 231,
    CHAT_22798 = 255,
    CHAT_22799 = 256,
    CHAT_22800 = 257,
    CHAT_23151 = 267,
    CHAT_23152 = 268,
    TAB_ARMADILLO = 500,
    TAB_BASE_1 = 501,
    TAB_EXPERIMENTAL_1 = 502,
    TAB_EXPERIMENTAL_2 = 503,
    TAB_EXPERIMENTAL_3 = 504,
    TAB_EXPERIMENTAL_4 = 505,
    TAB_EXPERIMENTAL_5 = 506,
    TAB_EXPERIMENTAL_6 = 507,
    TAB_EXPERIMENTAL_7 = 508,
    TAB_EXPERIMENTAL_8 = 509,
    TAB_EXPERIMENTAL_9 = 510,
    TAB_EXPERIMENTAL_10 = 511,
    CASCADE_22893 = 270,
    CASCADE_20064 = 225,
    CASCADE_20065 = 236,
    CASCADE_20066 = 237,
    CASCADE_20067 = 238,
    CASCADE_20068 = 239,
    CASCADE_20069 = 240,
    CASCADE_20070 = 250,
    CASCADE_20071 = 251,
    CASCADE_20072 = 252,
    CASCADE_20073 = 253,
    CASCADE_20074 = 254,
    CASCADE_20075 = 307,
    CASCADE_20076 = 308,
    CASCADE_20077 = 309,
    CASCADE_20078 = 310,
    CASCADE_20079 = 311,
    CASCADE_20080 = 297,
    CASCADE_20081 = 298,
    CASCADE_20082 = 299,
    CASCADE_20083 = 300,
    CASCADE_20084 = 301,
    CASCADE_20085 = 302,
    CASCADE_20086 = 303,
    CASCADE_20087 = 304,
    CASCADE_20088 = 305,
    CASCADE_20089 = 306,
    DEEPSEEK_V3_INTERNAL = 247,
    DEEPSEEK_V3_0324_INTERNAL = 248,
    DEEPSEEK_R1_INTERNAL = 249,
    ANTHROPIC_WINDSURF_RESEARCH = 241,
    ANTHROPIC_WINDSURF_RESEARCH_THINKING = 242,
    DRAFT_11408 = 65,
    DRAFT_CHAT_11883 = 67,
    DRAFT_CHAT_12196 = 72,
    DRAFT_CHAT_12413 = 73,
    DRAFT_CHAT_13175 = 104,
    DRAFT_CHAT_19823 = 232,
    DRAFT_CHAT_20707 = 243,
    DRAFT_CHAT_22801 = 258,
    DRAFT_CHAT_23508 = 273,
    DRAFT_CASCADE_23672 = 274,
    CHAT_3_5_TURBO = 28,
    CHAT_GPT_4 = 30,
    CHAT_GPT_4_1106_PREVIEW = 37,
    TEXT_EMBEDDING_OPENAI_ADA = 91,
    TEXT_EMBEDDING_OPENAI_3_SMALL = 163,
    TEXT_EMBEDDING_OPENAI_3_LARGE = 164,
    CHAT_GPT_4O_2024_05_13 = 71,
    CHAT_GPT_4O_2024_08_06 = 109,
    CHAT_GPT_4O_MINI_2024_07_18 = 113,
    CHAT_GPT_4_1_2025_04_14 = 259,
    CHAT_GPT_4_1_MINI_2025_04_14 = 260,
    CHAT_GPT_4_1_NANO_2025_04_14 = 261,
    CHAT_O1_PREVIEW = 117,
    CHAT_O1_MINI = 118,
    CHAT_O1 = 170,
    CHAT_O3_MINI = 207,
    CHAT_O3_MINI_LOW = 213,
    CHAT_O3_MINI_HIGH = 214,
    CHAT_O3 = 218,
    CHAT_O3_LOW = 262,
    CHAT_O3_HIGH = 263,
    CHAT_O4_MINI = 264,
    CHAT_O4_MINI_LOW = 265,
    CHAT_O4_MINI_HIGH = 266,
    CHAT_GPT_4_5 = 228,
    CODEX_MINI_LATEST = 287,
    CODEX_MINI_LATEST_LOW = 288,
    CODEX_MINI_LATEST_HIGH = 289,
    O3_PRO_2025_06_10 = 294,
    O3_PRO_2025_06_10_LOW = 295,
    O3_PRO_2025_06_10_HIGH = 296,
    GPT_OSS_120B = 326,
    GPT_5_NANO = 337,
    CHAT_GPT_5_MINIMAL = 338,
    CHAT_GPT_5_LOW = 339,
    CHAT_GPT_5 = 340,
    CHAT_GPT_5_HIGH = 341,
    CHAT_GPT_5_CODEX = 346,
    GPT_5_1_CODEX_MINI_LOW = 385,
    GPT_5_1_CODEX_MINI_MEDIUM = 386,
    GPT_5_1_CODEX_MINI_HIGH = 387,
    GPT_5_1_CODEX_LOW = 388,
    GPT_5_1_CODEX_MEDIUM = 389,
    GPT_5_1_CODEX_HIGH = 390,
    GPT_5_1_CODEX_MAX_LOW = 395,
    GPT_5_1_CODEX_MAX_MEDIUM = 396,
    GPT_5_1_CODEX_MAX_HIGH = 397,
    GOOGLE_GEMINI_1_0_PRO = 61,
    GOOGLE_GEMINI_1_5_PRO = 62,
    GOOGLE_GEMINI_EXP_1206 = 183,
    GOOGLE_GEMINI_2_0_FLASH = 184,
    GOOGLE_GEMINI_2_5_PRO = 246,
    GOOGLE_GEMINI_2_5_FLASH_PREVIEW_04_17 = 272,
    GOOGLE_GEMINI_2_5_FLASH_PREVIEW_05_20 = 275,
    GOOGLE_GEMINI_2_5_FLASH_PREVIEW_05_20_THINKING = 276,
    GOOGLE_GEMINI_2_5_FLASH = 312,
    GOOGLE_GEMINI_2_5_FLASH_THINKING = 313,
    GOOGLE_GEMINI_2_5_FLASH_LITE = 343,
    GOOGLE_GEMINI_3_0_PRO_LOW = 378,
    GOOGLE_GEMINI_3_0_PRO_HIGH = 379,
    GOOGLE_GEMINI_3_0_PRO_MINIMAL = 411,
    GOOGLE_GEMINI_3_0_PRO_MEDIUM = 412,
    GOOGLE_GEMINI_3_0_FLASH_MINIMAL = 413,
    GOOGLE_GEMINI_3_0_FLASH_LOW = 414,
    GOOGLE_GEMINI_3_0_FLASH_MEDIUM = 415,
    GOOGLE_GEMINI_3_0_FLASH_HIGH = 416,
    CLAUDE_3_OPUS_20240229 = 63,
    CLAUDE_3_SONNET_20240229 = 64,
    CLAUDE_3_HAIKU_20240307 = 172,
    CLAUDE_3_5_HAIKU_20241022 = 171,
    CLAUDE_3_5_SONNET_20240620 = 80,
    CLAUDE_3_5_SONNET_20241022 = 166,
    CLAUDE_3_7_SONNET_20250219 = 226,
    CLAUDE_3_7_SONNET_20250219_THINKING = 227,
    CLAUDE_3_5_SONNET_BYOK = 284,
    CLAUDE_3_7_SONNET_BYOK = 285,
    CLAUDE_3_7_SONNET_OPEN_ROUTER_BYOK = 319,
    CLAUDE_3_7_SONNET_THINKING_BYOK = 286,
    CLAUDE_3_7_SONNET_THINKING_OPEN_ROUTER_BYOK = 320,
    CLAUDE_4_OPUS_BYOK = 277,
    CLAUDE_4_OPUS_THINKING_BYOK = 278,
    CLAUDE_4_OPUS = 290,
    CLAUDE_4_OPUS_THINKING = 291,
    CLAUDE_4_SONNET_BYOK = 279,
    CLAUDE_4_SONNET_OPEN_ROUTER_BYOK = 321,
    CLAUDE_4_SONNET_THINKING_BYOK = 280,
    CLAUDE_4_SONNET_THINKING_OPEN_ROUTER_BYOK = 322,
    CLAUDE_4_SONNET = 281,
    CLAUDE_4_SONNET_THINKING = 282,
    CLAUDE_4_1_OPUS = 328,
    CLAUDE_4_1_OPUS_THINKING = 329,
    CLAUDE_4_5_SONNET = 353,
    CLAUDE_4_5_SONNET_THINKING = 354,
    CLAUDE_4_5_SONNET_1M = 370,
    CLAUDE_4_5_SONNET_THINKING_1M = 371,
    CLAUDE_4_5_OPUS = 391,
    CLAUDE_4_5_OPUS_THINKING = 392,
    CLAUDE_4_SONNET_DATABRICKS = 292,
    CLAUDE_4_SONNET_THINKING_DATABRICKS = 293,
    TOGETHERAI_TEXT_EMBEDDING_M2_BERT = 81,
    TOGETHERAI_LLAMA_3_1_8B_INSTRUCT = 165,
    HUGGING_FACE_TEXT_EMBEDDING_M2_BERT = 82,
    HUGGING_FACE_TEXT_EMBEDDING_UAE_CODE = 83,
    HUGGING_FACE_TEXT_EMBEDDING_BGE = 84,
    HUGGING_FACE_TEXT_EMBEDDING_BLADE = 85,
    HUGGING_FACE_TEXT_EMBEDDING_ARCTIC_LARGE = 86,
    HUGGING_FACE_TEXT_EMBEDDING_E5_BASE = 87,
    HUGGING_FACE_TEXT_EMBEDDING_MXBAI = 88,
    LLAMA_3_1_8B_INSTRUCT = 106,
    LLAMA_3_1_70B_INSTRUCT = 107,
    LLAMA_3_1_405B_INSTRUCT = 105,
    LLAMA_3_3_70B_INSTRUCT = 208,
    LLAMA_3_3_70B_INSTRUCT_R1 = 209,
    LLAMA_3_1_70B_INSTRUCT_LONG_CONTEXT = 116,
    LLAMA_3_1_8B_HERMES_3 = 176,
    LLAMA_3_1_70B_HERMES_3 = 177,
    QWEN_2_5_7B_INSTRUCT = 178,
    QWEN_2_5_32B_INSTRUCT = 179,
    QWEN_2_5_72B_INSTRUCT = 180,
    QWEN_2_5_32B_INSTRUCT_R1 = 224,
    QWEN_3_235B_INSTRUCT = 324,
    QWEN_3_CODER_480B_INSTRUCT = 325,
    QWEN_3_CODER_480B_INSTRUCT_FAST = 327,
    GLM_4_5 = 342,
    GLM_4_5_FAST = 352,
    GLM_4_6 = 356,
    GLM_4_6_FAST = 357,
    GLM_4_7 = 417,
    GLM_4_7_FAST = 418,
    SWE_1_5 = 359,
    SWE_1_5_REDIRECT = 361,
    SWE_1_5_THINKING = 369,
    SWE_1_5_SLOW = 377,
    SWE_1_6 = 420,
    SWE_1_6_FAST = 421,
    CODEMAP_SMALL = 358,
    CODEMAP_MEDIUM = 360,
    CODEMAP_SMART = 362,
    COGNITION_INSTANT_CONTEXT = 355,
    LLAMA_FT_DEEPWIKI_ARTICLE = 335,
    LLAMA_FT_DEEPWIKI_HOVER = 336,
    LLAMA_FT_LIFEGUARD = 398,
    COGNITION_LIFEGUARD = 410,
    NOMIC_TEXT_EMBEDDING_V1 = 89,
    NOMIC_TEXT_EMBEDDING_V1_5 = 90,
    MISTRAL_7B = 77,
    SALESFORCE_EMBEDDING_2R = 99,
    CUSTOM_VLLM = 182,
    TEI_BGE_M3 = 92,
    TEI_NOMIC_EMBED_TEXT_V1 = 93,
    TEI_INTFLOAT_E5_LARGE_INSTRUCT = 94,
    TEI_SNOWFLAKE_ARCTIC_EMBED_L = 95,
    TEI_UAE_CODE_LARGE_V1 = 96,
    TEI_B1ADE = 97,
    TEI_WHEREISAI_UAE_LARGE_V1 = 98,
    TEI_WHEREISAI_UAE_CODE_LARGE_V1 = 100,
    OPENAI_COMPATIBLE = 200,
    ANTHROPIC_COMPATIBLE = 201,
    VERTEX_COMPATIBLE = 202,
    BEDROCK_COMPATIBLE = 203,
    AZURE_COMPATIBLE = 204,
    DEEPSEEK_V3 = 205,
    DEEPSEEK_R1 = 206,
    DEEPSEEK_R1_SLOW = 215,
    DEEPSEEK_R1_FAST = 216,
    KIMI_K2 = 323,
    MINIMAX_M2 = 368,
    MINIMAX_M2_1 = 419,
    DEEPSEEK_V3_2 = 409,
    KIMI_K2_THINKING = 394,
    CUSTOM_OPEN_ROUTER = 185,
    XAI_GROK_2 = 212,
    XAI_GROK_3 = 217,
    XAI_GROK_3_MINI_REASONING = 234,
    XAI_GROK_CODE_FAST = 345,
    PRIVATE_1 = 219,
    PRIVATE_2 = 220,
    PRIVATE_3 = 221,
    PRIVATE_4 = 222,
    PRIVATE_5 = 223,
    PRIVATE_6 = 314,
    PRIVATE_7 = 315,
    PRIVATE_8 = 316,
    PRIVATE_9 = 317,
    PRIVATE_10 = 318,
    PRIVATE_11 = 347,
    PRIVATE_12 = 348,
    PRIVATE_13 = 349,
    PRIVATE_14 = 350,
    PRIVATE_15 = 351,
    PRIVATE_16 = 363,
    PRIVATE_17 = 364,
    PRIVATE_18 = 365,
    PRIVATE_19 = 366,
    PRIVATE_20 = 367,
    PRIVATE_21 = 372,
    PRIVATE_22 = 373,
    PRIVATE_23 = 374,
    PRIVATE_24 = 375,
    PRIVATE_25 = 376,
    PRIVATE_26 = 380,
    PRIVATE_27 = 381,
    PRIVATE_28 = 382,
    PRIVATE_29 = 383,
    PRIVATE_30 = 384,
    GPT_5_2_NONE = 399,
    GPT_5_2_LOW = 400,
    GPT_5_2_MEDIUM = 401,
    GPT_5_2_HIGH = 402,
    GPT_5_2_XHIGH = 403,
    GPT_5_2_NONE_PRIORITY = 404,
    GPT_5_2_LOW_PRIORITY = 405,
    GPT_5_2_MEDIUM_PRIORITY = 406,
    GPT_5_2_HIGH_PRIORITY = 407,
    GPT_5_2_XHIGH_PRIORITY = 408,
    GPT_5_2_CODEX_LOW = 422,
    GPT_5_2_CODEX_MEDIUM = 423,
    GPT_5_2_CODEX_HIGH = 424,
    GPT_5_2_CODEX_XHIGH = 425,
    GPT_5_2_CODEX_LOW_PRIORITY = 426,
    GPT_5_2_CODEX_MEDIUM_PRIORITY = 427,
    GPT_5_2_CODEX_HIGH_PRIORITY = 428,
    GPT_5_2_CODEX_XHIGH_PRIORITY = 429,
    SGLANG_ROLLOUT = 600
}
/** Devin enum ModelAlias. */
export declare enum ModelAlias {
    UNSPECIFIED = 0,
    CASCADE_BASE = 1,
    VISTA = 3,
    SHAMU = 4,
    SWE_1 = 5,
    SWE_1_LITE = 6,
    AUTO = 7
}
/** Devin enum ModelCostTier. */
export declare enum ModelCostTier {
    UNSPECIFIED = 0,
    LOW = 1,
    MEDIUM = 2,
    HIGH = 3,
    FREE = 4
}
/** Devin enum ModelDimensionKind. */
export declare enum ModelDimensionKind {
    UNSPECIFIED = 0,
    COST = 1,
    COST_FUZZY = 2
}
/** Devin enum ModelPricingType. */
export declare enum ModelPricingType {
    UNSPECIFIED = 0,
    STATIC_CREDIT = 1,
    API = 2,
    BYOK = 3,
    ACU_TOKEN = 4,
    ACU_CREDIT = 5
}
/** Devin enum ModelProvider. */
export declare enum ModelProvider {
    UNSPECIFIED = 0,
    WINDSURF = 1,
    OPENAI = 2,
    ANTHROPIC = 3,
    GOOGLE = 4,
    XAI = 5,
    DEEPSEEK = 6,
    MOONSHOT = 7,
    QWEN = 8,
    ZAI = 9,
    MINIMAX = 10
}
/** Devin enum ModelType. */
export declare enum ModelType {
    UNSPECIFIED = 0,
    COMPLETION = 1,
    CHAT = 2,
    EMBED = 3,
    QUERY = 4
}
/** Devin enum PromptAnnotationKind. */
export declare enum PromptAnnotationKind {
    UNSPECIFIED = 0,
    COPY = 1,
    PROMPT_CACHE = 2
}
/** Devin enum PromptTemplaterType. */
export declare enum PromptTemplaterType {
    UNSPECIFIED = 0,
    LLAMA_2 = 1,
    LLAMA_3 = 2,
    CHATML = 3,
    CHAT_TRANSCRIPT = 4,
    DEEPSEEK_V2 = 5,
    DEEPSEEK_V3 = 6,
    KIMI = 7
}
/** Devin enum ProviderSource. */
export declare enum ProviderSource {
    UNSPECIFIED = 0,
    AUTOCOMPLETE = 1,
    CHAT = 2,
    COMMAND_GENERATE = 4,
    COMMAND_EDIT = 5,
    SUPERCOMPLETE = 6,
    COMMAND_PLAN = 7,
    QUERY = 8,
    FAST_APPLY = 9,
    COMMAND_TERMINAL = 10,
    TAB_JUMP = 11,
    CASCADE = 12
}
/** Devin enum StopReason. */
export declare enum StopReason {
    UNSPECIFIED = 0,
    INCOMPLETE = 1,
    STOP_PATTERN = 2,
    MAX_TOKENS = 3,
    MIN_LOG_PROB = 4,
    MAX_NEWLINES = 5,
    EXIT_SCOPE = 6,
    NONFINITE_LOGIT_OR_PROB = 7,
    FIRST_NON_WHITESPACE_LINE = 8,
    PARTIAL = 9,
    FUNCTION_CALL = 10,
    CONTENT_FILTER = 11,
    NON_INSERTION = 12,
    ERROR = 13
}
/** Devin enum TeamsTier. */
export declare enum TeamsTier {
    UNSPECIFIED = 0,
    TEAMS = 1,
    PRO = 2,
    TRIAL = 9,
    ENTERPRISE_SAAS = 3,
    HYBRID = 4,
    ENTERPRISE_SELF_HOSTED = 5,
    ENTERPRISE_SELF_SERVE = 10,
    DEVIN_ENTERPRISE = 12,
    DEVIN_TEAMS = 14,
    DEVIN_TEAMS_V2 = 15,
    DEVIN_PRO = 16,
    DEVIN_MAX = 17,
    MAX = 18,
    DEVIN_FREE = 19,
    DEVIN_TRIAL = 20,
    WAITLIST_PRO = 6,
    TEAMS_ULTIMATE = 7,
    PRO_ULTIMATE = 8,
    ENTERPRISE_SAAS_POOLED = 11
}
/** Devin enum ToolFormatterType. */
export declare enum ToolFormatterType {
    UNSPECIFIED = 0,
    LLAMA_3 = 1,
    HERMES = 2,
    XML = 3,
    CHAT_TRANSCRIPT = 4,
    KIMI = 5,
    QWENCODER = 6,
    SUPERCOMPLETE = 7
}
/** Devin message exa.codeium_common_pb.AnthropicInferenceConfig. */
export interface AnthropicInferenceConfig extends ProtoMessage {
    thinking: boolean;
    effort: string;
    fastMode: boolean;
    context1m: boolean;
}
export declare const AnthropicInferenceConfigSchema: MessageCodec<AnthropicInferenceConfig>;
/** Devin message exa.codeium_common_pb.ArenaConfig. */
export interface ArenaConfig extends ProtoMessage {
    tokensPerSecond: number;
}
export declare const ArenaConfigSchema: MessageCodec<ArenaConfig>;
/** Devin message exa.chat_pb.ChatMessagePrompt. */
export interface ChatMessagePrompt extends ProtoMessage {
    messageId: string;
    source: ChatMessageSource;
    prompt: string;
    numTokens: number;
    safeForCodeTelemetry: boolean;
    toolCalls: ChatToolCall[];
    toolCallId: string;
    promptCacheOptions?: PromptCacheOptions;
    toolResultIsError: boolean;
    images: ImageData[];
    thinking: string;
    signature: string;
    thinkingRedacted: boolean;
    promptAnnotationRanges: PromptAnnotationRange[];
    outputId: string;
    thinkingId: string;
    geminiThoughtSignature: Uint8Array;
    signatureType: string;
    phase: string;
}
export declare const ChatMessagePromptSchema: MessageCodec<ChatMessagePrompt>;
/** Devin message exa.codeium_common_pb.ChatToolCall. */
export interface ChatToolCall extends ProtoMessage {
    id: string;
    name: string;
    argumentsJson: string;
    invalidJsonStr: string;
    invalidJsonErr: string;
    isCustomToolCall: boolean;
}
export declare const ChatToolCallSchema: MessageCodec<ChatToolCall>;
/** Devin message exa.chat_pb.ChatToolChoice. */
export interface ChatToolChoice extends ProtoMessage {
    choice: {
        case: undefined;
        value?: undefined;
    } | {
        case: "optionName";
        value: string;
    } | {
        case: "toolName";
        value: string;
    };
}
export declare const ChatToolChoiceSchema: MessageCodec<ChatToolChoice>;
/** Devin message exa.chat_pb.ChatToolDefinition. */
export interface ChatToolDefinition extends ProtoMessage {
    name: string;
    description: string;
    jsonSchemaString: string;
    attributionFieldNames: string[];
    serverName: string;
    readOnlyHint?: boolean;
    computerUseConfig?: ComputerUseToolConfig;
    isCustomTool?: boolean;
    customToolGrammar?: string;
    customToolGrammarSyntax?: string;
    strict: boolean;
}
export declare const ChatToolDefinitionSchema: MessageCodec<ChatToolDefinition>;
/** Devin message exa.codeium_common_pb.ClientModelConfig. */
export interface ClientModelConfig extends ProtoMessage {
    label: string;
    modelOrAlias?: ModelOrAlias;
    modelUid: string;
    creditMultiplier: number;
    pricingType: ModelPricingType;
    disabled: boolean;
    supportsImages: boolean;
    supportsLegacy: boolean;
    isPremium: boolean;
    betaWarningMessage: string;
    isBeta: boolean;
    provider: ModelProvider;
    isRecommended: boolean;
    allowedTiers: TeamsTier[];
    apiProvider: APIProvider;
    isNew: boolean;
    partialRollout: boolean;
    rolloutFraction: number;
    maxTokens: number;
    promoStatus?: PromoStatus;
    isCapacityLimited: boolean;
    fastStatus?: FastStatus;
    modelInfo?: ModelInfo;
    modelCostTier: ModelCostTier;
    description?: string;
    smartFriendModelUid?: string;
    modelFamilyMetadata?: ModelFamilyMetadata;
    isDefaultModelInFamily: boolean;
    modelDimensions: ModelDimension[];
    disabledReason?: ModelDisabledReason;
}
export declare const ClientModelConfigSchema: MessageCodec<ClientModelConfig>;
/** Devin message exa.codeium_common_pb.CompletionConfiguration. */
export interface CompletionConfiguration extends ProtoMessage {
    numCompletions: bigint;
    maxTokens: bigint;
    maxNewlines: bigint;
    minLogProbability: number;
    temperature: number;
    firstTemperature: number;
    topK: bigint;
    topP: number;
    stopPatterns: string[];
    seed: bigint;
    fimEotProbThreshold: number;
    useFimEotThreshold: boolean;
    doNotScoreStopTokens: boolean;
    sqrtLenNormalizedLogProbScore: boolean;
    lastMessageIsPartial: boolean;
    returnLogprob: boolean;
    serviceTier: string;
}
export declare const CompletionConfigurationSchema: MessageCodec<CompletionConfiguration>;
/** Devin message exa.codeium_common_pb.CompletionProfile. */
export interface CompletionProfile extends ProtoMessage {
    modelProfile?: SingleModelCompletionProfile;
    draftModelProfile?: SingleModelCompletionProfile;
    timeToFirstPrefillPass: number;
    timeToFirstToken: number;
    totalCompletionTime: number;
    modelUsage?: ModelUsageStats;
}
export declare const CompletionProfileSchema: MessageCodec<CompletionProfile>;
/** Devin message exa.chat_pb.ComputerUseToolConfig. */
export interface ComputerUseToolConfig extends ProtoMessage {
    displayWidthPx: number;
    displayHeightPx: number;
    displayNumber: number;
}
export declare const ComputerUseToolConfigSchema: MessageCodec<ComputerUseToolConfig>;
/** Devin message exa.cortex_pb.CortexTrajectoryReference. */
export interface CortexTrajectoryReference extends ProtoMessage {
    trajectoryId: string;
    trajectoryType: CortexTrajectoryType;
    stepIndex: number;
    stepType: CortexStepType;
    forceBillable: boolean;
}
export declare const CortexTrajectoryReferenceSchema: MessageCodec<CortexTrajectoryReference>;
/** Devin message exa.codeium_common_pb.DefaultOverrideModelConfig. */
export interface DefaultOverrideModelConfig extends ProtoMessage {
    modelOrAliasDeprecated?: ModelOrAlias;
    modelUid: string;
    versionId: string;
}
export declare const DefaultOverrideModelConfigSchema: MessageCodec<DefaultOverrideModelConfig>;
/** Devin message exa.codeium_common_pb.ExperimentConfig. */
export interface ExperimentConfig extends ProtoMessage {
    experiments: ExperimentWithVariant[];
    forceEnableExperiments: ExperimentKey[];
    forceDisableExperiments: ExperimentKey[];
    forceEnableExperimentsWithVariants: ExperimentWithVariant[];
    forceEnableExperimentStrings: string[];
    forceDisableExperimentStrings: string[];
    devMode: boolean;
}
export declare const ExperimentConfigSchema: MessageCodec<ExperimentConfig>;
/** Devin message exa.codeium_common_pb.ExperimentWithVariant. */
export interface ExperimentWithVariant extends ProtoMessage {
    key: ExperimentKey;
    keyString: string;
    disabled: boolean;
    source: ExperimentSource;
    payload: {
        case: undefined;
        value?: undefined;
    } | {
        case: "string";
        value: string;
    } | {
        case: "json";
        value: string;
    } | {
        case: "csv";
        value: string;
    };
}
export declare const ExperimentWithVariantSchema: MessageCodec<ExperimentWithVariant>;
/** Devin message exa.codeium_common_pb.FastStatus. */
export interface FastStatus extends ProtoMessage {
    isActive: boolean;
    tooltip: string;
}
export declare const FastStatusSchema: MessageCodec<FastStatus>;
/** Devin message exa.api_server_pb.GetChatMessageRequest. */
export interface GetChatMessageRequest extends ProtoMessage {
    metadata?: Metadata;
    prompt: string;
    chatMessagePrompts: ChatMessagePrompt[];
    useInternalChatModel: boolean;
    internalChatModel: Model;
    chatModelUid: string;
    requestType: ChatMessageRequestType;
    configuration?: CompletionConfiguration;
    experimentConfig?: ExperimentConfig;
    tools: ChatToolDefinition[];
    disableParallelToolCalls: boolean;
    toolChoice?: ChatToolChoice;
    systemPromptCacheOptions?: PromptCacheOptions;
    chatModelName: string;
    trajectoryReference?: CortexTrajectoryReference;
    cascadeId: string;
    promptId: string;
    providerSource: ProviderSource;
    language: Language;
    plannerMode: ConversationalPlannerMode;
    executionId: string;
    arenaConvergeCount?: number;
    arenaAssignmentJwt?: string;
    modelAssignmentJwt?: string;
}
export declare const GetChatMessageRequestSchema: MessageCodec<GetChatMessageRequest>;
/** Devin message exa.api_server_pb.GetChatMessageResponse. */
export interface GetChatMessageResponse extends ProtoMessage {
    messageId: string;
    timestamp?: Timestamp;
    deltaText: string;
    deltaTokens: number;
    stopReason: StopReason;
    deltaToolCalls: ChatToolCall[];
    usage?: ModelUsageStats;
    creditCost: number;
    redact: boolean;
    deltaThinking: string;
    deltaSignature: string;
    thinkingRedacted: boolean;
    latency: number;
    completionProfile?: CompletionProfile;
    outputId: string;
    thinkingId: string;
    requestId: string;
    committedCreditCost: number;
    prompt: string;
    geminiThoughtSignature: Uint8Array;
    deltaSignatureType: string;
    committedAcuCost: number;
    actualModelUid?: string;
    arenaInvocationCapReached: boolean;
    phase: string;
    committedQuotaCostBasisPoints?: bigint;
    committedOverageCostCents?: bigint;
    responseDimensionGroups: ResponseDimensionGroup[];
}
export declare const GetChatMessageResponseSchema: MessageCodec<GetChatMessageResponse>;
/** Devin message exa.api_server_pb.GetCliModelConfigsRequest. */
export interface GetCliModelConfigsRequest extends ProtoMessage {
    metadata?: Metadata;
}
export declare const GetCliModelConfigsRequestSchema: MessageCodec<GetCliModelConfigsRequest>;
/** Devin message exa.api_server_pb.GetCliModelConfigsResponse. */
export interface GetCliModelConfigsResponse extends ProtoMessage {
    clientModelConfigs: ClientModelConfig[];
    defaultOverrideModelConfig?: DefaultOverrideModelConfig;
}
export declare const GetCliModelConfigsResponseSchema: MessageCodec<GetCliModelConfigsResponse>;
/** Devin message exa.auth_pb.GetUserJwtRequest. */
export interface GetUserJwtRequest extends ProtoMessage {
    metadata?: Metadata;
}
export declare const GetUserJwtRequestSchema: MessageCodec<GetUserJwtRequest>;
/** Devin message exa.auth_pb.GetUserJwtResponse. */
export interface GetUserJwtResponse extends ProtoMessage {
    userJwt: string;
    customApiServerUrl: string;
}
export declare const GetUserJwtResponseSchema: MessageCodec<GetUserJwtResponse>;
/** Devin message exa.codeium_common_pb.GoogleInferenceConfig. */
export interface GoogleInferenceConfig extends ProtoMessage {
    reasoningEffort: string;
}
export declare const GoogleInferenceConfigSchema: MessageCodec<GoogleInferenceConfig>;
/** Devin message exa.codeium_common_pb.ImageData. */
export interface ImageData extends ProtoMessage {
    base64Data: string;
    mimeType: string;
    caption: string;
}
export declare const ImageDataSchema: MessageCodec<ImageData>;
/** Devin message exa.codeium_common_pb.InferenceConfig. */
export interface InferenceConfig extends ProtoMessage {
    config: {
        case: undefined;
        value?: undefined;
    } | {
        case: "openai";
        value: OpenAIInferenceConfig;
    } | {
        case: "google";
        value: GoogleInferenceConfig;
    } | {
        case: "anthropic";
        value: AnthropicInferenceConfig;
    };
}
export declare const InferenceConfigSchema: MessageCodec<InferenceConfig>;
/** Devin message exa.codeium_common_pb.Metadata. */
export interface Metadata extends ProtoMessage {
    ideName: string;
    ideVersion: string;
    ideType: string;
    extensionName: string;
    extensionVersion: string;
    apiKey: string;
    locale: string;
    os: string;
    hardware: string;
    disableTelemetry: boolean;
    sessionId: string;
    lsTimestamp?: Timestamp;
    requestId: bigint;
    sourceAddress: string;
    userAgent: string;
    url: string;
    authSource: AuthSource;
    extensionPath: string;
    userId: string;
    userJwt: string;
    forceTeamId: string;
    deviceFingerprint: string;
    triggerId: string;
    planName: string;
    id: string;
    impersonateTier: string;
    supportedModelDisplays: DisplayOption[];
    f: string;
    teamId: string;
}
export declare const MetadataSchema: MessageCodec<Metadata>;
/** Devin message exa.codeium_common_pb.ModelDimension. */
export interface ModelDimension extends ProtoMessage {
    label: string;
    value: number;
    denominator: string;
    minRange: number;
    maxRange: number;
    kind: ModelDimensionKind;
    info?: string;
}
export declare const ModelDimensionSchema: MessageCodec<ModelDimension>;
/** Devin message exa.codeium_common_pb.ModelDisabledReason. */
export interface ModelDisabledReason extends ProtoMessage {
    shortReason: string;
    description?: string;
    link?: string;
}
export declare const ModelDisabledReasonSchema: MessageCodec<ModelDisabledReason>;
/** Devin message exa.codeium_common_pb.ModelFamilyMetadata. */
export interface ModelFamilyMetadata extends ProtoMessage {
    modelFamilyLabel: string;
    entries: ModelFamilyMetadataEntry[];
    isDefaultModelInFamily: boolean;
}
export declare const ModelFamilyMetadataSchema: MessageCodec<ModelFamilyMetadata>;
/** Devin message exa.codeium_common_pb.ModelFamilyMetadataEntry. */
export interface ModelFamilyMetadataEntry extends ProtoMessage {
    key: string;
    value?: ModelFamilyMetadataValue;
}
export declare const ModelFamilyMetadataEntrySchema: MessageCodec<ModelFamilyMetadataEntry>;
/** Devin message exa.codeium_common_pb.ModelFamilyMetadataValue. */
export interface ModelFamilyMetadataValue extends ProtoMessage {
    order: number;
    name: string;
}
export declare const ModelFamilyMetadataValueSchema: MessageCodec<ModelFamilyMetadataValue>;
/** Devin message exa.codeium_common_pb.ModelFeatures. */
export interface ModelFeatures extends ProtoMessage {
    supportsContextTokens: boolean;
    requiresInstructTags: boolean;
    requiresFimContext: boolean;
    requiresContextSnippetPrefix: boolean;
    requiresContextRelevanceTags: boolean;
    requiresLlama3Tokens: boolean;
    zeroShotCapable: boolean;
    requiresAutocompleteAsCommand: boolean;
    supportsCursorAwareSupercomplete: boolean;
    supportsImages: boolean;
    supportsImageCaptions: boolean;
    supportsToolCalls: boolean;
    supportsParallelToolCalls: boolean;
    supportsCumulativeContext: boolean;
    tabJumpPrintLineRange: boolean;
    supportsThinking: boolean;
    interleaveThinking: boolean;
    preserveThinking: boolean;
    supportsEstimateTokenCounter: boolean;
    addCursorToFindReplaceTarget: boolean;
    supportsTabJumpUseWholeDocument: boolean;
    requiresSupercompleteClean: boolean;
    tabRouteToModal: boolean;
    supportsRejectionContext: boolean;
}
export declare const ModelFeaturesSchema: MessageCodec<ModelFeatures>;
/** Devin message exa.codeium_common_pb.ModelInfo. */
export interface ModelInfo extends ProtoMessage {
    modelId: Model;
    modelUid: string;
    isInternal: boolean;
    modelType: ModelType;
    maxTokens: number;
    tokenizerType: string;
    modelFeatures?: ModelFeatures;
    apiProvider: APIProvider;
    modelName: string;
    supportsContext: boolean;
    embedDim: number;
    baseUrl: string;
    chatModelName: string;
    maxOutputTokens: number;
    promptTemplaterType: PromptTemplaterType;
    toolFormatterType: ToolFormatterType;
    inferenceServerUrl: string;
    harnessUids: string[];
    arenaConfig?: ArenaConfig;
    displayOption: DisplayOption;
    modelFamilyUid: string;
    inferenceConfig?: InferenceConfig;
    isModelRouter: boolean;
}
export declare const ModelInfoSchema: MessageCodec<ModelInfo>;
/** Devin message exa.codeium_common_pb.ModelOrAlias. */
export interface ModelOrAlias extends ProtoMessage {
    choice: {
        case: undefined;
        value?: undefined;
    } | {
        case: "model";
        value: Model;
    } | {
        case: "alias";
        value: ModelAlias;
    } | {
        case: "modelUid";
        value: string;
    };
}
export declare const ModelOrAliasSchema: MessageCodec<ModelOrAlias>;
/** Devin message exa.codeium_common_pb.ModelUsageStats. */
export interface ModelUsageStats extends ProtoMessage {
    modelDeprecated: Model;
    modelUid: string;
    billingModelUid: string;
    requestedModelUid: string;
    inputTokens: bigint;
    outputTokens: bigint;
    cacheWriteTokens: bigint;
    cacheReadTokens: bigint;
    apiProvider: APIProvider;
    messageId: string;
    responseHeader: Record<string, string>;
}
export declare const ModelUsageStatsSchema: MessageCodec<ModelUsageStats>;
/** Devin message exa.codeium_common_pb.OpenAIInferenceConfig. */
export interface OpenAIInferenceConfig extends ProtoMessage {
    reasoningEffort: string;
    serviceTier: string;
    extendedPromptCacheRetention: boolean;
}
export declare const OpenAIInferenceConfigSchema: MessageCodec<OpenAIInferenceConfig>;
/** Devin message exa.codeium_common_pb.PromoStatus. */
export interface PromoStatus extends ProtoMessage {
    isActive: boolean;
    endDate?: Timestamp;
    label: string;
}
export declare const PromoStatusSchema: MessageCodec<PromoStatus>;
/** Devin message exa.codeium_common_pb.PromptAnnotationRange. */
export interface PromptAnnotationRange extends ProtoMessage {
    kind: PromptAnnotationKind;
    byteOffsetStart: bigint;
    byteOffsetEnd: bigint;
    suffix: string;
}
export declare const PromptAnnotationRangeSchema: MessageCodec<PromptAnnotationRange>;
/** Devin message exa.chat_pb.PromptCacheOptions. */
export interface PromptCacheOptions extends ProtoMessage {
    type: CacheControlType;
}
export declare const PromptCacheOptionsSchema: MessageCodec<PromptCacheOptions>;
/** Devin message exa.codeium_common_pb.ResponseDimension. */
export interface ResponseDimension extends ProtoMessage {
    uid: string;
    dimension: {
        case: undefined;
        value?: undefined;
    } | {
        case: "copyableCode";
        value: ResponseDimensionCopyableCode;
    } | {
        case: "metric";
        value: ResponseDimensionMetric;
    } | {
        case: "cumulativeMetric";
        value: ResponseDimensionCumulativeMetric;
    };
}
export declare const ResponseDimensionSchema: MessageCodec<ResponseDimension>;
/** Devin message exa.codeium_common_pb.ResponseDimensionCopyableCode. */
export interface ResponseDimensionCopyableCode extends ProtoMessage {
    label: string;
    value: string;
}
export declare const ResponseDimensionCopyableCodeSchema: MessageCodec<ResponseDimensionCopyableCode>;
/** Devin message exa.codeium_common_pb.ResponseDimensionCumulativeMetric. */
export interface ResponseDimensionCumulativeMetric extends ProtoMessage {
    label: string;
    value: number;
    tail: string;
    pluralTail: string;
    prefix: string;
}
export declare const ResponseDimensionCumulativeMetricSchema: MessageCodec<ResponseDimensionCumulativeMetric>;
/** Devin message exa.codeium_common_pb.ResponseDimensionGroup. */
export interface ResponseDimensionGroup extends ProtoMessage {
    title: string;
    dimensions: ResponseDimension[];
}
export declare const ResponseDimensionGroupSchema: MessageCodec<ResponseDimensionGroup>;
/** Devin message exa.codeium_common_pb.ResponseDimensionMetric. */
export interface ResponseDimensionMetric extends ProtoMessage {
    label: string;
    value: string;
}
export declare const ResponseDimensionMetricSchema: MessageCodec<ResponseDimensionMetric>;
/** Devin message exa.codeium_common_pb.SingleModelCompletionProfile. */
export interface SingleModelCompletionProfile extends ProtoMessage {
    totalPrefillPassTime: number;
    avgPrefillPassTime: number;
    numPrefillPasses: bigint;
    totalSpecCopyPassTime: number;
    avgSpecCopyPassTime: number;
    numSpecCopyPasses: bigint;
    totalGenerationPassTime: number;
    avgGenerationPassTime: number;
    numGenerationPasses: bigint;
    totalModelTime: number;
}
export declare const SingleModelCompletionProfileSchema: MessageCodec<SingleModelCompletionProfile>;
/** Devin message google.protobuf.Timestamp. */
export interface Timestamp extends ProtoMessage {
    seconds: bigint;
    nanos: number;
}
export declare const TimestampSchema: MessageCodec<Timestamp>;
