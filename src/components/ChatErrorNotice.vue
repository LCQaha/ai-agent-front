<script setup>
import { onMounted, onUnmounted, ref, watch } from 'vue';

const props = defineProps({ session: { type: Object, required: true } });
const previewEnabled = import.meta.env.DEV || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const lastReason = ref(props.session.error);
const open = ref(false);
const trigger = ref(null);
const closeButton = ref(null);

watch(() => props.session, () => {
  lastReason.value = '';
  open.value = false;
});
watch([() => props.session.error, () => props.session.outcome], ([reason, outcome]) => {
  if (reason) lastReason.value = reason;
  else if (outcome === 'success') lastReason.value = '';
  open.value = Boolean(reason);
});

function closeNotice() {
  if (document.activeElement === closeButton.value) trigger.value?.focus();
  open.value = false;
}

function onShortcut(event) {
  if (event.isComposing || event.keyCode === 229 || event.repeat || event.defaultPrevented) return;
  if (event.key === 'Escape' && open.value) {
    event.preventDefault();
    closeNotice();
  } else if (event.code === 'KeyE' && event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey
      && (previewEnabled || lastReason.value)) {
    event.preventDefault();
    open.value = !open.value;
  }
}

onMounted(() => window.addEventListener('keydown', onShortcut));
onUnmounted(() => window.removeEventListener('keydown', onShortcut));
</script>

<template>
  <button v-if="previewEnabled || lastReason" id="firstapp-error-trigger" ref="trigger" type="button"
          class="notice-trigger" aria-controls="firstapp-error-notice" :aria-expanded="open"
          aria-keyshortcuts="Alt+Shift+E" title="打开或收起提示（Mac：Option + Shift + E，Windows：Alt + Shift + E）"
          @click="open = !open">
    {{ lastReason ? '查看错误原因' : '预览错误提示' }} <kbd aria-hidden="true">Alt ⇧ E</kbd>
  </button>
  <aside v-if="open" id="firstapp-error-notice" class="chat-notice" aria-labelledby="firstapp-error-title">
    <div :role="lastReason ? 'alert' : 'status'" aria-atomic="true">
      <strong id="firstapp-error-title">{{ lastReason ? '这次回复未能完成' : '错误提示预览' }}</strong>
      <p>{{ lastReason || '示例：连接模型服务超时。稍等片刻，再发送一次试试。' }}</p>
    </div>
    <button ref="closeButton" type="button" class="notice-close" aria-label="关闭提示" title="关闭（Esc）" @click="closeNotice">×</button>
  </aside>
</template>

<style scoped>
.notice-trigger { min-height: 36px; padding: 5px 6px; color: var(--muted); font-size: 12px; background: transparent; border: 0; border-radius: 6px; }
.notice-trigger:hover, .notice-trigger[aria-expanded="true"] { color: var(--ink); background: var(--paper); }
.notice-trigger kbd { margin-left: 3px; padding: 2px 4px; border: 1px solid var(--line); border-radius: 4px; font: 10px/1.2 system-ui, sans-serif; }
.chat-notice {
  position: absolute; z-index: 2; top: calc(100% + 4px); left: 18px; width: min(355px, calc(100% - 36px));
  display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; padding: 14px 14px 14px 16px;
  border: 1px solid #dcc9a7; border-radius: 12px; background: #fffaf0; color: #5d4926;
  box-shadow: 0 6px 18px #40351418; animation: notice-in .16s ease-out;
}
.chat-notice::before {
  content: ''; position: absolute; top: -6px; left: 19px; width: 9px; height: 9px; transform: rotate(45deg);
  background: #fffaf0; border-left: 1px solid #dcc9a7; border-top: 1px solid #dcc9a7;
}
.chat-notice strong { font-size: 14px; }
.chat-notice p { margin: 5px 0 0; font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
.notice-close { flex: none; display: grid; place-items: center; width: 28px; height: 28px; border: 0; border-radius: 6px; background: transparent; color: inherit; font-size: 20px; line-height: 1; }
.notice-close:hover { background: #f2e6d1; }
@keyframes notice-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
@media (max-width: 640px) { .notice-trigger kbd { display: none; } }
</style>
