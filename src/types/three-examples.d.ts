declare module 'three/examples/jsm/utils/SkeletonUtils' {
  import type { Object3D } from 'three';
  export const SkeletonUtils: {
    clone<T extends Object3D>(source: T): T;
  };
}
