<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { X } from 'lucide-vue-next';

defineProps<{ title: string }>();
const emit = defineEmits<{ close: [] }>();
const element = ref<HTMLDialogElement>();
onMounted(() => element.value?.showModal());
</script>

<template>
  <dialog ref="element" class="game-dialog" :aria-label="title" @close="emit('close')" @cancel.prevent="emit('close')"
    @click.self="emit('close')">
    <div class="dialog-inner">
      <div class="dialog-heading">
        <h2>{{ title }}</h2>
        <button type="button" class="icon-button dialog-close" aria-label="关闭" @click="emit('close')"><X :size="20" /></button>
      </div>
      <slot />
    </div>
  </dialog>
</template>
