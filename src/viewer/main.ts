import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { DEFAULT_OPTIONS, grade, INJECTIONS } from '../core/grade.ts';
import type { GradeOptions } from '../core/grade.ts';
import { PRESETS } from '../core/presets.ts';
import { buildTrace } from '../core/trace.ts';
import type { BoxItem, Grade, ItemKind, Layer, Scene, SpaceSpec, SurfaceKind } from '../core/types.ts';
import { makeItem } from '../core/catalog.ts';
import { EVAL_TASKS, runExperiment } from '../core/experiment.ts';
import type { ExperimentReport, RunResult } from '../core/experiment.ts';
import { DEFAULT_MODEL, createModelOperator, offlineOperator, proxyCaller, safeSurfaceId, toExisting } from '../core/operator.ts';
import type { Operator, PlacementRequest } from '../core/operator.ts';
import { assetStats, instantiateAsset, preloadAssets } from './assets.ts';
import {
  applyTurn, availableInstructions, currentSceneOf, localityReport,
  openSession, routeInstruction, structuredReader, validateScene,
} from '../core/incremental.ts';
import type { EditSession } from '../core/incremental.ts';

const TRACE = buildTrace();

const viewport = document.querySelector<HTMLDivElement>('#viewport')!;
const dagEl = document.querySelector<HTMLDivElement>('#dag')!;
const slidersEl = document.querySelector<HTMLDivElement>('#sliders')!;
const verdictEl = document.querySelector<HTMLDivElement>('#verdict')!;
const violationsEl = document.querySelector<HTMLUListElement>('#violations')!;
const branchesEl = document.querySelector<HTMLDivElement>('#branches')!;
const presetsEl = document.querySelector<HTMLDivElement>('#presets')!;
const injectEl = document.querySelector<HTMLDivElement>('#inject')!;
const spaceInfoEl = document.querySelector<HTMLDivElement>('#spaceInfo')!;
const modeTag = document.querySelector<HTMLSpanElement>('#modeTag')!;
const btnPlay = document.querySelector<HTMLButtonElement>('#btnPlay')!;
const btnPrev = document.querySelector<HTMLButtonElement>('#btnPrev')!;
const btnNext = document.querySelector<HTMLButtonElement>('#btnNext')!;
const btnFork = document.querySelector<HTMLButtonElement>('#btnFork')!;
const btnRepair = document.querySelector<HTMLButtonElement>('#btnRepair')!;
const frameRange = document.querySelector<HTMLInputElement>('#frameRange')!;
const frameLabel = document.querySelector<HTMLSpanElement>('#frameLabel')!;
const frameNote = document.querySelector<HTMLSpanElement>('#frameNote')!;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
/** 真实感有一半来自色调映射：高光滚到白而不是硬切，暗部也还留得住层次。 */
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.04;
viewport.appendChild(renderer.domElement);

const scene3d = new THREE.Scene();
scene3d.background = new THREE.Color(0x0b0e12);
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 3000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

/**
 * 环境贴图当"房间里被弹回来的光"用，替代拍脑袋的环境光数字：
 * 有方向、有色温，PBR 材质的低角度反光也就有了来处。
 */
const pmrem = new THREE.PMREMGenerator(renderer);
const roomEnv = pmrem.fromScene(new RoomEnvironment(), 0.04);
scene3d.environment = roomEnv.texture;
scene3d.environmentIntensity = 0.62;
pmrem.dispose();

/** 环境光只留一点点托底，避免背光面纯黑；主体亮度交给环境贴图 + 主光。 */
scene3d.add(new THREE.AmbientLight(0xdde6ff, 0.12));
scene3d.add(new THREE.HemisphereLight(0xd6e4ff, 0x2a231a, 0.28));

/** 主光：从桌前（−Z）低角度打进床下工位的"窗外光"，暖白、投影、决定体积。 */
const keyLight = new THREE.DirectionalLight(0xfff0dc, 2.6);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
keyLight.shadow.bias = -0.0006;
keyLight.shadow.normalBias = 0.45;
scene3d.add(keyLight, keyLight.target);

/** 冷色补光：从左上来的天光，只提亮暗部，不投影，避免整片死黑。 */
const fillLight = new THREE.DirectionalLight(0xc3d7ff, 0.55);
scene3d.add(fillLight, fillLight.target);

/** 台灯感：桌左前侧一盏暖光，单位是 cm，所以强度是坎德拉量级。 */
const practicalLight = new THREE.PointLight(0xffd2a1, 3200, 360, 2);
scene3d.add(practicalLight);

/** 平行光的阴影相机是正交的，换预设（空间尺寸变了）必须跟着改视锥。 */
function syncLightToSpace(space: SpaceSpec): void {
  /** 主光落在床板底以下：光从床下钻进桌洞，桌面亮、床上层压暗，关系才对。 */
  keyLight.position.set(space.width * 0.15, space.bedBottom * 0.86, -space.depth * 2.6);
  keyLight.target.position.set(space.width / 2, space.deskY, space.depth / 2);
  keyLight.target.updateMatrixWorld();

  fillLight.position.set(-space.width * 0.5, space.bedBottom * 1.3, -space.depth * 1.1);
  fillLight.target.position.copy(keyLight.target.position);
  fillLight.target.updateMatrixWorld();
  practicalLight.position.set(
    space.width * 0.07, space.deskY + 36, space.depth * 0.45,
  );

  const span = Math.max(space.width, space.depth, space.bedBottom) * 1.15 + 60;
  const cam = keyLight.shadow.camera;
  cam.left = -span;
  cam.right = span;
  cam.top = span;
  cam.bottom = -span;
  cam.near = 1;
  cam.far = span * 4;
  cam.updateProjectionMatrix();
}

const staticGroup = new THREE.Group();
const itemGroup = new THREE.Group();
scene3d.add(staticGroup, itemGroup);

const LAYER_COLOR: Record<Layer, number> = {
  desk: 0x4f9dff, shelf: 0xffb84d, wall: 0xa78bfa,
  floor: 0x6b7280, bed: 0x3a4250, post: 0x4a5260,
};

/** 放置面用不同颜色标出：桌面蓝、格位橙、墙面紫。 */
const SURFACE_COLOR: Record<SurfaceKind, number> = {
  desk: 0x4f9dff, slot: 0xffb84d, niche: 0x3ddc97, wall: 0xa78bfa, drawer: 0x8899aa,
};

/** 每个容器自己记一份"我造的几何/材质"；资产缓存里的共享几何不能在这里释放。 */
interface Owned { geo: THREE.BufferGeometry[]; mat: THREE.Material[] }
const ownedByGroup = new Map<THREE.Group, Owned>();

function ownedFor(group: THREE.Group): Owned {
  let owned = ownedByGroup.get(group);
  if (!owned) {
    owned = { geo: [], mat: [] };
    ownedByGroup.set(group, owned);
  }
  return owned;
}

function clearGroup(group: THREE.Group): void {
  for (const child of [...group.children]) group.remove(child);
  const owned = ownedByGroup.get(group);
  if (owned) {
    owned.geo.forEach((g) => g.dispose());
    owned.mat.forEach((m) => m.dispose());
  }
  ownedByGroup.set(group, { geo: [], mat: [] });
}

