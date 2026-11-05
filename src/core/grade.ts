import { makeItem } from './catalog.ts';
import {
  centerOf, containsPoint, gap3D, overlap3D, projectionOverlap,
} from './space.ts';
import type { Box, Grade, ItemKind, Scene, Violation, ViolationCode } from './types.ts';

const EPS = 1e-6;
const MAX_CABLE_GAP = 55;
const BED_HEADROOM = 5;

/** 怕水的电器；插座在桌沿，不计入。 */
const ELECTRONICS = new Set<ItemKind>([
  'monitor', 'second_monitor', 'laptop', 'keyboard', 'mouse', 'lamp',
]);

/** 约束滑块直接改这些阈值；判分器无状态，改阈值立刻改变结果。 */
export interface GradeOptions {
  /** 屏幕上方到床板的最小净空 */
  screenHeadroom: number;
  /** 水杯与电子设备的最小距离 */
  liquidGap: number;
  /** 坐姿伸手可达的进深（会截断可达体积） */
  reachDepth: number;
  /** 桌面可用宽度比例 */
  usableRatio: number;
  /** 单个放置面的投影占用上限 */
  slotFill: number;
}

export const DEFAULT_OPTIONS: GradeOptions = {
  screenHeadroom: 25,
  liquidGap: 15,
  reachDepth: 38,
  usableRatio: 1,
  slotFill: 0.85,
};

function v(code: ViolationCode, objectIds: string[], message: string, severity: 'hard' | 'soft' = 'hard'): Violation {
  return { code, severity, objectIds, message };
}

/**
 * 立体判分器：全部在结构化坐标上解析计算，不依赖渲染网格。
 * 九类硬约束：面内边界 / 实体穿透 / 占位重叠 / 净空（床板 + 格位层高）/
 * 分面可达 / 视线遮挡（含柜体侧板）/ 水杯安全距离 / 走线 / 格位容量，
 * 另有桌面密度软约束。
 */
