import type { EndpointConfig, ProviderConfig, ApiFormat, SamplingConfig, ThinkingEffort } from '../types';

type AnyProvider = EndpointConfig | ProviderConfig;

type ClaudeSystemBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };

// WO-09c: local content-block type for Claude text/tool_use/tool_result blocks
// carrying an optional cache_control marker. Kept local so unrelated public
// types are not widened.
type ClaudeContentBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
    | { type: 'tool_use'; id: string; name: string; input: unknown; cache_control?: { type: 'ephemeral' } }
    | { type: 'tool_result'; tool_use_id: string; content: string; cache_control?: { type: 'ephemeral' } };

const OPENAI_EFFORT_MAP: Record<ThinkingEffort, string | undefined> = {
    off: undefined, low: 'low', medium: 'medium', high: 'high', max: 'high'
};
// DeepSeek's own API accepts `max` (verified 2026-10-01 against deepseek-v4-flash).
const DEEPSEEK_EFFORT_MAP: Record<ThinkingEffort, string | undefined> = {
    off: undefined, low: 'low', medium: 'medium', high: 'high', max: 'max'
};
const CLAUDE_BUDGET_MAP: Record<ThinkingEffort, number | undefined> = {
    off: undefined, low: 1024, medium: 4096, high: 8192, max: 16384
};
const CLAUDE_EFFORT_MAP: Record<Exclude<ThinkingEffort, 'off'>, string> = {
    low: 'low', medium: 'medium', high: 'high', max: 'max',
};

export interface ClaudeModelProfile {
    /** Uses `thinking: {type: 'adaptive'}` + `output_config.effort` instead of `budget_tokens`. */
    adaptiveThinking: boolean;
    /** Thinking cannot be turned off (sending `disabled` is a 400). */
    thinkingAlwaysOn: boolean;
    /** Accepts `temperature` / `top_p` / `top_k`. */
    acceptsSampling: boolean;
}

/**
 * Request-shape rules per Claude model family. Newer models reject
 * `budget_tokens` and sampling parameters with a 400, so sending the
 * legacy shape to them breaks every turn. Unknown names fall back to the
 * legacy shape, which older and third-party-hosted models still accept.
 */
export function claudeModelProfile(modelName: string | undefined): ClaudeModelProfile {
    const m = (modelName || '').toLowerCase();
    const legacy: ClaudeModelProfile = { adaptiveThinking: false, thinkingAlwaysOn: false, acceptsSampling: true };
    if (/claude-(fable|mythos)/.test(m)) {
        return { adaptiveThinking: true, thinkingAlwaysOn: true, acceptsSampling: false };
    }
    const match = m.match(/claude-(opus|sonnet|haiku)-(\d+)(?:[-.](\d+))?(?![\d])/);
    if (!match) return legacy;
    const family = match[1];
    const major = Number(match[2]);
    // A trailing 8-digit chunk is a date snapshot, not a minor version.
    const minor = match[3] && match[3].length <= 2 ? Number(match[3]) : 0;
    const version = major + minor / 10;
    if (version < 4.6) return legacy;
    if (version < 4.7) return { adaptiveThinking: true, thinkingAlwaysOn: false, acceptsSampling: true };
    const thinkingAlwaysOn =
        (family === 'opus' && version >= 5.5) ||
        (family === 'sonnet' && version >= 5.5) ||
        (family === 'haiku' && version >= 5.5);
    return { adaptiveThinking: true, thinkingAlwaysOn, acceptsSampling: false };
}

const GEMINI_LEVEL_MAP: Record<ThinkingEffort, number | undefined> = {
    off: undefined, low: 512, medium: 2048, high: 4096, max: 8192
};
const OPENAI_THINKING_RESERVE: Record<ThinkingEffort, number> = {
    off: 0, low: 4096, medium: 8192, high: 16384, max: 32768,
};