function addBox(
  group: THREE.Group, w: number, h: number, d: number,
  x: number, y: number, z: number, color: number,
  opacity = 1, edgeColor = 0x9aa4b2, roughness = 0.82, metalness = 0.04,
): THREE.Mesh {
  const geometry = new THREE.BoxGeometry(w, h, d);
  /** 实体用 PBR 吃光；半透明体是"标注层"，不该跟着灯一起变亮变暗。 */
  const material = opacity < 1
    ? new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false })
    : new THREE.MeshStandardMaterial({ color, roughness, metalness });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.receiveShadow = opacity >= 1;
  group.add(mesh);
  const owned = ownedFor(group);
  owned.geo.push(geometry);
  owned.mat.push(material);
  /** 实体家具靠材质和光影出轮廓；只有半透明的标注体才需要描边。 */
  if (opacity < 1) {
    const edgeGeometry = new THREE.EdgesGeometry(geometry);
    const edgeMaterial = new THREE.LineBasicMaterial({
      color: edgeColor, transparent: true, opacity: 0.42,
    });
    const edges = new THREE.LineSegments(edgeGeometry, edgeMaterial);
    edges.position.copy(mesh.position);
    group.add(edges);
    owned.geo.push(edgeGeometry);
    owned.mat.push(edgeMaterial);
  }
  return mesh;
}

/* ---------- 程序化贴图：地面木纹、墙面涂料、挂画，不拉外部资源 ---------- */

function canvasOf(w: number, h: number): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas.getContext('2d')!;
}

function hsl(h: number, s: number, l: number, a = 1): string {
  return `hsla(${h}, ${s}%, ${l}%, ${a})`;
}

/** 贴图只建一次：换预设换的是 repeat，不是重新画 canvas。 */
let floorMap: THREE.Texture | null = null;
let wallMapBack: THREE.Texture | null = null;
let wallMapSide: THREE.Texture | null = null;
let artMap: THREE.Texture | null = null;

function finishTexture(texture: THREE.Texture): THREE.Texture {
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return texture;
}

/** 木地板：错缝拼板 + 板缝 + 木纹，让地面有尺度感，不再是一片纯色。 */
function floorTexture(): THREE.Texture {
  if (floorMap) return floorMap;
  const size = 512;
  const ctx = canvasOf(size, size);
  ctx.fillStyle = hsl(26, 28, 24);
  ctx.fillRect(0, 0, size, size);

  let seed = 20261105;
  const rnd = (): number => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };

  const rows = 8;
  const rowH = size / rows;
  for (let r = 0; r < rows; r++) {
    const y = r * rowH;
    const shift = r % 2 === 0 ? 0 : size / 2;
    for (let c = -1; c <= 1; c++) {
      const x = c * size + shift;
      ctx.fillStyle = hsl(30, 24 + rnd() * 8, 27 + rnd() * 9);
      ctx.fillRect(x + 2, y + 2, size - 4, rowH - 4);
      /** 木纹：几条近乎水平的暗线，间距随机，太整齐就像瓷砖。 */
      for (let i = 0; i < 10; i++) {
        const gy = y + 6 + rnd() * (rowH - 12);
        ctx.strokeStyle = hsl(26, 30, 18, 0.14 + rnd() * 0.12);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + 3, gy);
        ctx.bezierCurveTo(
          x + size * 0.3, gy + (rnd() - 0.5) * 6,
          x + size * 0.7, gy + (rnd() - 0.5) * 6,
          x + size - 3, gy,
        );
        ctx.stroke();
      }
    }
  }
  floorMap = finishTexture(new THREE.CanvasTexture(ctx.canvas));
  return floorMap;
}

/** 墙面：暖灰乳胶漆，细噪点 + 顶亮底暗，远看是一整面墙，近看不是塑料板。 */
function makeWallTexture(): THREE.Texture {
  const size = 256;
  const ctx = canvasOf(size, size);
  ctx.fillStyle = hsl(38, 8, 68);
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 2600; i++) {
    ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.045)';
    ctx.fillRect(Math.random() * size, Math.random() * size, 2, 2);
  }
  const grad = ctx.createLinearGradient(0, 0, 0, size);
  grad.addColorStop(0, 'rgba(255,250,240,0.10)');
  grad.addColorStop(1, 'rgba(0,0,0,0.06)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return finishTexture(new THREE.CanvasTexture(ctx.canvas));
}

function wallTexture(slot: 'back' | 'side'): THREE.Texture {
  if (slot === 'back') {
    wallMapBack ??= makeWallTexture();
    return wallMapBack;
  }
  wallMapSide ??= makeWallTexture();
  return wallMapSide;
}

/** 挂画：米底 + 几块抽象色，用来打破整面墙的空白。 */
function artTexture(): THREE.Texture {
  if (artMap) return artMap;
  const w = 256;
  const h = 320;
  const ctx = canvasOf(w, h);
  ctx.fillStyle = '#e9dfcd';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#c06a4e';
  ctx.beginPath();
  ctx.arc(w * 0.62, h * 0.34, w * 0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#3f5061';
  ctx.fillRect(w * 0.14, h * 0.58, w * 0.42, h * 0.3);
  ctx.fillStyle = '#c9a15c';
  ctx.beginPath();
  ctx.moveTo(0, h);
  ctx.lineTo(w * 0.55, h * 0.42);
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(30,30,30,0.25)';
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, w - 6, h - 6);
  artMap = finishTexture(new THREE.CanvasTexture(ctx.canvas));
  return artMap;
}

