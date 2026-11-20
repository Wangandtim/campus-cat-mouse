<script setup lang="ts">
import { Activity, CirclePause, Footprints, Play, Rat, Zap } from 'lucide-vue-next';
import { computed } from 'vue';
import { campus, kilometers, shanghaiTime, type GameState } from '../model';

const props = defineProps<{ game: GameState; busy: boolean; now: number; demo: boolean }>();
const emit = defineEmits<{ track: [active: boolean]; exit: []; walk: [] }>();
const participation = computed(() => props.game.participation);
const status = computed(() => {
  const entry = participation.value;
  if (!entry) return props.game.stats.tracking ? '记录中' : '已暂停';
  if (entry.status === 'void') return '本场已作废';
  if (entry.status === 'settled') return '本场已结算';
  if (!entry.open) return '场次未开放';
  if (entry.dataGap) return '定位中断';
  if (entry.status === 'active') return '记录中';
  if (entry.status === 'exited') return '已退出';
  return entry.status === 'paused' ? '已暂停' : '未开始';
});
const pace = computed(() => {
  const entry = participation.value;
  if (!entry?.deadline || !entry.open || !entry.requiredMeters) return '';
  if (entry.completedAt !== null && entry.completedAt <= entry.deadline) return '本场配速已达标。';
  if (props.now > entry.deadline) return '已超过本场配速时限。';
  const seconds = Math.ceil((entry.deadline - props.now) / 1000);
  return `请在剩余 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒内完成 ${entry.requiredMeters / 1000} 公里。`;
});
</script>

<template>
  <section class="inner-page records-page" aria-labelledby="records-title">
    <div class="page-title">
      <div class="page-title-icon"><Activity :size="27" /></div>
      <div><h1 id="records-title">运动记录</h1><p>查看本场里程、游戏积分与抓捕记录。</p></div>
    </div>
    <div class="record-grid">
      <section class="panel record-summary" aria-labelledby="record-summary-title">
        <div class="panel-heading">
          <div><h2 id="record-summary-title">{{ game.stage.label }}运动</h2><p>{{ game.stage.hours }}</p></div>
          <span class="neutral-chip"><span class="status-dot" :class="{ active: game.stats.tracking && !participation?.dataGap }"></span>{{ status }}</span>
        </div>
        <div class="record-number"><Footprints :size="23" /><strong>{{ kilometers(game.stats.meters) }} <small>km</small></strong><span>本场活动里程</span></div>
        <div class="record-substats">
          <span>今日累计 <strong>{{ kilometers(game.stats.dailyMeters) }} km</strong></span>
          <span>今日积分 <strong>{{ game.stats.dailyPoints }} / {{ participation ? 250 : 200 }}</strong></span>
        </div>
        <div class="record-actions">
          <button type="button" class="primary-button" :disabled="busy || (participation && !participation.open)" @click="emit('track', !game.stats.tracking)">
            <CirclePause v-if="game.stats.tracking" :size="18" /><Play v-else :size="18" />
            {{ game.stats.tracking ? '暂停记录' : participation ? '开始参与' : '开始记录' }}
          </button>
          <button v-if="demo && !participation" type="button" class="secondary-button" :disabled="busy || !game.stats.tracking" @click="emit('walk')"><Footprints :size="18" /> 模拟步行 100 米</button>
          <button v-else-if="participation?.open && ['active', 'paused'].includes(participation.status)" type="button" class="secondary-button" :disabled="busy" @click="emit('exit')">退出本场</button>
        </div>
        <p v-if="demo && !participation" class="panel-footnote"><Zap :size="14" /> 演示步行会增加活动里程和追捕体力。</p>
        <p v-else-if="participation?.dataGap" class="panel-footnote" role="status">定位中断期间停止计程。中断记录可在结算后复核。</p>
        <p v-else-if="pace" class="panel-footnote">{{ pace }}</p>
        <p v-if="(game.stats.balance ?? 0) < 0" class="panel-footnote">待抵扣积分 {{ -(game.stats.balance ?? 0) }}，可用积分为 0。</p>
      </section>
      <section class="panel record-history" aria-labelledby="record-history-title">
        <div class="panel-heading"><div><h2 id="record-history-title">抓捕记录</h2><p>{{ game.stage.label }} · {{ game.stats.captures }} 次</p></div></div>
        <div v-if="!game.captures.length" class="empty-state record-empty"><Rat :size="31" /><p>本场还没有抓捕记录</p></div>
        <ul v-else class="capture-history">
          <li v-for="capture in game.captures" :key="capture.id">
            <span class="zone-glyph"><Rat :size="18" /></span>
            <div><strong>{{ String(capture.mouseId).padStart(2, '0') }} 号鼠</strong><small>{{ campus.zones.find(({ id }) => id === capture.zoneId)?.name }} · {{ shanghaiTime.format(capture.at) }}</small></div>
            <b>{{ capture.voided ? '积分已冲销' : `+${capture.award} 分` }}</b>
          </li>
        </ul>
      </section>
    </div>
  </section>
</template>
