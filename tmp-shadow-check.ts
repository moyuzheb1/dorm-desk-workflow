import * as THREE from 'three';
import { PRESETS } from './src/core/presets.ts';

/**
 * 临时校验：把主光的阴影相机按 main.ts 的公式重建一遍，
 * 检查所有"要投影的」和"要受影的"顶点是否都落在正交视锥内。
 * 无头浏览器渲染不出阴影贴图，但视锥算错是这边最常见也最致命的错。
 */
for (const preset of PRESETS) {
  const { space, items } = preset;
  const lightPos = new THREE.Vector3(space.width * 0.2, space.bedBottom * 2.1, space.depth * 3.4);
  const target = new THREE.Vector3(space.width / 2, space.deskY, space.depth / 2);
  const span = Math.max(space.width, space.depth, space.bedBottom) * 1.15 + 40;
  const cam = new THREE.OrthographicCamera(-span, span, span, -span, 1, span * 4);
  cam.position.copy(lightPos);
  cam.lookAt(target);
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();

  const points: { label: string; p: THREE.Vector3 }[] = [];
  for (const it of items) {
    const b = it.box;
    for (const dx of [0, b.w]) for (const dy of [0, b.h]) for (const dz of [0, b.d]) {
      points.push({ label: it.id, p: new THREE.Vector3(b.x + dx, b.y + dy, b.z + dz) });
    }
  }
  // 地板与桌板（受影面）
  for (const dx of [-130, space.width + 130]) for (const dz of [-130, space.depth + 130]) {
    points.push({ label: 'floor', p: new THREE.Vector3(space.width / 2 + dx, 0, space.depth / 2 + dz) });
  }
  for (const dx of [0, space.width]) for (const dz of [0, space.depth]) {
    points.push({ label: 'desk', p: new THREE.Vector3(dx, space.deskY, dz) });
  }

  let outside = 0;
  let worst = 0;
  const offenders = new Set<string>();
  for (const { label, p } of points) {
    const ndc = p.clone().applyMatrix4(cam.matrixWorldInverse).applyMatrix4(cam.projectionMatrix);
    const margin = Math.max(Math.abs(ndc.x), Math.abs(ndc.y), Math.abs(ndc.z));
    worst = Math.max(worst, margin);
    if (margin > 1) { outside++; offenders.add(label); }
  }
  console.log(
    `${space.id.padEnd(14)} 视锥 margin 最大 ${worst.toFixed(2)} · 越界顶点 ${outside}/${points.length}` +
    (offenders.size ? ` · ${[...offenders].join(',')}` : ' · 全部在视锥内'),
  );
}