export function grade(scene: Scene, options: GradeOptions = DEFAULT_OPTIONS): Grade {
  const { space, items } = scene;
  const hard: Violation[] = [];
  const soft: Violation[] = [];
  const ids = new Set<string>();
  const surfaceMap = new Map(space.surfaces.map((s) => [s.id, s]));

  for (const it of items) {
    if (ids.has(it.id)) hard.push(v('dangling', [it.id], `重复 id：${it.id}`));
    ids.add(it.id);
  }
  for (const it of items) {
    if (it.pluggedInto && !ids.has(it.pluggedInto)) {
      hard.push(v('dangling', [it.id], `${it.label} 引用了不存在的插座 ${it.pluggedInto}`));
    }
    if (!surfaceMap.has(it.surfaceId)) {
      hard.push(v('dangling', [it.id], `${it.label} 站在不存在的放置面 ${it.surfaceId}`));
    }
  }

  for (const it of items) {
    const s = surfaceMap.get(it.surfaceId);
    if (!s) continue;
    const b = it.box;
    const maxX = s.origin.x + s.w * (s.kind === 'desk' ? options.usableRatio : 1);
    if (b.x < s.origin.x - EPS || b.x + b.w > maxX + EPS ||
        b.z < s.origin.z - EPS || b.z + b.d > s.origin.z + s.d + EPS) {
      hard.push(v('bounds', [it.id], `${it.label} 超出「${s.label}」的面内范围`));
    }
    if (b.y < s.origin.y - EPS) {
      hard.push(v('bounds', [it.id], `${it.label} 低于「${s.label}」的台面`));
    }
  }

  for (const it of items) {
    for (const sol of space.solids) {
      if (overlap3D(it.box, sol.box)) {
        hard.push(v('penetration', [it.id], `${it.label} 穿透了${sol.label}`));
        break;
      }
    }
  }

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (overlap3D(items[i].box, items[j].box)) {
        hard.push(v('overlap', [items[i].id, items[j].id], `${items[i].label} 与 ${items[j].label} 立体占位重叠`));
      }
    }
  }

  for (const it of items) {
    const s = surfaceMap.get(it.surfaceId);
    const top = it.box.y + it.box.h;
    if (top > space.bedBottom - BED_HEADROOM + EPS) {
      hard.push(v('clearance', [it.id], `${it.label} 顶部顶到床板，需留 ${BED_HEADROOM}cm`));
    }
    if (s && top - s.origin.y > s.headroom + EPS) {
      hard.push(v('clearance', [it.id],
        `${it.label} 高 ${(top - s.origin.y).toFixed(0)}cm，超过「${s.label}」层高 ${s.headroom.toFixed(0)}cm`));
    }
    if (it.screen) {
      const bedGap = space.bedBottom - top;
      if (bedGap < options.screenHeadroom - EPS) {
        hard.push(v('clearance', [it.id],
          `${it.label} 到床板净空仅 ${bedGap.toFixed(0)}cm，需 ${options.screenHeadroom}cm`));
      }
    }
    if (it.screen) {
      const above = items
        .filter((b) => b !== it && b.box.y >= top - EPS && projectionOverlap(it.box, b.box))
        .sort((a, b) => a.box.y - b.box.y)[0];
      if (above) {
        const gap = above.box.y - top;
        if (gap < options.screenHeadroom - EPS) {
          hard.push(v('clearance', [it.id, above.id],
            `${it.label} 上方净空仅 ${gap.toFixed(0)}cm，需 ${options.screenHeadroom}cm（${above.label} 压得太低）`));
        }
      }
    }
  }

  for (const it of items.filter((i) => i.frequentlyUsed)) {
    const c = centerOf(it.box);
    const ok = space.reachVolumes.some((vol) => {
      const clipped: Box = { ...vol, d: Math.min(vol.d, options.reachDepth) };
      return containsPoint(clipped, c);
    });
    if (!ok) {
      const s = surfaceMap.get(it.surfaceId);
      hard.push(v('reach', [it.id], `${it.label} 在「${s?.label ?? it.surfaceId}」，超出坐姿伸手可达范围`));
    }
  }

  const blockers = [
    ...items.map((b) => ({ id: b.id, label: b.label, box: b.box })),
    ...space.solids.filter((x) => x.blocksSight).map((x) => ({ id: x.id, label: x.label, box: x.box })),
  ];
  for (const s of items.filter((i) => i.screen)) {
    const midY = s.box.y + s.box.h / 2;
    const blocker = blockers.find((b) => {
      if (b.id === s.id) return false;
      const xOverlap = Math.min(b.box.x + b.box.w, s.box.x + s.box.w) - Math.max(b.box.x, s.box.x);
      return b.box.h > 15 && b.box.y + b.box.h > midY &&
        b.box.z + b.box.d <= s.box.z + EPS && xOverlap >= 15;
    });
    if (blocker) {
      hard.push(v('occlusion', [blocker.id, s.id], `${blocker.label} 挡住了 ${s.label} 的视线`));
    }
  }

  if (options.liquidGap > 0) {
    for (const mug of items.filter((i) => i.kind === 'mug')) {
      const near = items.find((e) =>
        e !== mug && ELECTRONICS.has(e.kind) && gap3D(mug.box, e.box) < options.liquidGap - EPS);
      if (near) {
        const gap = gap3D(mug.box, near.box);
        hard.push(v('liquid', [mug.id, near.id],
          `${mug.label} 距 ${near.label} 仅 ${gap.toFixed(0)}cm，需 ≥ ${options.liquidGap}cm`));
      }
    }
  }

  const powered = items.filter((i) => i.needsPower);
  const strips = items.filter((i) => i.kind === 'powerstrip');
  if (powered.length) {
    if (!strips.length) {
      hard.push(v('cable', powered.map((i) => i.id), '有需要供电的物件，但场景里没有插座'));
    } else {
      for (const it of powered) {
        if (it.pluggedInto && ids.has(it.pluggedInto)) continue;
        const nearest = Math.min(...strips.map((s) => gap3D(it.box, s.box)));
        if (nearest > MAX_CABLE_GAP + EPS) {
          hard.push(v('cable', [it.id], `${it.label} 距最近插座 ${nearest.toFixed(0)}cm，走线超过 ${MAX_CABLE_GAP}cm`));
        }
      }
    }
  }

  for (const s of space.surfaces) {
    const on = items.filter((i) => i.surfaceId === s.id);
    if (!on.length) continue;
    const used = on.reduce((n, i) => n + i.box.w * i.box.d, 0);
    const area = Math.max(1, s.w * s.d);
    const ratio = used / area;
    if (ratio > options.slotFill + EPS) {
      hard.push(v('capacity', on.map((i) => i.id),
        `「${s.label}」已占 ${(ratio * 100).toFixed(0)}%，超过 ${(options.slotFill * 100).toFixed(0)}% 容量`));
    }
  }

  const deskItems = items.filter((i) => surfaceMap.get(i.surfaceId)?.kind === 'desk');
  const used = deskItems.reduce((sum, i) => sum + i.box.w * i.box.d, 0);
  const ratio = used / (space.width * space.depth);
  if (ratio > 0.5) {
    soft.push(v('density', [], `桌面投影占用率 ${(ratio * 100).toFixed(0)}%，偏拥挤`, 'soft'));
  }

  return {
    pass: hard.length === 0,
    score: hard.length === 0 ? Math.max(0, 1 - soft.length * 0.05) : 0,
    hard,
    soft,
  };
}

