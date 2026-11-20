<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref, watch } from 'vue';
import L from 'leaflet';
import { Crosshair, Layers3, Maximize, Minus, Plus } from 'lucide-vue-next';
import { campus, metersBetween, type Position, type ZoneView } from '../model';
import { liveMapKey } from '../composables/useGame';
import { createAmap } from '../map/amap';
import { mapPalette } from '../map/palette';

const props = defineProps<{ zones: ZoneView[]; selected: string; demo: boolean }>();
const emit = defineEmits<{ select: [id: string]; position: [point: Position] }>();
const live = inject(liveMapKey);
const mapElement = ref<HTMLElement>();
const amapElement = ref<HTMLElement>();
const mapMessage = ref('');
const online = ref(false);
const loadingLayer = ref(false);
const position = ref<Position>(campus.demoPosition);
const usingGps = ref(false);
const locating = ref(false);
let map: L.Map | undefined;
let zoneLayer: L.LayerGroup | undefined;
let liveLayer: L.LayerGroup | undefined;
let personalMarker: L.Marker | undefined;
let onlineMap: Awaited<ReturnType<typeof createAmap>> | undefined;
let resize: ResizeObserver | undefined;
let geometryRequest: AbortController | undefined;
let disposed = false;

const latLng = ([lng, lat]: Position): L.LatLngTuple => [lat, lng];
const campusBounds = L.latLngBounds(campus.boundary.map(latLng));
const zoneKey = computed(() => props.zones.map((zone) => `${zone.id}:${zone.available.length}:${!!zone.cooldown}`).join(','));

function updateMarkers() {
  onlineMap?.setZones(props.zones, props.selected);
  zoneLayer?.clearLayers();
  if (!zoneLayer) return;
  for (const zone of props.zones) {
    const selected = zone.id === props.selected;
    const inert = zone.available.length === 0 || zone.cooldown > 0;
    const { stroke, fill } = inert ? mapPalette.inactive : mapPalette.mouse;
    L.circle(latLng(zone.position), {
      radius: zone.radius, color: stroke, opacity: selected ? 0.95 : 0.75,
      weight: selected ? 2 : 1, fillColor: fill,
      fillOpacity: selected ? 0.34 : 0.19, dashArray: '4 4',
    }).on('click', () => emit('select', zone.id)).addTo(zoneLayer);
    L.marker(latLng(zone.position), {
      title: zone.name, alt: `${zone.name}，${zone.available.length} 条可用鼠迹`,
      zIndexOffset: selected ? 1100 : 400,
      icon: L.divIcon({
        className: 'map-marker-root',
        html: `<span class="map-pin ${selected ? 'is-selected' : ''} ${inert ? 'is-inactive' : ''}"><span class="map-pin-core"></span>${zone.available.length}</span>`,
        iconSize: [42, 34], iconAnchor: [21, 17],
      }),
    }).on('click', () => emit('select', zone.id))
      .bindTooltip(zone.name, { direction: 'top', offset: [0, -12], className: 'zone-tooltip' })
      .addTo(zoneLayer);
  }
}

function updateLiveMarkers() {
  const markers = live?.markers.value ?? [];
  liveLayer?.clearLayers();
  onlineMap?.setLiveMarkers(online.value ? markers : []);
  if (!liveLayer || online.value) return;
  for (const { lat, lng, role } of markers) {
    const glyph = role === 'mouse' ? '鼠' : '猫';
    L.marker([lat, lng], {
      title: `实时${glyph}位置`, interactive: false, keyboard: false, zIndexOffset: 1500,
      icon: L.divIcon({
        className: `live-map-marker live-map-marker--${role}`,
        html: glyph, iconSize: [24, 24], iconAnchor: [12, 12],
      }),
    }).addTo(liveLayer);
  }
}

function fitCampus() {
  if (online.value) onlineMap?.fit();
  else map?.fitBounds(campusBounds, { paddingTopLeft: [28, 29], paddingBottomRight: [32, 44], animate: false });
}

function updateLocation() {
  personalMarker?.setLatLng(latLng(position.value));
  const label = usingGps.value ? '我的位置' : props.demo ? '演示位置' : '位置未获取';
  personalMarker?.setTooltipContent(label);
  personalMarker?.setOpacity(usingGps.value || props.demo ? 1 : 0);
  onlineMap?.setPosition(position.value);
}

