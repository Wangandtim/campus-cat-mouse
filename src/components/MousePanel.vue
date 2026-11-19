<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import QRCode from 'qrcode';
import { ChevronRight, Clock3, Copy, EyeOff, QrCode, Rat } from 'lucide-vue-next';
import { request, type IssuedCode, type StageId } from '../model';

const props = defineProps<{ sharing: boolean; stage: StageId; now: number; busy: boolean; usedCodeExpiry: number | null }>();
const emit = defineEmits<{ role: []; sharing: [active: boolean] }>();
const issued = ref<IssuedCode>();
const source = ref('');
const message = ref('');
const loading = ref(false);
let version = 0;
let mounted = false;
const seconds = computed(() => Math.max(0, Math.ceil(((issued.value?.expiresAt ?? 0) - props.now) / 1000)));

async function refreshCode() {
  if (!props.sharing || loading.value || document.hidden) return;
  const turn = ++version;
  loading.value = true;
  message.value = '';
  try {
    const next = await request<IssuedCode>('/api/preview/mouse-code', {});
    const qr = await QRCode.toDataURL(next.code, { width: 236, margin: 2, color: { dark: '#1f2548', light: '#ffffff' } });
    if (turn !== version || !mounted || !props.sharing) return;
    issued.value = next;
    source.value = qr;
  } catch (error) {
    message.value = (error as Error).message;
  } finally {
    if (turn === version) loading.value = false;
  }
}

function resetCode() {
  ++version;
  loading.value = false;
  issued.value = undefined;
  source.value = '';
  message.value = '';
  if (props.sharing) void refreshCode();
}

async function copyCode() {
  try {
    await navigator.clipboard.writeText(issued.value?.code ?? '');
    message.value = '捕获码已复制。';
  } catch {
    message.value = '可以长按上方捕获码进行复制。';
  }
}

function onVisibility() {
  if (document.hidden && props.sharing) emit('sharing', false);
}

watch(() => [props.sharing, props.stage], resetCode);
watch(() => props.usedCodeExpiry, (expiresAt) => {
  if (expiresAt && expiresAt === issued.value?.expiresAt) resetCode();
});
watch(seconds, (remaining) => { if (!remaining && issued.value && !loading.value) void refreshCode(); });
onMounted(() => {
  mounted = true;
  document.addEventListener('visibilitychange', onVisibility);
  void refreshCode();
});
onUnmounted(() => {
  mounted = false;
  document.removeEventListener('visibilitychange', onVisibility);
});
</script>

<template>
  <div class="side-stack">
    <section class="panel mouse-panel" aria-labelledby="mouse-title">
      <div class="panel-heading">
        <div><span class="role-label mouse-role"><Rat :size="15" aria-hidden="true" /> 鼠阵营</span><h2 id="mouse-title">展示捕获码</h2></div>
        <button type="button" class="text-button" @click="emit('role')">切换身份 <ChevronRight :size="15" /></button>
      </div>
      <div class="mouse-location"><Rat :size="17" /> 03 号鼠 <span>中心步道</span></div>
      <div class="qr-box">
        <img v-if="source && seconds" :src="source" width="206" height="206" alt="本场鼠端捕获二维码" />
        <div v-else class="qr-empty">
          <EyeOff v-if="!sharing" :size="34" /><QrCode v-else :size="34" />
          <span>{{ sharing ? (loading ? '正在生成' : '捕获码待刷新') : '共享已暂停' }}</span>
        </div>
      </div>
      <div v-if="sharing && issued && seconds" class="mouse-code-meta">
        <span><Clock3 :size="15" /> {{ seconds }} 秒后刷新</span>
        <button type="button" class="text-button" aria-label="复制捕获码" @click="copyCode"><Copy :size="15" /> 复制</button>
      </div>
      <code v-if="sharing && issued && seconds" class="manual-code">{{ issued.code }}</code>
      <p v-if="message" class="field-feedback" role="status">{{ message }}</p>
      <button v-if="sharing && !issued && !loading" type="button" class="secondary-button full-button" @click="refreshCode">重新生成</button>
      <button type="button" class="secondary-button full-button" :disabled="busy" @click="emit('sharing', !sharing)">
        <EyeOff :size="17" /> {{ sharing ? '暂停位置与扫码' : '恢复共享' }}
      </button>
      <p class="panel-footnote">在安全位置停步后，再向其他参与者展示二维码。</p>
    </section>
  </div>
</template>