export function withThinkingReserve(
    format: ApiFormat,
    effort: ThinkingEffort | undefined,
    answerTokens: number,
    declaredCeiling: number | undefined,
): number {
    if (!effort || effort === 'off' || format === 'ollama') return answerTokens;

    const exactBudget = format === 'claude'
        ? CLAUDE_BUDGET_MAP[effort]
        : format === 'gemini'
            ? GEMINI_LEVEL_MAP[effort]
            : undefined;
    if (exactBudget !== undefined) return answerTokens + exactBudget;

    const reserve = OPENAI_THINKING_RESERVE[effort];
    const ceiling = typeof declaredCeiling === 'number'
        && Number.isFinite(declaredCeiling)
        && declaredCeiling > 0
        ? declaredCeiling
        : 8192;
    return Math.max(answerTokens, Math.min(answerTokens + reserve, ceiling));
}

export function getApiFormat(provider: AnyProvider): ApiFormat {
    return (provider as EndpointConfig).apiFormat || 'openai';
}

/** The host that sells service tiers behind this endpoint, if any. */
export function serviceTierHostOf(endpoint: string): 'nanogpt' | 'openrouter' | undefined {
    try {
        const { hostname } = new URL(endpoint.trim());
        if (hostname === 'nano-gpt.com' || hostname.endsWith('.nano-gpt.com')) return 'nanogpt';
        if (hostname === 'openrouter.ai' || hostname.endsWith('.openrouter.ai')) return 'openrouter';
    } catch { /* invalid URL */ }
    return undefined;
}

/** Whether this provider can take a service tier: an OpenAI-style body on NanoGPT or OpenRouter. */
export function supportsServiceTier(provider: AnyProvider): boolean {
    const format = getApiFormat(provider);
    return (format === 'openai' || format === 'openrouter') && serviceTierHostOf(provider.endpoint) !== undefined;
}

/**
 * The `service_tier` value for this provider, or undefined to send none.
 * NanoGPT calls priority `fast` (`priority` is its legacy alias); OpenRouter
 * calls it `priority`. Both route a tiered request only to providers that offer it.
 */
export function serviceTierFor(provider: AnyProvider): string | undefined {
    const tier = (provider as EndpointConfig).serviceTier;
    if (!tier || !supportsServiceTier(provider)) return undefined;
    if (serviceTierHostOf(provider.endpoint) === 'nanogpt') return tier === 'priority' ? 'fast' : 'flex';
    return tier;
}

function isBareHost(url: string): boolean {
    try {
        return new URL(url).pathname.replace(/\/+$/, '') === '';
    } catch {
        const pathPart = url.replace(/^https?:\/\/[^/]+/, '').replace(/\/+$/, '');
        return pathPart === '';
    }
}

export function detectFormatFromEndpoint(endpoint: string): ApiFormat | null {
    try {
        const { hostname } = new URL(endpoint);
        if (hostname.includes('api.anthropic.com')) return 'claude';
        if (hostname.includes('generativelanguage.googleapis.com')) return 'gemini';
        if (/^(localhost|127\.0\.0\.1):11434$/.test(hostname)) return 'ollama';
    } catch { /* invalid URL */ }
    return null;
}

export function getBaseUrl(provider: AnyProvider): string {
    let base = provider.endpoint.replace(/\/+$/, '');
    const format = getApiFormat(provider);
    if ((format === 'openai' || format === 'claude') && isBareHost(base)) {
        base += '/v1';
    }
    return base;
}

export function getChatUrl(provider: AnyProvider, options?: { stream?: boolean }): string {
    const base = getBaseUrl(provider);
    const format = getApiFormat(provider);
    if (format === 'ollama') return `${base}/api/chat`;
    if (format === 'claude') return `${base}/messages`;
    if (format === 'gemini') {
        const stream = options?.stream ?? false;
        const model = provider.modelName;
        return stream
            ? `${base}/models/${model}:streamGenerateContent?alt=sse`
            : `${base}/models/${model}:generateContent`;
    }
    return `${base}/chat/completions`;
}

