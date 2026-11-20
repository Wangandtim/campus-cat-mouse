<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ApiError, apiResponseError, request } from '../model';

type InterviewStatus = 'PENDING' | 'CONFIRMED' | 'DECLINED' | 'WAITLISTED' | 'NO_SHOW';
type EmailStatus = 'pending' | 'sent' | 'failed';
type Student = { userId: string; name: string; studentId: string; rank?: number };
type Entry = Student & {
  rank: number; captures: number; validMeters: number; achievedAt: number;
  dataGap: boolean; status: InterviewStatus; emailStatus: EmailStatus;
};
type Dashboard = {
  snapshotDate: string; assignmentDate: string; firstEventDate: string; publicationDue: boolean;
  eventStartDate: string; eventEndDate: string; eventDurationDays: number; eventSettingsEditable: boolean;
  interviewsClosed: boolean; rosterLocked: boolean; emailEnabled: boolean;
  snapshot: { createdAt: number; entries: Entry[] } | null;
  assignment: {
    rows: (Student & { slot: number; assignedBy: string | null; assignedAt: number | null })[];
    reserve: Student[]; activatedAt: number | null;
  };
};

const statusText: Record<InterviewStatus, string> = {
  PENDING: '待约谈', CONFIRMED: '已确认', DECLINED: '放弃', WAITLISTED: '顺延', NO_SHOW: '未到场',
};
const emailText: Record<EmailStatus, string> = { pending: '待发送', sent: '已发送', failed: '发送失败' };
const interviewActions: Partial<Record<InterviewStatus, InterviewStatus[]>> = {
  PENDING: ['CONFIRMED', 'DECLINED', 'WAITLISTED', 'NO_SHOW'], WAITLISTED: ['CONFIRMED'],
};
const shanghaiTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
const meters = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });

const account = ref('');
const loginAccount = ref('');
const password = ref('');
const ready = ref(false);
const busy = ref(false);
const issue = ref('');
const message = ref('');
const data = ref<Dashboard>();
const snapshotDate = ref('');
const assignmentDate = ref('');
const eventStartDate = ref('');
const eventDurationDays = ref(1);
const query = ref('');
const matches = ref<Student[]>();
const userId = ref('');
const replaceUserId = ref('');
const reason = ref('');
const firstDay = computed(() => data.value?.assignmentDate === data.value?.firstEventDate);
const eligible = computed(() => firstDay.value
  ? (matches.value ?? []).filter((student) => !data.value?.assignment.rows.some((row) => row.userId === student.userId))
  : data.value?.assignment.reserve ?? []);

function resetAssignment() {
  userId.value = '';
  replaceUserId.value = '';
  reason.value = '';
}

async function perform(work: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  issue.value = '';
  message.value = '';
  try {
    await work();
  } catch (error) {
    if (error instanceof ApiError && error.code === 'TEACHER_AUTH') {
      account.value = '';
      data.value = undefined;
    }
    issue.value = (error as Error).message;
  } finally {
    busy.value = false;
  }
}

async function load() {
  const result = await request<Dashboard>('/api/admin/dashboard', {
    ...(snapshotDate.value ? { snapshotDate: snapshotDate.value } : {}),
    ...(assignmentDate.value ? { assignmentDate: assignmentDate.value } : {}),
  });
  if (data.value?.assignmentDate !== result.assignmentDate) {
    matches.value = undefined;
    resetAssignment();
  }
  data.value = result;
  snapshotDate.value = result.snapshotDate;
  assignmentDate.value = result.assignmentDate;
  eventStartDate.value = result.eventStartDate;
  eventDurationDays.value = result.eventDurationDays;
}

const eventEndPreview = computed(() => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventStartDate.value) ||
      !Number.isSafeInteger(eventDurationDays.value) || eventDurationDays.value < 1) return '';
  const end = Date.parse(`${eventStartDate.value}T00:00:00+08:00`) + (eventDurationDays.value - 1) * 86_400_000;
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(end);
});

function saveEventSettings() {
  return perform(async () => {
    const result = await request<{ startDate: string; endDate: string; durationDays: number }>('/api/admin/event', {
      startDate: eventStartDate.value,
      durationDays: eventDurationDays.value,
    });
    message.value = `活动日期已保存：${result.startDate} 至 ${result.endDate}（${result.durationDays} 天）。`;
    await load();
  });
}

