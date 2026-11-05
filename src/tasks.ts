import type { DeskSpec, ObjectKind, TaskSpec } from './schema.ts';

export interface CatalogEntry {
  w: number;
  d: number;
  needsPower: boolean;
  layer: 'surface' | 'above';
  x: number;
  y: number;
}

/** 初始槽位刻意保留了若干冲突，用来让"编排是否有用"这个对照实验有区分度。 */
export const CATALOG: Record<ObjectKind, CatalogEntry> = {
  monitor:        { w: 54, d: 20, needsPower: true,  layer: 'surface', x: 33,  y: 38 },
  second_monitor: { w: 48, d: 18, needsPower: true,  layer: 'surface', x: 2,   y: 40 },
  laptop:         { w: 32, d: 22, needsPower: true,  layer: 'surface', x: 20,  y: 36 },
  keyboard:       { w: 44, d: 15, needsPower: false, layer: 'surface', x: 38,  y: 14 },
  mouse:          { w: 7,  d: 11, needsPower: false, layer: 'surface', x: 86,  y: 16 },
  lamp:           { w: 14, d: 14, needsPower: true,  layer: 'surface', x: 2,   y: 40 },
  mug:            { w: 9,  d: 9,  needsPower: false, layer: 'surface', x: 88,  y: 12 },
  powerstrip:     { w: 25, d: 6,  needsPower: false, layer: 'surface', x: 2,   y: 2  },
  shelf:          { w: 30, d: 20, needsPower: false, layer: 'surface', x: 2,   y: 38 },
  storage:        { w: 20, d: 16, needsPower: false, layer: 'surface', x: 96,  y: 2  },
  plant:          { w: 12, d: 12, needsPower: false, layer: 'surface', x: 104, y: 44 },
  cable:          { w: 1,  d: 1,  needsPower: false, layer: 'above',   x: 60,  y: 30 },
};

const DESK: DeskSpec = { width: 120, depth: 60, unit: 'cm' };

/**
 * L1 少量物件 / L2 多约束 / L3 需求本身不可行 / L4 指代歧义 /
 * L5 多轮增量编辑（W3 接入，当前骨架只跑首轮）。
 */
export const TASKS: TaskSpec[] = [
  {
    id: 't01', level: 'L1', prompt: '放一台显示器、键盘和鼠标',
    desk: DESK, required: { monitor: 1, keyboard: 1, mouse: 1 },
  },
  {
    id: 't02', level: 'L1', prompt: '放一台笔记本、一盏台灯和一个水杯',
    desk: DESK, required: { laptop: 1, lamp: 1, mug: 1 },
  },
  {
    id: 't03', level: 'L2', prompt: '布置一个完整的桌面：显示器、键盘、鼠标、台灯、水杯、插座和收纳盒',
    desk: DESK, required: { monitor: 1, keyboard: 1, mouse: 1, lamp: 1, mug: 1, powerstrip: 1, storage: 1 },
  },
  {
    id: 't04', level: 'L2', prompt: '双屏桌面：主屏、副屏、键盘、鼠标、台灯、水杯、插座',
    desk: DESK, required: { monitor: 1, second_monitor: 1, keyboard: 1, mouse: 1, lamp: 1, mug: 1, powerstrip: 1 },
  },
  {
    id: 't05', level: 'L2', prompt: '笔记本加书架和绿植，还要台灯、水杯、插座',
    desk: DESK, required: { laptop: 1, shelf: 1, plant: 1, lamp: 1, mug: 1, powerstrip: 1 },
  },
  {
    id: 't06', level: 'L2', prompt: '显示器、键盘、鼠标、水杯、绿植、插座、收纳盒、台灯都要有',
    desk: DESK, required: { monitor: 1, keyboard: 1, mouse: 1, mug: 1, plant: 1, powerstrip: 1, storage: 1, lamp: 1 },
  },
  {
    id: 't07', level: 'L3', prompt: '60cm 宽的桌上放 3 台 27 寸显示器、键盘和鼠标',
    desk: { width: 60, depth: 60, unit: 'cm' },
    required: { monitor: 3, keyboard: 1, mouse: 1 },
    expectInfeasible: true,
  },
  {
    id: 't08', level: 'L3', prompt: '台灯必须放在显示器正后方，且不占用任何桌面面积',
    desk: DESK, required: { monitor: 1, lamp: 1, keyboard: 1 },
    expectInfeasible: true,
  },
  {
    id: 't09', level: 'L4', prompt: '把它往左挪 10cm，其他都别动',
    desk: DESK, required: { monitor: 1, keyboard: 1 },
    expectClarify: true,
  },
  {
    id: 't10', level: 'L5', prompt: '先布置双屏桌面，再按后续指令逐步调整',
    desk: DESK, required: { monitor: 1, second_monitor: 1, keyboard: 1, mouse: 1, mug: 1, powerstrip: 1 },
    edits: [
      '把显示器往左挪 10cm',
      '加一个水杯，别挨着键盘',
      '台灯移到桌面右上角',
      '把鼠标换成收纳盒',
      '其他都别动',
    ],
  },
];

export function requiredKinds(task: TaskSpec): ObjectKind[] {
  const kinds: ObjectKind[] = [];
  for (const [kind, count] of Object.entries(task.required)) {
    for (let i = 0; i < (count ?? 0); i++) kinds.push(kind as ObjectKind);
  }
  return kinds;
}
