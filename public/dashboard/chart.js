/**
 * Small line chart: inline SVG, no dependencies.
 *
 * One series per chart by design. Sessions, credits and dollars are different
 * scales, and putting two scales on one plot is the single most misleading
 * thing a chart can do — so they become separate charts rather than a second
 * y-axis.
 */

const PAD = { top: 18, right: 14, bottom: 22 };
const AXIS_FONT = '10px ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif';

/**
 * Left padding is measured, not assumed.
 *
 * A fixed gutter is only ever right for one label width: "50" fits in 42px,
 * "$10.00" does not — it renders at a negative x, and because the SVG is
 * `overflow: visible` it escapes the card entirely rather than being clipped.
 */
let measurer = null;
function textWidth(text) {
  if (!measurer) {
    measurer = document.createElement('canvas').getContext('2d');
    measurer.font = AXIS_FONT;
  }
  return measurer.measureText(text).width;
}

function leftGutter(labels) {
  const widest = Math.max(...labels.map(textWidth), 0);
  return Math.ceil(widest) + 12; // 7px tick gap + a little breathing room
}

function niceMax(value) {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const scaled = value / magnitude;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return step * magnitude;
}

function shortDate(iso) {
  const [, month, day] = iso.split('-');
  return `${Number(day)}/${Number(month)}`;
}

/**
 * @param {object} options
 * @param {{date:string,value:number}[]} options.points
 * @param {string} options.color   CSS custom property name for the series hue
 * @param {(n:number)=>string} options.format
 */
export function lineChart({ points, color, format, width = 600, height = 160 }) {
  // The viewBox is in real pixels and the SVG scales uniformly. An earlier
  // version used a 100-unit box with preserveAspectRatio="none", which stretches
  // the path to fit — and stretches every label and marker with it.
  const max = niceMax(Math.max(...points.map((p) => p.value), 0));
  const ticks = [0, 0.5, 1].map((t) => max * t);
  const padLeft = leftGutter(ticks.map(format));
  const innerW = width - padLeft - PAD.right;

  const x = (i) => (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW) + padLeft;
  const y = (v) => PAD.top + (1 - v / max) * (height - PAD.top - PAD.bottom);

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(p.value).toFixed(2)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(2)},${y(0)} L${x(0).toFixed(2)},${y(0)} Z`;
  const last = points[points.length - 1];

  const gridLines = ticks
    .map(
      (value) => `<line class="grid" x1="${padLeft}" x2="${width - PAD.right}" y1="${y(value)}" y2="${y(value)}"/>
              <text class="axis-y" x="${padLeft - 7}" y="${y(value) + 3.5}">${format(value)}</text>`,
    )
    .join('');

  const svg = `
    <svg viewBox="0 0 ${width} ${height}" role="img" class="chart-svg"
         style="--chart-h:${height}px">
      <defs>
        <linearGradient id="fill-${color}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--${color})" stop-opacity=".18"/>
          <stop offset="100%" stop-color="var(--${color})" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${gridLines}
      <path d="${area}" fill="url(#fill-${color})"/>
      <path d="${line}" fill="none" stroke="var(--${color})" stroke-width="2"
            vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${x(points.length - 1)}" cy="${y(last.value)}" r="4"
              fill="var(--${color})" stroke="var(--surface-1)" stroke-width="2"/>
      <text class="value-label" x="${x(points.length - 1)}" y="${Math.max(y(last.value) - 10, 11)}"
            text-anchor="end">${format(last.value)}</text>
      <line class="crosshair" x1="0" x2="0" y1="${PAD.top}" y2="${height - PAD.bottom}" style="display:none"/>
      <circle class="cursor-dot" r="4.5" fill="var(--${color})" stroke="var(--surface-1)"
              stroke-width="2" style="display:none"/>
      <text class="axis-x" x="${padLeft}" y="${height - 6}" text-anchor="start">${shortDate(points[0].date)}</text>
      <text class="axis-x" x="${width - PAD.right}" y="${height - 6}" text-anchor="end">${shortDate(last.date)}</text>
    </svg>`;

  return { svg, x, y, max, points, width, height, pad: { ...PAD, left: padLeft } };
}

/** Crosshair + tooltip. An HTML chart is interactive; a static one is a picture. */
export function attachHover(container, chart, format) {
  const svg = container.querySelector('.chart-svg');
  const crosshair = svg.querySelector('.crosshair');
  const dot = svg.querySelector('.cursor-dot');
  const tip = container.querySelector('.chart-tip');
  if (!svg || !tip) return;

  const move = (event) => {
    const box = svg.getBoundingClientRect();
    const scale = chart.width / box.width;
    const localX = (event.clientX - box.left) * scale;
    const ratio = (localX - chart.pad.left) / (chart.width - chart.pad.left - chart.pad.right);
    const index = Math.round(ratio * (chart.points.length - 1));
    const point = chart.points[Math.min(Math.max(index, 0), chart.points.length - 1)];
    if (!point) return;

    const px = chart.x(chart.points.indexOf(point));
    crosshair.setAttribute('x1', px);
    crosshair.setAttribute('x2', px);
    crosshair.style.display = '';
    dot.setAttribute('cx', px);
    dot.setAttribute('cy', chart.y(point.value));
    dot.style.display = '';

    tip.hidden = false;
    tip.innerHTML = `<b>${format(point.value)}</b><span>${point.date}</span>`;
    const left = (px / chart.width) * box.width;
    tip.style.left = `${Math.min(Math.max(left, 46), box.width - 46)}px`;
  };

  const leave = () => {
    crosshair.style.display = 'none';
    dot.style.display = 'none';
    tip.hidden = true;
  };

  container.addEventListener('pointermove', move);
  container.addEventListener('pointerleave', leave);
}