function exportClasses(scope: 'day' | 'total' = 'day') {
  return perform(async () => {
    const eventDate = data.value?.snapshotDate;
    if (!eventDate) return;
    let response: Response;
    try {
      response = await fetch('/api/admin/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventDate, scope }),
      });
    } catch {
      throw new ApiError('网络暂时不可用，请重试。', 'NETWORK');
    }
    if (!response.ok) {
      const failure = await response.json().catch(() => null);
      throw apiResponseError(response.status, failure, '导出暂时无法完成，请稍后重试。');
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = `${scope === 'total' ? '总成绩' : '当日成绩'}-${eventDate}.xlsx`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    message.value = scope === 'total' ? '已开始下载活动总成绩。' : '已开始下载当日成绩。';
  });
}

function login() {
  return perform(async () => {
    try {
      ({ account: account.value } = await request<{ account: string }>('/api/teacher/login', {
        account: loginAccount.value.trim(), password: password.value,
      }));
    } finally {
      password.value = '';
    }
    await load();
  });
}

function logout() {
  return perform(async () => {
    await request('/api/admin/logout', {});
    account.value = '';
    data.value = undefined;
    matches.value = undefined;
    resetAssignment();
  });
}

function changeStatus(entry: Entry, event: Event) {
  const select = event.target as HTMLSelectElement;
  const status = select.value;
  select.value = '';
  return perform(async () => {
    await request('/api/admin/interviews', { eventDate: data.value?.snapshotDate, userId: entry.userId, status });
    await load();
    message.value = '约谈状态已更新。';
  });
}

function searchStudents() {
  return perform(async () => {
    userId.value = '';
    matches.value = await request<Student[]>('/api/admin/students', { query: query.value });
  });
}

function assign() {
  return perform(async () => {
    await request('/api/admin/assignments', {
      eventDate: data.value?.assignmentDate, userId: userId.value,
      ...(replaceUserId.value ? { replaceUserId: replaceUserId.value, reason: reason.value } : {}),
    });
    resetAssignment();
    await load();
    message.value = '任命名单已更新。';
  });
}

onMounted(async () => {
  await perform(async () => {
    try {
      ({ account: account.value } = await request<{ account: string }>('/api/admin/session', {}));
    } catch (error) {
      if (error instanceof ApiError && error.code === 'TEACHER_AUTH') return;
      throw error;
    }
    await load();
  });
  ready.value = true;
});
</script>

