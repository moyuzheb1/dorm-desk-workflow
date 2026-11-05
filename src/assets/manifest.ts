import type { ItemKind } from '../core/types.ts';

/**
 * 资产契约（纯数据，不含 three，node 侧脚本可以直接读）。
 *
 * 判分器只认 `ITEM_SIZE` 里的 AABB；模型只是外观，永远不许反过来定义几何。
 * 因此每个 glb 必须满足：
 *   1. 1 unit = 1cm，不做缩放；
 *   2. 原点在底面中心（x/z 居中、y 贴底），这样"放在某个放置面上"才不需要额外偏移；
 *   3. 正面朝 −Z（朝桌前侧、也就是朝用户）；桌面的 z=0 在用户这一侧，z 越大越靠里；
 *   4. 整体包围盒不超过 `ITEM_SIZE[kind]`；外观可以略小（倒角、把手留余量），不能更大；
 *   5. 三角面 ≤ 2000，导出一个 glb 即可。
 *
 * 模型自带材质会被丢弃，统一套 `PALETTE` —— 这样混用不同来源的资产也不会花。
 */
export const ASSET_CONTRACT = [
  '1 unit = 1cm',
  '原点在底面中心',
  '正面朝 −Z',
  '包围盒不超过 ITEM_SIZE',
  '三角面 ≤ 2000',
] as const;

/** 统一低模色板：所有资产共用，模型自带材质会被丢弃。 */
export const PALETTE = {
  body: 0xd9dee6,
  accent: 0x2b313b,
  screen: 0x1b2430,
  metal: 0x8f9aa8,
} as const;

export type ToneKey = keyof typeof PALETTE;

/**
 * 网格名以这些前缀开头就套对应材质，其余一律 body。
 * 例：`screen_panel` / `metal_stand` / `accent_keys` / `mug_body`。
 */
export const TONE_BY_PREFIX: { prefix: string; tone: ToneKey }[] = [
  { prefix: 'screen', tone: 'screen' },
  { prefix: 'metal', tone: 'metal' },
  { prefix: 'accent', tone: 'accent' },
];

/** 一类一件，不做尺寸/配色变体；新增种类要走 ItemKind，而不是加资产 id。 */
export const ASSET_FILE: Record<ItemKind, string> = {
  monitor: 'models/monitor.glb',
  second_monitor: 'models/second_monitor.glb',
  laptop: 'models/laptop.glb',
  keyboard: 'models/keyboard.glb',
  mouse: 'models/mouse.glb',
  lamp: 'models/lamp.glb',
  mug: 'models/mug.glb',
  powerstrip: 'models/powerstrip.glb',
  storage: 'models/storage.glb',
  plant: 'models/plant.glb',
  hanger: 'models/hanger.glb',
  riser: 'models/riser.glb',
  book: 'models/book.glb',
};

/** 资产放在 `public/models/`，构建后就是站点根下的 `/models/*.glb`。 */
export function assetUrl(kind: ItemKind): string {
  return `/${ASSET_FILE[kind]}`;
}
