/**
 * The Enhanced render style's materials.
 *
 * Built on `MeshLambertMaterial` rather than a raw `ShaderMaterial`, and that choice carries
 * most of the file: Lambert with `flatShading` derives face normals from screen-space
 * derivatives (so the mesher still ships no normal attribute), and staying inside a built-in
 * material keeps clipping planes, fog, tonemapping and the transparent path working exactly
 * as they do in Classic — every one of those is a hand-rolled liability in a from-scratch
 * shader.
 *
 * Two things are injected via `onBeforeCompile`:
 *
 * 1. **Un-baking the face shade.** The mesher bakes `faceShade × AO` into vertex colours so
 *    the Classic unlit material reads as 3D. Under real lights that face shade would apply
 *    twice — the sun darkens a wall the mesher already darkened. The fragment shader knows
 *    the face normal (the same derivative trick flat shading uses), so the baked factor is
 *    divided back out, leaving `albedo × AO`: baked occlusion survives, direction is the
 *    lights' job now. The constants here MUST match `FACES[].shade` in `mesher.ts`.
 *
 * 2. **Per-voxel grain.** A hash of the voxel's cell position varies brightness a little from
 *    block to block, and a finer hash adds a faint 4×4 texel pattern inside each face. This
 *    is what makes a wall read as *material* rather than as flat paint — and because it is
 *    procedural, it ships no texture and redistributes nothing.
 */

import * as THREE from 'three';

/** Fragment code shared by both materials, spliced in after `#include <color_fragment>`. */
const GRAIN_FRAGMENT = /* glsl */ `
  {
    vec3 grainNormal = normalize(cross(dFdx(vGrainPos), dFdy(vGrainPos)));

    // Divide the mesher's baked face shade back out. Same table as FACES[].shade.
    float baked = abs(grainNormal.y) > 0.5
      ? (grainNormal.y > 0.0 ? 1.0 : 0.5)
      : (abs(grainNormal.z) > 0.5 ? 0.8 : 0.6);
    diffuseColor.rgb /= baked;

    // Which voxel does this fragment belong to? Half a block inward along the normal,
    // because the fragment sits exactly on the face between two cells.
    vec3 cell = floor(vGrainPos - grainNormal * 0.5) + 0.5;
    diffuseColor.rgb *= 0.93 + 0.14 * grainHash(cell);

    // Faint texel-scale variation inside the face, seeded per cell so it never scrolls.
    vec3 texel = floor((vGrainPos - grainNormal * 0.02) * 4.0);
    diffuseColor.rgb *= 0.975 + 0.05 * grainHash(texel * 0.25 + cell * 7.0);
  }
`;

const GRAIN_PARS = /* glsl */ `
  varying vec3 vGrainPos;
  // The classic cheap 3D value hash — deterministic, good enough for brightness jitter.
  float grainHash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
`;

function injectGrain(material: THREE.MeshLambertMaterial): void {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n  varying vec3 vGrainPos;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n  vGrainPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GRAIN_PARS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${GRAIN_FRAGMENT}`);
  };
  // onBeforeCompile changes are part of the program cache key only if we say so.
  material.customProgramCacheKey = () => 'craftmagic-grain';
}

export interface WorldMaterials {
  opaque: THREE.Material;
  transparent: THREE.Material;
}

/** The Classic pair — unlit, colours straight off the vertices. Exactly the old look. */
export function classicMaterials(): WorldMaterials {
  return {
    opaque: new THREE.MeshBasicMaterial({ vertexColors: true }),
    transparent: new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      // Without this, panes of glass in the same chunk occlude each other in draw order.
      depthWrite: false,
      opacity: 0.72,
      side: THREE.DoubleSide,
    }),
  };
}

export function enhancedMaterials(): WorldMaterials {
  const opaque = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const transparent = new THREE.MeshLambertMaterial({
    vertexColors: true,
    flatShading: true,
    transparent: true,
    depthWrite: false,
    opacity: 0.72,
    side: THREE.DoubleSide,
  });
  injectGrain(opaque);
  injectGrain(transparent);
  return { opaque, transparent };
}