/** 带贴图的实体块：地板、墙、挂画共用同一条释放链路。 */
function addTexturedBox(
  group: THREE.Group, w: number, h: number, d: number,
  x: number, y: number, z: number, map: THREE.Texture,
  roughness = 0.85, metalness = 0.02, tint = 0xffffff,
): THREE.Mesh {
  const geometry = new THREE.BoxGeometry(w, h, d);
  const material = new THREE.MeshStandardMaterial({
    map, color: tint, roughness, metalness,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.receiveShadow = true;
  group.add(mesh);
  const owned = ownedFor(group);
  owned.geo.push(geometry);
  owned.mat.push(material);
  return mesh;
}

function drawStructure(space: SpaceSpec, opt: GradeOptions): void {
  clearGroup(staticGroup);
  syncLightToSpace(space);
  const { width: W, depth: D, deskY: Y, bedBottom: B } = space;

  const wood = 0x8a6a4a;
  const woodDark = 0x6b5138;

  /** 地板：有厚度的木地板楼板，墙、柜、床都坐在上面，空间不再浮在网格线里。 */
  const floor = floorTexture();
  floor.repeat.set((W + 200) / 160, (D + 200) / 160);
  addTexturedBox(staticGroup, W + 200, 8, D + 200, W / 2, -4, D / 2, floor, 0.42, 0.02);

  /** 后墙 + 左墙：暖灰乳胶漆，围出"床下工位"的房间感，也接住主光。 */
  const wallH = B + 90;
  const backMap = wallTexture('back');
  backMap.repeat.set((W + 200) / 160, wallH / 160);
  addTexturedBox(staticGroup, W + 200, wallH, 8, W / 2, wallH / 2, D + 4, backMap, 0.94, 0.01);

  const sideMap = wallTexture('side');
  sideMap.repeat.set((D + 44) / 160, wallH / 160);
  addTexturedBox(staticGroup, 8, wallH, D + 44, -8, wallH / 2, D / 2, sideMap, 0.94, 0.01, 0xcfcac2);

  /** 踢脚线：深木色收边把墙和地接起来，墙脚才不会是一条悬空的分界线。 */
  addBox(staticGroup, W + 200, 10, 3, W / 2, 5, D - 1.5, 0x4a4036, 1, 0x9aa4b2, 0.5, 0.04);

  /** 桌面：实木台面 + 前挡板 + 两侧支撑，从"一块板"变成一件家具。 */
  addBox(staticGroup, W, 4, D, W / 2, Y - 2, D / 2, wood, 1, 0x9aa4b2, 0.55, 0.02).castShadow = true;
  addBox(staticGroup, W, 9, 3, W / 2, Y - 8.5, 1.5, woodDark, 1, 0x9aa4b2, 0.62, 0.02);
  for (const x of [2, W - 2]) {
    addBox(staticGroup, 3.5, Y - 4, D - 6, x, (Y - 4) / 2, D / 2, woodDark, 1, 0x9aa4b2, 0.68, 0.02)
      .castShadow = true;
  }

  /**
   * 上床：实木床架 + 床垫 + 前侧护栏。
   * 主光压到床板底以下，光从床下打进桌洞，所以床架投影不会把桌面压黑；
   * 上层的暗与桌洞的亮形成对比，正是"上床下桌"该有的明暗关系。
   */
  addBox(staticGroup, W + 16, 6, D + 16, W / 2, B + 3, D / 2, woodDark, 1, 0x9aa4b2, 0.72, 0.02)
    .castShadow = true;
  addBox(staticGroup, W + 4, 14, D + 4, W / 2, B + 13, D / 2, 0x9aa3b0, 1, 0x9aa4b2, 0.95, 0)
    .castShadow = true;
  addBox(staticGroup, W + 16, 4, 3, W / 2, B + 44, -3, woodDark, 1, 0x9aa4b2, 0.66, 0.04)
    .castShadow = true;

  const p = space.postSize;
  const postH = B + 48;
  const corners: [number, number][] = [[-3, -3], [W + 3, -3], [-3, D + 3], [W + 3, D + 3]];
  for (const [x, z] of corners) {
    addBox(staticGroup, p, postH, p, x, postH / 2, z, 0x424b58, 1, 0x9aa4b2, 0.45, 0.35)
      .castShadow = true;
  }

  /** 柜体侧板 / 层板 / 背板：实木实体，占体积、不可穿透，格位从正面看得进去。 */
  for (const sol of space.solids) {
    addBox(staticGroup, sol.box.w, sol.box.h, sol.box.d,
      sol.box.x + sol.box.w / 2, sol.box.y + sol.box.h / 2, sol.box.z + sol.box.d / 2,
      sol.blocksSight ? wood : 0x7d5f42, 1, 0x9aa4b2, 0.62, 0.02).castShadow = true;
  }

  /** 墙上再加一层置物板 + 托架：架子的"层"不只长在立柜里。 */
  const shelfW = Math.min(64, W * 0.45);
  const shelfY = B - 34;
  addBox(staticGroup, shelfW, 3, 17, 8 + shelfW / 2, shelfY, D - 8.5, wood, 1, 0x9aa4b2, 0.55, 0.02)
    .castShadow = true;
  for (const x of [10.5, 8 + shelfW - 2.5]) {
    addBox(staticGroup, 3, 12, 14, x, shelfY - 7.5, D - 10, woodDark, 1, 0x9aa4b2, 0.68, 0.02);
  }

  /** 置物板上摆几本书：层板空着会显得整个房间没人住。 */
  const books: [number, number, number][] = [[0xb4574a, 5, 20], [0x4a6b8a, 4, 17], [0x8a7a4a, 3.4, 14]];
  let bookX = 12;
  for (const [color, bw, bh] of books) {
    addBox(staticGroup, bw, bh, 14, bookX + bw / 2, shelfY + 1.5 + bh / 2, D - 8.5, color, 1, 0x9aa4b2, 0.72, 0.02)
      .castShadow = true;
    bookX += bw + 0.9;
  }

  /** 挂画：画框 + 画芯，放在置物板右侧的墙面上，压住大片空白。 */
  const artX0 = 8 + shelfW + 7;
  const artW = Math.min(26, W - 12 - artX0);
  if (artW >= 14) {
    const artH = Math.min(36, artW * 1.35);
    const artCX = artX0 + artW / 2;
    /** 上不碰床板、下不压置物板。 */
    const artCY = Math.min(B - 14 - artH / 2, shelfY + 10 + artH / 2);
    addBox(staticGroup, artW, artH, 2.4, artCX, artCY, D - 1.2, 0x2b2a28, 1, 0x9aa4b2, 0.5, 0.15)
      .castShadow = true;
    addTexturedBox(staticGroup, artW - 3.4, artH - 3.4, 0.3, artCX, artCY, D - 2.62, artTexture(), 0.88, 0)
      .castShadow = true;
  }

  /** 桌前地毯：给地面一块颜色，也把镜头下方的前景压住。 */
  const rugW = Math.max(52, W - 24);
  const rugD = Math.min(130, D * 1.6);
  const rugZ = 6 - rugD / 2;
  addBox(staticGroup, rugW, 0.6, rugD, W / 2, 0.3, rugZ, 0x3c4350, 1, 0x9aa4b2, 0.98, 0);
  addBox(staticGroup, rugW - 9, 0.5, rugD - 9, W / 2, 0.42, rugZ, 0x4c5464, 1, 0x9aa4b2, 0.98, 0);

  /** 每个放置面独立标出：格位有自己的宽、深与层高，不是同一块平面换坐标。 */
  for (const s of space.surfaces) {
    const c = SURFACE_COLOR[s.kind];
    if (s.plane === 'vertical') {
      const h = Math.min(s.headroom, 60);
      addBox(staticGroup, s.w, h, 0.8, s.origin.x + s.w / 2, s.origin.y + h / 2, s.origin.z, c, 0.07, c);
    } else {
      addBox(staticGroup, s.w, 0.2, s.d,
        s.origin.x + s.w / 2, s.origin.y + 0.1, s.origin.z + s.d / 2, c, 0.12, c);
    }
  }

  /** 坐姿可达体积可以有多个：桌面近侧 + 最下层格位。 */
  for (const vol of space.reachVolumes) {
    const r = { ...vol, d: Math.min(vol.d, opt.reachDepth) };
    addBox(staticGroup, r.w, r.h, r.d, r.x + r.w / 2, r.y + r.h / 2, r.z + r.d / 2, 0x3ddc97, 0.045, 0x3ddc97);
  }

  const deskSurface = space.surfaces.find((s) => s.kind === 'desk');
  if (deskSurface && opt.usableRatio < 1 - 1e-6) {
    const cut = deskSurface.origin.x + deskSurface.w * opt.usableRatio;
    addBox(staticGroup, 0.6, B - Y, D, cut, (Y + B) / 2, D / 2, 0xf05a5a, 0.22, 0xf05a5a);
  }
}

interface ItemView {
  id: string;
  layer: Layer;
  group: THREE.Group;
  /** 拾取代理：永远是一个 AABB，和判分用的盒体同尺寸，raycast 又便宜又稳 */
  proxy: THREE.Mesh;
  /** 本实例独占的材质，违规/选中时改 emissive，不影响同类物件 */
  lit: THREE.MeshStandardMaterial[];
  /** 没有模型时的盒体回退：整块换色 */
  fallback: THREE.Mesh | null;
}

let itemViews: ItemView[] = [];
let pickProxies: THREE.Mesh[] = [];
let changedSet = new Set<string>();
const PROXY_MATERIAL = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });

