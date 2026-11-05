import type { Box, Solid, SpaceSpec, Surface } from './types.ts';

const EPS = 1e-6;

export function overlap3D(a: Box, b: Box): boolean {
  return Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > EPS &&
         Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > EPS &&
         Math.min(a.z + a.d, b.z + b.d) - Math.max(a.z, b.z) > EPS;
}

/** x/z 平面投影是否重叠（判断"上方有没有东西压着"）。 */
export function projectionOverlap(a: Box, b: Box): boolean {
  return Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > EPS &&
         Math.min(a.z + a.d, b.z + b.d) - Math.max(a.z, b.z) > EPS;
}

/** 两个盒体表面之间的最短距离，用于走线可达性。 */
export function gap3D(a: Box, b: Box): number {
  const dx = Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w));
  const dy = Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h));
  const dz = Math.max(0, a.z - (b.z + b.d), b.z - (a.z + a.d));
  return Math.hypot(dx, dy, dz);
}

export function centerOf(a: Box): { x: number; y: number; z: number } {
  return { x: a.x + a.w / 2, y: a.y + a.h / 2, z: a.z + a.d / 2 };
}

export function containsPoint(box: Box, p: { x: number; y: number; z: number }): boolean {
  return p.x >= box.x - EPS && p.x <= box.x + box.w + EPS &&
         p.y >= box.y - EPS && p.y <= box.y + box.h + EPS &&
         p.z >= box.z - EPS && p.z <= box.z + box.d + EPS;
}

export function surfaceById(space: SpaceSpec, id: string): Surface | undefined {
  return space.surfaces.find((s) => s.id === id);
}

/** 放置面局部坐标 → 世界坐标盒体。 */
export function placeOn(
  surface: Surface, x: number, z: number, w: number, h: number, d: number, lift = 0,
): Box {
  if (surface.plane === 'vertical') {
    return { x: surface.origin.x + x, y: surface.origin.y + lift, z: surface.origin.z, w, h, d };
  }
  return { x: surface.origin.x + x, y: surface.origin.y + lift, z: surface.origin.z + z, w, h, d };
}

/** 世界坐标盒体 → 放置面局部坐标（给"读现状 → 重算"还原位置用）。 */
export function localOf(surface: Surface, box: Box): { x: number; z: number; lift: number } {
  if (surface.plane === 'vertical') {
    return { x: box.x - surface.origin.x, z: 0, lift: box.y - surface.origin.y };
  }
  return {
    x: box.x - surface.origin.x,
    z: box.z - surface.origin.z,
    lift: box.y - surface.origin.y,
  };
}

/** 局部坐标是否完全落在面内（层高由判分器另算）。 */
export function fitsSurface(surface: Surface, x: number, z: number, w: number, d: number): boolean {
  return x >= -EPS && z >= -EPS && x + w <= surface.w + EPS && z + d <= surface.d + EPS;
}

export interface CabinetOptions {
  id: string;
  /** 柜体左边界 x */
  x: number;
  width: number;
  depth: number;
  z: number;
  bottom: number;
  top: number;
  /** 板厚 */
  board: number;
  /** 格数 */
  levels: number;
}

/**
 * 右侧通高立柜：实体侧板 / 背板 / 层板，加一层一个离散格位。
 * 这是"3D 是任务本身需要"的来源——格位有独立的宽、深、层高，
 * 且只有最下层在坐姿可达范围内。
 */
export function buildCabinet(o: CabinetOptions): { surfaces: Surface[]; solids: Solid[] } {
  const solids: Solid[] = [];
  const surfaces: Surface[] = [];
  const levelH = (o.top - o.bottom) / o.levels;

  solids.push({
    id: `${o.id}-left`, label: '立柜左侧板', blocksSight: true,
    box: { x: o.x, y: o.bottom, z: o.z, w: o.board, h: o.top - o.bottom, d: o.depth },
  });
  solids.push({
    id: `${o.id}-right`, label: '立柜右侧板',
    box: { x: o.x + o.width - o.board, y: o.bottom, z: o.z, w: o.board, h: o.top - o.bottom, d: o.depth },
  });
  solids.push({
    id: `${o.id}-back`, label: '立柜背板',
    box: { x: o.x, y: o.bottom, z: o.z + o.depth - o.board, w: o.width, h: o.top - o.bottom, d: o.board },
  });

  for (let i = 1; i < o.levels; i++) {
    solids.push({
      id: `${o.id}-board${i}`, label: `第 ${i} 层板`, blocksSight: true,
      box: { x: o.x, y: o.bottom + i * levelH - o.board / 2, z: o.z, w: o.width, h: o.board, d: o.depth },
    });
  }

  for (let i = 0; i < o.levels; i++) {
    /** 层板是横跨在分界线上的实体，所以格位地面要抬过层板半厚（最下层直接落在柜底）。 */
    const floorY = o.bottom + i * levelH + (i === 0 ? 0 : o.board / 2);
    surfaces.push({
      id: `slot${i + 1}`,
      label: `立柜第 ${i + 1} 格`,
      kind: 'slot',
      plane: 'horizontal',
      origin: { x: o.x + o.board, y: floorY, z: o.z },
      w: o.width - o.board * 2,
      d: o.depth - o.board,
      headroom: levelH - o.board,
    });
  }

  return { surfaces, solids };
}

export interface SpaceOverrides {
  id: string;
  label: string;
  width: number;
  depth: number;
  deskY?: number;
  bedBottom?: number;
  postSize?: number;
  surfaces: Surface[];
  solids: Solid[];
  reachVolumes: Box[];
}

export function makeSpace(o: SpaceOverrides): SpaceSpec {
  return {
    id: o.id,
    label: o.label,
    width: o.width,
    depth: o.depth,
    deskY: o.deskY ?? 75,
    bedBottom: o.bedBottom ?? 170,
    postSize: o.postSize ?? 2,
    surfaces: o.surfaces,
    solids: o.solids,
    reachVolumes: o.reachVolumes,
  };
}
