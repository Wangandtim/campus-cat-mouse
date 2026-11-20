<script setup lang="ts">
import { computed, defineAsyncComponent, defineComponent, inject, ref, watch } from 'vue';
import { Cat, CircleHelp, Footprints, Map, Rat, Trophy, UserRound, ChevronDown, ShieldCheck } from 'lucide-vue-next';
import { campus, type Profile, type Role } from './model';
import { useAuth } from './composables/useAuth';
import { liveMapKey, useGame } from './composables/useGame';
import CampusMap from './components/CampusMap.vue';
import CatPanel from './components/CatPanel.vue';
import EventBanner from './components/EventBanner.vue';
import GameDialog from './components/GameDialog.vue';
import Leaderboard from './components/Leaderboard.vue';
import Login from './components/Login.vue';
import MousePanel from './components/MousePanel.vue';
import Records from './components/Records.vue';
import Register from './components/Register.vue';
import ScanDialog from './components/ScanDialog.vue';
import StudentInterview from './admin/StudentInterview.vue';

const isAdmin = /^\/admin\/?$/.test(window.location.pathname);
const AdminView = defineAsyncComponent(() => import('./admin/AdminView.vue'));
const { auth, authBusy, authIssue, syncAuth, rosterLogin, register, completeGender, logout } = useAuth();
const demo = computed(() => auth.value?.status === 'demo');
const canPlay = computed(() => !isAdmin && (demo.value || (auth.value?.status === 'player' && !auth.value.needsGender)));
const {
  state, issue, positionIssue, busy, now, zoneViews, selectedZone, selectedId, mapPosition, refresh, changeProfile, track, exitParticipation, walk,
} = useGame(canPlay);
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

watch(canPlay, (enabled) => {
  if (!enabled) dialog.value = null;
});