/** 接触阴影：一张径向渐变的黑片，压住"物件浮在桌面上"的感觉。 */
function contactTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(0,0,0,0.5)');
  gradient.addColorStop(0.55, 'rgba(0,0,0,0.2)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

const CONTACT_MATERIAL = new THREE.MeshBasicMaterial({
  map: contactTexture(), transparent: true, depthWrite: false,
});

/** 回退盒体带一点倒角：还是同一个方块，但轮廓和受光都不一样。 */
function addRoundedBox(group: THREE.Group, w: number, h: number, d: number, color: number): THREE.Mesh {
  const radius = Math.max(0.25, Math.min(1.1, Math.min(w, h, d) * 0.14));
  const geometry = new RoundedBoxGeometry(w, h, d, 2, radius);
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.42, metalness: 0.08 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.position.y = h / 2;
  group.add(mesh);
  ownedFor(group).geo.push(geometry);
  ownedFor(group).mat.push(material);
  return mesh;
}

function drawItems(scene: Scene, g: Grade, focus: Set<string>, changed: Set<string>): void {
  clearGroup(itemGroup);
  itemViews = [];
  pickProxies = [];
  changedSet = changed;
  const broken = new Set(g.hard.flatMap((v) => v.objectIds));
  const surfaceMap = new Map(scene.space.surfaces.map((s) => [s.id, s]));

  for (const it of scene.items) {
    const b = it.box;
    const group = new THREE.Group();
    /** 组放在"底面中心"，和资产契约一致：模型原点既不用改，盒体回退也对得上。 */
    group.position.set(b.x + b.w / 2, b.y, b.z + b.d / 2);
    group.userData.id = it.id;

    const asset = instantiateAsset(it.kind);
    let fallback: THREE.Mesh | null = null;
    if (asset) {
      asset.object.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      group.add(asset.object);
      ownedFor(itemGroup).mat.push(...asset.materials);
    } else {
      fallback = addRoundedBox(group, b.w, b.h, b.d,
        broken.has(it.id) ? 0xf05a5a : focus.has(it.id) ? 0xffe58a : LAYER_COLOR[it.layer]);
    }

    /** 立在水平面上的物件才加接触阴影；墙面挂件底下没有面。 */
    if (surfaceMap.get(it.surfaceId)?.plane !== 'vertical') {
      const geometry = new THREE.PlaneGeometry(b.w + 10, b.d + 10);
      const shadow = new THREE.Mesh(geometry, CONTACT_MATERIAL);
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.y = 0.3;
      shadow.renderOrder = 1;
      group.add(shadow);
      ownedFor(itemGroup).geo.push(geometry);
    }

    const proxy = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, b.d), PROXY_MATERIAL);
    proxy.position.y = b.h / 2;
    proxy.userData.id = it.id;
    group.add(proxy);
    ownedFor(itemGroup).geo.push(proxy.geometry);
    pickProxies.push(proxy);

    itemGroup.add(group);
    itemViews.push({ id: it.id, layer: it.layer, group, proxy, fallback, lit: asset?.materials ?? [] });
  }
  paintColors();
}

function paintColors(): void {
  const broken = new Set(currentGrade.hard.flatMap((v) => v.objectIds));
  for (const view of itemViews) {
    const bad = broken.has(view.id);
    const selected = focusIds.has(view.id);
    const focus = selected || changedSet.has(view.id);
    const emissive = bad ? 0x5a1010 : focus ? 0x4a3a08 : 0x000000;
    for (const mat of view.lit) mat.emissive.setHex(emissive);
    if (view.fallback) {
      const mat = view.fallback.material as THREE.MeshStandardMaterial;
      mat.color.setHex(bad ? 0xf05a5a : selected ? 0xffe58a : LAYER_COLOR[view.layer]);
      mat.emissive.setHex(emissive);
    }
  }
}

function frameCamera(space: SpaceSpec): void {
  /** 站在桌前（−Z）略偏右看：键鼠近、屏幕远，屏幕正面朝观众，立柜落在右手边。 */
  camera.position.set(space.width * 0.92, space.bedBottom * 0.95, -space.depth * 3.0);
  controls.target.set(space.width / 2, space.deskY + 35, space.depth / 2);
  controls.update();
}

type Mode = 'play' | 'inspect';
interface Branch { label: string; items: BoxItem[]; fromFrame: number; checkpoint?: boolean }

let mode: Mode = 'play';
let presetIndex = 0;
let injectionIndex: number | null = null;
let frameIndex = 0;
let playing = false;
let playTimer: number | null = null;
let options: GradeOptions = { ...DEFAULT_OPTIONS };
let focusIds = new Set<string>();
let activeTarget: number | null = null;
let branches: Branch[] = [];
let currentScene: Scene = { space: TRACE.space, items: structuredClone(TRACE.frames[0].items) };
let currentGrade: Grade = grade(currentScene, options);
/** 阶段 4a 的展示轨会话；播放时间轴不销毁数据，切换起点现状才重置。 */
let editSession: EditSession | null = null;

function currentSpace(): SpaceSpec {
  return mode === 'play' ? TRACE.space : PRESETS[presetIndex].space;
}

function baseItems(): BoxItem[] {
  if (mode === 'play') return structuredClone(TRACE.frames[frameIndex].items);
  const scene = structuredClone(PRESETS[presetIndex]);
  if (injectionIndex !== null) INJECTIONS[injectionIndex].apply(scene);
  return scene.items;
}

function displayedItems(): BoxItem[] {
  return activeTarget === null ? baseItems() : branches[activeTarget].items;
}

function changedIds(): Set<string> {
  return mode === 'play' ? new Set(TRACE.frames[frameIndex].changed) : new Set<string>();
}

function refresh(structure = false): void {
  currentScene = { space: currentSpace(), items: displayedItems() };
  currentGrade = grade(currentScene, options);
  if (structure) drawStructure(currentScene.space, options);
  drawItems(currentScene, currentGrade, focusIds, changedIds());
  renderPanel();
  renderDag();
  renderBranches();
  renderTimeline();
  syncButtons();
}

function lightRefresh(): void {
  currentScene = { space: currentSpace(), items: displayedItems() };
  currentGrade = grade(currentScene, options);
  paintColors();
  renderPanel();
  renderBranches();
}

