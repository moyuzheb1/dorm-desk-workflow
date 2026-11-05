import { placeOn, surfaceById } from './space.ts';
import type { BoxItem, ItemKind, Layer, SpaceSpec, SurfaceKind } from './types.ts';

export const LABEL: Record<ItemKind, string> = {
  monitor: '主显示器', second_monitor: '副显示器', laptop: '笔记本',
  keyboard: '键盘', mouse: '鼠标', lamp: '台灯', mug: '水杯',
  powerstrip: '插座', storage: '收纳盒', plant: '绿植', hanger: '墙面挂件',
  riser: '显示器增高架', book: '一摞书',
};

/** 尺寸与语义由本地决定，模型只负责给 surfaceId + 面内坐标。 */
export const ITEM_SIZE: Record<ItemKind, { w: number; h: number; d: number }> = {
  monitor: { w: 54, h: 34, d: 18 },
  second_monitor: { w: 48, h: 32, d: 18 },
  laptop: { w: 32, h: 25, d: 22 },
  keyboard: { w: 44, h: 3, d: 15 },
  mouse: { w: 7, h: 3, d: 11 },
  lamp: { w: 14, h: 35, d: 14 },
  mug: { w: 9, h: 10, d: 9 },
  powerstrip: { w: 25, h: 3, d: 6 },
  storage: { w: 20, h: 12, d: 16 },
  plant: { w: 12, h: 18, d: 12 },
  hanger: { w: 20, h: 15, d: 2 },
  riser: { w: 60, h: 8, d: 20 },
  book: { w: 18, h: 10, d: 24 },
};

export const ITEM_META: Record<ItemKind, {
  needsPower?: boolean; screen?: boolean; frequentlyUsed?: boolean;
}> = {
  monitor: { needsPower: true, screen: true },
  second_monitor: { needsPower: true, screen: true },
  laptop: { needsPower: true, screen: true, frequentlyUsed: true },
  keyboard: { frequentlyUsed: true },
  mouse: { frequentlyUsed: true },
  lamp: { needsPower: true },
  mug: { frequentlyUsed: true },
  powerstrip: {},
  storage: {},
  plant: {},
  hanger: {},
  riser: {},
  book: {},
};

const LAYER_OF: Record<SurfaceKind, Layer> = {
  desk: 'desk', slot: 'shelf', niche: 'shelf', wall: 'wall', drawer: 'desk',
};

/** 每类物件的默认归宿：哪个面、面内哪个槽位。离线算子从这里出发再被判分器修正。 */
export const ITEM_HOME: Record<ItemKind, { surface: string; x: number; z: number; lift?: number }> = {
  monitor: { surface: 'desk', x: 14, z: 40 },
  second_monitor: { surface: 'desk', x: 0, z: 40 },
  laptop: { surface: 'desk', x: 6, z: 10 },
  keyboard: { surface: 'desk', x: 16, z: 8 },
  mouse: { surface: 'desk', x: 64, z: 10 },
  lamp: { surface: 'desk', x: 0, z: 34 },
  mug: { surface: 'desk', x: 93, z: 0 },
  powerstrip: { surface: 'desk', x: 28, z: 0 },
  storage: { surface: 'slot2', x: 0, z: 2 },
  plant: { surface: 'slot3', x: 0, z: 2 },
  hanger: { surface: 'wall', x: 16, z: 0, lift: 20 },
  riser: { surface: 'desk', x: 6, z: 30 },
  book: { surface: 'slot1', x: 0, z: 2 },
};

export function makeItem(
  space: SpaceSpec, id: string, kind: ItemKind, surfaceId: string, x: number, z: number, lift = 0,
): BoxItem {
  const surface = surfaceById(space, surfaceId);
  if (!surface) throw new Error(`未知放置面：${surfaceId}`);
  const size = ITEM_SIZE[kind];
  return {
    id,
    kind,
    label: LABEL[kind],
    layer: LAYER_OF[surface.kind],
    surfaceId,
    box: placeOn(surface, x, z, size.w, size.h, size.d, lift),
    ...ITEM_META[kind],
  };
}
