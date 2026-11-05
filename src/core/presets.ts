import { makeItem } from './catalog.ts';
import { buildCabinet, makeSpace } from './space.ts';
import type { Box, Scene, Solid, SpaceSpec, Surface } from './types.ts';

const DESK_Y = 75;

interface RoomOptions {
  id: string;
  label: string;
  /** 整块空间宽度（桌面 + 右侧立柜） */
  width: number;
  depth: number;
  /** 桌面可摆物件的宽度 */
  deskW: number;
  bedBottom?: number;
  /** 右侧通高立柜：给出 4 个离散格位（越往上越不可达） */
  cabinet?: boolean;
}

/**
 * 一个"上床下桌"房间：桌面 + 可选立柜格位 + 墙面。
 * 立体性来自格位本身有宽/深/层高，且只有最下层落在坐姿可达体积里。
 */
function room(o: RoomOptions): SpaceSpec {
  const bedBottom = o.bedBottom ?? 170;
  const surfaces: Surface[] = [{
    id: 'desk',
    label: '桌面',
    kind: 'desk',
    plane: 'horizontal',
    origin: { x: 0, y: DESK_Y, z: 0 },
    w: o.deskW,
    d: o.depth,
    headroom: bedBottom - DESK_Y - 5,
  }];
  const solids: Solid[] = [];
  const reachVolumes: Box[] = [
    { x: 0, y: DESK_Y, z: 0, w: o.deskW, h: 35, d: o.depth },
  ];

  if (o.cabinet) {
    const cab = buildCabinet({
      id: 'cab',
      x: o.width - 34,
      width: 32,
      depth: o.depth - 10,
      z: 8,
      bottom: DESK_Y,
      top: bedBottom,
      board: 2,
      levels: 4,
    });
    surfaces.push(...cab.surfaces);
    solids.push(...cab.solids);
    const bottomSlot = cab.surfaces[0];
    reachVolumes.push({
      x: bottomSlot.origin.x,
      y: bottomSlot.origin.y,
      z: bottomSlot.origin.z,
      w: bottomSlot.w,
      h: bottomSlot.headroom,
      d: bottomSlot.d,
    });
  }

  surfaces.push({
    id: 'wall',
    label: '墙面',
    kind: 'wall',
    plane: 'vertical',
    origin: { x: 0, y: 100, z: o.depth - 2 },
    w: o.deskW,
    d: 2,
    headroom: 60,
  });

  return makeSpace({
    id: o.id,
    label: o.label,
    width: o.width,
    depth: o.depth,
    deskY: DESK_Y,
    bedBottom,
    surfaces,
    solids,
    reachVolumes,
  });
}

/** 合规基准：靠墙单屏。判分必须 0 硬违规。 */
function single(): Scene {
  const space = room({ id: 'single', label: '靠墙单屏', width: 140, depth: 60, deskW: 104, cabinet: true });
  return {
    space,
    items: [
      makeItem(space, 'monitor', 'monitor', 'desk', 14, 40),
      makeItem(space, 'keyboard', 'keyboard', 'desk', 16, 8),
      makeItem(space, 'mouse', 'mouse', 'desk', 64, 10),
      makeItem(space, 'lamp', 'lamp', 'desk', 0, 34),
      makeItem(space, 'mug', 'mug', 'desk', 93, 0),
      makeItem(space, 'powerstrip', 'powerstrip', 'desk', 28, 0),
      makeItem(space, 'book', 'book', 'slot1', 0, 2),
    ],
  };
}

/** 合规基准：笔记本 + 立柜里的书/收纳/绿植。 */
function laptopShelf(): Scene {
  const space = room({ id: 'laptop-shelf', label: '笔记本加书架', width: 140, depth: 60, deskW: 104, cabinet: true });
  return {
    space,
    items: [
      makeItem(space, 'laptop', 'laptop', 'desk', 20, 16),
      makeItem(space, 'lamp', 'lamp', 'desk', 0, 34),
      makeItem(space, 'mug', 'mug', 'desk', 93, 0),
      makeItem(space, 'powerstrip', 'powerstrip', 'desk', 28, 0),
      makeItem(space, 'book1', 'book', 'slot1', 0, 0),
      makeItem(space, 'book2', 'book', 'slot1', 0, 24),
      makeItem(space, 'storage', 'storage', 'slot2', 0, 2),
      makeItem(space, 'plant', 'plant', 'slot3', 0, 2),
    ],
  };
}

/**
 * 故意留一处格位超限：副屏被塞进立柜第 2 格，格位宽 28cm、层高 21.75cm，
 * 都装不下 48×32 的副屏 —— 判分器同时报 bounds 与 clearance（还会穿到侧板）。
 * 这类问题在平面模型里根本表达不出来，挪回桌面即可修复。
 */
function dual(): Scene {
  const space = room({ id: 'dual', label: '已装副屏', width: 140, depth: 60, deskW: 104, cabinet: true });
  return {
    space,
    items: [
      makeItem(space, 'monitor', 'monitor', 'desk', 48, 40),
      makeItem(space, 'second_monitor', 'second_monitor', 'slot2', 0, 2),
      makeItem(space, 'keyboard', 'keyboard', 'desk', 16, 8),
      makeItem(space, 'mouse', 'mouse', 'desk', 64, 10),
      makeItem(space, 'lamp', 'lamp', 'desk', 0, 34),
      makeItem(space, 'mug', 'mug', 'desk', 93, 0),
      makeItem(space, 'powerstrip', 'powerstrip', 'desk', 28, 0),
    ],
  };
}

/** 故意留一处超界问题：墙面挂件伸出了 80cm 窄桌。 */
function narrow(): Scene {
  const space = room({ id: 'narrow', label: '极窄桌', width: 80, depth: 50, deskW: 80, bedBottom: 165 });
  return {
    space,
    items: [
      makeItem(space, 'laptop', 'laptop', 'desk', 10, 8),
      makeItem(space, 'lamp', 'lamp', 'desk', 62, 32),
      makeItem(space, 'mug', 'mug', 'desk', 60, 4),
      makeItem(space, 'storage', 'storage', 'desk', 2, 32),
      makeItem(space, 'powerstrip', 'powerstrip', 'desk', 30, 2),
      makeItem(space, 'hanger', 'hanger', 'wall', 70, 0, 20),
    ],
  };
}

/** 评测轨的 4 个结构化预设现状。两个合规、两个带真实待修问题。 */
export const PRESETS: Scene[] = [single(), laptopShelf(), dual(), narrow()];