function renderPanel(): void {
  const g = currentGrade;
  verdictEl.className = g.pass ? 'pass' : 'fail';
  verdictEl.textContent = `${g.pass ? 'PASS' : 'FAIL'} · ${g.score.toFixed(2)} · 硬约束 ${g.hard.length} 条 / 软约束 ${g.soft.length} 条`;
  const assets = assetStats();
  spaceInfoEl.textContent = `${currentScene.space.label} · 桌面 ${currentScene.space.width}×${currentScene.space.depth}cm · ` +
    `放置面 ${currentScene.space.surfaces.length} 个 · 桌面高 ${currentScene.space.deskY}cm · ` +
    `床板底 ${currentScene.space.bedBottom}cm · ${currentScene.items.length} 件` +
    (assets.total ? ` · 模型 ${assets.ready}/${assets.total}` : '');
  modeTag.textContent = mode === 'play'
    ? `工作流播放 · 帧 ${frameIndex + 1}/${TRACE.frames.length}`
    : `现状检查 · ${PRESETS[presetIndex].space.label}`;

  violationsEl.replaceChildren();
  const all = [...g.hard, ...g.soft];
  if (!all.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = '所有立体约束均满足';
    violationsEl.appendChild(li);
    return;
  }
  for (const violation of all) {
    const li = document.createElement('li');
    if (violation.severity === 'soft') li.className = 'muted';
    const tag = document.createElement('b');
    tag.textContent = `[${violation.code}] `;
    li.appendChild(tag);
    li.appendChild(document.createTextNode(violation.message));
    if (violation.objectIds.length) {
      li.addEventListener('click', () => {
        focusIds = new Set(violation.objectIds);
        drawItems(currentScene, currentGrade, focusIds, changedIds());
      });
    }
    violationsEl.appendChild(li);
  }
}

function renderDag(): void {
  dagEl.replaceChildren();
  const phases = [...new Set(TRACE.nodes.map((n) => n.phase))].sort((a, b) => a - b);
  const cur = mode === 'play' ? TRACE.frames[frameIndex] : null;
  const frameGrade = cur ? grade({ space: TRACE.space, items: cur.items }, options) : null;
  for (const phase of phases) {
    const row = document.createElement('div');
    row.className = 'dag-phase';
    for (const node of TRACE.nodes.filter((n) => n.phase === phase)) {
      const el = document.createElement('div');
      el.className = 'dag-node';
      el.textContent = node.label;
      if (cur && frameGrade) {
        if (node.id === cur.nodeId) el.classList.add(frameGrade.hard.length ? 'failed' : 'active');
        else if (node.phase < cur.phase) el.classList.add('done');
      }
      row.appendChild(el);
    }
    dagEl.appendChild(row);
  }
}

function renderBranches(): void {
  branchesEl.replaceChildren();
  const addRow = (label: string, items: BoxItem[], target: number | null): void => {
    const g = grade({ space: currentSpace(), items }, options);
    const row = document.createElement('div');
    row.className = 'branch' + (activeTarget === target ? ' active' : '');
    const name = document.createElement('span');
    name.textContent = label;
    const badge = document.createElement('span');
    badge.className = 'badge ' + (g.pass ? 'pass' : 'fail');
    badge.textContent = `${g.pass ? 'PASS' : 'FAIL'} · ${g.hard.length} 条`;
    row.append(name, badge);
    row.addEventListener('click', () => {
      pause();
      activeTarget = target;
      focusIds = new Set();
      refresh();
    });
    branchesEl.appendChild(row);
  };
  addRow('主干（节点规划状态）', baseItems(), null);
  branches.forEach((b, i) => addRow(
    b.checkpoint ? b.label : `${b.label} · 从帧 ${b.fromFrame + 1} 分叉`, b.items, i,
  ));
}

function renderTimeline(): void {
  frameRange.max = String(TRACE.frames.length - 1);
  frameRange.value = String(frameIndex);
  frameLabel.textContent = `帧 ${frameIndex + 1}/${TRACE.frames.length}`;
  frameNote.textContent = mode === 'play'
    ? TRACE.frames[frameIndex].note
    : '现状检查模式：点「播放」或「下一步」回到工作流演示。';
}

const presetButtons: HTMLButtonElement[] = [];
const injectButtons: HTMLButtonElement[] = [];
const restoreButton = document.createElement('button');

function syncButtons(): void {
  presetButtons.forEach((b, i) => b.classList.toggle('active', mode === 'inspect' && i === presetIndex));
  injectButtons.forEach((b, i) => b.classList.toggle('active', mode === 'inspect' && i === injectionIndex));
  restoreButton.classList.toggle('active', mode === 'inspect' && injectionIndex === null);
  btnPlay.textContent = playing ? '暂停' : '播放';
}

function pause(): void {
  playing = false;
  if (playTimer !== null) {
    window.clearInterval(playTimer);
    playTimer = null;
  }
  syncButtons();
}

function setFrame(i: number): void {
  mode = 'play';
  frameIndex = Math.max(0, Math.min(TRACE.frames.length - 1, i));
  injectionIndex = null;
  focusIds = new Set();
  activeTarget = null;
  refresh(true);
}

function play(): void {
  if (playing) { pause(); return; }
  if (mode !== 'play' || frameIndex >= TRACE.frames.length - 1) setFrame(0);
  playing = true;
  syncButtons();
  playTimer = window.setInterval(() => {
    if (frameIndex >= TRACE.frames.length - 1) { pause(); return; }
    setFrame(frameIndex + 1);
  }, 1200);
}

function showInspect(index: number, injection: number | null): void {
  pause();
  mode = 'inspect';
  presetIndex = index;
  injectionIndex = injection;
  focusIds = new Set();
  branches = [];
  activeTarget = null;
  editSession = null;
  frameCamera(PRESETS[index].space);
  refresh(true);
}

function ensureBranch(): void {
  if (activeTarget !== null) return;
  branches.push({
    label: `分支 ${branches.length + 1}`,
    items: structuredClone(displayedItems()),
    fromFrame: frameIndex,
  });
  activeTarget = branches.length - 1;
}

/* ---------- 阶段 3：算子状态、评测轨对照实验、展示轨节点级改输入 ---------- */

const statusEl = document.querySelector<HTMLDivElement>('#operatorStatus')!;
const sourceSelect = document.querySelector<HTMLSelectElement>('#operatorSource')!;
const btnRunEval = document.querySelector<HTMLButtonElement>('#btnRunEval')!;
const evalResult = document.querySelector<HTMLDivElement>('#evalResult')!;
const nodeSelect = document.querySelector<HTMLSelectElement>('#nodeSelect')!;
const instructionInput = document.querySelector<HTMLInputElement>('#instruction')!;
const strategySelect = document.querySelector<HTMLSelectElement>('#strategySelect')!;
const btnRerunNode = document.querySelector<HTMLButtonElement>('#btnRerunNode')!;
const btnClearIntent = document.querySelector<HTMLButtonElement>('#btnClearIntent')!;
const nodeResult = document.querySelector<HTMLDivElement>('#nodeResult')!;

const NODE_LABEL: Record<string, string> = {
  anchor: '锚点 · 屏幕 / 供电 / 层架',
  ergonomics: '人机区 · 键盘 / 鼠标',
  periphery: '周边件 · 台灯 / 水杯 / 收纳',
  verify: '节点级判分', repair: '局部重算', power: '走线收尾',
};
const STRATEGIES: { value: string; label: string }[] = [
  { value: '', label: '不干预 · 按判分反馈自动重算' },
  { value: '优先显示器净空', label: '优先显示器净空（屏幕上移）' },
  { value: '优先伸手范围', label: '优先伸手范围（常用件靠前）' },
  { value: '把书本抬到上层格位', label: '把书 / 收纳挪到上层格位' },
  { value: '优先水杯安全', label: '优先水杯安全' },
];
const NODE_IDS = [...new Set(EVAL_TASKS.flatMap((t) => t.groups.map((g) => g.nodeId)))];

let proxyAvailable = false;
let modelConfigured = false;
let modelName = DEFAULT_MODEL;
const modelOperator = createModelOperator(proxyCaller());

