import type { ProviderConfig } from "./store.js";
import type { ConfigStore } from "../config/store.js";

// --- Types for OpenAI-compatible requests ---

export interface ChatCompletionRequest {
  model: string;
  messages: any[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  [key: string]: any;
}

export interface AnthropicMessagesRequest {
  model: string;
  messages: any[];
  stream?: boolean;
  max_tokens?: number;
  system?: string | any[];
  [key: string]: any;
}

export interface ProxyResult {
  response: Response;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Proxy a chat completion request to the upstream provider.
 * Handles both streaming (SSE pass-through) and non-streaming.
 */
export async function proxyChatCompletion(
  provider: ProviderConfig,
  configStore: ConfigStore,
  body: ChatCompletionRequest,
  incomingHeaders: Headers
): Promise<ProxyResult> {
  const apiKey = getApiKey(provider, configStore);

  if (provider.name === "anthropic") {
    return proxyToAnthropic(provider, apiKey, body, incomingHeaders);
  }
  return proxyToOpenAI(provider, apiKey, body, incomingHeaders);
}

/**
 * Proxy an Anthropic /v1/messages request directly.
 * No format conversion needed — pass through as-is.
 */
export async function proxyAnthropicMessages(
  provider: ProviderConfig,
  configStore: ConfigStore,
  body: AnthropicMessagesRequest,
  incomingHeaders: Headers
): Promise<ProxyResult> {
  const apiKey = getApiKey(provider, configStore);
  const url = `${provider.baseUrl}/v1/messages`;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": apiKey,
    ...provider.defaultHeaders,
  };

  // Forward anthropic-specific headers
  for (const key of ["anthropic-version", "anthropic-beta"]) {
    const val = incomingHeaders.get(key);
    if (val) headers[key] = val;
  }

  const upstreamRes = await fetchWithRetry(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (body.stream) {
    return {
      response: new Response(upstreamRes.body, {
        status: upstreamRes.status,
        headers: passHeaders(upstreamRes),
      }),
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
  }

  const data = await upstreamRes.json();
  const usage = data.usage || {};

  return {
    response: new Response(JSON.stringify(data), {
      status: upstreamRes.status,
      headers: { "content-type": "application/json" },
    }),
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    cacheReadTokens: usage.cache_read_input_tokens || 0,
    cacheWriteTokens: usage.cache_creation_input_tokens || 0,
  };
}

// --- Internal ---

function getApiKey(provider: ProviderConfig, configStore: ConfigStore): string {
  const entry = configStore.get(provider.apiKeyConfigKey);
  const key = entry?.value || process.env[provider.apiKeyConfigKey] || "";
  if (!key) {
    throw new Error(`API key not configured: ${provider.apiKeyConfigKey}`);
  }
  return key;
}

async function proxyToOpenAI(
  provider: ProviderConfig,
  apiKey: string,
  body: ChatCompletionRequest,
  _incomingHeaders: Headers
): Promise<ProxyResult> {
  const url = `${provider.baseUrl}/v1/chat/completions`;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
    ...provider.defaultHeaders,
  };

  const upstreamRes = await fetchWithRetry(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (body.stream) {
    return {
      response: new Response(upstreamRes.body, {
        status: upstreamRes.status,
        headers: passHeaders(upstreamRes),
      }),
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
  }

  const data = await upstreamRes.json();
  const usage = data.usage || {};

  return {
    response: new Response(JSON.stringify(data), {
      status: upstreamRes.status,
      headers: { "content-type": "application/json" },
    }),
    inputTokens: usage.prompt_tokens || 0,
    outputTokens: usage.completion_tokens || 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

async function proxyToAnthropic(
  provider: ProviderConfig,
  apiKey: string,
  body: ChatCompletionRequest,
  incomingHeaders: Headers
): Promise<ProxyResult> {
  // Convert OpenAI format to Anthropic format
  const anthropicBody = openaiToAnthropic(body);
  const url = `${provider.baseUrl}/v1/messages`;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": apiKey,
    ...provider.defaultHeaders,
  };

  // Forward anthropic-specific headers from client
  for (const key of ["anthropic-version", "anthropic-beta"]) {
    const val = incomingHeaders.get(key);
    if (val) headers[key] = val;
  }

  const upstreamRes = await fetchWithRetry(url, {
    method: "POST",
    headers,
    body: JSON.stringify(anthropicBody),
  });

  if (body.stream) {
    return {
      response: new Response(upstreamRes.body, {
        status: upstreamRes.status,
        headers: passHeaders(upstreamRes),
      }),
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
  }

  const data = await upstreamRes.json();
  const usage = data.usage || {};

  // Convert Anthropic response to OpenAI format
  const openaiResponse = anthropicToOpenai(data, body.model);

  return {
    response: new Response(JSON.stringify(openaiResponse), {
      status: upstreamRes.status,
      headers: { "content-type": "application/json" },
    }),
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    cacheReadTokens: usage.cache_read_input_tokens || 0,
    cacheWriteTokens: usage.cache_creation_input_tokens || 0,
  };
}

// --- Format Conversion ---

function openaiToAnthropic(body: ChatCompletionRequest): AnthropicMessagesRequest {
  const messages = [...(body.messages || [])];
  let system: string | undefined;

  // Extract system message
  if (messages.length > 0 && messages[0].role === "system") {
    system = messages[0].content;
    messages.shift();
  }

  const result: AnthropicMessagesRequest = {
    model: body.model,
    messages,
    max_tokens: body.max_tokens || 4096,
  };

  if (system) result.system = system;
  if (body.stream) result.stream = true;
  if (body.temperature !== undefined) result.temperature = body.temperature;

  return result;
}

function anthropicToOpenai(data: any, model: string): any {
  if (data.error) return data;

  const content = data.content?.map((block: any) => block.text).join("") || "";

  return {
    id: data.id || `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: data.stop_reason === "end_turn" ? "stop" : data.stop_reason || "stop",
      },
    ],
    usage: {
      prompt_tokens: data.usage?.input_tokens || 0,
      completion_tokens: data.usage?.output_tokens || 0,
      total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
    },
  };
}

// --- Retry Logic ---

const RETRYABLE_STATUS = new Set([429, 529, 502, 503]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  attempt = 0
): Promise<Response> {
  const res = await fetch(url, init);

  if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES) {
    // Check Retry-After header
    const retryAfter = res.headers.get("retry-after");
    let delayMs = BASE_DELAY_MS * Math.pow(2, attempt);

    if (retryAfter) {
      const parsed = parseInt(retryAfter);
      if (!isNaN(parsed)) delayMs = parsed * 1000;
    }

    // Add jitter
    delayMs += Math.random() * 500;

    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return fetchWithRetry(url, init, attempt + 1);
  }

  return res;
}

// --- Headers ---

function passHeaders(res: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  const pass = ["content-type", "x-request-id", "request-id"];
  for (const key of pass) {
    const val = res.headers.get(key);
    if (val) headers[key] = val;
  }
  // SSE requires these
  if (res.headers.get("content-type")?.includes("text/event-stream")) {
    headers["content-type"] = "text/event-stream";
    headers["cache-control"] = "no-cache";
    headers["connection"] = "keep-alive";
  }
  return headers;
}
