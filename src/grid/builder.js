import { SEARCH_AREA, SEARCH_AREA_EXTENDED } from "../core/constants.js";
import { store } from "../core/store.js";
import { state } from "../core/state.js";
import {
  buildExtendedCellFeatures,
  buildPrimaryCellFeatures,
  rowLabel,
} from "./features.js";

export function buildGrid() {
  store.cellLookup.clear();
  store.cellFeatures = buildPrimaryCellFeatures(SEARCH_AREA.boundary);
  store.cellFeatures.forEach((feature) => {
    store.cellLookup.set(feature.properties.id, feature);
  });
}

export { rowLabel };

export function findContainingCell(lng, lat) {
  const point = turf.point([lng, lat]);
  for (const feature of store.cellFeatures) {
    if (turf.booleanPointInPolygon(point, feature)) {
      return feature.properties.id;
    }
  }
  return null;
}

export function buildExtendedGrid() {
  // Strip any previously generated extended cells so rebuilds are clean.
  const extIds = new Set(store.cellFeatures.filter((f) => f.properties.id?.startsWith("E-")).map((f) => f.properties.id));
  extIds.forEach((id) => store.cellLookup.delete(id));
  store.cellFeatures = store.cellFeatures.filter((f) => !f.properties.id?.startsWith("E-"));

  const boundary = state.customExtendedBoundary || SEARCH_AREA_EXTENDED.boundary;
  const extCells = buildExtendedCellFeatures(store.cellFeatures, boundary);
  extCells.forEach((feature) => {
    store.cellLookup.set(feature.properties.id, feature);
  });

  store.cellFeatures.push(...extCells);
}
