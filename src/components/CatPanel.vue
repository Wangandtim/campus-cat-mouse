<script setup lang="ts">
import { computed, ref } from 'vue';
import { ArrowUpRight, Cat, ChevronDown, ChevronRight, Footprints, Rat, ScanLine, Zap } from 'lucide-vue-next';
import { distanceLabel, kilometers, type GameState, type ZoneView } from '../model';

const props = defineProps<{ stats: GameState['stats']; zones: ZoneView[]; selected: ZoneView; sessionCap: number }>();
const emit = defineEmits<{ select: [id: string]; scan: []; records: []; role: [] }>();
const expanded = ref(false);
const visibleZones = computed(() => {
  if (expanded.value) return props.zones;
  const closest = props.zones.slice(0, 3);
  return closest.some(({ id }) => id === props.selected.id) ? closest : [...closest.slice(0, 2), props.selected];
});
</script>

<template>
  <div class="side-stack">
    <section class="panel mission-panel" aria-labelledby="mission-title">
      <div class="panel-heading mission-heading">
        <div><span class="role-label"><Cat :size="15" aria-hidden="true" /> 猫阵营</span><h2 id="mission-title">追捕面板</h2></div>
        <button type="button" class="text-button" @click="emit('role')">切换身份 <ChevronRight :size="15" /></button>
      </div>
      <div class="mission-stats">
        <div><span>活动里程</span><strong>{{ kilometers(stats.meters) }} <small>km</small></strong></div>
        <div><span>本场积分</span><strong>{{ stats.sessionPoints }} <small>/ {{ sessionCap }}</small></strong></div>
      </div>
      <div class="energy">
        <div class="energy-label">
          <span><Zap :size="15" /> 追捕体力</span>
          <strong>{{ stats.energy }}<small> / 100 米</small></strong>
        </div>
        <progress :value="stats.energy" max="100" aria-label="追捕体力"></progress>
      </div>
      <button type="button" class="primary-button scan-button" @click="emit('scan')">
        <ScanLine :size="20" /> 扫码抓捕 <ArrowUpRight :size="18" class="button-end" />
      </button>
      <button v-if="stats.energy < 100" type="button" class="text-button distance-link" @click="emit('records')">
        <Footprints :size="15" /> 再移动 {{ 100 - stats.energy }} 米即可扫码 <ChevronRight :size="15" />
      </button>
    </section>

    <section class="panel zone-panel" aria-labelledby="zones-title">
      <div class="panel-heading zone-heading">
        <h2 id="zones-title">附近鼠迹</h2>
        <button type="button" class="text-button" :aria-expanded="expanded" @click="expanded = !expanded">
          {{ expanded ? '收起' : '全部区域' }} <ChevronDown :size="15" :class="{ flipped: expanded }" />
        </button>
      </div>
      <div class="zone-list">
        <button v-for="zone in visibleZones" :key="zone.id" type="button" class="zone-row"
          :class="{ 'zone-row-active': selected.id === zone.id }" :aria-pressed="selected.id === zone.id"
          @click="emit('select', zone.id)">
          <span class="zone-glyph"><Rat :size="19" :stroke-width="1.75" /></span>
          <span class="zone-row-title"><strong>{{ zone.name }}</strong><small>约 {{ distanceLabel(zone.distance) }}</small></span>
          <span class="zone-count" :class="{ 'zone-locked': zone.cooldown > 0 }">
            {{ zone.cooldown > 0 ? `冷却 ${zone.cooldown}s` : zone.available.length ? `${zone.available.length} 条鼠迹` : '本场已完成' }}
          </span>
          <ChevronRight :size="15" class="zone-arrow" />
        </button>
      </div>
    </section>
  </div>
</template>
