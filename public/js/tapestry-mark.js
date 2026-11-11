// The Midnight symbol on Cup & Claim's tapestry is whole or not there (11-06): never clipped by the room's crop.

/**
 * Whether the frame shows the symbol whole, with a margin of cloth round it. `crop` is the share of the picture cut off
 * the top and bottom; `mark` is where the symbol sits in the picture's pixels ({ cy, size, cloth: { top, bottom } }).
 */
export function markWhole(crop, roomH, mark) {
  const shownTop = roomH * crop.top;
  const shownBottom = roomH * (1 - crop.bottom);
  const margin = mark.size * 0.35;
  return mark.cy - mark.size / 2 - margin >= Math.max(shownTop, mark.cloth.top)
    && mark.cy + mark.size / 2 + margin <= Math.min(shownBottom, mark.cloth.bottom);
}
