import { STATUS, LABEL_MIN_ZOOM } from "../core/constants.js";
import { state } from "../core/state.js";
import { getGridAuditCount } from "../core/audit.js";
import { store } from "../core/store.js";

export function getCellStyle(feature) {
  const id = feature.properties.id;
  const entry = state.cells[id];
  const statusKey = entry?.status || "open";
  const visual = STATUS[statusKey] || STATUS.open;
  const isSelected = store.activeCellId === id;
  const isCurrentGps = store.gpsCellId === id;
  const baseWeight = isSelected || isCurrentGps ? 4 : 1.2;

  if (store.heatMode) {
    const count = getGridAuditCount(id);
    const opacity = count ? Math.min(0.18 + count * 0.06, 0.68) : 0.07;
    return {
      color: isSelected ? "#111827" : isCurrentGps ? "#6d28d9" : "#7f1d1d",
      weight: baseWeight,
      fillColor: count > 6 ? "#dc2626" : count > 2 ? "#f97316" : "#facc15",
      fillOpacity: opacity,
      opacity: 0.95,
    };
  }

  if (store.hastyMode) {
    const s = entry?.status;
    const isUnsearched = !s || s === "open" || s === "stale";
    if (isUnsearched) {
      const rank = store.hastyPriority.get(id) ?? 999;
      const t = Math.min((rank - 1) / 19, 1); // 0 = highest priority, 1 = lowest
      // Interpolate: bright blue (#2563eb) → muted steel (#94a3b8)
      const opacity = 0.62 - t * 0.38;
      const color = t < 0.33 ? "#1d4ed8" : t < 0.66 ? "#3b82f6" : "#64748b";
      return {
        color: isSelected ? "#111827" : color,
        weight: baseWeight,
        fillColor: color,
        fillOpacity: isSelected ? Math.max(opacity, 0.55) : opacity,
        opacity: 0.95,
      };
    }
  }

  // Assignment overlays — only applied when the cell has no explicit non-open status.
  const isOccupied = store.occupiedCells?.has(id);
  const isAssigned = !isOccupied && store.assignedCells?.has(id);
  if ((isAssigned || isOccupied) && (statusKey === "open" || statusKey === "stale")) {
    if (isOccupied) {
      // Volunteer GPS is inside this cell — show as actively searching.
      return {
        color: isSelected ? "#111827" : "#154fc0",
        weight: isSelected ? 4 : 2.5,
        fillColor: "#2563eb",
        fillOpacity: isSelected ? 0.52 : 0.38,
        opacity: 1,
      };
    }
    // Volunteer is assigned but hasn't entered yet — amber "reserved" style.
    return {
      color: isSelected ? "#111827" : "#b45309",
      weight: isSelected ? 4 : 2,
      fillColor: "#fef3c7",
      fillOpacity: isSelected ? 0.5 : 0.30,
      opacity: 0.9,
    };
  }

  return {
    color: isSelected ? "#111827" : isCurrentGps ? "#6d28d9" : visual.color,
    weight: baseWeight,
    fillColor: visual.fill,
    fillOpacity: isSelected ? Math.max(visual.opacity, 0.42) : visual.opacity,
    opacity: 0.95,
  };
}

export function refreshGrid() {
  if (store.gridLayer) {
    store.gridLayer.setStyle(getCellStyle);
  }
  if (store.map && store.labelLayer) {
    renderLabels();
  }
  // Render last-seen marker — dispatched to avoid importing map.js here.
  document.dispatchEvent(new CustomEvent("esti:render-last-seen"));
}

export function renderLabels() {
  if (!store.labelLayer) return;
  store.labelLayer.clearLayers();
  if (store.map.getZoom() < LABEL_MIN_ZOOM) return;

  store.cellFeatures.forEach((feature) => {
    const [lng, lat] = feature.properties.center;
    const id = feature.properties.id;
    const entry = state.cells[id];
    const searchers = Array.isArray(entry?.searchers) ? entry.searchers : [];
    const count = searchers.length;
    const badge = count > 0 ? `<span class="cell-count">${count}</span>` : "";

    let rankBadge = "";
    if (store.hastyMode) {
      const s = entry?.status;
      const isUnsearched = !s || s === "open" || s === "stale";
      if (isUnsearched && store.hastyPriority.has(id)) {
        const rank = store.hastyPriority.get(id);
        rankBadge = `<span class="hasty-rank">#${rank}</span>`;
      }
    }

    const label = L.marker([lat, lng], {
      interactive: false,
      icon: L.divIcon({
        className: "cell-label",
        html: `<span class="cell-id">${id}</span>${rankBadge}${badge}`,
        iconSize: [46, 20],
        iconAnchor: [23, 10],
      }),
    });
    store.labelLayer.addLayer(label);
  });
}
