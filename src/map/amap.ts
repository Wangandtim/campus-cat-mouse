import { wgs84togcj02 } from 'coordtransform';
import { campus, request, type Position, type Role, type ZoneView } from '../model';
import { mapPalette } from './palette';

type Overlay = { on(event: 'click', callback: () => void): void };
type Marker = Overlay & { setPosition(position: Position): void };
type LiveMarker = Readonly<{ lat: number; lng: number; role: Role }>;
type AmapInstance = {
  on(event: 'complete', callback: () => void): void;
  off(event: 'complete', callback: () => void): void;
  add(overlays: Overlay[]): void;
  remove(overlays: Overlay[]): void;
  setFitView(overlays?: Overlay[], immediate?: boolean, padding?: number[]): void;
  setCenter(position: Position): void;
  zoomIn(): void;
  zoomOut(): void;
  resize?(): void;
  destroy(): void;
};
type AmapLibrary = {
  Map: new (element: HTMLElement, options: object) => AmapInstance;
  Polygon: new (options: object) => Overlay;
  Circle: new (options: object) => Overlay;
  Marker: new (options: object) => Marker;
  Pixel: new (x: number, y: number) => object;
};

declare global {
  interface Window {
    AMap?: AmapLibrary;
    _AMapSecurityConfig?: { serviceHost: string };
  }
}

function loadLibrary(key: string): Promise<AmapLibrary> {
  if (window.AMap?.Map) return Promise.resolve(window.AMap);
  window._AMapSecurityConfig = { serviceHost: `${location.origin}/_AMapService` };
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timer = window.setTimeout(() => {
      script.remove();
      reject(new Error('高德底图连接超时，当前显示校区图。'));
    }, 9000);
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(key)}`;
    script.async = true;
    script.onload = () => {
      window.clearTimeout(timer);
      if (window.AMap?.Map) resolve(window.AMap);
      else reject(new Error('高德底图暂时不可用，当前显示校区图。'));
    };
    script.onerror = () => {
      window.clearTimeout(timer);
      script.remove();
      reject(new Error('高德底图连接失败，当前显示校区图。'));
    };
    document.head.append(script);
  });
}

export async function createAmap(element: HTMLElement, select: (id: string) => void) {
  const settings = await request<{ amapKey: string | null }>('/api/map-settings');
  if (!settings.amapKey) throw new Error('当前预览使用校区图，高德配置待接入。');
  const api = await loadLibrary(settings.amapKey);
  const map = new api.Map(element, {
    center: wgs84togcj02(...campus.center),
    zoom: 16,
    viewMode: '2D',
    features: ['bg', 'road', 'building', 'point'],
    mapStyle: 'amap://styles/whitesmoke',
  });
  const boundary = new api.Polygon({
    path: campus.boundary.map((point) => wgs84togcj02(...point)),
    strokeColor: mapPalette.campus.stroke,
    strokeWeight: 2,
    strokeStyle: 'dashed',
    fillColor: mapPalette.campus.fill,
    fillOpacity: 0.12,
  });
  const markerElement = document.createElement('span');
  markerElement.className = 'personal-map-dot';
  const personal = new api.Marker({
    position: wgs84togcj02(...campus.demoPosition),
    content: markerElement,
    offset: new api.Pixel(-10, -10),
    zIndex: 130,
  });
  map.add([boundary, personal]);
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        window.clearTimeout(timer);
        map.off('complete', finish);
        resolve();
      };
      const timer = window.setTimeout(() => {
        map.off('complete', finish);
        reject(new Error('高德底图尚未加载，当前显示校区图。'));
      }, 8500);
      map.on('complete', finish);
    });
  } catch (error) {
    map.destroy();
    throw error;
  }
  const fit = () => map.setFitView([boundary], true, [28, 32, 44, 32]);
  fit();
  let overlays: Overlay[] = [];
  let liveOverlays: Marker[] = [];

  function clearLiveMarkers() {
    if (liveOverlays.length) map.remove(liveOverlays);
    liveOverlays = [];
  }

  return {
    setZones(zones: ZoneView[], selected: string) {
      if (overlays.length) map.remove(overlays);
      overlays = zones.flatMap((zone) => {
        const position = wgs84togcj02(...zone.position);
        const active = selected === zone.id;
        const inactive = !zone.available.length || zone.cooldown > 0;
        const { stroke, fill } = inactive ? mapPalette.inactive : mapPalette.mouse;
        const radius = new api.Circle({
          center: position, radius: zone.radius, strokeColor: stroke, strokeWeight: active ? 2 : 1,
          fillColor: fill, fillOpacity: active ? 0.30 : 0.17, strokeOpacity: 0.75,
        });
        const pin = document.createElement('button');
        pin.type = 'button';
        pin.className = `map-pin ${active ? 'is-selected' : ''} ${inactive ? 'is-inactive' : ''}`;
        const glyph = document.createElement('span');
        glyph.className = 'map-pin-core';
        glyph.setAttribute('aria-hidden', 'true');
        pin.append(glyph, String(zone.available.length));
        pin.setAttribute('aria-label', `${zone.name}，${zone.available.length} 条鼠迹`);
        pin.addEventListener('click', (event) => { event.stopPropagation(); select(zone.id); });
        const marker = new api.Marker({ position, content: pin, offset: new api.Pixel(-21, -17) });
        radius.on('click', () => select(zone.id));
        return [radius, marker];
      });
      map.add(overlays);
    },
    setLiveMarkers(markers: readonly LiveMarker[]) {
      clearLiveMarkers();
      liveOverlays = markers.map(({ lng, lat, role }) => {
        const glyph = role === 'mouse' ? '鼠' : '猫';
        const content = document.createElement('span');
        content.className = `live-map-marker live-map-marker--${role}`;
        content.textContent = glyph;
        return new api.Marker({
          position: wgs84togcj02(lng, lat),
          content,
          title: `实时${glyph}位置`,
          anchor: 'center',
          offset: new api.Pixel(0, 0),
          zIndex: 120,
          clickable: false,
        });
      });
      if (liveOverlays.length) map.add(liveOverlays);
    },
    zoomIn: () => map.zoomIn(),
    zoomOut: () => map.zoomOut(),
    center: (point: Position) => map.setCenter(wgs84togcj02(...point)),
    setPosition: (point: Position) => personal.setPosition(wgs84togcj02(...point)),
    fit,
    resize: () => map.resize?.(),
    destroy() {
      clearLiveMarkers();
      map.destroy();
    },
  };
}