export interface Injection {
  code: ViolationCode;
  label: string;
  apply: (scene: Scene) => void;
}

/** 供判分自测与视口的"注入冲突"开关共用；调用方负责先 clone 场景。 */
export const INJECTIONS: Injection[] = [
  {
    code: 'overlap', label: '制造立体重叠',
    apply: (s) => {
      const desk = s.items.filter((i) => i.surfaceId === 'desk');
      if (desk.length >= 2) desk[1].box = { ...desk[0].box };
    },
  },
  {
    code: 'clearance', label: '把屏幕顶到床板',
    apply: (s) => {
      const target = s.items.find((i) => i.screen);
      if (!target) return;
      target.box.y = s.space.bedBottom - target.box.h - 2;
    },
  },
  {
    code: 'reach', label: '常用件塞进高层格位',
    apply: (s) => {
      const target = s.items.find((i) => i.frequentlyUsed);
      const slot = s.space.surfaces.find((x) => x.id === 'slot3');
      if (!target || !slot) return;
      target.surfaceId = slot.id;
      target.box = { ...target.box, x: slot.origin.x, y: slot.origin.y, z: slot.origin.z };
    },
  },
  {
    code: 'occlusion', label: '屏幕前放高物件',
    apply: (s) => {
      const target = s.items.find((i) => i.screen);
      if (!target) return;
      s.items.push(makeItem(s.space, 'inject-block', 'storage', 'desk', 10, 6));
      const block = s.items[s.items.length - 1];
      block.box = { ...block.box, x: target.box.x + 5, y: s.space.deskY, z: Math.max(0, target.box.z - 25), h: 30 };
    },
  },
  {
    code: 'liquid', label: '水杯贴着鼠标',
    apply: (s) => {
      const mug = s.items.find((i) => i.kind === 'mug');
      const mouse = s.items.find((i) => i.kind === 'mouse');
      if (mug && mouse) mug.box = { ...mouse.box, x: mouse.box.x + mouse.box.w + 4 };
    },
  },
  {
    code: 'cable', label: '移除插座',
    apply: (s) => { s.items = s.items.filter((i) => i.kind !== 'powerstrip'); },
  },
  {
    code: 'bounds', label: '把物件推出所属面',
    apply: (s) => {
      const target = s.items.find((i) => i.surfaceId === 'desk');
      if (target) target.box.x = s.space.width + 10;
    },
  },
  {
    code: 'dangling', label: '插到不存在的插座',
    apply: (s) => {
      const target = s.items.find((i) => i.needsPower);
      if (target) target.pluggedInto = 'ghost';
    },
  },
  {
    code: 'penetration', label: '把物件插进立柜侧板',
    apply: (s) => {
      const target = s.items.find((i) => i.surfaceId === 'desk' && i.kind === 'lamp');
      const cab = s.space.solids.find((x) => x.id === 'cab-left');
      if (!target || !cab) return;
      target.box = { ...target.box, x: cab.box.x + cab.box.w - 6, z: 10 };
    },
  },
  {
    code: 'capacity', label: '塞满一个格位',
    apply: (s) => {
      const slot = s.space.surfaces.find((x) => x.id === 'slot1');
      if (!slot) return;
      for (let i = 0; i < 3; i++) {
        const book = makeItem(s.space, `inject-book${i}`, 'book', 'slot1', 0, 2);
        book.box = { ...book.box, y: slot.origin.y + i * 10 };
        s.items.push(book);
      }
    },
  },
];
