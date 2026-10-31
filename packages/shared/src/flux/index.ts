// The Flux exercise catalog, as a subpath (`@aperture/shared/flux`) — never re-exported from the root
// barrel: flux's `Category` would collide with Aperture's Category entity (docs/areas/flux).
export * from './types';
export * from './definitions';
export * from './catalog';
export * from './history';
