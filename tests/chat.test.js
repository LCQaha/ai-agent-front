import { effectScope } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_REGISTRY } from '../src/config/apps.js';
import { ChatRequestError, sendCompleteRequest, sendStreamRequest } from '../src/api/chat.js';
import { useChat } from '../src/composables/useChat.js';

const app = APP_REGISTRY[0];
const answer = (conversationId = 'conversation-a') => ({ conversationId, answer: '**模拟回复**' });
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const cleanups = [];
function createChat(options) {
  const chat = useChat(options);
  cleanups.push(chat.dispose);
  return chat;
}
afterEach(() => {
  cleanups.splice(0).forEach(dispose => dispose());
  vi.useRealTimers();
});

describe('complete response API', () => {
  it('registers only the available LoveApp endpoint', () => {
    expect(APP_REGISTRY).toHaveLength(1);
    expect(app).toMatchObject({ id: 'loveapp', endpoint: '/api/ai/love/v1', streamEndpoint: null });
  });

  it('omits the first conversation ID and sends the returned ID on continuation', async () => {
    const fetchImpl = vi.fn(async () => response(answer()));
    const chat = createChat({ fetchImpl });
    chat.setDraft(' 第一条消息 ');
    await chat.send();
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/ai/love/v1');
    expect(fetchImpl.mock.calls[0][1].method).toBe('POST');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ message: '第一条消息' });
    chat.setDraft('第二条消息');
    await chat.send();
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({
      message: '第二条消息', conversationId: 'conversation-a',
    });
    expect(chat.session.value.messages).toHaveLength(4);
  });

  it('does not read HTTP error bodies, retry or expose server internals', async () => {
    const readError = vi.fn(async () => ({ error: '<html>internal-secret</html>' }));
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, json: readError }));
    await expect(sendCompleteRequest({ app, message: '问题', fetchImpl })).rejects.toMatchObject({
      code: 'http', message: expect.stringContaining('HTTP 500'),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(readError).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { answer: '回答' },
    { conversationId: ' ', answer: '回答' },
    { conversationId: 3, answer: '回答' },
    { conversationId: 'id', answer: ' \n ' },
    { conversationId: 'id', answer: 42 },
  ])('rejects malformed successful responses: %j', async (body) => {
    await expect(sendCompleteRequest({ app, message: '问题', fetchImpl: async () => response(body) }))
      .rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('sanitizes malformed JSON and network errors', async () => {
    await expect(sendCompleteRequest({ app, message: '问题', fetchImpl: async () => ({
      ok: true, status: 200, json: async () => { throw new SyntaxError('<html>secret</html>'); },
    }) })).rejects.toMatchObject({ code: 'invalid-json', message: expect.not.stringContaining('secret') });
    await expect(sendCompleteRequest({ app, message: '问题', fetchImpl: async () => {
      throw new TypeError('private-key-and-stack');
    } })).rejects.toMatchObject({ code: 'network', message: expect.not.stringContaining('private-key') });
  });

  it('times out even if the transport ignores its abort signal', async () => {
    vi.useFakeTimers();
    let signal;
    const waiting = sendCompleteRequest({ app, message: '问题', timeoutMs: 100,
      fetchImpl: (url, options) => { signal = options.signal; return new Promise(() => {}); },
    });
    const rejected = expect(waiting).rejects.toMatchObject({
      code: 'timeout', message: expect.stringContaining('服务器可能仍在处理'),
    });
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(signal.aborted).toBe(true);
  });

  it('supports aborting frontend waiting without claiming backend cancellation', async () => {
    const controller = new AbortController();
    const request = sendCompleteRequest({ app, message: '问题', signal: controller.signal,
      fetchImpl: () => new Promise(() => {}),
    });
    controller.abort();
    await expect(request).rejects.toMatchObject({
      code: 'aborted', message: expect.stringContaining('不代表服务器已取消'),
    });
  });

  it('does not start a request for an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn();
    await expect(sendCompleteRequest({ app, message: '问题', signal: controller.signal, fetchImpl }))
      .rejects.toMatchObject({ code: 'aborted' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('Vue conversation state', () => {
  it('clears the input immediately and preserves the next draft when the answer arrives', async () => {
    const network = deferred();
    const transport = vi.fn(() => network.promise);
    const chat = createChat({ transport });
    chat.setDraft('已经发送的消息');
    const sending = chat.send();
    expect(chat.session.value.draft).toBe('');
    expect(chat.pending.value).toBe(true);
    expect(chat.pendingMessage.value).toBe('已经发送的消息');
    chat.setDraft('等待时写的下一条');
    network.resolve(answer());
    await sending;
    expect(chat.session.value.draft).toBe('等待时写的下一条');
    expect(chat.session.value.messages[0].content).toBe('已经发送的消息');
    expect(chat.session.value.messages[1].content).toBe('**模拟回复**');
    expect(chat.pending.value).toBe(false);
  });

  it('restores an unchanged original draft on failure without accepting a new ID', async () => {
    const network = deferred();
    const chat = createChat({ transport: () => network.promise });
    chat.setDraft('  原始草稿\n');
    const sending = chat.send();
    expect(chat.session.value.draft).toBe('');
    network.reject(new ChatRequestError('network', '网络暂时不可用。'));
    await sending;
    expect(chat.session.value.draft).toBe('  原始草稿\n');
    expect(chat.session.value.failedDraft).toBe('');
    expect(chat.session.value.conversationId).toBe(null);
    expect(chat.session.value.messages).toEqual([]);
    expect(chat.session.value.error).toContain('后台可能已执行');
  });

  it('preserves a new draft and offers an explicit, non-overwriting failed-draft restore', async () => {
    const network = deferred();
    const chat = createChat({ transport: () => network.promise });
    chat.setDraft('发送失败的原稿');
    const sending = chat.send();
    chat.setDraft('不能覆盖的新稿');
    network.reject(new Error('raw-secret-error'));
    await sending;
    expect(chat.session.value.draft).toBe('不能覆盖的新稿');
    expect(chat.session.value.failedDraft).toBe('发送失败的原稿');
    expect(chat.session.value.error).not.toContain('raw-secret-error');
    expect(chat.restoreFailedDraft()).toBe(false);
    expect(chat.session.value.draft).toBe('不能覆盖的新稿');
    chat.setDraft('');
    expect(chat.restoreFailedDraft()).toBe(true);
    expect(chat.session.value.draft).toBe('发送失败的原稿');
    expect(chat.session.value.failedDraft).toBe('');
  });

  it('does not replace an intentionally edited-and-cleared draft after a failure', async () => {
    const network = deferred();
    const chat = createChat({ transport: () => network.promise });
    chat.setDraft('原稿');
    const sending = chat.send();
    chat.setDraft('新稿');
    chat.setDraft('');
    network.reject(new Error('failed'));
    await sending;
    expect(chat.session.value.draft).toBe('');
    expect(chat.session.value.failedDraft).toBe('原稿');
  });

  it('keeps multiple failed drafts available instead of overwriting an earlier failure', async () => {
    let network = deferred();
    const chat = createChat({ transport: () => network.promise });
    chat.setDraft('第一份');
    const first = chat.send();
    chat.setDraft('第二份');
    network.reject(new Error('failed'));
    await first;
    network = deferred();
    const second = chat.send();
    chat.setDraft('第三份');
    network.reject(new Error('failed'));
    await second;
    expect(chat.session.value.failedDraftCount).toBe(2);
    chat.setDraft('');
    expect(chat.restoreFailedDraft()).toBe(true);
    expect(chat.session.value.draft).toBe('第一份');
    chat.setDraft('');
    expect(chat.restoreFailedDraft()).toBe(true);
    expect(chat.session.value.draft).toBe('第二份');
  });

  it('blocks duplicate sends, app switches and session resets while pending', async () => {
    const network = deferred();
    const transport = vi.fn(() => network.promise);
    const chat = createChat({ transport });
    chat.setDraft('仅发一次');
    const sending = chat.send();
    expect(await chat.send()).toEqual({ ok: false, ignored: true });
    expect(chat.selectApp(app.id)).toBe(false);
    expect(chat.newConversation()).toBe(false);
    expect(transport).toHaveBeenCalledTimes(1);
    network.resolve(answer());
    await sending;
  });

  it('isolates apps and starts a new conversation without affecting other apps', async () => {
    const apps = [app, { ...app, id: 'fixture', endpoint: '/fixture' }];
    const transport = vi.fn(async ({ app: selected }) => answer(`id-${selected.id}`));
    const chat = createChat({ apps, transport });
    chat.setDraft('LoveApp问题');
    await chat.send();
    chat.setDraft('LoveApp草稿');
    chat.selectApp('fixture');
    expect(chat.session.value.conversationId).toBe(null);
    chat.setDraft('另一应用问题');
    await chat.send();
    expect(chat.session.value.conversationId).toBe('id-fixture');
    chat.selectApp(app.id);
    expect(chat.session.value.conversationId).toBe('id-loveapp');
    expect(chat.session.value.draft).toBe('LoveApp草稿');
    expect(chat.session.value.messages).toHaveLength(2);
    chat.newConversation();
    expect(chat.session.value.conversationId).toBe(null);
    expect(chat.session.value.draft).toBe('');
    expect(chat.session.value.messages).toEqual([]);
    chat.selectApp('fixture');
    expect(chat.session.value.conversationId).toBe('id-fixture');
  });

  it('keeps an existing ID after a malformed continuation response', async () => {
    const transport = vi.fn().mockResolvedValueOnce(answer('existing'))
      .mockResolvedValueOnce({ conversationId: 'replacement', answer: '' });
    const chat = createChat({ transport });
    chat.setDraft('第一轮');
    await chat.send();
    chat.setDraft('第二轮');
    expect((await chat.send()).code).toBe('invalid-response');
    expect(chat.session.value.conversationId).toBe('existing');
    expect(chat.session.value.draft).toBe('第二轮');
    expect(chat.session.value.messages).toHaveLength(2);
  });

  it('creates fresh state for a new page instance', async () => {
    const chat = createChat({ transport: async () => answer() });
    chat.setDraft('旧页面');
    await chat.send();
    const fresh = createChat({ transport: async () => answer() });
    expect(fresh.session.value.conversationId).toBe(null);
    expect(fresh.session.value.messages).toEqual([]);
  });

  it('dispose stops waiting and ignores a late reply, including transports that ignore abort', async () => {
    const network = deferred();
    let signal;
    const chat = createChat({ transport: parameters => {
      signal = parameters.signal;
      return network.promise;
    } });
    chat.setDraft('待回复');
    const sending = chat.send();
    chat.dispose();
    expect(signal.aborted).toBe(true);
    expect(chat.pending.value).toBe(false);
    expect(await sending).toEqual({ ok: false, code: 'disposed' });
    network.resolve(answer('late-id'));
    await Promise.resolve();
    expect(chat.session.value.conversationId).toBe(null);
    expect(chat.session.value.messages).toEqual([]);
    expect((await chat.send()).code).toBe('disposed');
  });

  it('registers disposal with the Vue effect scope', async () => {
    const scope = effectScope();
    let signal;
    const chat = scope.run(() => useChat({ transport: parameters => {
      signal = parameters.signal;
      return new Promise(() => {});
    } }));
    chat.setDraft('待回复');
    const sending = chat.send();
    scope.stop();
    expect(signal.aborted).toBe(true);
    expect((await sending).code).toBe('disposed');
  });

  it('does not send empty messages or an unimplemented stream request', async () => {
    const transport = vi.fn();
    const chat = createChat({ transport });
    chat.setDraft(' \n ');
    expect((await chat.send()).code).toBe('empty-message');
    chat.setDraft('待发送');
    expect((await chat.send({ delivery: 'stream' })).code).toBe('stream-unavailable');
    expect(chat.session.value.draft).toBe('待发送');
    expect(transport).not.toHaveBeenCalled();
    await expect(sendStreamRequest()).rejects.toMatchObject({ code: 'stream-unavailable' });
  });
});
