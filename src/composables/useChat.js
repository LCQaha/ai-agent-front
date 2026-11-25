import { computed, getCurrentScope, onScopeDispose, reactive, ref } from 'vue';
import { APP_REGISTRY } from '../config/apps.js';
import { ChatRequestError, DEFAULT_TIMEOUT_MS, sendCompleteRequest, validateChatResponse } from '../api/chat.js';

function emptySession() {
  return {
    conversationId: null,
    messages: [],
    draft: '',
    error: '',
    outcome: 'idle',
    // Keep older failed drafts too if several requests fail while new text is being written.
    failedDrafts: [],
    get failedDraft() { return this.failedDrafts[0] ?? ''; },
    get failedDraftCount() { return this.failedDrafts.length; },
  };
}

// Also abort injected transports that ignore their signal; a late result must not change state.
async function waitForRequest(transport, parameters) {
  const { signal } = parameters;
  let rejectWaiting;
  const stopped = new Promise((resolve, reject) => { rejectWaiting = reject; });
  const onAbort = () => rejectWaiting(new ChatRequestError(
    'aborted', '已停止等待这次回复；这不代表服务器已取消处理。',
  ));
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal.aborted) onAbort();
    const response = await Promise.race([
      signal.aborted ? stopped : transport(parameters),
      stopped,
    ]);
    return validateChatResponse(response);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export function useChat({
  apps = APP_REGISTRY, transport = sendCompleteRequest,
  fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!apps.length || new Set(apps.map(app => app.id)).size !== apps.length) {
    throw new TypeError('Applications must have unique IDs and include at least one entry.');
  }
  const appMap = new Map(apps.map(app => [app.id, app]));
  const sessions = reactive(new Map(apps.map(app => [app.id, emptySession()])));
  const draftVersions = new Map(apps.map(app => [app.id, 0]));
  const selectedId = ref(apps[0].id);
  const activeAppId = computed(() => selectedId.value);
  const activeApp = computed(() => appMap.get(selectedId.value));
  const session = computed(() => sessions.get(selectedId.value));
  const isPending = ref(false);
  const sentMessage = ref('');
  const pending = computed(() => isPending.value);
  const pendingMessage = computed(() => sentMessage.value);
  let currentRequest = null;
  let disposed = false;

  function setDraft(value) {
    if (disposed) return false;
    session.value.draft = String(value);
    session.value.error = '';
    if (!isPending.value) session.value.outcome = 'idle';
    draftVersions.set(selectedId.value, draftVersions.get(selectedId.value) + 1);
    return true;
  }

  function selectApp(appId) {
    if (disposed || isPending.value) return false;
    if (!appMap.has(appId)) throw new RangeError('Unknown application ID.');
    selectedId.value = appId;
    return true;
  }

  function newConversation() {
    if (disposed || isPending.value) return false;
    sessions.set(selectedId.value, emptySession());
    draftVersions.set(selectedId.value, 0);
    return true;
  }

  function restoreFailedDraft() {
    if (disposed || isPending.value || !session.value.failedDraft
      || session.value.draft.length !== 0) return false;
    setDraft(session.value.failedDrafts.shift());
    return true;
  }

  async function send({ delivery = 'complete' } = {}) {
    if (disposed) return { ok: false, code: 'disposed' };
    if (isPending.value) return { ok: false, ignored: true };
    const current = session.value;
    if (delivery !== 'complete') {
      current.error = '流式响应尚未接入，请使用完整回复。';
      current.outcome = 'error';
      return { ok: false, code: 'stream-unavailable' };
    }
    const originalDraft = current.draft;
    const message = originalDraft.trim();
    if (!message) {
      current.error = '请先输入消息。';
      current.outcome = 'error';
      return { ok: false, code: 'empty-message' };
    }

    const appId = selectedId.value;
    const versionAtSend = draftVersions.get(appId);
    const firstTurn = current.conversationId === null;
    const controller = new AbortController();
    currentRequest = controller;
    current.error = '';
    // Clear synchronously, before waiting: any text written afterwards is a new draft.
    current.draft = '';
    isPending.value = true;
    sentMessage.value = message;
    try {
      const response = await waitForRequest(transport, {
        app: appMap.get(appId), message, conversationId: current.conversationId,
        fetchImpl, timeoutMs, signal: controller.signal,
      });
      if (disposed || controller.signal.aborted) return { ok: false, code: 'disposed' };
      current.conversationId = response.conversationId;
      current.messages.push(
        { role: 'user', content: message },
        { role: 'assistant', content: response.answer },
      );
      current.outcome = 'success';
      // Never clear or replace the user's next draft here.
      return { ok: true };
    } catch (error) {
      if (disposed) return { ok: false, code: 'disposed' };
      current.error = error instanceof ChatRequestError
        ? error.message : '这次请求未完成，请检查后端服务后再试。';
      if (firstTurn) {
        current.error += ' 首轮未取得会话编号，可以重新发送；后台可能已执行上一条请求。';
      }
      if (draftVersions.get(appId) === versionAtSend) {
        current.draft = originalDraft;
      } else {
        current.failedDrafts.push(originalDraft);
      }
      current.outcome = 'error';
      return { ok: false, code: error instanceof ChatRequestError ? error.code : 'unknown' };
    } finally {
      if (currentRequest === controller) {
        currentRequest = null;
        isPending.value = false;
        sentMessage.value = '';
      }
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    currentRequest?.abort();
    isPending.value = false;
    sentMessage.value = '';
  }

  if (getCurrentScope()) onScopeDispose(dispose);
  return {
    activeApp, activeAppId, session, pending, pendingMessage,
    setDraft, selectApp, newConversation, send, restoreFailedDraft, dispose,
  };
}