<template>
  <header class="teacher-header">
    <div class="teacher-header-inner">
      <div class="teacher-brand"><img src="/chase-mark.png" width="40" height="40" alt="" /><span>猫鼠追缉令</span></div>
      <div v-if="account" class="teacher-account">
        <span>{{ account }}</span>
        <button type="button" class="secondary-button" :disabled="busy" @click="logout">退出登录</button>
      </div>
    </div>
  </header>

  <main v-if="!ready || !account" class="teacher-login">
    <h1>教师登录</h1>
    <p v-if="!ready" role="status">正在检查登录状态…</p>
    <form v-else class="teacher-form" @submit.prevent="login">
      <label>教师账号<input v-model="loginAccount" autocomplete="username" maxlength="64" required /></label>
      <label>密码<input v-model="password" type="password" autocomplete="current-password" maxlength="256" required /></label>
      <p v-if="issue" class="inline-error" role="alert">{{ issue }}</p>
      <button type="submit" class="primary-button" :disabled="busy">登录</button>
    </form>
  </main>

  <main v-else class="teacher-layout" :aria-busy="busy">
    <div class="teacher-heading">
      <h1>教师工作台</h1>
      <button type="button" class="secondary-button" :disabled="busy" @click="perform(load)">刷新</button>
    </div>
    <p v-if="issue" class="inline-error" role="alert">{{ issue }}</p>
    <p v-if="message" class="teacher-success" role="status">{{ message }}</p>
    <div v-if="data" class="teacher-grid">
      <section class="teacher-panel" aria-labelledby="event-settings-title">
        <div class="teacher-panel-heading">
          <h2 id="event-settings-title">活动日期</h2>
          <span>{{ data.eventStartDate }} 至 {{ data.eventEndDate }} · {{ data.eventDurationDays }} 天</span>
        </div>
        <div class="event-settings-form">
          <label>开始日期 <input v-model="eventStartDate" type="date" :disabled="busy || !data.eventSettingsEditable" /></label>
          <label>持续天数 <input v-model.number="eventDurationDays" type="number" min="1" max="3650"
            :disabled="busy" /></label>
          <span>结束日期：{{ eventEndPreview || '—' }}</span>
          <button type="button" class="secondary-button"
            :disabled="busy || (!data.eventSettingsEditable && eventDurationDays <= data.eventDurationDays)"
            @click="saveEventSettings">保存活动日期</button>
        </div>
        <p v-if="!data.eventSettingsEditable" class="teacher-note">活动已开始，开始日期不可改；只能延长持续天数。</p>
      </section>

      <section class="teacher-panel" aria-labelledby="top20-title">
        <div class="teacher-panel-heading">
          <h2 id="top20-title">Top20 与面谈</h2>
          <label>成绩日期 <input v-model="snapshotDate" type="date" :min="data.firstEventDate" :max="data.eventEndDate" :disabled="busy" @change="perform(load)" /></label>
          <button type="button" class="secondary-button" :disabled="busy" @click="exportClasses('day')">导出当日成绩</button>
          <button type="button" class="secondary-button" :disabled="busy" @click="exportClasses('total')">导出总成绩</button>
        </div>
        <p v-if="!data.snapshot" class="teacher-note">
          {{ data.publicationDue ? '等待早晚场结算齐备，系统会自动生成榜单。' : '北京时间 20:40 检查早晚场结算并生成榜单。' }}
        </p>
        <p v-else-if="!data.snapshot.entries.length" class="teacher-note">当日榜单已生成，暂无符合条件的候选。</p>
        <template v-else>
          <p v-if="!data.emailEnabled" class="teacher-note">邮件服务未配置，候选可在活动 H5 查看邀约。</p>
          <div class="teacher-table" tabindex="0" role="region" aria-label="Top20 榜单">
            <table>
              <thead><tr><th scope="col">排名</th><th scope="col">学生</th><th scope="col">抓捕</th><th scope="col">有效里程</th>
                <th scope="col">最后抓捕</th><th scope="col">邮件</th><th scope="col">面谈</th></tr></thead>
              <tbody>
                <tr v-for="entry in data.snapshot.entries" :key="entry.userId">
                  <td>{{ entry.rank }}</td>
                  <th scope="row">{{ entry.name }}<small>{{ entry.studentId }}</small><small v-if="entry.dataGap" class="review">定位缺口 · 待复核</small></th>
                  <td>{{ entry.captures }}</td>
                  <td>{{ meters.format(entry.validMeters) }} 米</td>
                  <td>{{ shanghaiTime.format(entry.achievedAt) }}</td>
                  <td>{{ emailText[entry.emailStatus] }}</td>
                  <td>
                    <span>{{ statusText[entry.status] }}</span>
                    <select v-if="!data.interviewsClosed && interviewActions[entry.status]" value="" :aria-label="`处理 ${entry.name} 的约谈`"
                      :disabled="busy" @change="changeStatus(entry, $event)">
                      <option value="" disabled>更新状态</option>
                      <option v-for="status in interviewActions[entry.status]" :key="status" :value="status">{{ statusText[status] }}</option>
                    </select>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </section>

      <section class="teacher-panel" aria-labelledby="roster-title">
        <div class="teacher-panel-heading">
          <h2 id="roster-title">鼠阵营名单</h2>
          <label>任命日期 <input v-model="assignmentDate" type="date" :min="data.firstEventDate" :max="data.eventEndDate" :disabled="busy" @change="perform(load)" /></label>
        </div>
        <div class="teacher-roster-info"><span>{{ data.assignment.rows.length }} / 10 人</span>
          <span>{{ data.assignment.activatedAt !== null ? '已生效' : '北京时间 06:30 生效' }}</span></div>
        <ol v-if="data.assignment.rows.length" class="teacher-roster">
          <li v-for="row in data.assignment.rows" :key="row.slot" :value="row.slot">
            <strong>{{ row.name }}</strong> <span>{{ row.studentId }}</span>
            <small v-if="row.assignedBy && row.assignedAt !== null" class="teacher-note">
              {{ row.assignedBy === 'scheduler' ? '榜单递补' : row.assignedBy }} · {{ shanghaiTime.format(row.assignedAt) }}
            </small>
          </li>
        </ol>
        <p v-else class="teacher-note">暂无已排定的任命。</p>
        <template v-if="!data.rosterLocked">
          <form v-if="firstDay" class="teacher-form teacher-search" @submit.prevent="searchStudents">
            <label>搜索已报名学生
              <input v-model="query" placeholder="姓名或学号" minlength="2" maxlength="64" required />
            </label>
            <button type="submit" class="secondary-button" :disabled="busy">搜索</button>
          </form>
          <form v-if="eligible.length" class="teacher-form teacher-assignment" @submit.prevent="assign">
            <label>选择学生
              <select v-model="userId" required>
                <option value="" disabled>请选择</option>
                <option v-for="student in eligible" :key="student.userId" :value="student.userId">
                  {{ student.name }} · {{ student.studentId }}{{ student.rank ? ` · 第 ${student.rank} 名` : '' }}
                </option>
              </select>
            </label>
            <label v-if="data.assignment.rows.length">替换名单成员
              <select v-model="replaceUserId" :required="data.assignment.rows.length >= 10">
                <option value="" :disabled="data.assignment.rows.length >= 10">
                  {{ data.assignment.rows.length >= 10 ? '请选择要换出的学生' : '新增任命' }}
                </option>
                <option v-for="row in data.assignment.rows" :key="row.userId" :value="row.userId">{{ row.name }} · {{ row.studentId }}</option>
              </select>
            </label>
            <label v-if="replaceUserId">换人原因<input v-model="reason" maxlength="200" required /></label>
            <button type="submit" class="primary-button" :disabled="busy">{{ replaceUserId ? '保存换人' : '任命' }}</button>
          </form>
          <p v-else-if="matches || !firstDay" class="teacher-note">
            {{ firstDay ? '没有可任命的搜索结果。' : '暂无可换入的已确认候选。' }}
          </p>
        </template>
      </section>
    </div>
  </main>
