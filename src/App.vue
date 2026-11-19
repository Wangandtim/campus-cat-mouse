<script setup lang="ts">
import { computed, ref } from 'vue';
import { Cat, CircleHelp, Footprints, Map, Rat, Trophy, UserRound, ChevronDown, ShieldCheck } from 'lucide-vue-next';
import { campus, type Profile, type Role } from './model';
import { useGame } from './composables/useGame';
import CampusMap from './components/CampusMap.vue';
import CatPanel from './components/CatPanel.vue';
import EventBanner from './components/EventBanner.vue';
import GameDialog from './components/GameDialog.vue';
import Leaderboard from './components/Leaderboard.vue';
import MousePanel from './components/MousePanel.vue';
import Records from './components/Records.vue';
import ScanDialog from './components/ScanDialog.vue';

const {
  state, issue, busy, now, zoneViews, selectedZone, selectedId, mapPosition, refresh, changeProfile, track, walk,
} = useGame();
const pages = [
  { id: 'map', label: '活动地图', icon: Map },
  { id: 'rank', label: '排行榜', icon: Trophy },
  { id: 'records', label: '运动记录', icon: Footprints },
] as const;
type Page = typeof pages[number]['id'];
const page = ref<Page>('map');
const dialog = ref<'scan' | 'profile' | 'rules' | null>(null);
const draft = ref('');
const updated = ref(false);
const pageTitle = computed(() => pages.find(({ id }) => id === page.value)?.label);

function openProfile() {
  draft.value = state.value?.profile.nickname ?? '';
  updated.value = false;
  dialog.value = 'profile';
}

function changePage(next: Page) {
  if (next === page.value) return;
  if (next !== 'map' && state.value?.profile.role === 'mouse' && state.value.profile.sharing) {
    void changeProfile({ sharing: false });
  }
  page.value = next;
  window.scrollTo({ top: 0, behavior: 'instant' });
}

async function applyProfile(patch: Partial<Profile>) {
  await changeProfile(patch);
  if (!issue.value) updated.value = true;
}

async function chooseRole(role: Role) {
  await applyProfile({ role, sharing: true });
  if (!issue.value) {
    changePage('map');
    dialog.value = null;
  }
}
</script>

<template>
  <a href="#main" class="skip-link">跳到活动内容</a>
  <header class="site-header">
    <div class="header-inner">
      <button type="button" class="brand" aria-label="猫鼠追缉令，返回活动地图" @click="changePage('map')">
        <img src="/chase-mark.png" width="42" height="42" alt="" />
        <span><strong>猫鼠追缉令</strong><small>校园追光计划</small></span>
      </button>
      <nav class="main-nav" aria-label="活动导航">
        <button v-for="item in pages" :key="item.id" type="button" :aria-current="page === item.id ? 'page' : undefined"
          @click="changePage(item.id)">
          <component :is="item.icon" :size="17" :stroke-width="1.8" /> {{ item.label }}
        </button>
      </nav>
      <div class="header-actions">
        <button type="button" class="icon-button help-button" aria-label="查看活动规则" @click="dialog = 'rules'"><CircleHelp :size="21" /></button>
        <button type="button" class="account-button" :disabled="!state" @click="openProfile">
          <span class="account-avatar"><UserRound :size="17" :stroke-width="1.8" /></span>
          <span class="account-name">{{ state?.profile.nickname ?? '体验账号' }}</span>
          <ChevronDown :size="14" class="account-chevron" />
        </button>
      </div>
    </div>
  </header>

  <main id="main" class="layout" :class="{ 'has-mobile-action': page === 'map' && state?.profile.role === 'cat' }" :aria-label="pageTitle">
    <div v-if="!state" class="panel boot-state">
      <p :role="issue ? 'alert' : 'status'">{{ issue || '正在载入校园活动…' }}</p>
      <button v-if="issue" type="button" class="primary-button" @click="refresh()">重新载入</button>
    </div>
    <template v-else>
      <div v-if="issue && !dialog" role="alert" class="inline-error page-error">{{ issue }} <button type="button" class="text-button" @click="refresh()">重试</button></div>
      <template v-if="page === 'map'">
        <EventBanner :stage="state.stage" :now="now" :busy="busy" @stage="(stage) => changeProfile({ stage })" />
        <div class="game-grid">
          <CampusMap :zones="zoneViews" :selected="selectedId" @select="selectedId = $event" @position="mapPosition = $event" />
          <CatPanel v-if="state.profile.role === 'cat'" :stats="state.stats" :zones="zoneViews" :selected="selectedZone"
            @select="selectedId = $event" @scan="dialog = 'scan'" @records="changePage('records')" @role="openProfile" />
          <MousePanel v-else :sharing="state.profile.sharing" :stage="state.stage.id" :now="now" :busy="busy" :used-code-expiry="state.usedMouseCodeExpiry"
            @sharing="(sharing) => changeProfile({ sharing })" @role="openProfile" />
        </div>
      </template>
      <Leaderboard v-else-if="page === 'rank'" :stage="state.stage.id" :label="state.stage.label" />
      <Records v-else :game="state" :busy="busy" @track="track" @walk="walk" />
    </template>
    <footer class="site-footer">
      <span>{{ campus.name }} · {{ campus.address }}</span>
      <button type="button" class="text-button" @click="dialog = 'rules'"><ShieldCheck :size="16" /> 活动规则与定位说明</button>
    </footer>
  </main>

  <ScanDialog v-if="dialog === 'scan' && state" :zone="selectedZone" :energy="state.stats.energy" @close="dialog = null" @captured="refresh()" />
  <GameDialog v-else-if="dialog === 'profile' && state" title="体验账号" @close="dialog = null">
    <p class="dialog-description">切换阵营，体验完整的猫端和鼠端流程。</p>
    <div class="role-picker">
      <button type="button" :disabled="busy" :aria-pressed="state.profile.role === 'cat'" @click="chooseRole('cat')"><Cat :size="26" /> 猫阵营</button>
      <button type="button" :disabled="busy" :aria-pressed="state.profile.role === 'mouse'" @click="chooseRole('mouse')"><Rat :size="26" /> 鼠阵营</button>
    </div>
    <form class="profile-form" @submit.prevent="applyProfile({ nickname: draft })">
      <label for="profile-name">榜单显示名</label>
      <div class="field-with-action">
        <input id="profile-name" v-model="draft" minlength="2" maxlength="16" autocomplete="off" required />
        <button type="submit" class="primary-button" :disabled="busy">保存</button>
      </div>
    </form>
    <p v-if="issue" class="inline-error" role="alert">{{ issue }}</p>
    <p v-else-if="updated" class="field-feedback" role="status">设置已保存。</p>
  </GameDialog>
  <GameDialog v-else-if="dialog === 'rules'" title="活动规则" @close="dialog = null">
    <div class="rules-body">
      <h3>场次与范围</h3>
      <p>计划 11 月 23 日开放。早场 06:30–08:10，晚场 17:30–20:30。请在校区允许活动的区域步行或慢跑。</p>
      <h3>抓捕与积分</h3>
      <p>停步后扫描鼠端动态二维码。同一场次对同一只鼠计一次，下一场可再次抓捕。每次有效抓捕最多得 10 分，本场最多 100 分，全天最多 200 分。再次抓捕前需新增 100 米。</p>
      <h3>演示数据与定位</h3>
      <p>预览使用演示鼠迹、围栏和运动数据。点击定位后，实际位置仅在当前页面用于地图定位。学分按校方确认的规则执行。</p>
    </div>
    <button type="button" class="primary-button full-button" @click="dialog = null">知道了</button>
  </GameDialog>
</template>