function applyGps(point: Position) {
  position.value = point;
  usingGps.value = true;
  updateLocation();
  emit('position', point);
}

function locate() {
  if (locating.value) return;
  if (!navigator.geolocation) {
    mapMessage.value = '此浏览器暂时无法定位，已保留校区全景。';
    fitCampus();
    return;
  }
  locating.value = true;
  mapMessage.value = '';
  navigator.geolocation.getCurrentPosition((reading) => {
    if (disposed) return;
    locating.value = false;
    const point: Position = [reading.coords.longitude, reading.coords.latitude];
    if (metersBetween(point, campus.center) > 1300) {
      mapMessage.value = '你当前在校区之外，正在查看校区全景。';
      fitCampus();
      return;
    }
    applyGps(point);
    live?.enableLocation(reading);
    if (online.value) onlineMap?.center(point);
    else map?.panTo(latLng(point));
  }, () => {
    if (disposed) return;
    locating.value = false;
    mapMessage.value = '暂时无法取得定位，当前显示校区全景。';
    fitCampus();
  }, { timeout: 6000, enableHighAccuracy: true, maximumAge: live?.enabled.value ? 0 : 10000 });
}

watch(() => live?.gpsPosition.value, (point) => {
  if (point) applyGps(point);
}, { immediate: true });

function showLayer(showAmap: boolean) {
  online.value = showAmap;
  // Preserve the classes each map library adds to its container.
  mapElement.value?.classList.toggle('map-below', showAmap);
  amapElement.value?.classList.toggle('map-visible', showAmap);
  updateLiveMarkers();
}

async function toggleLayer() {
  if (!amapElement.value || loadingLayer.value) return;
  mapMessage.value = '';
  if (online.value) {
    showLayer(false);
    map?.invalidateSize();
    return;
  }
  loadingLayer.value = true;
  try {
    const nextMap = onlineMap ?? await createAmap(amapElement.value, (id) => emit('select', id));
    if (disposed) {
      nextMap.destroy();
      return;
    }
    onlineMap = nextMap;
    onlineMap.setZones(props.zones, props.selected);
    onlineMap.setPosition(position.value);
    showLayer(true);
    onlineMap.resize();
    onlineMap.fit();
  } catch (error) {
    mapMessage.value = (error as Error).message;
  } finally {
    loadingLayer.value = false;
  }
}

const styles: Record<string, L.PathOptions> = {
  building: { color: '#c6c6cc', weight: 0.8, fillColor: '#fbf8f2', fillOpacity: 1 },
  block: { color: '#e0d8cc', weight: 1, fillColor: '#f1ece3', fillOpacity: 0.9 },
  green: { color: '#cfdbc1', weight: 0.8, fillColor: '#dbe7c8', fillOpacity: 0.9 },
  sport: { color: '#d7a889', weight: 1.1, fillColor: '#f0c6ab', fillOpacity: 0.88 },
  trail: { color: '#fbf9ee', weight: 3.5, opacity: 0.95, dashArray: '3 4' },
  lane: { color: '#fffdf7', weight: 3, opacity: 1 },
  road: { color: '#fffdf9', weight: 6, opacity: 1 },
};

