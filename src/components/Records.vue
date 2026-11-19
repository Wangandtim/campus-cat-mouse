<script setup lang="ts">
import { Activity, CirclePause, Footprints, Play, Rat, Zap } from 'lucide-vue-next';
import { campus, kilometers, shanghaiTime, type GameState } from '../model';

defineProps<{ game: GameState; busy: boolean }>();
const emit = defineEmits<{ track: [active: boolean]; walk: [] }>();
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
          <span class="neutral-chip"><span class="status-dot" :class="{ active: game.stats.tracking }"></span>{{ game.stats.tracking ? '记录中' : '已暂停' }}</span>
        </div>
        <div class="record-number"><Footprints :size="23" /><strong>{{ kilometers(game.stats.meters) }} <small>km</small></strong><span>本场活动里程</span></div>
        <div class="record-substats">
          <span>今日累计 <strong>{{ kilometers(game.stats.dailyMeters) }} km</strong></span>
          <span>今日积分 <strong>{{ game.stats.dailyPoints }} / 200</strong></span>
        </div>
        <div class="record-actions">
          <button type="button" class="primary-button" :disabled="busy" @click="emit('track', !game.stats.tracking)">
            <CirclePause v-if="game.stats.tracking" :size="18" /><Play v-else :size="18" />
            {{ game.stats.tracking ? '暂停记录' : '开始记录' }}
          </button>
          <button type="button" class="secondary-button" :disabled="busy || !game.stats.tracking" @click="emit('walk')"><Footprints :size="18" /> 模拟步行 100 米</button>
        </div>
        <p class="panel-footnote"><Zap :size="14" /> 演示步行会增加活动里程和追捕体力。</p>
      </section>
      <section class="panel record-history" aria-labelledby="record-history-title">
        <div class="panel-heading"><div><h2 id="record-history-title">抓捕记录</h2><p>{{ game.stage.label }} · {{ game.stats.captures }} 次</p></div></div>
        <div v-if="!game.captures.length" class="empty-state record-empty"><Rat :size="31" /><p>本场还没有抓捕记录</p></div>
        <ul v-else class="capture-history">
          <li v-for="capture in game.captures" :key="capture.id">
            <span class="zone-glyph"><Rat :size="18" /></span>
            <div><strong>{{ String(capture.mouseId).padStart(2, '0') }} 号鼠</strong><small>{{ campus.zones.find(({ id }) => id === capture.zoneId)?.name }} · {{ shanghaiTime.format(capture.at) }}</small></div>
            <b>+{{ capture.award }} 分</b>
          </li>
        </ul>
      </section>
    </div>
  </section>
</template>
