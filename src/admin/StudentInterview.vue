<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import GameDialog from '../components/GameDialog.vue';
import { request } from '../model';

const props = defineProps<{ blocked: boolean }>();
const invite = ref<{ eventDate: string } | null>(null);
const dismissedDate = ref('');
const busy = ref(false);
const issue = ref('');
let timer: number;
let checking = false;
let stopped = false;

async function check() {
  if (document.hidden || busy.value || checking) return;
  checking = true;
  try {
    const result = await request<{ interview: typeof invite.value }>('/api/preview/interview', {});
    if (!stopped && !busy.value) invite.value = result.interview;
  } catch {
    // The next foreground check retries without blocking the activity.
  } finally {
    checking = false;
  }
}

async function decline() {
  if (!invite.value || busy.value) return;
  const { eventDate } = invite.value;
  busy.value = true;
  issue.value = '';
  try {
    await request('/api/preview/interview/decline', { eventDate });
    dismissedDate.value = eventDate;
    invite.value = null;
  } catch (error) {
    issue.value = (error as Error).message;
  } finally {
    busy.value = false;
  }
}

onMounted(() => {
  void check();
  timer = window.setInterval(check, 60_000);
  document.addEventListener('visibilitychange', check);
});
onUnmounted(() => {
  stopped = true;
  window.clearInterval(timer);
  document.removeEventListener('visibilitychange', check);
});
</script>

<template>
  <GameDialog v-if="!props.blocked && invite && dismissedDate !== invite.eventDate" title="面谈邀约"
    @close="dismissedDate = invite.eventDate">
    <p class="dialog-description">请按时面谈。不能参加点放弃。</p>
    <p v-if="issue" class="inline-error" role="alert">{{ issue }}</p>
    <button type="button" class="secondary-button full-button" :disabled="busy" @click="decline">放弃</button>
  </GameDialog>
</template>
