<script setup lang="ts">
import { reactive } from 'vue';

const props = defineProps<{ mock: boolean; roster: boolean; issue: string }>();
const emit = defineEmits<{ login: [form: { studentNo: string; name: string; phoneLast4: string }] }>();
const form = reactive({ studentNo: '', name: '', phoneLast4: '' });

function submit() {
  emit('login', { ...form });
}
</script>

<template>
  <section class="panel boot-state" aria-labelledby="login-title">
    <div class="panel-heading"><h2 id="login-title">{{ roster ? '学号登录' : '登录校园追光计划' }}</h2></div>
    <p v-if="issue" role="alert" class="inline-error">{{ issue }}</p>
    <form v-if="roster" class="profile-form" @submit.prevent="submit">
      <label for="login-student-no">学号</label>
      <input id="login-student-no" v-model="form.studentNo" maxlength="64" autocomplete="username" required />
      <label for="login-name">姓名</label>
      <input id="login-name" v-model="form.name" maxlength="64" autocomplete="name" required />
      <label for="login-phone">手机号后四位</label>
      <input id="login-phone" v-model="form.phoneLast4" maxlength="4" inputmode="numeric"
        pattern="[0-9]{4}" autocomplete="off" required />
      <p class="field-feedback">使用学号、姓名和报名手机号后四位登录；首次登录后补齐资料。</p>
      <button type="submit" class="primary-button">登录</button>
    </form>
    <a v-else href="/api/auth/login" class="primary-button">{{ props.mock ? '模拟微信登录' : '使用微信登录' }}</a>
  </section>
</template>

<style scoped>
.profile-form { display: grid; gap: 8px; margin-top: 12px; }
.profile-form input { min-height: 43px; }
</style>