export function getModelsUrl(provider: AnyProvider): string {
    const base = getBaseUrl(provider);
    const format = getApiFormat(provider);
    if (format === 'ollama') return `${base}/api/tags`;
    if (format === 'gemini') return `${base}/models`;
    if (format === 'claude') return `${base}/models`;
    return `${base}/models`;
}

export function buildChatHeaders(provider: AnyProvider): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const format = getApiFormat(provider);
    if (format === 'claude') {
        if (provider.apiKey) {
            headers['x-api-key'] = provider.apiKey;
            headers['anthropic-version'] = '2023-06-01';
        }
    } else if (format === 'gemini') {
        // Gemini auth goes in URL param, not headers — remove Content-Type for GET-style endpoints
    } else if (provider.apiKey) {
        headers['Authorization'] = `Bearer ${provider.apiKey}`;
    }
    return headers;
}

// ── Claude thinking-block continuity across a tool loop ─────────────────
// With thinking on, Claude requires the assistant turn that issued a tool_use
// to be sent back with its original (signed) thinking blocks when the tool
// result is returned. The app keeps history in OpenAI shape, which has no
// place for them, so they are held here keyed by the tool_use id.
export type ClaudeThinkingBlock =
    | { type: 'thinking'; thinking: string; signature: string }
    | { type: 'redacted_thinking'; data: string };

const CLAUDE_THINKING_STORE_LIMIT = 256;
const claudeThinkingByToolUseId = new Map<string, ClaudeThinkingBlock[]>();

export function rememberClaudeThinking(toolUseId: string, blocks: ClaudeThinkingBlock[]): void {
    if (!toolUseId || blocks.length === 0) return;
    claudeThinkingByToolUseId.set(toolUseId, blocks);
    while (claudeThinkingByToolUseId.size > CLAUDE_THINKING_STORE_LIMIT) {
        const oldest = claudeThinkingByToolUseId.keys().next().value;
        if (oldest === undefined) break;
        claudeThinkingByToolUseId.delete(oldest);
    }
}

export function recallClaudeThinking(toolUseId: string): ClaudeThinkingBlock[] | undefined {
    return claudeThinkingByToolUseId.get(toolUseId);
}

/** Accumulates thinking blocks from a Claude SSE stream. */
export class ClaudeThinkingCollector {
    private blocks = new Map<number, ClaudeThinkingBlock>();

    /** Feed one parsed SSE event. Returns any visible thinking text delta. */
    push(event: unknown): string {
        const e = event as {
            type?: string; index?: number;
            content_block?: { type?: string; thinking?: string; signature?: string; data?: string };
            delta?: { type?: string; thinking?: string; signature?: string };
        };
        const index = e.index ?? 0;
        if (e.type === 'content_block_start' && e.content_block) {
            if (e.content_block.type === 'thinking') {
                this.blocks.set(index, { type: 'thinking', thinking: e.content_block.thinking ?? '', signature: e.content_block.signature ?? '' });
            } else if (e.content_block.type === 'redacted_thinking') {
                this.blocks.set(index, { type: 'redacted_thinking', data: e.content_block.data ?? '' });
            }
            return '';
        }
        if (e.type === 'content_block_delta' && e.delta) {
            const block = this.blocks.get(index);
            if (!block || block.type !== 'thinking') return '';
            if (e.delta.type === 'thinking_delta' && e.delta.thinking) {
                block.thinking += e.delta.thinking;
                return e.delta.thinking;
            }
            if (e.delta.type === 'signature_delta' && e.delta.signature) {
                block.signature += e.delta.signature;
            }
        }
        return '';
    }