function esc(s: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  return s.replace(/[&<>"]/g, (c) => map[c] ?? c);
}

function useModel(): boolean {
  return sourceSelect.value === 'model';
}

function activeOperator(): Operator {
  return useModel() ? modelOperator : offlineOperator;
}

function renderStatus(): void {
  const ok = proxyAvailable && modelConfigured;
  const modelOption = sourceSelect.querySelector<HTMLOptionElement>('option[value="model"]')!;
  modelOption.disabled = !ok;
  if (!ok && sourceSelect.value === 'model') sourceSelect.value = 'offline';
  statusEl.innerHTML =
    `服务端代理：<b>${proxyAvailable ? '已连接' : '未连接（静态构建或代理不可用）'}</b><br />` +
    `模型：<b>${esc(modelName)}</b><br />` +
    `OpenRouter key：<b>${ok ? '已配置' : '未配置 / 无效'}</b><br />` +
    `当前算子：<b>${useModel() ? 'OpenRouter 模型' : '离线演示算子'}</b>`;
}

async function checkStatus(): Promise<void> {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json() as { configured?: boolean; model?: string };
    proxyAvailable = true;
    modelConfigured = !!data.configured;
    modelName = data.model ?? DEFAULT_MODEL;
  } catch {
    proxyAvailable = false;
    modelConfigured = false;
  }
  renderStatus();
}

function evalCell(r: RunResult): string {
  return `<td class="${r.pass ? 'ok' : 'bad'}">${r.pass ? 'PASS' : 'FAIL'} ${esc(r.codes.join(',') || '-')}</td>`;
}

function renderEvalReport(report: ExperimentReport): void {
  const ids = [...new Set(report.rows.map((r) => r.taskId))];
  let html = '<table class="eval-table"><thead><tr><th>任务</th><th>端到端</th><th>工作流</th><th>重算</th></tr></thead><tbody>';
  for (const id of ids) {
    const b = report.rows.find((r) => r.taskId === id && r.arm === 'baseline')!;
    const w = report.rows.find((r) => r.taskId === id && r.arm === 'workflow')!;
    html += `<tr><td>${esc(id)}</td>${evalCell(b)}${evalCell(w)}<td>${w.recomputed}/${w.totalNodes}</td></tr>`;
  }
  html += '</tbody></table>';
  const s = report.summary;
  html += `<p class="note">端到端 ${s.baselinePass}/${s.total} PASS · 工作流 ${s.workflowPass}/${s.total} PASS · 局部重算 ${s.recomputed}/${s.totalNodes} 节点 · tokens ${s.tokens} · 耗时 ${s.latencyMs.toFixed(0)}ms</p>`;
  html += `<p class="note">人工节点：${report.autoApprove ? '自动通过（评测轨）' : '需人工确认'}</p>`;
  const errors = [...new Set(report.rows.map((r) => r.error).filter((e): e is string => !!e))];
  if (errors.length) {
    html += `<p class="note warn">算子错误：${esc(errors.slice(0, 2).map((e) => e.slice(0, 180)).join(' | '))}</p>`;
  }
  if (report.source === 'offline') {
    html += '<p class="note warn">确定性演示桩：仅验证管线连通，不能作为模型能力数字。</p>';
  }
  evalResult.innerHTML = html;
}

async function runEval(): Promise<void> {
  btnRunEval.disabled = true;
  evalResult.textContent = '运行中…';
  try {
    const report = await runExperiment(EVAL_TASKS, activeOperator(), {
      source: useModel() ? 'model' : 'offline',
      model: modelName,
      autoApprove: true,
    });
    renderEvalReport(report);
  } catch (e) {
    evalResult.textContent = `运行失败：${String(e)}`;
  } finally {
    btnRunEval.disabled = false;
  }
}

function nodeKinds(nodeId: string): ItemKind[] {
  const pool = new Set<ItemKind>();
  for (const t of EVAL_TASKS) {
    for (const g of t.groups) if (g.nodeId === nodeId) g.kinds.forEach((k) => pool.add(k));
  }
  return [...pool].filter((k) => currentScene.items.some((i) => i.kind === k));
}

async function rerunNode(): Promise<void> {
  pause();
  const nodeId = nodeSelect.value;
  const kinds = nodeKinds(nodeId);
  if (!kinds.length) {
    nodeResult.textContent = '当前场景在这个节点下没有可重算的物件。';
    return;
  }
  ensureBranch();
  if (activeTarget === null) return;
  const branch = branches[activeTarget];
  const kept = branch.items.filter((i) => !kinds.includes(i.kind));
  const req: PlacementRequest = {
    task: `为「${currentScene.space.label}」重新规划 ${nodeId} 节点`,
    nodeId, kinds, space: currentScene.space,
    existing: toExisting(kept, currentScene.space),
    attempt: 1,
    instruction: instructionInput.value.trim() || undefined,
    strategy: strategySelect.value || undefined,
  };
  btnRerunNode.disabled = true;
  nodeResult.textContent = '算子生成中…';
  try {
    const res = await activeOperator()(req);
    if (res.error) throw new Error(res.error);
    const produced = res.placements.map((p) =>
      makeItem(currentScene.space, p.id, p.id as ItemKind,
        safeSurfaceId(currentScene.space, p.surfaceId), p.x, p.z, p.lift));
    branch.items = [...kept, ...produced];
    focusIds = new Set(produced.map((i) => i.id));
    refresh();
    const g = currentGrade;
    const coords = produced.map((p) => `${p.kind}(${p.box.x},${p.box.z})`).join(' ');
    nodeResult.innerHTML =
      `<b>${esc(NODE_LABEL[nodeId] ?? nodeId)}</b> · ${res.source === 'offline' ? '离线算子' : 'OpenRouter 模型'} · ${res.latencyMs.toFixed(0)}ms · ${res.tokens} tokens<br />` +
      `本次重算 ${produced.length} 件 · 判分 <b class="${g.pass ? 'ok' : 'bad'}">${g.pass ? 'PASS' : 'FAIL · ' + esc(g.hard.map((v) => v.code).join(','))}</b><br />` +
      `坐标：${esc(coords)}`;
  } catch (e) {
    nodeResult.innerHTML = `<span class="bad">算子失败：${esc(String(e))}</span>`;
  } finally {
    btnRerunNode.disabled = false;
  }
}

function mountStage3(): void {
  for (const id of NODE_IDS) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = NODE_LABEL[id] ?? id;
    nodeSelect.appendChild(opt);
  }
  for (const s of STRATEGIES) {
    const opt = document.createElement('option');
    opt.value = s.value;
    opt.textContent = s.label;
    strategySelect.appendChild(opt);
  }
  sourceSelect.addEventListener('change', renderStatus);
  btnRunEval.addEventListener('click', () => { void runEval(); });
  btnRerunNode.addEventListener('click', () => { void rerunNode(); });
  btnClearIntent.addEventListener('click', () => {
    instructionInput.value = '';
    strategySelect.value = '';
    nodeResult.textContent = '已清空意图与仲裁策略。';
  });
  renderStatus();
  void checkStatus();
}

/* ---------- 阶段 4a：多轮增量编辑、局部性采集、现状输入兜底 ---------- */

