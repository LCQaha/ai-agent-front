<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import MarkdownMessage from './components/MarkdownMessage.vue';
import BaseChatBenchmark from './components/BaseChatBenchmark.vue';
import { APP_REGISTRY } from './config/apps.js';
import { useChat } from './composables/useChat.js';

const {
  activeApp, activeAppId, session, pending, pendingMessage,
  setDraft, selectApp, newConversation, send, restoreFailedDraft,
} = useChat();
const workspaceView = ref('chat');
const messageInput = ref(null);
const messageList = ref(null);
const composing = ref(false);
const conversationLabel = computed(() => session.value.conversationId
  ? `会话 ${session.value.conversationId.slice(0, 8)}` : '新会话 · 尚未开始');
const requestStatus = computed(() => {
  if (pending.value) return '正在等待回复，你可以先写下一条消息。';
  if (session.value.error) return '发送未完成，请查看提示。';
  if (session.value.outcome === 'success') return '已收到回复，可以继续聊。';
  return '准备好了，随时开始。';
});

function focusInput() { nextTick(() => messageInput.value?.focus()); }

function submit() {
  if (composing.value || pending.value || !session.value.draft.trim()) return;
  // send() 在等待 HTTP 响应前清空当前草稿；输入框仍可写下一条。
  void send();
  focusInput();
}

function onKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey
      && !event.isComposing && !composing.value && event.keyCode !== 229 && !event.repeat) {
    event.preventDefault();
    submit();
  }
}

function useSuggestion(prompt) { setDraft(prompt); focusInput(); }
function startNewConversation() { if (newConversation()) focusInput(); }
function recoverDraft() { if (restoreFailedDraft()) focusInput(); }

watch([() => session.value.messages.length, pending, activeAppId], async () => {
  await nextTick();
  if (messageList.value) messageList.value.scrollTop = messageList.value.scrollHeight;
});
</script>

