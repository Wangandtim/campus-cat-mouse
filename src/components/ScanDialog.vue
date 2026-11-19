<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';
import { Camera, Check, FlaskConical, ScanLine } from 'lucide-vue-next';
import { ApiError, request, type CaptureResult, type IssuedCode, type ZoneView } from '../model';
import GameDialog from './GameDialog.vue';

const props = defineProps<{ zone: ZoneView; energy: number }>();
const emit = defineEmits<{ close: []; captured: [result: CaptureResult] }>();
const code = ref('');
const error = ref('');
const result = ref<CaptureResult>();
const busy = ref(false);
const camera = ref(false);
const video = ref<HTMLVideoElement>();
const canSimulate = computed(() => props.zone.available.length > 0 && props.zone.cooldown === 0 && props.energy >= 100);
let stream: MediaStream | undefined;
let frame = 0;
let lastFrame = 0;
let disposed = false;
let pending: { code: string; id: string } | undefined;

function stopCamera() {
  window.cancelAnimationFrame(frame);
  stream?.getTracks().forEach((track) => track.stop());
  stream = undefined;
  camera.value = false;
}

async function submit(value: string, simulate = false) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const existing = pending;
    if (simulate && !existing) {
      const sample = await request<IssuedCode>('/api/preview/sample-code', { mouseId: props.zone.available[0] });
      value = sample.code;
    }
    const active = existing && (simulate || existing.code === value) ? existing : { code: value, id: crypto.randomUUID() };
    pending = active;
    const confirmed = await request<CaptureResult>('/api/preview/capture', { code: active.code }, active.id);
    result.value = confirmed;
    pending = undefined;
    stopCamera();
    emit('captured', confirmed);
  } catch (failure) {
    error.value = (failure as Error).message;
    if (failure instanceof ApiError && failure.code !== 'NETWORK' && failure.code !== 'SERVER') pending = undefined;
  } finally {
    busy.value = false;
  }
}

async function startCamera() {
  error.value = '';
  if (!navigator.mediaDevices?.getUserMedia) {
    error.value = '此浏览器暂时无法打开相机，可直接输入捕获码。';
    return;
  }
  camera.value = true;
  try {
    const active = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    if (!camera.value || disposed) {
      active.getTracks().forEach((track) => track.stop());
      return;
    }
    stream = active;
    await nextTick();
    if (!video.value) return stopCamera();
    video.value.srcObject = stream;
    await video.value.play();
    const { default: scan } = await import('jsqr');
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return stopCamera();
    function tick(time: number) {
      const player = video.value;
      if (!camera.value || !player) return;
      if (context && player.videoWidth && time - lastFrame > 160) {
        lastFrame = time;
        canvas.width = Math.min(player.videoWidth, 520);
        canvas.height = Math.round(player.videoHeight * canvas.width / player.videoWidth);
        context.drawImage(player, 0, 0, canvas.width, canvas.height);
        const picture = context.getImageData(0, 0, canvas.width, canvas.height);
        const found = scan(picture.data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' });
        if (found) {
          code.value = found.data;
          stopCamera();
          void submit(found.data);
          return;
        }
      }
      frame = window.requestAnimationFrame(tick);
    }
    frame = window.requestAnimationFrame(tick);
  } catch {
    stopCamera();
    if (!disposed) error.value = '相机未能启动，可直接输入鼠端捕获码。';
  }
}

onBeforeUnmount(() => { disposed = true; stopCamera(); });
</script>

<template>
  <GameDialog :title="result ? '捕获成功' : '扫码抓捕'" @close="emit('close')">
    <div v-if="result" class="scan-result" role="status">
      <div class="scan-success-icon"><Check :size="31" :stroke-width="2.5" /></div>
      <strong class="scan-result-score">+{{ result.award }} <span>积分</span></strong>
      <p>{{ result.zone }} · {{ String(result.mouseId).padStart(2, '0') }} 号鼠</p>
      <p class="field-feedback">本场有效抓捕 +1。再移动 100 米后可继续抓捕。</p>
      <button class="primary-button full-button" type="button" @click="emit('close')">返回地图</button>
    </div>
    <form v-else class="scan-form" @submit.prevent="submit(code.trim())">
      <p class="dialog-description">{{ zone.name }} · 请在安全位置停步后扫码。</p>
      <div v-if="camera" class="camera-frame"><video ref="video" autoplay playsinline muted></video><i></i></div>
      <button class="secondary-button full-button" type="button" :disabled="busy" @click="camera ? stopCamera() : startCamera()">
        <Camera :size="18" /> {{ camera ? '关闭相机' : '打开相机' }}
      </button>
      <label for="capture-code">手动输入捕获码</label>
      <div class="field-with-action">
        <input id="capture-code" v-model="code" maxlength="64" autocomplete="off" placeholder="输入鼠端捕获码" />
        <button type="submit" class="primary-button" :disabled="!code.trim() || busy"><ScanLine :size="17" /> 确认</button>
      </div>
      <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
      <button class="preview-scan-button" type="button" :disabled="busy || (!canSimulate && !pending)" @click="submit('', true)">
        <FlaskConical :size="17" /> {{ busy ? '校验中' : '模拟本点扫码' }}
      </button>
      <p v-if="!canSimulate" class="field-feedback">
        {{ energy < 100 ? `再移动 ${100 - energy} 米后可以模拟抓捕。` : zone.cooldown > 0 ? '当前区域冷却中。' : '请选择还有可用鼠迹的区域。' }}
      </p>
    </form>
  </GameDialog>
</template>