const sceneSource = document.querySelector<HTMLSelectElement>('#sceneSource')!;
const sceneJson = document.querySelector<HTMLTextAreaElement>('#sceneJson')!;
const btnLoadScene = document.querySelector<HTMLButtonElement>('#btnLoadScene')!;
const sceneReadInfo = document.querySelector<HTMLDivElement>('#sceneReadInfo')!;
const turnInstruction = document.querySelector<HTMLInputElement>('#turnInstruction')!;
const demoEl = document.querySelector<HTMLDivElement>('#demoInstructions')!;
const btnApplyTurn = document.querySelector<HTMLButtonElement>('#btnApplyTurn')!;
const btnResetTurns = document.querySelector<HTMLButtonElement>('#btnResetTurns')!;
const turnResult = document.querySelector<HTMLDivElement>('#turnResult')!;
const localityTable = document.querySelector<HTMLDivElement>('#localityTable')!;

/** 低置信度现状的"人工确认"槽：第一次点击只报告问题，第二次才载入。 */
let pendingManual: Scene | null = null;

function renderReadInfo(): void {
  if (!editSession) {
    sceneReadInfo.textContent = '尚未载入起点现状。';
    return;
  }
  const r = editSession.read;
  sceneReadInfo.innerHTML =
    `来源：<b>${esc(r.source)}</b> · 置信度 <b>${r.confidence.toFixed(2)}</b> · ` +
    `${esc(editSession.initial.space.label)} · ${editSession.initial.items.length} 件` +
    (r.confidence < 1
      ? `<br /><span class="bad">现状校验发现 ${r.notes.length} 处问题：${esc(r.notes.slice(0, 3).join('；'))}；按决策 3 应弹人工确认。</span>`
      : '<br />现状自洽校验通过，无需人工确认。');
}

function renderDemoButtons(): void {
  demoEl.replaceChildren();
  if (!editSession) return;
  for (const d of availableInstructions(currentSceneOf(editSession))) {
    const b = document.createElement('button');
    b.textContent = d.text;
    b.addEventListener('click', () => {
      turnInstruction.value = d.text;
      void applyEditTurn(d.text);
    });
    demoEl.appendChild(b);
  }
}

function renderLocality(): void {
  if (!editSession || !editSession.turns.length) {
    localityTable.innerHTML = '<p class="note">还没有增量轮次。</p>';
    return;
  }
  const rep = localityReport(editSession);
  let html = '<table class="eval-table"><thead><tr><th>轮</th><th>节点</th><th>变化</th><th>上游</th><th>判分</th></tr></thead><tbody>';
  for (const t of editSession.turns) {
    html += `<tr><td>${t.index}</td><td>${esc(t.nodeId)}</td>` +
      `<td>${esc(t.changedIds.join(',') || '—')} (${t.changedIds.length})</td>` +
      `<td class="${t.upstreamTouched.length ? 'bad' : 'ok'}">${t.upstreamTouched.length}</td>` +
      `<td class="${t.pass ? 'ok' : 'bad'}">${t.pass ? 'PASS' : 'FAIL ' + esc(t.codes.join(','))}</td></tr>`;
  }
  html += '</tbody></table>';
  html += `<p class="note">合计 ${rep.turns} 轮 · 场景 ${rep.itemCount} 件 · 累计变化 ${rep.changedTotal} 件次 · ` +
    `上游触碰 <b class="${rep.upstreamTotal ? 'bad' : 'ok'}">${rep.upstreamTotal}</b> 次 · ` +
    `平均每轮 ${rep.avgChanged.toFixed(1)} 件（${(rep.avgRatio * 100).toFixed(1)}%）</p>`;
  localityTable.innerHTML = html;
}

/** 每轮落一个 checkpoint，复用阶段 2 的分支对比做回放。 */
function useCheckpoint(items: BoxItem[], label: string): void {
  branches.push({ label, items: structuredClone(items), fromFrame: frameIndex, checkpoint: true });
  activeTarget = branches.length - 1;
}

async function finishLoad(scene: Scene, source: 'preset' | 'manual', index: number): Promise<void> {
  pause();
  sceneSource.value = String(index);
  showInspect(index, null);
  editSession = await openSession(structuredReader(scene, source));
  sceneJson.value = JSON.stringify(editSession.initial.items, null, 2);
  branches = [];
  useCheckpoint(editSession.initial.items, '起点现状');
  focusIds = new Set();
  refresh(true);
  renderReadInfo();
  renderDemoButtons();
  renderLocality();
  turnResult.textContent = `起点已载入（${source === 'preset' ? '预设现状' : '手动录入'}），可连续下增量指令。`;
}

async function loadManualScene(): Promise<void> {
  if (pendingManual) {
    const scene = pendingManual;
    pendingManual = null;
    btnLoadScene.textContent = '校验并载入';
    await finishLoad(scene, 'manual', presetIndex);
    return;
  }
  let items: BoxItem[];
  try {
    items = JSON.parse(sceneJson.value) as BoxItem[];
  } catch (e) {
    turnResult.innerHTML = `<span class="bad">JSON 解析失败：${esc(String(e))}</span>`;
    return;
  }
  if (!Array.isArray(items) || !items.length) {
    turnResult.innerHTML = '<span class="bad">需要一个非空的 BoxItem 数组。</span>';
    return;
  }
  const scene: Scene = { space: PRESETS[presetIndex].space, items };
  const problems = validateScene(scene);
  if (problems.length) {
    pendingManual = scene;
    btnLoadScene.textContent = '仍要使用（人工确认）';
    turnResult.innerHTML =
      `<span class="bad">现状校验发现 ${problems.length} 处问题：${esc(problems.slice(0, 3).join('；'))}</span><br />` +
      '决策 3：低置信度才弹人工确认。再点一次表示确认沿用，或修正 JSON 后重新校验。';
    return;
  }
  await finishLoad(scene, 'manual', presetIndex);
}

async function applyEditTurn(text: string): Promise<void> {
  if (!text) {
    turnResult.textContent = '先写一句增量指令，或点上面的预置指令。';
    return;
  }
  if (!editSession) await finishLoad(structuredClone(PRESETS[presetIndex]), 'preset', presetIndex);
  if (!editSession) return;
  const route = routeInstruction(text, currentSceneOf(editSession));
  if (!route.kinds.length) {
    turnResult.innerHTML = '<span class="bad">该指令在当前现状下没有可重算的物件。</span>';
    return;
  }
  btnApplyTurn.disabled = true;
  try {
    const turn = await applyTurn(editSession, text, {
      operator: activeOperator(),
      strategy: strategySelect.value || undefined,
    });
    useCheckpoint(turn.after.items, `第 ${turn.index} 轮 · ${turn.nodeId}`);
    focusIds = new Set(turn.changedIds);
    refresh(true);
    renderDemoButtons();
    renderLocality();
    turnResult.innerHTML =
      `<b>第 ${turn.index} 轮</b> · ${esc(turn.nodeId)} · ${turn.source === 'offline' ? '离线算子' : 'OpenRouter 模型'} · 重算 ${turn.attempts} 次<br />` +
      `变化 ${turn.changedIds.length} 件：${esc(turn.changedIds.join(', ') || '无（现状已满足该意图）')} · ` +
      `上游 <b class="${turn.upstreamTouched.length ? 'bad' : 'ok'}">${turn.upstreamTouched.length}</b> · ` +
      `<b class="${turn.pass ? 'ok' : 'bad'}">${turn.pass ? 'PASS' : 'FAIL ' + esc(turn.codes.join(','))}</b><br />` +
      esc(turn.note);
  } catch (e) {
    turnResult.innerHTML = `<span class="bad">这一轮失败：${esc(String(e))}</span>`;
  } finally {
    btnApplyTurn.disabled = false;
  }
}

