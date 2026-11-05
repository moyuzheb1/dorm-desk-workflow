import { PRESETS } from './presets.ts';
import type { BoxItem, SpaceSpec } from './types.ts';

export type FrameKind = 'produce' | 'verify' | 'repair';

export interface TraceNode {
  id: string;
  label: string;
  phase: number;
}

export interface TraceFrame {
  nodeId: string;
  label: string;
  phase: number;
  kind: FrameKind;
  note: string;
  /** 本帧新增或被重算的物件，视口里用亮边高亮 */
  changed: string[];
  items: BoxItem[];
}

export interface Trace {
  space: SpaceSpec;
  nodes: TraceNode[];
  frames: TraceFrame[];
}

/**
 * 阶段 2 的手工节点事件序列：不接 AI，帧数据是静态的，播放只是逐帧回放。
 * 序列刻意包含一次失败与一次局部重算，用来演示"只重算被归责的那一步"。
 */
export function buildTrace(): Trace {
  const base = PRESETS[0];
  const byId = new Map(base.items.map((i) => [i.id, structuredClone(i)]));
  const pick = (...ids: string[]): BoxItem[] => ids.map((id) => structuredClone(byId.get(id)!));

  const mistaken = pick('monitor', 'powerstrip', 'keyboard', 'mouse', 'lamp', 'mug');
  const badMug = mistaken.find((i) => i.id === 'mug')!;
  badMug.box = { ...badMug.box, x: 75, z: 10 };

  const final = pick('monitor', 'powerstrip', 'keyboard', 'mouse', 'lamp', 'mug');
  for (const it of final) if (it.needsPower) it.pluggedInto = 'powerstrip';

  return {
    space: base.space,
    nodes: [
      { id: 'anchor', label: '锚点', phase: 0 },
      { id: 'ergonomics', label: '人机区', phase: 1 },
      { id: 'periphery', label: '周边件', phase: 1 },
      { id: 'verify', label: '判分', phase: 2 },
      { id: 'repair', label: '局部重算', phase: 3 },
      { id: 'power', label: '走线收尾', phase: 4 },
    ],
    frames: [
      {
        nodeId: 'anchor', label: '固定锚点', phase: 0, kind: 'produce',
        note: '先固定空间锚点：主显示器与插座。',
        changed: ['monitor', 'powerstrip'],
        items: pick('monitor', 'powerstrip'),
      },
      {
        nodeId: 'ergonomics', label: '摆人机区', phase: 1, kind: 'produce',
        note: '按依赖摆人机区：键盘与鼠标必须落在伸手可达体积内。',
        changed: ['keyboard', 'mouse'],
        items: pick('monitor', 'powerstrip', 'keyboard', 'mouse'),
      },
      {
        nodeId: 'periphery', label: '摆周边件', phase: 1, kind: 'produce',
        note: '与上一节点并行：摆台灯和水杯（此处故意把水杯放错位置）。',
        changed: ['lamp', 'mug'],
        items: mistaken,
      },
      {
        nodeId: 'verify', label: '判分', phase: 2, kind: 'verify',
        note: '判分器发现水杯距鼠标仅 4cm，违反安全距离；归责到 periphery 节点。',
        changed: [],
        items: structuredClone(mistaken),
      },
      {
        nodeId: 'repair', label: '局部重算', phase: 3, kind: 'repair',
        note: '只重算 periphery 节点，把水杯挪回安全位置；上游 4 件完全不动。',
        changed: ['mug'],
        items: pick('monitor', 'powerstrip', 'keyboard', 'mouse', 'lamp', 'mug'),
      },
      {
        nodeId: 'power', label: '走线收尾', phase: 4, kind: 'verify',
        note: '补上走线关系并做整体校验，全部约束通过。',
        changed: [],
        items: final,
      },
    ],
  };
}
