export type ObjectKind =
  | 'monitor' | 'second_monitor' | 'laptop' | 'keyboard' | 'mouse'
  | 'lamp' | 'mug' | 'powerstrip' | 'shelf' | 'storage' | 'plant' | 'cable';

export const ELECTRONICS = new Set<ObjectKind>([
  'monitor', 'second_monitor', 'laptop', 'keyboard', 'mouse', 'powerstrip', 'lamp',
]);

export interface DeskSpec {
  width: number;
  depth: number;
  unit: 'cm';
}

export interface DeskObject {
  id: string;
  kind: ObjectKind;
  w: number;
  d: number;
  x: number;
  y: number;
  rotation: 0 | 90 | 180 | 270;
  layer: 'surface' | 'above';
  needsPower: boolean;
  pluggedInto?: string;
}

export interface SceneState {
  desk: DeskSpec;
  objects: DeskObject[];
}

export type TaskLevel = 'L1' | 'L2' | 'L3' | 'L4' | 'L5';

export interface TaskSpec {
  id: string;
  level: TaskLevel;
  prompt: string;
  desk: DeskSpec;
  required: Partial<Record<ObjectKind, number>>;
  expectInfeasible?: boolean;
  expectClarify?: boolean;
  edits?: string[];
}

export interface Violation {
  code: string;
  severity: 'hard' | 'soft';
  objectIds: string[];
  message: string;
}

export interface Score {
  pass: boolean;
  score: number;
  hard: Violation[];
  soft: Violation[];
}

export interface NodeContext {
  task: TaskSpec;
  scene: SceneState;
  nodeId: string;
  kinds: ObjectKind[];
  attempt: number;
  violations: Violation[];
}

export interface NodeOutput {
  objects: DeskObject[];
  infeasible?: boolean;
  needsClarify?: boolean;
  note?: string;
}

export type Operator = (ctx: NodeContext) => NodeOutput | Promise<NodeOutput>;

export interface WorkflowNode {
  id: string;
  phase: 'build';
  deps: string[];
  kinds: ObjectKind[];
}

export interface Plan {
  nodes: WorkflowNode[];
  groups: string[][];
}

export interface WorkflowEvent {
  seq: number;
  nodeId: string;
  status: 'interpret' | 'running' | 'done' | 'failed' | 'skipped' | 'checkpoint';
  attempt: number;
  detail?: string;
}

export interface Outcome {
  infeasible: boolean;
  needsClarify: boolean;
}
