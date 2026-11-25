<script setup>
import { computed } from 'vue'
import { renderMarkdown } from '../utils/markdown.js'

const props = defineProps({
  content: {
    type: String,
    default: '',
  },
})

const safeHtml = computed(() => renderMarkdown(props.content))
</script>

<template>
  <div class="markdown-message" v-html="safeHtml"></div>
</template>