const CheckLiveSession = defineComponent({
  setup() {
    const live = inject(liveMapKey);
    if (live) watch(live.message, (message) => { if (message) void syncAuth(); });
    return () => null;
  },
});

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
  <AdminView v-if="isAdmin" />
  <template v-else>
  <a href="#main" class="skip-link">跳到活动内容</a>
  <header class="site-header">
    <div class="header-inner">
      <button type="button" class="brand" aria-label="猫鼠追缉令，返回活动地图" @click="changePage('map')">
        <img src="/chase-mark.png" width="42" height="42" alt="" />
        <span><strong>猫鼠追缉令</strong><small>校园追光计划</small></span>
      </button>
      <nav v-if="canPlay" class="main-nav" aria-label="活动导航">
        <button v-for="item in pages" :key="item.id" type="button" :aria-current="page === item.id ? 'page' : undefined"
          @click="changePage(item.id)">
          <component :is="item.icon" :size="17" :stroke-width="1.8" /> {{ item.label }}
        </button>
      </nav>
      <div v-if="canPlay" class="header-actions">
        <button type="button" class="icon-button help-button" aria-label="查看活动规则" @click="dialog = 'rules'"><CircleHelp :size="21" /></button>
        <button type="button" class="account-button" :disabled="!state" @click="openProfile">
          <span class="account-avatar"><UserRound :size="17" :stroke-width="1.8" /></span>
          <span class="account-name">{{ state?.profile.nickname ?? (demo ? '体验账号' : '我的账号') }}</span>
          <ChevronDown :size="14" class="account-chevron" />
        </button>
      </div>
    </div>
  </header>

  <CheckLiveSession v-if="auth?.status === 'player'" />
  <main id="main" class="layout" :class="{ 'has-mobile-action': canPlay && page === 'map' && state?.profile.role === 'cat' }"
    :aria-label="canPlay ? pageTitle : '登录与报名'">
    <template v-if="!canPlay">
      <div v-if="!auth" class="panel boot-state">
        <p :role="authIssue ? 'alert' : 'status'">{{ authIssue || '正在检查登录状态…' }}</p>
        <button v-if="authIssue" type="button" class="primary-button" @click="syncAuth()">重试</button>
      </div>
      <Register v-else-if="auth.status === 'registration' || auth.needsGender" :mock="auth.mode === 'mock'"
        :gender-only="auth.needsGender" :busy="authBusy" :issue="authIssue" :initial="auth.prefill"
        @register="(form) => auth?.needsGender ? completeGender(form.gender) : register(form)" @logout="logout" />
      <Login v-else :mock="auth.mode === 'mock'" :roster="auth.mode === 'roster'" :issue="authIssue" @login="rosterLogin" />
    </template>
    <div v-else-if="!state" class="panel boot-state">
      <p :role="issue ? 'alert' : 'status'">{{ issue || '正在载入校园活动…' }}</p>
      <button v-if="issue" type="button" class="primary-button" @click="refresh()">重新载入</button>
    </div>
    <template v-else>
      <div v-if="(issue || positionIssue) && !dialog" role="alert" class="inline-error page-error">{{ issue || positionIssue }} <button type="button" class="text-button" @click="refresh()">重试</button></div>
      <template v-if="page === 'map'">
        <EventBanner :stage="state.stage" :now="now" :busy="busy" :demo="demo" @stage="(stage) => changeProfile({ stage })" />
        <div class="game-grid">
          <CampusMap :zones="zoneViews" :selected="selectedId" :demo="demo" @select="selectedId = $event" @position="mapPosition = $event" />
          <CatPanel v-if="state.profile.role === 'cat'" :stats="state.stats" :zones="zoneViews" :selected="selectedZone" :session-cap="demo ? 100 : 120"
            @select="selectedId = $event" @scan="dialog = 'scan'" @records="changePage('records')" @role="openProfile" />
          <MousePanel v-else :sharing="state.profile.sharing" :stage="state.stage.id" :now="now" :busy="busy" :used-code-expiry="state.usedMouseCodeExpiry"
            @sharing="(sharing) => changeProfile({ sharing })" @role="openProfile" />
        </div>
      </template>
      <Leaderboard v-else-if="page === 'rank'" :stage="state.stage.id" :label="state.stage.label" />
      <Records v-else :game="state" :busy="busy" :now="now" :demo="demo" @track="track" @exit="exitParticipation" @walk="walk" />
    </template>
    <footer v-if="canPlay" class="site-footer">
      <span>{{ campus.name }} · {{ campus.address }}</span>
      <button type="button" class="text-button" @click="dialog = 'rules'"><ShieldCheck :size="16" /> 活动规则与定位说明</button>
    </footer>
  </main>

  <ScanDialog v-if="canPlay && dialog === 'scan' && state" :zone="selectedZone" :energy="state.stats.energy"
    :demo="demo" @close="dialog = null" @captured="refresh()" />
  <GameDialog v-else-if="canPlay && dialog === 'profile' && state" :title="demo ? '体验账号' : '我的账号'" @close="dialog = null">
    <p v-if="demo" class="dialog-description">切换阵营，体验完整的猫端和鼠端流程。</p>
    <div v-if="demo" class="role-picker">
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
    <p v-if="authIssue" class="inline-error" role="alert">{{ authIssue }}</p>
    <button v-if="!demo" type="button" class="text-button" :disabled="authBusy" @click="logout()">退出登录</button>
  </GameDialog>
  <GameDialog v-else-if="canPlay && dialog === 'rules'" title="活动规则" @close="dialog = null">
    <div class="rules-body">
      <h3>场次与范围</h3>
      <p>计划 11 月 23 日开放。早场 06:30–08:10，晚场 17:30–20:30。请在校区允许活动的区域步行或慢跑。</p>
      <h3>抓捕与积分</h3>
      <p>停步后扫描鼠端动态二维码。同一场次对同一只鼠计一次，下一场可再次抓捕。每次有效抓捕最多得 10 分，本场最多 {{ demo ? 100 : 120 }} 分，全天最多 {{ demo ? 200 : 250 }} 分。再次抓捕前需新增 100 米。</p>
      <p v-if="!demo">在运动记录页开始参与。猫早场跑 2 公里（男 17 分钟、女 20 分钟），晚场跑 3 公里（男 25 分 30 秒、女 30 分钟）。超时或里程不足会作废本场里程和抓捕分。鼠跑满全场得 100 分，另计有效里程档位分。</p>
      <h3>演示数据与定位</h3>
      <p v-if="!demo">请在运动时保持页面在前台。暂停、退出或定位中断期间停止计程，猫的配速时间继续计算。定位中断可在场末结算后复核。</p>
      <p>{{ demo ? '预览使用演示鼠迹、围栏和运动数据。' : '' }}定位后，你的实时位置仅在活动窗口内向对方阵营显示。暂停共享（预览安全屋）时隐藏实时位置。实时点短时有效，过期后从地图移除。学分按校方确认的规则执行。</p>
    </div>
    <button type="button" class="primary-button full-button" @click="dialog = null">知道了</button>
  </GameDialog>
  <StudentInterview v-if="auth?.status === 'player'" :blocked="dialog !== null" />
  </template>
</template>
