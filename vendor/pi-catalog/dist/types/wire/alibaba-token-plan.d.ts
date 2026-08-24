/**
 * International (Singapore) Token Plan endpoint. Default region; keys issued by
 * the international product authenticate only here.
 */
export declare const ALIBABA_TOKEN_PLAN_BASE_URL = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
/**
 * China (Beijing) Token Plan endpoint (百炼 Token Plan). Keys are region-locked:
 * a Beijing-issued key is rejected by the international endpoint with
 * `invalid_api_key`, and vice versa (#6682).
 */
export declare const ALIBABA_TOKEN_PLAN_CN_BASE_URL = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
export interface AlibabaTokenPlanCredential {
    token: string;
    cookie?: string;
    /**
     * Region base URL the key authenticates against. Absent means the default
     * international endpoint ({@link ALIBABA_TOKEN_PLAN_BASE_URL}).
     */
    baseUrl?: string;
}
export declare function parseAlibabaTokenPlanCredential(value: string): AlibabaTokenPlanCredential | null;
export declare function serializeAlibabaTokenPlanCredential(token: string, cookie: string, baseUrl?: string): string;
