<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Medal, Trophy } from 'lucide-vue-next';
import { kilometers, request, type RankRow, type StageId } from '../model';

const props = defineProps<{ stage: StageId; label: string }>();
const range = ref<'day' | 'session'>('day');
const rows = ref<RankRow[]>([]);
const busy = ref(true);
const error = ref('');
const mine = computed(() => rows.value.find((row) => row.mine));
let version = 0;

async function load() {
  const turn = ++version;
  busy.value = true;
  error.value = '';
  try {
    const result = await request<RankRow[]>(`/api/preview/leaderboard?range=${range.value}`);
    if (turn === version) rows.value = result;
  } catch (failure) {
    if (turn === version) error.value = (failure as Error).message;
  } finally {
    if (turn === version) busy.value = false;
  }
}

watch([range, () => props.stage], load, { immediate: true });
</script>

<template>
  <section class="inner-page rank-page" aria-labelledby="rank-title">
    <div class="page-title">
      <div class="page-title-icon"><Trophy :size="28" /></div>
      <div><h1 id="rank-title">排行榜</h1><p>按有效抓捕数排序，同分比较里程和达成时间。</p></div>
    </div>
    <div class="panel table-panel" :aria-busy="busy">
      <div class="panel-heading rank-heading">
        <div class="segmented" aria-label="榜单范围">
          <button type="button" :aria-pressed="range === 'day'" @click="range = 'day'">全校日榜</button>
          <button type="button" :aria-pressed="range === 'session'" @click="range = 'session'">{{ label }}榜</button>
        </div>
        <span v-if="mine" class="my-rank"><Medal :size="18" /> 我的排名 <strong>{{ mine.rank }}</strong></span>
      </div>
      <p v-if="error" class="inline-error table-notice" role="alert">{{ error }} <button class="text-button" type="button" @click="load">重试</button></p>
      <p v-else-if="busy && !rows.length" class="empty-state" role="status">正在载入榜单…</p>
      <table v-else class="rank-table">
        <thead><tr><th scope="col">排名</th><th scope="col">参与者</th><th scope="col">抓捕</th><th scope="col">里程</th><th scope="col">积分</th></tr></thead>
        <tbody>
          <tr v-for="row in rows" :key="row.rank" :class="{ 'mine-row': row.mine }">
            <td><span class="rank-number" :class="{ podium: row.rank <= 3 }">{{ row.rank }}</span></td>
            <th scope="row">{{ row.nickname }} <small v-if="row.mine">我</small></th>
            <td>{{ row.captures }}</td>
            <td>{{ kilometers(row.meters) }} <small>km</small></td>
            <td>{{ row.points }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
