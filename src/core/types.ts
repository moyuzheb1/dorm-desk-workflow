export type Layer = 'desk' | 'shelf' | 'wall' | 'floor' | 'bed' | 'post';

export type ItemKind =
  | 'monitor' | 'second_monitor' | 'laptop' | 'keyboard' | 'mouse'
  | 'lamp' | 'mug' | 'powerstrip' | 'storage' | 'plant' | 'hanger'
  | 'riser' | 'book';

/** 最小角 + 尺寸，单位 cm。x 向右、y 向上、z 向桌子里侧。 */
export interface Box {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
}

/** 放置面类型：桌面 / 立柜格位 / 侧向凹槽 / 墙面 / 桌下柜。 */
export type SurfaceKind = 'desk' | 'slot' | 'niche' | 'wall' | 'drawer';

/**
 * 一个离散放置面。立体性来自：格位是凹进去的、有层高与进深上限，
 * 不同格位的可达性不同——不是同一块平面上换坐标。
 */
export interface Surface {
  id: string;
  label: string;
  kind: SurfaceKind;
  /** horizontal：原点在面左下角，x/z 为面内坐标；vertical：贴墙，x 横向、lift 为离地高度 */
  plane: 'horizontal' | 'vertical';
  origin: { x: number; y: number; z: number };
  /** 面内可用宽 / 深 */
  w: number;
  d: number;
  /** 物件顶部到上方层板底或床板底的最大高度 */
  headroom: number;
}

/** 实体结构件：柜体侧板、层板、背板、桌板、床板。占体积，不可穿透。 */
export interface Solid {
  id: string;
  label: string;
  box: Box;
  /** 参与视线遮挡判定（柜体侧板会挡住显示器） */
  blocksSight?: boolean;
}

export interface SpaceSpec {
  id: string;
  label: string;
  width: number;
  depth: number;
  deskY: number;
  bedBottom: number;
  postSize: number;
  surfaces: Surface[];
  solids: Solid[];
  /** 坐姿可达体积，可多个（桌面近侧 / 右侧最下层格位） */
  reachVolumes: Box[];
}

export interface BoxItem {
  id: string;
  kind: ItemKind;
  label: string;
  layer: Layer;
  /** 它站在哪个放置面上 */
  surfaceId: string;
  box: Box;
  needsPower?: boolean;
  pluggedInto?: string;
  /** 需要落在坐姿伸手体积内 */
  frequentlyUsed?: boolean;
  /** 屏幕类：需要上方净空与前方无遮挡 */
  screen?: boolean;
  minHeadroom?: number;
}

export interface Scene {
  space: SpaceSpec;
  items: BoxItem[];
}

export type ViolationCode =
  | 'overlap' | 'clearance' | 'reach' | 'occlusion' | 'liquid'
  | 'cable' | 'bounds' | 'dangling' | 'density'
  | 'penetration' | 'capacity';

export interface Violation {
  code: ViolationCode;
  severity: 'hard' | 'soft';
  objectIds: string[];
  message: string;
}

export interface Grade {
  pass: boolean;
  score: number;
  hard: Violation[];
  soft: Violation[];
}
