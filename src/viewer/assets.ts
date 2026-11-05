import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PALETTE, TONE_BY_PREFIX, assetUrl } from '../assets/manifest.ts';
import type { ToneKey } from '../assets/manifest.ts';
import { ITEM_SIZE } from '../core/catalog.ts';
import type { ItemKind } from '../core/types.ts';

/**
 * 资产管线：glb 只负责外观，判分几何仍由 ITEM_SIZE 的 AABB 决定。
 * - 文件缺失 → 调用方回退盒体，不报错、不阻塞首帧；
 * - 模型自带材质一律丢弃，套同一套低模色板；
 * - 实例化时克隆材质，才能只把"这一件"标红而不染红同类。
 */

type AssetState = 'missing' | 'loading' | 'ready';

const templates = new Map<ItemKind, THREE.Object3D>();
const states = new Map<ItemKind, AssetState>();
const paletteMats = new Map<ToneKey, THREE.MeshStandardMaterial>();
const loader = new GLTFLoader();

/** 同色板但要分材质性格：屏幕低粗糙、金属高金属度，其余是哑光塑料。 */
const TONE_FINISH: Record<ToneKey, { roughness: number; metalness: number }> = {
  body: { roughness: 0.62, metalness: 0.06 },
  accent: { roughness: 0.5, metalness: 0.12 },
  screen: { roughness: 0.22, metalness: 0.1 },
  metal: { roughness: 0.32, metalness: 0.8 },
};

function paletteMaterial(tone: ToneKey): THREE.MeshStandardMaterial {
  let mat = paletteMats.get(tone);
  if (!mat) {
    const finish = TONE_FINISH[tone];
    mat = new THREE.MeshStandardMaterial({
      color: PALETTE[tone], roughness: finish.roughness, metalness: finish.metalness,
    });
    paletteMats.set(tone, mat);
  }
  return mat;
}

/** 网格名或父节点名以 screen/metal/accent 开头就套对应材质；glTF 的命名不一定落在同一层。 */
function toneOfMesh(object: THREE.Object3D): ToneKey {
  let node: THREE.Object3D | null = object;
  for (let depth = 0; node && depth < 4; depth++, node = node.parent) {
    const lower = node.name.toLowerCase();
    const hit = TONE_BY_PREFIX.find((t) => lower.startsWith(t.prefix));
    if (hit) return hit.tone;
  }
  return 'body';
}

/** 统一材质 + 用包围盒兜住"原点没放在底面中心"的模型，保证放上面不错位。 */
function normalize(kind: ItemKind, scene: THREE.Object3D): THREE.Object3D {
  scene.traverse((o) => {
    if (o instanceof THREE.Mesh) o.material = paletteMaterial(toneOfMesh(o));
  });

  const hull = ITEM_SIZE[kind];
  const box = new THREE.Box3().setFromObject(scene);
  const size = box.getSize(new THREE.Vector3());
  const over = [
    size.x > hull.w + 0.5 ? `x ${size.x.toFixed(1)} > ${hull.w}` : '',
    size.y > hull.h + 0.5 ? `y ${size.y.toFixed(1)} > ${hull.h}` : '',
    size.z > hull.d + 0.5 ? `z ${size.z.toFixed(1)} > ${hull.d}` : '',
  ].filter(Boolean);
  if (over.length) {
    console.warn(`[asset] ${kind} 超出判分盒体：${over.join('，')}。判分仍按盒体，观感会对不上。`);
  }

  const center = box.getCenter(new THREE.Vector3());
  scene.position.set(-center.x, -box.min.y, -center.z);
  const holder = new THREE.Group();
  holder.add(scene);
  return holder;
}

async function probeThenLoad(kind: ItemKind, onReady: () => void): Promise<void> {
  const url = assetUrl(kind);
  const head = await fetch(url, { method: 'HEAD' }).catch(() => null);
  if (!head || !head.ok) {
    states.set(kind, 'missing');
    return;
  }
  loader.load(url, (gltf) => {
    try {
      templates.set(kind, normalize(kind, gltf.scene));
      states.set(kind, 'ready');
    } catch (e) {
      console.warn(`[asset] ${kind} 处理失败：`, e);
      states.set(kind, 'missing');
    }
    onReady();
  }, undefined, () => {
    states.set(kind, 'missing');
    onReady();
  });
}

/** 逐个探测并加载；每落一个就回调一次，视口据此重绘。 */
export function preloadAssets(kinds: ItemKind[], onReady: () => void): void {
  for (const kind of kinds) {
    if (states.has(kind)) continue;
    states.set(kind, 'loading');
    void probeThenLoad(kind, onReady);
  }
}

export interface AssetInstance {
  object: THREE.Object3D;
  /** 本实例独占的材质，调用方负责在重绘时释放 */
  materials: THREE.MeshStandardMaterial[];
}

export function instantiateAsset(kind: ItemKind): AssetInstance | null {
  const template = templates.get(kind);
  if (!template) return null;
  const object = template.clone(true);
  const materials: THREE.MeshStandardMaterial[] = [];
  object.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      const mat = (o.material as THREE.MeshStandardMaterial).clone();
      o.material = mat;
      materials.push(mat);
    }
  });
  return { object, materials };
}

export function assetStats(): { ready: number; total: number; missing: number } {
  let ready = 0;
  let missing = 0;
  for (const s of states.values()) {
    if (s === 'ready') ready++;
    else if (s === 'missing') missing++;
  }
  return { ready, missing, total: states.size };
}

/** 供 HMR / 重置用；共享的色板材质也一并释放。 */
export function disposeAssets(): void {
  templates.clear();
  states.clear();
  for (const mat of paletteMats.values()) mat.dispose();
  paletteMats.clear();
}