</template>

<style scoped>
.teacher-header { background: var(--surface); border-bottom: 1px solid var(--line); }
.teacher-header-inner, .teacher-layout { max-width: 1440px; margin: auto; padding-inline: clamp(16px, 4vw, 56px); }
.teacher-header-inner, .teacher-heading, .teacher-panel-heading, .teacher-account, .teacher-brand, .teacher-roster-info {
  display: flex; align-items: center; gap: 12px;
}
.teacher-header-inner, .teacher-heading, .teacher-panel-heading, .teacher-roster-info { justify-content: space-between; }
.teacher-header-inner { min-height: 70px; }
.teacher-brand { font-weight: 800; }
.teacher-account { color: var(--muted); font-size: 14px; }
.teacher-layout { padding-block: 28px 48px; }
.teacher-heading { margin-bottom: 18px; }
h1 { font-size: clamp(22px, 3vw, 30px); }
h2 { font-size: 18px; }
.teacher-login, .teacher-panel { background: var(--surface); border: 1px solid var(--line); border-radius: var(--outer-radius); }
.teacher-login { width: min(400px, calc(100% - 32px)); margin: 48px auto; padding: 24px; }
.teacher-grid { display: grid; grid-template-columns: minmax(0, 2.4fr) minmax(280px, 1fr); align-items: start; gap: 18px; }
.teacher-panel { min-width: 0; padding: 18px; }
.teacher-panel-heading { flex-wrap: wrap; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
.teacher-panel-heading label, .teacher-note, .teacher-roster-info, .teacher-roster span, .teacher-table small { color: var(--muted); font-size: 13px; }
.teacher-note { margin-block: 12px; line-height: 1.5; }
.teacher-form { display: grid; gap: 12px; margin-top: 16px; }
.event-settings-form { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; margin-top: 12px; }
.event-settings-form label { display: grid; gap: 5px; color: var(--muted); font-size: 13px; }
.event-settings-form input { min-height: 36px; padding: 6px 8px; border: 1px solid var(--line); border-radius: var(--control-radius); }
.teacher-form label { display: grid; gap: 5px; font-size: 14px; }
.teacher-form input, .teacher-form select { width: 100%; }
.teacher-form input, .teacher-form select, .teacher-panel-heading input, .teacher-table select {
  min-height: 36px; padding: 6px 8px; border: 1px solid var(--line); border-radius: var(--control-radius);
  color: var(--ink); background: var(--surface);
}
.teacher-table { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
td, th { padding: 10px 8px; text-align: left; border-bottom: 1px solid var(--line); white-space: nowrap; }
thead th { color: var(--muted); font-size: 13px; }
.teacher-table small, .teacher-table select, .teacher-roster small { display: block; margin-top: 3px; }
.teacher-table small.review { color: var(--warm); }
.teacher-roster-info { margin-block: 12px; }
.teacher-roster { margin: 0; padding-left: 26px; }
.teacher-roster li { padding: 6px 0; line-height: 1.4; }
.teacher-success, .teacher-layout > .inline-error { margin-bottom: 12px; }
.teacher-success { color: var(--blue-hover); }
.teacher-search, .teacher-assignment { padding-top: 12px; border-top: 1px solid var(--line); }
@media (max-width: 960px) { .teacher-grid { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 460px) {
  .teacher-header-inner { padding-block: 8px; }
  .teacher-account { justify-content: flex-end; flex-wrap: wrap; gap: 4px; }
  .teacher-panel { padding: 12px; }
}
</style>