function resetTurns(): void {
  if (!editSession) return;
  editSession.turns.length = 0;
  branches = [];
  useCheckpoint(editSession.initial.items, '起点现状');
  focusIds = new Set();
  turnInstruction.value = '';
  pendingManual = null;
  btnLoadScene.textContent = '校验并载入';
  refresh(true);
  renderDemoButtons();
  renderLocality();
  turnResult.textContent = '轮次已清空，回到起点现状。';
}

function mountStage4(): void {
  PRESETS.forEach((p, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = p.space.label;
    sceneSource.appendChild(opt);
  });
  sceneSource.addEventListener('change', () => {
    const idx = Number(sceneSource.value);
    pendingManual = null;
    btnLoadScene.textContent = '校验并载入';
    void finishLoad(structuredClone(PRESETS[idx]), 'preset', idx);
  });
  sceneJson.addEventListener('input', () => {
    if (pendingManual) { pendingManual = null; btnLoadScene.textContent = '校验并载入'; }
  });
  btnLoadScene.addEventListener('click', () => { void loadManualScene(); });
  btnApplyTurn.addEventListener('click', () => { void applyEditTurn(turnInstruction.value.trim()); });
  btnResetTurns.addEventListener('click', resetTurns);
  void finishLoad(structuredClone(PRESETS[0]), 'preset', 0);
}

function buildButtons(): void {
  PRESETS.forEach((p, i) => {
    const b = document.createElement('button');
    b.textContent = p.space.label;
    b.addEventListener('click', () => showInspect(i, null));
    presetsEl.appendChild(b);
    presetButtons.push(b);
  });
  INJECTIONS.forEach((inj, i) => {
    const b = document.createElement('button');
    b.className = 'warn';
    b.textContent = inj.label;
    b.addEventListener('click', () => showInspect(presetIndex, i));
    injectEl.appendChild(b);
    injectButtons.push(b);
  });
  restoreButton.textContent = '恢复现状';
  restoreButton.addEventListener('click', () => showInspect(presetIndex, null));
  injectEl.appendChild(restoreButton);

  btnPlay.addEventListener('click', play);
  btnPrev.addEventListener('click', () => { pause(); setFrame(frameIndex - 1); });
  btnNext.addEventListener('click', () => { pause(); setFrame(frameIndex + 1); });
  frameRange.addEventListener('input', () => { pause(); setFrame(Number(frameRange.value)); });
  btnFork.addEventListener('click', () => {
    pause();
    branches.push({
      label: `分支 ${branches.length + 1}`,
      items: structuredClone(displayedItems()),
      fromFrame: frameIndex,
    });
    activeTarget = branches.length - 1;
    focusIds = new Set();
    refresh();
  });
  btnRepair.addEventListener('click', () => {
    if (activeTarget === null) return;
    branches[activeTarget].items = structuredClone(baseItems());
    focusIds = new Set();
    refresh();
  });
}

type SliderKey = keyof GradeOptions;
const SLIDERS: { key: SliderKey; label: string; min: number; max: number; step: number; unit: string; init: number }[] = [
  { key: 'screenHeadroom', label: '屏幕上方净空', min: 5, max: 50, step: 1, unit: 'cm', init: 25 },
  { key: 'liquidGap', label: '水杯与设备安全距离', min: 0, max: 35, step: 1, unit: 'cm', init: 15 },
  { key: 'reachDepth', label: '坐姿伸手半径', min: 15, max: 55, step: 1, unit: 'cm', init: 38 },
  { key: 'usableRatio', label: '可用桌面宽度', min: 50, max: 100, step: 5, unit: '%', init: 100 },
];

function buildSliders(): void {
  for (const s of SLIDERS) {
    const wrap = document.createElement('div');
    wrap.className = 'slider';
    const label = document.createElement('label');
    const name = document.createElement('span');
    name.textContent = s.label;
    const val = document.createElement('span');
    label.append(name, val);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(s.min);
    input.max = String(s.max);
    input.step = String(s.step);
    input.value = String(s.init);
    const sync = (): void => { val.textContent = `${input.value}${s.unit}`; };
    sync();
    input.addEventListener('input', () => {
      const n = Number(input.value);
      options[s.key] = s.key === 'usableRatio' ? n / 100 : n;
      sync();
      refresh(true);
    });
    wrap.append(label, input);
    slidersEl.appendChild(wrap);
  }
}

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let dragging: { id: string; plane: THREE.Plane; offsetX: number; offsetZ: number } | null = null;

function updatePointer(e: PointerEvent): void {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.set(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(pointer, camera);
}

renderer.domElement.addEventListener('pointerdown', (e: PointerEvent) => {
  updatePointer(e);
  const hit = raycaster.intersectObjects(pickProxies, false)[0];
  if (!hit) return;
  pause();
  const id = hit.object.userData.id as string;
  ensureBranch();
  if (activeTarget === null) return;
  const item = branches[activeTarget].items.find((i) => i.id === id);
  if (!item) return;
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -item.box.y);
  const p = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(plane, p)) return;
  dragging = { id, plane, offsetX: p.x - item.box.x, offsetZ: p.z - item.box.z };
  controls.enabled = false;
  renderer.domElement.setPointerCapture(e.pointerId);
  refresh();
});

renderer.domElement.addEventListener('pointermove', (e: PointerEvent) => {
  if (!dragging || activeTarget === null) return;
  updatePointer(e);
  const p = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(dragging.plane, p)) return;
  const item = branches[activeTarget].items.find((i) => i.id === dragging!.id);
  if (!item) return;
  item.box.x = Math.round(p.x - dragging.offsetX);
  item.box.z = Math.round(p.z - dragging.offsetZ);
  const view = itemViews.find((v) => v.id === dragging!.id);
  if (view) {
    view.group.position.set(item.box.x + item.box.w / 2, item.box.y, item.box.z + item.box.d / 2);
  }
  lightRefresh();
});

function endDrag(e: PointerEvent): void {
  if (!dragging) return;
  dragging = null;
  controls.enabled = true;
  if (renderer.domElement.hasPointerCapture(e.pointerId)) {
    renderer.domElement.releasePointerCapture(e.pointerId);
  }
  refresh();
}
renderer.domElement.addEventListener('pointerup', endDrag);
renderer.domElement.addEventListener('pointercancel', endDrag);

function resize(): void {
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  if (!w || !h) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
window.addEventListener('resize', resize);

function animate(): void {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene3d, camera);
}

resize();
buildButtons();
buildSliders();
mountStage3();
frameCamera(TRACE.space);
setFrame(0);

/** 模型异步加载：缺文件就保持盒体回退，每落一个重绘一次。 */
const ALL_KINDS = [...new Set([
  ...PRESETS.flatMap((p) => p.items.map((i) => i.kind)),
  ...TRACE.frames.flatMap((f) => f.items.map((i) => i.kind)),
])];
preloadAssets(ALL_KINDS, () => refresh());

play();
mountStage4();
animate();