<template>
  <div class="page">
    <header class="site-header">
      <a class="brand" href="/" aria-label="AI Agent 首页">
        <span class="brand-mark" aria-hidden="true">AI</span>
        <span>AI Agent <span class="brand-caption">从零实现</span></span>
      </a>
      <nav class="header-nav" aria-label="开发资源">
        <a href="/api/health" target="_blank" rel="noopener">健康检查 ↗</a>
        <a class="docs-link" href="/swagger-ui.html" target="_blank" rel="noopener">接口文档 ↗</a>
      </nav>
    </header>

    <main>
      <div class="page-heading">
        <div><p class="eyebrow">YOUR AI WORKSPACE</p><h1>AI 应用工作台</h1></div>
        <div class="workspace-switch" role="group" aria-label="工作台视图">
          <button type="button" aria-controls="chat-workspace" :aria-pressed="workspaceView === 'chat'"
                  @click="workspaceView = 'chat'">聊天</button>
          <button type="button" aria-controls="benchmark-workspace" :aria-pressed="workspaceView === 'benchmark'"
                  @click="workspaceView = 'benchmark'">BaseChat Benchmark</button>
        </div>
      </div>
      <div v-show="workspaceView === 'chat'" id="chat-workspace" class="workspace">
        <aside class="app-panel" aria-label="应用与对话设置">
          <div class="panel-label"><span class="section-number">01</span> 选择应用</div>
          <label for="app-select">当前应用</label>
          <select id="app-select" :value="activeAppId" :disabled="pending"
                  aria-describedby="app-description" @change="selectApp($event.target.value)">
            <option v-for="app in APP_REGISTRY" :key="app.id" :value="app.id">{{ app.name }}</option>
          </select>
          <div class="app-summary">
            <span class="heart-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/></svg></span>
            <h2>关系里的小事，<br>都可以慢慢说。</h2>
            <p id="app-description">{{ activeApp.description }}</p>
            <span class="feature-tag"><span aria-hidden="true"></span> 支持多轮对话</span>
          </div>
          <div class="delivery-settings">
            <p class="delivery-label">回复方式</p>
            <button id="stream-toggle" class="secondary-button stream-toggle" type="button"
                    aria-describedby="delivery-hint" disabled>开启流式输出</button>
            <p id="delivery-hint" class="field-hint">流式输出暂未开放，当前显示完整回复。</p>
          </div>
          <div class="session-note"><span class="note-mark" aria-hidden="true">↳</span>
            <p>每次新建会话，都从新的话题开始。刷新页面也会开启新会话。</p>
          </div>
        </aside>

        <section class="chat-panel" aria-labelledby="active-app-name">
          <div class="chat-header">
            <div class="chat-heading">
              <span class="app-avatar" aria-hidden="true">{{ activeApp.name.charAt(0) }}</span>
              <div><h2 id="active-app-name">{{ activeApp.name }}</h2>
                <p id="conversation-label" :title="session.conversationId || ''">{{ conversationLabel }}</p>
              </div>
            </div>
            <button id="new-chat" class="secondary-button" type="button" :disabled="pending" @click="startNewConversation">＋ 新建会话</button>
          </div>

          <div class="chat-body">
            <div v-if="!session.messages.length && !pending" class="empty-state">
              <div class="welcome-symbol" aria-hidden="true"><svg viewBox="0 0 48 48"><path d="M37 28a15 15 0 1 0-25 7l-2 8 9-3a15 15 0 0 0 18-12Z"/><path d="M17 21c0-5 7-5 7 0 0-5 7-5 7 0 0 4-7 8-7 8s-7-4-7-8Z"/></svg></div>
              <p class="welcome-eyebrow">留一点时间，聊聊你自己</p>
              <h2>今天，想从哪里说起？</h2>
              <p class="welcome-description">不必组织好所有语言。一个小困惑，也可以是开始。</p>
              <div class="suggestions" aria-label="话题建议">
                <button v-for="suggestion in activeApp.suggestions" :key="suggestion.label" type="button"
                        @click="useSuggestion(suggestion.prompt)">{{ suggestion.label }} <span aria-hidden="true">↗</span></button>
              </div>
            </div>
            <div ref="messageList" id="messages" class="messages" role="log" aria-live="polite" aria-relevant="additions" aria-label="对话记录">
              <article v-for="(message, index) in session.messages" :key="`${activeAppId}-${index}`"
                       class="message" :class="`message--${message.role}`">
                <span class="message-avatar" aria-hidden="true">{{ message.role === 'user' ? '你' : activeApp.name.charAt(0) }}</span>
                <div class="message-content">
                  <div class="message-role">{{ message.role === 'user' ? '你' : activeApp.name }}</div>
                  <p v-if="message.role === 'user'" class="message-text">{{ message.content }}</p>
                  <MarkdownMessage v-else class="message-text" :content="message.content" />
                </div>
              </article>
              <template v-if="pending">
                <article class="message message--user">
                  <span class="message-avatar" aria-hidden="true">你</span>
                  <div class="message-content"><div class="message-role">你</div><p class="message-text">{{ pendingMessage }}</p></div>
                </article>
                <article class="message message--pending">
                  <span class="message-avatar" aria-hidden="true">{{ activeApp.name.charAt(0) }}</span>
                  <div class="message-content"><div class="message-role">{{ activeApp.name }}</div><p class="message-text">正在认真想一想…</p></div>
                </article>
              </template>
            </div>
          </div>

          <div class="composer-area">
            <p v-if="session.error" id="error-message" class="error-message" role="alert">{{ session.error }}</p>
            <div v-if="session.failedDraft" class="failed-draft" role="status">
              <p>已保留 {{ session.failedDraftCount }} 条发送失败的原文。当前草稿不会被覆盖。</p>
              <details><summary>查看待恢复原文</summary><p class="failed-draft-text">{{ session.failedDraft }}</p></details>
              <button class="secondary-button" type="button" :disabled="pending || session.draft.length > 0" @click="recoverDraft">恢复到输入框</button>
              <span v-if="session.draft.length > 0">先保存或清空当前草稿，即可恢复。</span>
            </div>
            <form id="chat-form" @submit.prevent="submit">
              <label class="visually-hidden" for="message-input">输入消息</label>
              <div class="composer">
                <textarea ref="messageInput" id="message-input" name="message" rows="3"
                          :value="session.draft" placeholder="写下你此刻的想法…" aria-describedby="keyboard-hint request-status"
                          @input="setDraft($event.target.value)" @keydown="onKeydown"
                          @compositionstart="composing = true" @compositionend="composing = false"></textarea>
                <div class="composer-toolbar">
                  <span id="keyboard-hint">Enter 发送 · Shift + Enter 换行</span>
                  <button id="send-button" class="send-button" type="submit" :disabled="pending || !session.draft.trim()">{{ pending ? '等待回复…' : '发送 ↗' }}</button>
                </div>
              </div>
            </form>
            <div class="composer-caption"><span id="request-status" role="status">{{ requestStatus }}</span><span>{{ activeApp.name }} · 对话空间</span></div>
          </div>
        </section>
      </div>

      <BaseChatBenchmark v-show="workspaceView === 'benchmark'" id="benchmark-workspace" />

      <details class="developer-resources">
        <summary><span>开发资源</span><span class="resource-summary">文档、接口与官方参考 ＋</span></summary>
        <div class="resource-grid">
          <a href="/swagger-ui.html" target="_blank" rel="noopener"><strong>接口文档 ↗</strong><span>查看参数，在 Swagger 中调试</span></a>
          <a href="/api/health" target="_blank" rel="noopener"><strong>健康检查 ↗</strong><span>检查 HTTP 服务是否可访问</span></a>
          <a href="/v3/api-docs" target="_blank" rel="noopener"><strong>OpenAPI JSON ↗</strong><span>查看机器可读的接口描述</span></a>
        </div>
        <nav class="references" aria-label="官方参考文档">
          <a href="https://vuejs.org/guide/" target="_blank" rel="noopener noreferrer">Vue 3 ↗</a>
          <a href="https://docs.spring.io/spring-ai/reference/" target="_blank" rel="noopener noreferrer">Spring AI ↗</a>
          <a href="https://springdoc.org/" target="_blank" rel="noopener noreferrer">SpringDoc ↗</a>
        </nav>
      </details>
    </main>
    <footer><span>AI Agent · 从零实现</span><span>一步一步，把想法变成应用。</span></footer>
  </div>
</template>