    result(): ClaudeThinkingBlock[] {
        return [...this.blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
    }
}

/** OpenAI-style `{type:'function', function:{...}}` tools → Claude tool definitions. */
export function transformClaudeTools(tools: unknown[]): unknown[] {
    return tools.map(t => {
        const tool = t as { type?: string; function?: { name: string; description?: string; parameters?: unknown }; input_schema?: unknown };
        if (tool.function && !tool.input_schema) {
            return {
                name: tool.function.name,
                ...(tool.function.description ? { description: tool.function.description } : {}),
                input_schema: tool.function.parameters ?? { type: 'object', properties: {} },
            };
        }
        return t;
    });
}

function transformClaudeMessages(messages: { role: string; content: string | null; name?: string; tool_calls?: unknown[]; tool_call_id?: string; reasoning_content?: string; cache_control?: { type: 'ephemeral' } }[]): { system?: string | ClaudeSystemBlock[]; messages: { role: string; content: string | ClaudeContentBlock[] }[] } {
    const systemBlocks: { text: string; cache_control?: { type: 'ephemeral' } }[] = [];
    const transformed: { role: string; content: string | ClaudeContentBlock[] }[] = [];

    // Only the tool loop after the last real user message needs its thinking
    // blocks back; earlier turns are left as plain history.
    let lastUserIndex = -1;
    messages.forEach((m, i) => { if (m.role === 'user') lastUserIndex = i; });

    for (const [msgIndex, m] of messages.entries()) {
        if (m.role === 'system') {
            systemBlocks.push({ text: m.content || '', ...(m.cache_control ? { cache_control: m.cache_control } : {}) });
            continue;
        }

        if (m.role === 'assistant') {
            const tc = (m as { tool_calls?: { id: string; function: { name: string; arguments: string } }[] }).tool_calls;
            if (tc && tc.length > 0) {
                // WO-09c: when the assistant message carries cache_control, the
                // breakpoint covers the COMPLETE message — put the marker on the
                // FINAL emitted content block only, so the breakpoint includes all
                // text and tool_use blocks. Do not duplicate the marker across blocks.
                const content: ClaudeContentBlock[] = [];
                if (msgIndex > lastUserIndex) {
                    const thinking = recallClaudeThinking(tc[0].id);
                    if (thinking) content.push(...(thinking as unknown as ClaudeContentBlock[]));
                }
                if (m.content) content.push({ type: 'text', text: m.content });
                for (const t of tc) {
                    let input: unknown = {};
                    try { input = JSON.parse(t.function.arguments); } catch { input = { _raw: t.function.arguments }; }
                    content.push({ type: 'tool_use', id: t.id, name: t.function.name, input });
                }
                if (m.cache_control && content.length > 0) {
                    const lastBlock = content[content.length - 1];
                    (lastBlock as { cache_control?: { type: 'ephemeral' } }).cache_control = m.cache_control;
                }
                transformed.push({ role: 'assistant', content });
            } else {
                // WO-09c: a stamped plain assistant message emits as a single text
                // content block carrying the marker. An unstamped assistant message
                // retains the current plain-string representation.
                if (m.cache_control) {
                    transformed.push({
                        role: 'assistant',
                        content: [{ type: 'text', text: m.content || '', cache_control: m.cache_control }],
                    });
                } else {
                    transformed.push({ role: 'assistant', content: m.content || '' });
                }
            }
            continue;
        }

        if (m.role === 'tool') {
            // WO-09c: tool-role history messages are not stamped by payloadBuilder
            // (WO-09c §1 corrects the prior wording — tool-role stamping was not
            // authorized, not that the type cannot carry the marker). The tool
            // transformation is unchanged.
            transformed.push({
                role: 'user',
                content: [{
                    type: 'tool_result',
                    tool_use_id: (m as { tool_call_id?: string }).tool_call_id || '',
                    content: m.content || '',
                }],
            });
            continue;
        }

        // WO-09c: a stamped `user` message (non-tool) emits as a single text
        // content block carrying the marker. An unstamped user message retains
        // the current plain-string representation. The final volatile user
        // message has no marker in the assembled payload, so it stays plain.
        if (m.cache_control) {
            transformed.push({
                role: m.role,
                content: [{ type: 'text', text: m.content || '', cache_control: m.cache_control }],
            });
        } else {
            transformed.push({ role: m.role, content: m.content || '' });
        }
    }

    const result: { system?: string | ClaudeSystemBlock[]; messages: { role: string; content: string | ClaudeContentBlock[] }[] } = { messages: transformed };
    if (systemBlocks.length > 0) {
        const hasCacheControl = systemBlocks.some(b => b.cache_control);
        if (hasCacheControl) {
            result.system = systemBlocks.map(b => ({
                type: 'text' as const,
                text: b.text,
                ...(b.cache_control ? { cache_control: b.cache_control } : {}),
            }));
        } else {
            result.system = systemBlocks.map(b => b.text).join('\n\n');
        }
    }
    return result;
}

function transformGeminiMessages(messages: { role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string; name?: string; reasoning_content?: string; cache_control?: { type: 'ephemeral' } }[]): { systemInstruction?: { parts: { text: string }[] }; contents: { role: string; parts: unknown[] }[] } {
    const systemParts: string[] = [];
    const contents: { role: string; parts: unknown[] }[] = [];

    for (const m of messages) {
        if (m.role === 'system') {
            systemParts.push(m.content || '');
            continue;
        }

        if (m.role === 'assistant') {
            const tc = (m as { tool_calls?: { id: string; function: { name: string; arguments: string } }[] }).tool_calls;
            const parts: unknown[] = [];
            if (m.content) parts.push({ text: m.content });
            if (tc && tc.length > 0) {
                for (const t of tc) {
                    let args: Record<string, unknown> = {};
                    try { args = JSON.parse(t.function.arguments); } catch { args = { _raw: t.function.arguments }; }
                    parts.push({ functionCall: { name: t.function.name, args } });
                }
            }
            contents.push({ role: 'model', parts });
            continue;
        }

        if (m.role === 'tool') {
            const fName = m.name || '';
            contents.push({
                role: 'function',
                parts: [{ functionResponse: { name: fName, response: { content: m.content || '' } } }],
            });
            continue;
        }

        contents.push({ role: m.role, parts: [{ text: m.content || '' }] });
    }

    const result: { systemInstruction?: { parts: { text: string }[] }; contents: { role: string; parts: unknown[] }[] } = { contents };
    if (systemParts.length > 0) result.systemInstruction = { parts: [{ text: systemParts.join('\n\n') }] };
    return result;
}

function transformGeminiTools(tools: unknown[]): unknown[] {
    const openaiTools = tools as { type: string; function: { name: string; description: string; parameters: unknown } }[];
    const declarations = openaiTools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
    }));
    return [{ functionDeclarations: declarations }];
}

