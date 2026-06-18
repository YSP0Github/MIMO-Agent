export interface FriendlyErrorOptions {
    model?: string;
    baseUrl?: string;
}

export interface MimoErrorCodeInfo {
    code: string;
    titleZh: string;
    originZh: string;
    reasonZh: string;
    suggestionsZh: string[];
    titleEn: string;
    suggestionsEn: string[];
}

export const MIMO_ERROR_CODES: Record<string, MimoErrorCodeInfo> = {
    '400': {
        code: '400',
        titleZh: '请求体格式错误',
        originZh: '更可能是 Agent 请求构造、参数配置或多轮协议拼接问题，不是大模型推理能力问题。',
        reasonZh: '请求 JSON、参数范围、模型名、消息格式或多模态输入不符合 MiMo API 要求。',
        suggestionsZh: [
            '检查 JSON 格式、必需参数、参数范围和消息结构。',
            '确认模型名存在，并且当前接口支持该模型和图像/多模态输入。',
            '多轮思考模式下，工具返回后需要保留完整的 reasoning_content 字段。',
        ],
        titleEn: 'Bad request format',
        suggestionsEn: [
            'Check JSON, required parameters, parameter ranges, and message structure.',
            'Confirm the model exists and supports the requested modality on this endpoint.',
            'For multi-turn reasoning, preserve reasoning_content when continuing after tool calls.',
        ],
    },
    '401': {
        code: '401',
        titleZh: '认证失败',
        originZh: '更可能是用户配置或账号凭证问题，不是 Agent 执行逻辑或大模型推理问题。',
        reasonZh: 'API Key 缺失、无效，Authorization 请求头格式错误，或 Token Plan 与按量付费 API 的 Base URL/API Key 混用。',
        suggestionsZh: [
            '检查 API Key 和 Authorization 请求头格式。',
            '如果使用 Token Plan，请确认 Base URL 和 API Key 是同一套套餐下的专属配置。',
        ],
        titleEn: 'Authentication failed',
        suggestionsEn: [
            'Check the API key and Authorization header format.',
            'For Token Plan, make sure the Base URL and API key belong to the same plan.',
        ],
    },
    '402': {
        code: '402',
        titleZh: '余额不足',
        originZh: '这是账户额度问题，不是 Agent 或大模型推理问题。',
        reasonZh: '账户余额不足。',
        suggestionsZh: ['检查账户余额，并及时充值。'],
        titleEn: 'Insufficient balance',
        suggestionsEn: ['Check the account balance and recharge if needed.'],
    },
    '403': {
        code: '403',
        titleZh: '拒绝访问',
        originZh: '更可能是账户权限、地区限制、风控或内容安全问题，不是 Agent 执行逻辑问题。',
        reasonZh: '服务暂不支持当前地区，或 API Key 被风控。',
        suggestionsZh: ['新建 API Key，并注意输入内容安全。'],
        titleEn: 'Access denied',
        suggestionsEn: ['Create a new API key and check that the request content is safe.'],
    },
    '404': {
        code: '404',
        titleZh: '资源未找到',
        originZh: '更可能是模型/接口配置不匹配，或所选模型能力不支持当前输入；通常不是 Agent 工具执行问题。',
        reasonZh: '接口或模型不存在，或当前模型/接口不支持图像输入能力。',
        suggestionsZh: [
            '确认 Base URL、接口模式和模型名是否匹配。',
            '如果发送了图片，确认所选模型和接口支持多模态图像输入。',
        ],
        titleEn: 'Resource not found',
        suggestionsEn: [
            'Confirm the Base URL, endpoint mode, and model name match.',
            'If images were sent, confirm the selected model and endpoint support vision input.',
        ],
    },
    '421': {
        code: '421',
        titleZh: '内容拦截',
        originZh: '这是 MiMo API 内容安全策略拦截，不是 Agent 代码执行问题。',
        reasonZh: '请求内容触发审核拦截。',
        suggestionsZh: ['避免输入不安全或敏感内容，调整请求后重试。'],
        titleEn: 'Content blocked',
        suggestionsEn: ['Remove unsafe or sensitive content, then retry.'],
    },
    '429': {
        code: '429',
        titleZh: '请求超限',
        originZh: '这是 MiMo API 服务侧限流或额度问题，不是 Agent 逻辑错误。',
        reasonZh: '请求过于频繁，或 Token Plan 的额度耗尽。',
        suggestionsZh: [
            '稍后重试，或降低请求频率。',
            '升级 Token Plan 套餐，或切换为按量付费 API。',
        ],
        titleEn: 'Rate limit exceeded',
        suggestionsEn: [
            'Retry later or reduce request frequency.',
            'Upgrade the Token Plan or switch to pay-as-you-go API access.',
        ],
    },
    '500': {
        code: '500',
        titleZh: '服务器失败',
        originZh: '更可能是 MiMo API 服务侧故障，不是 Agent 本地执行问题。',
        reasonZh: '服务器内部故障。',
        suggestionsZh: ['请稍后重试；如果持续出现，联系服务支持。'],
        titleEn: 'Server failure',
        suggestionsEn: ['Retry later; if it persists, contact service support.'],
    },
    '503': {
        code: '503',
        titleZh: '服务不可用',
        originZh: '更可能是 MiMo API 服务侧负载或临时不可用，不是 Agent 本地执行问题。',
        reasonZh: '服务器负载过高或暂时不可用。',
        suggestionsZh: ['请稍后重试。'],
        titleEn: 'Service unavailable',
        suggestionsEn: ['Retry later.'],
    },
};

