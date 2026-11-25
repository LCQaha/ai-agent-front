import { EventSourceParserStream } from 'eventsource-parser/stream';

export const DEFAULT_TIMEOUT_MS = 150_000;

export class ChatRequestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ChatRequestError';
    this.code = code;
  }
}

const abortedError = () => new ChatRequestError(
  'aborted', '已停止等待这次回复；这不代表服务器已取消处理。',
);

function httpError(status) {
  const messages = {
    400: '请求参数有误，请检查输入后再发送。',
    401: '请求未获授权，请检查后端访问权限或模型配置。',
    403: '请求未获授权，请检查后端访问权限或模型配置。',
    404: '未找到聊天接口，请确认后端已更新并启动。',
    405: '聊天接口不支持当前请求方式，请检查后端接口配置。',
    408: '后端响应超时，服务器可能仍在处理这次请求。',
    429: '请求过于频繁或模型额度受限，请稍后再试并检查额度。',
    504: '后端响应超时，服务器可能仍在处理这次请求。',
  };
  return new ChatRequestError('http', messages[status]
    ?? `后端暂时无法完成请求（HTTP ${status}），请查看后端运行日志。`);
}

export function validateChatResponse(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)
    || typeof data.conversationId !== 'string' || !data.conversationId.trim()
    || typeof data.answer !== 'string' || !data.answer.trim()) {
    throw new ChatRequestError('invalid-response',
      '后端响应缺少有效的会话编号或回答，请检查聊天接口的响应格式。');
  }
  return { conversationId: data.conversationId.trim(), answer: data.answer };
}

export function sendCompleteRequest({ app, validateResponse = validateChatResponse, ...options }) {
  return postChat({
    ...options, endpoint: app?.endpoint, accept: 'application/json',
    async read(response) {
      let body;
      try {
        body = await response.json();
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new ChatRequestError('invalid-json',
            '后端返回的内容不是有效 JSON，请检查聊天接口的响应格式。');
        }
        throw new ChatRequestError('network', '读取回复时连接中断，请检查网络和后端服务。');
      }
      return validateResponse(body);
    },
  });
}

export async function sendStreamRequest({ app, onText, ...options } = {}) {
  if (!app?.streamEndpoint) {
    throw new ChatRequestError('stream-unavailable', '当前应用暂未开放流式输出。');
  }
  return postChat({
    ...options, endpoint: app.streamEndpoint, accept: 'text/plain',
    async read(response, signal) {
      const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (type !== 'text/plain' || !response.body) {
        throw new ChatRequestError('invalid-response', '后端未返回纯文本流，请检查流式接口。');
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      const cancel = () => { void reader.cancel().catch(() => {}); };
      signal.addEventListener('abort', cancel, { once: true });
      let hasContent = false;
      try {
        while (!signal.aborted) {
          const { done, value } = await reader.read();
          const text = done ? decoder.decode() : decoder.decode(value, { stream: true });
          if (text && !signal.aborted) {
            onText(text);
            if (text.trim()) hasContent = true;
          }
          if (done) break;
        }
      } finally {
        signal.removeEventListener('abort', cancel);
        reader.releaseLock();
      }
      if (!hasContent && !signal.aborted) {
        throw new ChatRequestError('invalid-response', 'BaseChat 返回的文本流缺少回答正文。');
      }
    },
  });
}

function readEventData(data) {
  try {
    return JSON.parse(data);
  } catch {
    throw new ChatRequestError('invalid-response', '事件流中的 data 不是有效 JSON。');
  }
}

export function sendEventStreamRequest({ app, onText, onStage, ...options }) {
  return postChat({
    ...options, endpoint: app.eventStreamEndpoint, accept: 'text/event-stream',
    async read(response, signal) {
      const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (type !== 'text/event-stream' || !response.body) {
        throw new ChatRequestError('invalid-response', '后端未返回 SSE 事件流，请检查事件流接口。');
      }
      const events = response.body
        .pipeThrough(new TextDecoderStream(), { signal })
        .pipeThrough(new EventSourceParserStream());
      for await (const { event, data } of events) {
        if (event === 'turn.started' || event === 'generation.started') {
          onStage(event);
        } else if (event === 'answer.delta') {
          const text = readEventData(data)?.text;
          if (typeof text !== 'string') {
            throw new ChatRequestError('invalid-response', 'answer.delta 缺少文本字段 text。');
          }
          onText(text);
        } else if (event === 'turn.finished') {
          const status = readEventData(data)?.status;
          if (status === 'completed') return;
          if (status === 'failed') {
            throw new ChatRequestError('generation-failed', '后端报告本轮生成失败。');
          }
          throw new ChatRequestError('invalid-response', 'turn.finished 返回了无效的结束状态。');
        }
      }
      throw new ChatRequestError('incomplete-stream', '事件流提前关闭，未收到 turn.finished。');
    },
  });
}

// A retry can submit the same prompt twice.
async function postChat({
  endpoint, accept, read, message, conversationId = null, fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS, signal,
}) {
  if (typeof message !== 'string' || !message.trim()) {
    throw new ChatRequestError('empty-message', '请先输入消息。');
  }
  if (!endpoint || typeof fetchImpl !== 'function') {
    throw new ChatRequestError('unavailable', '当前聊天服务不可用，请检查应用配置。');
  }
  if (signal?.aborted) throw abortedError();
  const payload = { message: message.trim() };
  if (conversationId !== null && conversationId !== undefined) {
    if (typeof conversationId !== 'string' || !conversationId.trim()) {
      throw new ChatRequestError('invalid-conversation', '会话编号无效，请新建会话后再试。');
    }
    payload.conversationId = conversationId;
  }

  const controller = new AbortController();
  let stopReason = null;
  let rejectWaiting;
  const stopped = new Promise((resolve, reject) => { rejectWaiting = reject; });
  const stopWaiting = (reason) => {
    if (stopReason) return;
    stopReason = reason;
    controller.abort();
    rejectWaiting(reason);
  };
  const onAbort = () => stopWaiting(abortedError());
  signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => stopWaiting(new ChatRequestError('timeout',
    '等待回复超时，服务器可能仍在处理这次请求。请稍后检查，再决定是否重新发送。')), timeoutMs);

  const request = async () => {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: accept },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    // Do not read or show an error page, raw exception or other server internals.
    if (!response.ok) throw httpError(response.status);
    if (stopReason) throw stopReason;
    return read(response, controller.signal);
  };

  try {
    return await Promise.race([request(), stopped]);
  } catch (error) {
    if (stopReason) throw stopReason;
    if (error instanceof ChatRequestError) throw error;
    throw new ChatRequestError('network', '无法连接聊天服务，请检查网络和后端是否正在运行。');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}