/** Fields the app reads the reply by; a custom body may not change them. */
const PROTECTED_BODY_FIELDS = new Set(['messages', 'contents', 'stream']);

/**
 * Parses a provider's custom body text. Returns the object, `{}` when blank,
 * or an error message when the text is not a JSON object.
 */
export function parseCustomBody(text: string | undefined): { fields: Record<string, unknown> } | { error: string } {
    if (!text || !text.trim()) return { fields: {} };
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (err) {
        return { error: err instanceof Error ? err.message : 'Invalid JSON' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { error: 'Must be a JSON object, like {"top_a": 0.2}' };
    }
    return { fields: parsed as Record<string, unknown> };
}

/** Merges a custom body over the built one: `null` removes a field, protected fields are kept. */
export function mergeCustomBody<T extends object>(body: T, customBody: string | undefined, protectedFields: ReadonlySet<string>): T {
    const parsed = parseCustomBody(customBody);
    if ('error' in parsed) {
        console.warn(`[llmApiHelper] Custom body ignored: ${parsed.error}`);
        return body;
    }
    const target = body as Record<string, unknown>;
    for (const [key, value] of Object.entries(parsed.fields)) {
        if (protectedFields.has(key)) continue;
        if (value === null) delete target[key];
        else target[key] = value;
    }
    return body;
}

function applyCustomBody(provider: AnyProvider, body: Record<string, unknown>): Record<string, unknown> {
    return mergeCustomBody(body, (provider as EndpointConfig).customBody, PROTECTED_BODY_FIELDS);
}

type ChatBodyMessage = { role: string; content: string | null; name?: string; tool_calls?: unknown[]; tool_call_id?: string; reasoning_content?: string; cache_control?: { type: 'ephemeral' } };
type ChatBodyOptions = { stream?: boolean; max_tokens?: number; temperature?: number; tools?: unknown[]; sampling?: SamplingConfig; thinkingEffort?: ThinkingEffort };

export function buildChatBody(
    provider: AnyProvider,
    messages: ChatBodyMessage[],
    options?: ChatBodyOptions
): Record<string, unknown> {
    return applyCustomBody(provider, buildBaseChatBody(provider, messages, options));
}

function buildBaseChatBody(
    provider: AnyProvider,
    messages: ChatBodyMessage[],
    options?: ChatBodyOptions
): Record<string, unknown> {
    const format = getApiFormat(provider);
    const stream = options?.stream ?? false;
    const effort = options?.thinkingEffort ?? (provider as EndpointConfig).thinkingEffort;

    if (format === 'claude') {
        const { system, messages: convMessages } = transformClaudeMessages(messages);
        const answerTokens = options?.sampling?.max_tokens ?? options?.max_tokens ?? 16384;
        const maxTokens = withThinkingReserve(format, effort, answerTokens, (provider as EndpointConfig).maxOutputTokens);
        const body: Record<string, unknown> = {
            model: provider.modelName,
            messages: convMessages,
            max_tokens: maxTokens,
            stream,
        };
        if (system) body.system = system;

        const profile = claudeModelProfile(provider.modelName);

        if (profile.adaptiveThinking) {
            // Claude 4.6+ reject (or deprecate) budget_tokens. Depth is set by
            // effort; thinking itself is adaptive.
            if (effort && effort !== 'off') {
                // 4.7+ default to empty thinking text; ask for the summary so
                // the reasoning panel has something to show.
                body.thinking = profile.acceptsSampling
                    ? { type: 'adaptive' }
                    : { type: 'adaptive', display: 'summarized' };
                body.output_config = { effort: CLAUDE_EFFORT_MAP[effort] };
            } else if (effort === 'off' && profile.thinkingAlwaysOn) {
                // Thinking cannot be disabled on these models — the closest
                // honest equivalent of "off" is the lowest effort.
                body.output_config = { effort: 'low' };
            }
        } else if (effort && effort !== 'off') {
            const budget = CLAUDE_BUDGET_MAP[effort];
            if (budget !== undefined) {
                body.thinking = { type: 'enabled', budget_tokens: budget };
            }
        }

        if (profile.acceptsSampling) {
            if (options?.temperature !== undefined) body.temperature = options.temperature;
            else if (options?.sampling?.temperature !== undefined) body.temperature = options.sampling.temperature;
            if (options?.sampling?.top_p !== undefined) body.top_p = options.sampling.top_p;
            if (options?.sampling?.top_k !== undefined) body.top_k = options.sampling.top_k;
        }

        if (options?.tools && options.tools.length > 0) {
            body.tools = transformClaudeTools(options.tools);
            // The turn loop executes one tool call per round trip; parallel
            // tool_use blocks would be merged into one broken argument string.
            body.tool_choice = { type: 'auto', disable_parallel_tool_use: true };
        }
        return body;
    }

    if (format === 'gemini') {
        const { systemInstruction, contents } = transformGeminiMessages(messages);
        const body: Record<string, unknown> = {
            contents,
        };
        if (systemInstruction) body.systemInstruction = systemInstruction;

        const genConfig: Record<string, unknown> = {};
        const answerTokens = options?.sampling?.max_tokens ?? options?.max_tokens ?? 8192;
        genConfig.maxOutputTokens = withThinkingReserve(format, effort, answerTokens, (provider as EndpointConfig).maxOutputTokens);
        if (options?.temperature !== undefined) genConfig.temperature = options.temperature;
        else if (options?.sampling?.temperature !== undefined) genConfig.temperature = options.sampling.temperature;
        if (options?.sampling?.top_p !== undefined) genConfig.topP = options.sampling.top_p;
        if (options?.sampling?.top_k !== undefined) genConfig.topK = options.sampling.top_k;
        if (options?.sampling?.frequency_penalty !== undefined) genConfig.frequencyPenalty = options.sampling.frequency_penalty;
        if (options?.sampling?.presence_penalty !== undefined) genConfig.presencePenalty = options.sampling.presence_penalty;

        if (effort && effort !== 'off') {
            const budget = GEMINI_LEVEL_MAP[effort];
            if (budget !== undefined) {
                genConfig.thinkingConfig = { thinkingBudget: budget };
            }
        }

        body.generationConfig = genConfig;

        if (options?.tools && options.tools.length > 0) {
            body.tools = transformGeminiTools(options.tools);
        }
        return body;
    }

    // OpenAI / Ollama / DeepSeek — strip cache_control (Anthropic-specific)
    const isOllama = format === 'ollama';
    const sanitizedMessages = messages.map((m) => {
        const rest = { ...m };
        delete (rest as Record<string, unknown>).cache_control;
        return rest;
    });
    const body: Record<string, unknown> = {
        model: provider.modelName,
        messages: sanitizedMessages,
        stream,
    };

    // Ask OpenAI-compatible providers to emit a final usage chunk while streaming
    // (DeepSeek reports prompt-cache hit/miss here). Harmless for servers that
    // ignore it; skipped for Ollama which has its own usage fields.
    if (stream && !isOllama) {
        body.stream_options = { include_usage: true };
    }

    const answerTokens = options?.sampling?.max_tokens ?? options?.max_tokens;
    if (answerTokens !== undefined) {
        body.max_tokens = isOllama
            ? answerTokens
            : withThinkingReserve(format, effort, answerTokens, (provider as EndpointConfig).maxOutputTokens);
    }

    if (options?.temperature !== undefined) body.temperature = options.temperature;
    else if (options?.sampling?.temperature !== undefined) body.temperature = options.sampling.temperature;

    if (options?.sampling) {
        const s = options.sampling;
        if (s.top_p !== undefined) body.top_p = s.top_p;
        if (s.top_k !== undefined) body.top_k = s.top_k;
        if (s.min_p !== undefined) body.min_p = s.min_p;
        if (s.frequency_penalty !== undefined) body.frequency_penalty = s.frequency_penalty;
        if (s.presence_penalty !== undefined) body.presence_penalty = s.presence_penalty;
        if (s.repetition_penalty !== undefined) body.repetition_penalty = s.repetition_penalty;
        if (s.dry_multiplier !== undefined) body.dry_multiplier = s.dry_multiplier;
        if (s.dry_base !== undefined) body.dry_base = s.dry_base;
        if (s.dry_allowed_length !== undefined) body.dry_allowed_length = s.dry_allowed_length;
    }

    // DeepSeek's own API, judged by host: DeepSeek models served elsewhere (NanoGPT,
    // OpenRouter) take that host's controls, not these.
    const isDeepSeekApi = !isOllama && (() => { try { return new URL(provider.endpoint.replace(/\/+$/, '')).hostname.includes('deepseek'); } catch { return false; } })();

    if (effort === 'off' && isDeepSeekApi) {
        // DeepSeek thinks by default (effort high), so leaving the field out is not
        // "off": the reasoning is billed against max_tokens and a small answer budget
        // comes back empty. Only an explicit disable turns it off.
        body.thinking = { type: 'disabled' };
    } else if (effort && effort !== 'off') {
        if (isOllama) {
            const ollamaThinkBudget: Record<ThinkingEffort, number | undefined> = {
                off: undefined, low: 2048, medium: 2048, high: 8192, max: 8192
            };
            const thinkBudget = ollamaThinkBudget[effort];
            if (thinkBudget !== undefined) {
                body.think = true;
                (body as Record<string, unknown>).options = { ...(body.options || {}), num_predict: thinkBudget };
            }
        } else {
            const effortMap = isDeepSeekApi ? DEEPSEEK_EFFORT_MAP : OPENAI_EFFORT_MAP;
            const mapped = effortMap[effort];
            if (mapped !== undefined) {
                body.reasoning_effort = mapped;
            }
        }
    }

    if (!isOllama && options?.tools && options.tools.length > 0) {
        body.tools = options.tools;
    }

    const serviceTier = serviceTierFor(provider);
    if (serviceTier) body.service_tier = serviceTier;

    return body;
}

export function extractContent(data: unknown, provider: AnyProvider): string {
    const format = getApiFormat(provider);

    if (format === 'ollama') {
        const ollama = data as { message?: { content?: string } };
        return ollama?.message?.content ?? '';
    }

    if (format === 'claude') {
        const claude = data as { content?: { type: string; text?: string }[] };
        const textBlocks = claude?.content?.filter(b => b.type === 'text');
        return textBlocks?.map(b => b.text ?? '').join('') ?? '';
    }

    if (format === 'gemini') {
        const gemini = data as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
        return gemini?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    }

    const openai = data as { choices?: { message?: { content?: string } }[] };
    return openai?.choices?.[0]?.message?.content ?? '';
}

export function extractStreamDelta(data: unknown, provider: AnyProvider): string {
    const format = getApiFormat(provider);

    if (format === 'claude') {
        const claude = data as { type?: string; delta?: { type?: string; text?: string } };
        if (claude.type === 'content_block_delta' && claude.delta?.type === 'text_delta') {
            return claude.delta.text ?? '';
        }
        return '';
    }

    if (format === 'gemini') {
        const gemini = data as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
        return gemini?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    }

    const openai = data as { choices?: { delta?: { content?: string } }[] };
    return openai?.choices?.[0]?.delta?.content ?? '';
}

export function extractStreamToolCall(data: unknown, provider: AnyProvider): { id: string; name: string; arguments: string } | null {
    const format = getApiFormat(provider);

    if (format === 'claude') {
        const claude = data as { type?: string; content_block?: { type?: string; id?: string; name?: string }; delta?: { type?: string; partial_json?: string } };
        if (claude.type === 'content_block_start' && claude.content_block?.type === 'tool_use') {
            return { id: claude.content_block.id || '', name: claude.content_block.name || '', arguments: '' };
        }
        if (claude.type === 'content_block_delta' && claude.delta?.type === 'input_json_delta' && claude.delta.partial_json) {
            return { id: '', name: '', arguments: claude.delta.partial_json };
        }
        return null;
    }

    if (format === 'gemini') {
        const gemini = data as { candidates?: { content?: { parts?: { functionCall?: { name: string; args: Record<string, unknown> } }[] } }[] };
        const fc = gemini?.candidates?.[0]?.content?.parts?.find(p => (p as { functionCall?: unknown }).functionCall);
        if (fc) {
            const fCall = (fc as { functionCall: { name: string; args: Record<string, unknown> } }).functionCall;
            return { id: `gemini_${Date.now()}`, name: fCall.name, arguments: JSON.stringify(fCall.args) };
        }
        return null;
    }

    const openai = data as { choices?: { delta?: { tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] } }[] };
    const tc = openai?.choices?.[0]?.delta?.tool_calls?.[0];
    if (!tc) return null;
    return { id: tc.id || '', name: tc.function?.name || '', arguments: tc.function?.arguments || '' };
}