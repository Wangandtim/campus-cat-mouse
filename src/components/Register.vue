<script setup lang="ts">
import { reactive } from 'vue';
import type { RegistrationForm } from '../composables/useAuth';

const props = defineProps<{ mock: boolean; busy: boolean; issue: string; genderOnly?: boolean; initial?: Partial<RegistrationForm> }>();
const emit = defineEmits<{ register: [form: RegistrationForm]; logout: [] }>();
const form = reactive<RegistrationForm>({
  school: '西安欧亚学院', name: '', studentNo: '', grade: '', college: '', className: '', phone: '', email: '', gender: '',
});
if (props.initial) Object.assign(form, props.initial);
const fields: { key: Exclude<keyof RegistrationForm, 'gender'>; label: string; maxLength: number; type?: string; autocomplete?: string }[] = [
  { key: 'school', label: '学校', maxLength: 120, autocomplete: 'organization' },
  { key: 'name', label: '姓名', maxLength: 64, autocomplete: 'name' },
  { key: 'studentNo', label: '学号', maxLength: 64 },
  { key: 'grade', label: '年级', maxLength: 32 },
  { key: 'college', label: '学院', maxLength: 120 },
  { key: 'className', label: '班级', maxLength: 120 },
  { key: 'phone', label: '电话', maxLength: 32, type: 'tel', autocomplete: 'tel' },
  { key: 'email', label: '邮箱', maxLength: 254, type: 'email', autocomplete: 'email' },
];
</script>

<template>
  <section class="panel registration-panel" aria-labelledby="registration-title">
    <div class="panel-heading"><h2 id="registration-title">{{ genderOnly ? '补录活动资料' : '学生活动报名' }}</h2></div>
    <p v-if="mock && !genderOnly" class="field-feedback">请使用虚构资料。示例学号 TEST-1，姓名 虚构学生1，电话 00000000000，邮箱 student1@example.invalid。</p>
    <form class="profile-form" @submit.prevent="emit('register', { ...form })">
      <template v-if="!genderOnly">
        <template v-for="field in fields" :key="field.key">
          <label :for="`registration-${field.key}`">{{ field.label }}</label>
          <div class="field-with-action">
            <input :id="`registration-${field.key}`" v-model="form[field.key]" :type="field.type || 'text'"
              :maxlength="field.maxLength" :autocomplete="mock ? 'off' : field.autocomplete || 'off'" required />
          </div>
        </template>
      </template>
      <label for="registration-gender">性别</label>
      <div class="field-with-action">
        <select id="registration-gender" v-model="form.gender" aria-describedby="gender-purpose" required>
          <option disabled value="">请选择</option>
          <option value="male">男</option>
          <option value="female">女</option>
        </select>
      </div>
      <p id="gender-purpose" class="field-feedback">用于判定猫阵营的配速要求。</p>
      <p v-if="issue" class="inline-error" role="alert">{{ issue }}</p>
      <div class="registration-actions">
        <button type="submit" class="primary-button" :disabled="busy">{{ busy ? '正在提交…' : genderOnly ? '保存资料' : '确认报名' }}</button>
        <button type="button" class="text-button" :disabled="busy" @click="emit('logout')">退出登录</button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.registration-panel { width: min(100%, 480px); margin-inline: auto; padding: 20px; }
.field-feedback, .inline-error { margin-top: 12px; }
.field-with-action select { width: 100%; min-height: 43px; border: 1px solid #e1dbea; border-radius: 9px; padding: 0 10px; color: var(--ink); background: #fcfaff; }
.registration-actions { display: flex; gap: 12px; margin-top: 16px; }
</style>