onMounted(async () => {
  if (!mapElement.value) return;
  map = L.map(mapElement.value, {
    minZoom: 14, maxZoom: 19, zoomSnap: 0.1, zoomDelta: 0.5,
    zoomControl: false, attributionControl: false, maxBounds: campusBounds.pad(0.85), preferCanvas: true,
    scrollWheelZoom: false,
  });
  map.createPane('campus-base').style.zIndex = '300';
  L.polygon(campus.boundary.map(latLng), {
    color: mapPalette.campus.stroke, opacity: 0.95, weight: 1.8, dashArray: '7 6',
    fillColor: mapPalette.campus.fill, fillOpacity: 0.24, interactive: false,
  }).addTo(map);
  zoneLayer = L.layerGroup().addTo(map);
  liveLayer = L.layerGroup().addTo(map);
  L.marker(latLng([108.91724, 34.17882]), {
    interactive: false,
    icon: L.divIcon({ className: 'campus-map-name', html: campus.name, iconSize: [120, 22], iconAnchor: [60, 11] }),
  }).addTo(map);
  personalMarker = L.marker(latLng(position.value), {
    zIndexOffset: 1800,
    title: '当前位置',
    icon: L.divIcon({ className: 'map-marker-root', html: '<span class="personal-map-dot"></span>', iconSize: [20, 20], iconAnchor: [10, 10] }),
  }).bindTooltip('位置未获取', { direction: 'bottom', offset: [0, 10], className: 'zone-tooltip' }).addTo(map);
  updateLocation();
  updateMarkers();
  updateLiveMarkers();
  fitCampus();
  live?.setOpen(true);
  resize = new ResizeObserver(() => {
    map?.invalidateSize({ pan: false });
    if (online.value) onlineMap?.resize();
  });
  resize.observe(mapElement.value);
  geometryRequest = new AbortController();
  try {
    const response = await fetch('/campus-map.json', { signal: geometryRequest.signal });
    if (!response.ok) throw new Error();
    const features = await response.json();
    if (disposed || !map) return;
    L.geoJSON(features, { interactive: false, pane: 'campus-base', style: (feature) => styles[feature?.properties.kind as string] }).addTo(map);
  } catch {
    if (!disposed) mapMessage.value = '部分底图详情暂时不可用，围栏和鼠迹仍可查看。';
  }
});

watch([zoneKey, () => props.selected], updateMarkers);
watch(() => live?.markers.value, updateLiveMarkers);
onUnmounted(() => {
  disposed = true;
  live?.setOpen(false);
  geometryRequest?.abort();
  resize?.disconnect();
  map?.remove();
  onlineMap?.destroy();
});
</script>

<template>
  <section class="panel map-panel" aria-labelledby="map-title">
    <div class="panel-heading map-heading">
      <div><h2 id="map-title">活动地图</h2><p>{{ live?.enabled.value ? '全校区围栏 · 定位后在活动时段共享坐标' : '全校区围栏 · 区域鼠迹' }}</p></div>
      <button type="button" class="secondary-button map-layer-button" :disabled="loadingLayer" @click="toggleLayer">
        <Layers3 :size="16" /> {{ loadingLayer ? '加载中' : online ? '校区图' : '高德底图' }}
      </button>
    </div>
    <div class="map-main">
      <div ref="mapElement" class="map-canvas" :aria-hidden="online" aria-label="西安欧亚学院校区地图"></div>
      <div ref="amapElement" class="map-canvas amap-canvas" :aria-hidden="!online"></div>
      <div class="map-controls" aria-label="地图控制">
        <button type="button" aria-label="查看全校区" @click="fitCampus"><Maximize :size="17" /></button>
        <button type="button" aria-label="放大地图" @click="online ? onlineMap?.zoomIn() : map?.zoomIn()"><Plus :size="19" /></button>
        <button type="button" aria-label="缩小地图" @click="online ? onlineMap?.zoomOut() : map?.zoomOut()"><Minus :size="19" /></button>
        <button type="button" :aria-label="live?.enabled.value ? '定位并共享实时位置' : '定位我自己'" :disabled="locating" @click="locate"><Crosshair :size="18" /></button>
      </div>
      <div v-if="mapMessage || live?.message.value" class="map-notice" role="status">{{ mapMessage || live?.message.value }}</div>
    </div>
    <div class="map-footer">
      <div class="map-legend">
        <span><i class="legend-mouse"></i>鼠迹区域</span>
        <span><i class="legend-position"></i>{{ usingGps ? '我的位置' : demo ? '演示位置' : '位置未获取' }}</span>
        <span><i class="legend-boundary"></i>校区范围</span>
      </div>
      <a class="map-attribution" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a>
    </div>
  </section>
</template>

<style scoped>
.map-main :deep(.live-map-marker) {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: 2px solid white;
  border-radius: 50%;
  background: #9c3918;
  color: white;
  box-shadow: 0 1px 4px #18204a55;
  font-size: 12px;
  font-weight: 700;
}

.map-main :deep(.live-map-marker--cat) {
  background: #33499b;
}
</style>