const ERROR_MESSAGES: Record<string, string> = {
    'ECONNREFUSED': 'Cannot connect to the API server. Check baseUrl, network, and proxy settings.',
    'ECONNRESET': 'The API connection was reset. The network or upstream server may be unstable.',
    'ETIMEDOUT': 'The API request timed out. Check network speed, proxy, or provider status.',
    'ENOTFOUND': 'Cannot resolve the API host. Check baseUrl and DNS settings.',
    'socket hang up': 'The API connection closed unexpectedly. Try again shortly.',
    'DEPTH_ZERO_SELF_SIGNED_CERT': 'TLS certificate verification failed because the certificate is self-signed.',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE': 'TLS certificate verification failed. Check system time and certificate configuration.',
    '502': 'The API gateway returned an error. The provider may be under maintenance.',
};

export function isMimoRoute(options: FriendlyErrorOptions = {}): boolean {
    const model = String(options.model || '').trim();
    const baseUrl = String(options.baseUrl || '').trim();
    return /^mimo[-_]/i.test(model) || /xiaomimimo|mimo/i.test(baseUrl);
}

export function extractHttpErrorCode(message: string): string | null {
    const msg = String(message || '');
    const match = msg.match(/\b(400|401|402|403|404|421|429|500|503)\b/);
    return match?.[1] || null;
}

function formatMimoError(info: MimoErrorCodeInfo, message: string): string {
    const detail = message.trim() && !new RegExp(`\\b${info.code}\\b`).test(message)
        ? `\n\n原始信息：${message.trim()}`
        : '';
    return [
        `MiMo API 返回 ${info.code}：${info.titleZh}`,
        `问题归因：${info.originZh}`,
        `原因：${info.reasonZh}`,
        `建议：${info.suggestionsZh.join('；')}`,
    ].join('\n') + detail;
}

function formatAbortError(options: FriendlyErrorOptions = {}): string {
    if (isMimoRoute(options)) {
        return [
            'MiMo 请求已中断：连接或流式响应在完成前被取消。',
            '问题归因：暂不能单凭 aborted 判定是 Agent 还是大模型。若没有点击 Stop，更可能是网络/服务端流式连接中断；如果总是在工具调用后发生，Agent 续写链路也需要重点排查。',
            '原因：这通常发生在网络波动、上游服务提前断开、VS Code 侧停止请求，或工具调用后模型续写阶段被 abort。',
            '建议：先检查刚才是否已经生成或修改了目标文件；如果已有阶段性结果，可以让 MiMo “继续刚才的任务并验证”。如果频繁出现，请降低请求频率、缩短单轮任务，或切换到稳定的 MiMo endpoint/API Key 后重试。',
        ].join('\n');
    }
    return 'Request was aborted before completion. Check whether the request was stopped, the network dropped, or the provider closed the stream early.';
}

export function getFriendlyError(error: Error | string, options: FriendlyErrorOptions = {}): string {
    const msg = typeof error === 'string' ? error : error.message || '';

    if (/^aborted$/i.test(msg.trim()) || /AbortError|aborted before complete/i.test(String((error as any)?.name || msg))) {
        return formatAbortError(options);
    }

    if (/max_tokens|MaxTokens/i.test(msg) && /invalid|should be in|range|too large|exceed/i.test(msg)) {
        if (isMimoRoute(options)) {
            return [
                'MiMo API 返回 400：生成参数不符合要求。',
                '问题归因：更可能是 Agent 请求参数或用户生成设置问题，不是大模型推理能力问题。',
                '原因：当前 Max Tokens 设置超出模型或接口允许范围。',
                '建议：把 Generation > Max Tokens 调到 65536 或更低，然后重试。',
            ].join('\n');
        }
        return 'FAILED: The selected provider rejected the Max Tokens setting. Lower Generation > Max Tokens to 65536 or less, then retry.';
    }

    const code = extractHttpErrorCode(msg);
    if (code && isMimoRoute(options) && MIMO_ERROR_CODES[code]) {
        return formatMimoError(MIMO_ERROR_CODES[code], msg);
    }

    for (const [pattern, friendly] of Object.entries(ERROR_MESSAGES)) {
        if (msg.includes(pattern)) {
            let result = `FAILED: ${friendly}`;

            if (msg.includes('429')) {
                const retryMatch = msg.match(/retry-after[:\s]+(\d+)/i);
                const waitTime = retryMatch ? parseInt(retryMatch[1]) : 30;
                result += `\n\nWait about ${waitTime} seconds and retry.`;
            }

            if (msg.includes('401') || msg.includes('403')) {
                result += '\n\nCheck the API key, baseUrl, selected model, and provider-side model permissions.';
            }

            return result;
        }
    }

    return `FAILED: ${msg}`;
}
