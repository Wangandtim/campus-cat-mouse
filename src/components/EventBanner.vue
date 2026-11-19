<script setup lang="ts">
import { computed } from 'vue';
import { ChevronDown, Clock3, MapPin } from 'lucide-vue-next';
import { campus, type GameState, type StageId } from '../model';

const props = defineProps<{ stage: GameState['stage']; now: number; busy: boolean }>();
const emit = defineEmits<{ stage: [value: StageId] }>();

const clock = computed(() => {
  const seconds = Math.max(0, Math.ceil((props.stage.endsAt - props.now) / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((part) => String(part).padStart(2, '0')).join(':');
});
</script>

<template>
  <section class="event-banner" aria-labelledby="event-title">
    <div class="event-banner-copy">
      <div class="event-location"><MapPin :size="15" /> {{ campus.name }} <span aria-hidden="true">·</span> 校园追光计划</div>
      <h1 id="event-title"><span>猫鼠</span>追缉令</h1>
      <p><Clock3 :size="15" /> <span>早场 06:30–08:10</span><span class="event-time-divider" aria-hidden="true"></span><span>晚场 17:30–20:30</span></p>
    </div>
    <div class="hero-mascots" aria-hidden="true">
      <img src="/chase-mascots.webp" alt="" decoding="async" fetchpriority="high" />
    </div>
    <div class="event-clock">
      <div class="clock-heading">
        <span class="live-mark" aria-hidden="true"></span>
        <label class="stage-select">
          <span class="sr-only">切换演示场次</span>
          <select :value="stage.id" :disabled="busy" @change="emit('stage', ($event.target as HTMLSelectElement).value as StageId)">
            <option value="evening">晚场演示</option>
            <option value="morning">早场演示</option>
          </select>
          <ChevronDown :size="14" aria-hidden="true" />
        </label>
      </div>
      <time class="event-clock-digits" aria-label="本场剩余时间">{{ clock }}</time>
      <span class="event-clock-label">本场剩余</span>
    </div>
  </section>
</template>
