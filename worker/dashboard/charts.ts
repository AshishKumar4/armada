/**
 * The job page's two pictures, drawn on canvas so a job of 100 000 tasks draws as fast as one of ten: every task as a
 * cell, and every container as a row of the tasks it ran. A cell or a bar is coloured by how its task stands; what
 * runs now is orange and breathes, and what is queued is a dim dot, as on the banner.
 */
import { append, h, type Child } from './dom';

export type TaskState = 'queued' | 'running' | 'green' | 'red' | 'timeout' | 'lost' | 'cancelled';

interface Palette {
  readonly accent: string;
  readonly ok: string;
  readonly bad: string;
  readonly warn: string;
  readonly faint: string;
  readonly muted: string;
  readonly dim: string;
  readonly line: string;
  readonly mono: string;
}

/** The theme's colours, read from its custom properties each time a picture is painted. */
function palette(): Palette {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string): string => style.getPropertyValue(`--${name}`).trim();

  return {
    accent: read('accent'), ok: read('ok'), bad: read('bad'), warn: read('warn'), faint: read('faint'), muted: read('muted'), dim: read('dim'), line: read('line'), mono: read('mono'),
  };
}

function fill(colors: Palette, state: TaskState): string {
  switch (state) {
    case 'running': return colors.accent;
    case 'green': return colors.ok;
    case 'red': return colors.bad;
    case 'timeout': return colors.warn;
    case 'lost': return colors.bad;
    case 'cancelled': return colors.faint;
    case 'queued': return colors.dim;
  }
}

/** How bright a running task is now: a slow breath, so the eye finds what is live. */
const breath = (now: number): number => 0.62 + 0.38 * (0.5 + 0.5 * Math.sin(now / 420));

/** The one tooltip, beside the pointer. */
const tip = h('div', { class: 'tooltip' });

function showTip(event: MouseEvent, content: Child): void {
  while (tip.firstChild !== null) tip.removeChild(tip.firstChild);
  append(tip, [content]);

  if (!tip.isConnected) document.body.appendChild(tip);
  const { width, height } = tip.getBoundingClientRect();
  const x = Math.min(event.clientX + 14, window.innerWidth - width - 8);
  const y = event.clientY + 16 + height > window.innerHeight ? event.clientY - height - 10 : event.clientY + 16;

  tip.style.left = `${String(Math.max(8, x))}px`;
  tip.style.top = `${String(Math.max(8, y))}px`;
}

export function hideTip(): void {
  tip.remove();
}

/** A canvas that fills its box's width, paints at the screen's density, and repaints each frame while what it shows
 *  is live. */
abstract class Surface<Hit> {
  readonly element: HTMLDivElement;

  protected readonly canvas: HTMLCanvasElement = h('canvas');

  private frame = 0;

  private readonly resized: ResizeObserver;

  private readonly themed = (): void => { this.paint(); };

  constructor(label: string, private readonly describe: (hit: Hit) => Child, private readonly pick: (hit: Hit) => void) {
    this.element = h('div', { class: 'canvas-wrap' }, this.canvas);
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', label);
    this.canvas.addEventListener('mousemove', (event) => {
      const hit = this.at(event.offsetX, event.offsetY);

      this.canvas.style.cursor = hit === null ? 'default' : 'pointer';

      if (hit === null) hideTip();
      else showTip(event, this.describe(hit));
    });
    this.canvas.addEventListener('mouseleave', hideTip);
    this.canvas.addEventListener('click', (event) => {
      const hit = this.at(event.offsetX, event.offsetY);

      if (hit === null) return;
      hideTip();
      this.pick(hit);
    });
    this.resized = new ResizeObserver(() => { this.paint(); });
    this.resized.observe(this.element);
    document.addEventListener('themechange', this.themed);
  }

  /** Lays the picture out at `width` CSS pixels and answers its height. */
  protected abstract measure(width: number): number;

  /** Paints the picture as last measured, and answers whether something on it is live. */
  protected abstract draw(context: CanvasRenderingContext2D, width: number, height: number, colors: Palette, now: number): boolean;

  /** What is under the point, in CSS pixels from the canvas's corner. */
  protected abstract at(x: number, y: number): Hit | null;

  protected paint(): void {
    cancelAnimationFrame(this.frame);
    const width = this.element.clientWidth;
    const context = this.canvas.getContext('2d');

    if (width === 0 || context === null) return;
    const ratio = window.devicePixelRatio || 1;
    const height = this.measure(width);
    const pixels = { width: Math.round(width * ratio), height: Math.round(height * ratio) };

    if (this.canvas.width !== pixels.width || this.canvas.height !== pixels.height) {
      this.canvas.width = pixels.width;
      this.canvas.height = pixels.height;
      this.canvas.style.height = `${String(height)}px`;
    }

    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    const live = this.draw(context, width, height, palette(), performance.now());

    if (live && document.visibilityState === 'visible' && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.frame = requestAnimationFrame(() => { this.paint(); });
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.resized.disconnect();
    document.removeEventListener('themechange', this.themed);
    hideTip();
  }
}

/** The tallest a task grid grows before its cells shrink. */
const MAX_HEIGHT = 300;

/** Cell sizes and gaps, largest first: a grid takes the largest that keeps it under MAX_HEIGHT. */
const CELLS = [[16, 5], [12, 4], [9, 3], [6, 2], [4, 1], [3, 1], [2, 1]] as const;

/** Above this many tasks a picture holds still between polls: breathing would repaint all of it each frame. */
const BREATHING = 6000;

/** Every task of a job as a cell, in index order. */
export class TaskGrid extends Surface<number> {
  private states: readonly TaskState[] = [];

  private layout = { size: 16, gap: 5, columns: 1 };

  update(states: readonly TaskState[]): void {
    this.states = states;
    this.paint();
  }

  protected measure(width: number): number {
    const count = this.states.length;
    const columnsOf = (size: number, gap: number): number => Math.max(1, Math.floor((width + gap) / (size + gap)));
    const [size, gap] = CELLS.find(([cell, space]) => Math.ceil(count / columnsOf(cell, space)) * (cell + space) <= MAX_HEIGHT) ?? [2, 1];
    const columns = columnsOf(size, gap);

    this.layout = { size, gap, columns };

    return Math.max(size, Math.ceil(count / columns) * (size + gap) - gap);
  }

  protected draw(context: CanvasRenderingContext2D, _width: number, _height: number, colors: Palette, now: number): boolean {
    const { size, gap, columns } = this.layout;
    const live = this.states.length <= BREATHING && this.states.includes('running');
    const glow = live ? breath(now) : 1;
    const radius = Math.max(0.5, size / 4.5);
    const dot = Math.max(1, Math.round(size * 0.44));
    const line = Math.max(1, size / 7);

    this.states.forEach((state, index) => {
      const x = (index % columns) * (size + gap);
      const y = Math.floor(index / columns) * (size + gap);

      context.beginPath();

      if (state === 'queued') {
        // Queued work is the banner's dim dot: smaller, and centred in its cell.
        context.fillStyle = colors.dim;
        context.roundRect(x + (size - dot) / 2, y + (size - dot) / 2, dot, dot, Math.min(radius, dot / 3));
        context.fill();
      } else if (state === 'lost' || state === 'cancelled') {
        // A task that never finished is an outline: nothing it ran answered.
        context.strokeStyle = fill(colors, state);
        context.lineWidth = line;
        context.roundRect(x + line / 2, y + line / 2, size - line, size - line, radius);
        context.stroke();
      } else {
        context.globalAlpha = state === 'running' ? glow : 1;
        context.fillStyle = fill(colors, state);
        context.roundRect(x, y, size, size, radius);
        context.fill();
        context.globalAlpha = 1;
      }
    });

    return live;
  }

  protected at(x: number, y: number): number | null {
    const { size, gap, columns } = this.layout;
    const column = Math.floor(x / (size + gap));
    const index = Math.floor(y / (size + gap)) * columns + column;

    if (column >= columns || x % (size + gap) > size || y % (size + gap) > size || index >= this.states.length) return null;

    return index;
  }
}

export interface Lane {
  readonly name: string;
  readonly state: string;
}

/** A stretch of a container's time: its start (`boot`, with no task) or a task it ran or runs. */
export interface Segment {
  readonly lane: string;
  readonly task: number | null;
  readonly start: number;
  readonly end: number;
  readonly state: TaskState | 'boot';
}

/** The time axis's height, and the narrowest the lane names' column is, in CSS pixels. */
const AXIS = 26;

const GUTTER = 52;

/** The lane names' column: room for the longest name in the 11 px monospace they are drawn in, about 0.6 em a
 *  character, so a slot's lane (`v12 · 3`) is not cut off. */
const gutterFor = (lanes: readonly Lane[]): number => Math.max(GUTTER, Math.ceil(Math.max(0, ...lanes.map((lane) => lane.name.length)) * 6.6) + 12);

/** Seconds between the axis's ticks: the first that leaves each label room. */
const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14_400];

/** `seconds` as the axis says them: `0:45`, `12:30`, `1:05:00`. */
function clock(seconds: number): string {
  const whole = Math.round(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60) % 60;
  const rest = String(whole % 60).padStart(2, '0');

  return hours > 0 ? `${String(hours)}:${String(minutes).padStart(2, '0')}:${rest}` : `${String(minutes)}:${rest}`;
}

/** Each container of a job as a row, its start hatched and each task it ran a bar, from the job's start on. */
export class Timeline extends Surface<Segment> {
  private lanes: readonly Lane[] = [];

  private segments: readonly Segment[] = [];

  private span = { from: 0, to: 1, live: false };

  private geometry = { row: 20, bar: 13, plot: 1, gutter: GUTTER };

  private hatch: { readonly pattern: CanvasPattern; readonly accent: string } | null = null;

  update(lanes: readonly Lane[], segments: readonly Segment[], from: number, to: number, live: boolean): void {
    this.lanes = lanes;
    this.segments = segments;
    this.span = { from, to, live };
    this.paint();
  }

  /** Where the axis ends now: a live job's runs on with the clock. */
  private end(): number {
    return Math.max(this.span.live ? Date.now() : this.span.to, this.span.from + 1000);
  }

  /** A start's hatching, in the theme's orange. */
  private pattern(context: CanvasRenderingContext2D, accent: string): CanvasPattern | null {
    if (this.hatch?.accent === accent) return this.hatch.pattern;
    const tile = h('canvas');

    tile.width = 6;
    tile.height = 6;
    const ink = tile.getContext('2d');

    if (ink === null) return null;
    ink.strokeStyle = accent;
    ink.globalAlpha = 0.55;
    ink.lineWidth = 1.4;
    ink.beginPath();
    ink.moveTo(-1, 7);
    ink.lineTo(7, -1);
    ink.stroke();
    const pattern = context.createPattern(tile, 'repeat');

    this.hatch = pattern === null ? null : { pattern, accent };

    return pattern;
  }

  protected measure(width: number): number {
    const count = this.lanes.length;
    const row = count <= 24 ? 20 : count <= 80 ? 12 : 7;
    const gutter = gutterFor(this.lanes);

    this.geometry = { row, bar: row >= 12 ? row - 7 : row - 2, plot: Math.max(1, width - gutter - 8), gutter };

    return AXIS + count * row + 4;
  }

  protected draw(context: CanvasRenderingContext2D, _width: number, height: number, colors: Palette, now: number): boolean {
    const { row, bar, plot, gutter } = this.geometry;
    const { from } = this.span;
    const to = this.end();
    const seconds = (to - from) / 1000;
    const step = STEPS.find((each) => (plot / seconds) * each >= 64) ?? 14_400;
    const x = (at: number): number => gutter + ((at - from) / (to - from)) * plot;

    context.font = `11px ${colors.mono}`;
    context.textBaseline = 'middle';

    for (let tick = 0; tick <= seconds; tick += step) {
      const at = x(from + tick * 1000);

      context.fillStyle = colors.line;
      context.fillRect(Math.round(at), AXIS - 6, 1, height - AXIS + 6);
      context.fillStyle = colors.faint;
      context.textAlign = tick === 0 ? 'left' : 'center';
      context.fillText(clock(tick), at, 9);
    }

    const rows = new Map(this.lanes.map((lane, index) => [lane.name, index]));

    if (row >= 12) {
      context.textAlign = 'left';
      this.lanes.forEach((lane, index) => {
        context.fillStyle = lane.state === 'failed' ? colors.bad : colors.muted;
        context.fillText(lane.name, 0, AXIS + index * row + row / 2);
      });
    }

    const glow = breath(now);

    for (const segment of this.segments) {
      const index = rows.get(segment.lane);

      if (index === undefined) continue;
      const left = x(segment.start);
      const right = Math.max(left + 2, x(segment.state === 'running' ? Math.max(segment.end, Date.now()) : segment.end));
      const top = AXIS + index * row + (row - bar) / 2;

      context.beginPath();
      context.roundRect(left, top, right - left, bar, Math.min(3, bar / 3));

      if (segment.state === 'boot') {
        context.fillStyle = this.pattern(context, colors.accent) ?? colors.dim;
        context.fill();
      } else if (segment.state === 'lost' || segment.state === 'cancelled') {
        context.strokeStyle = fill(colors, segment.state);
        context.lineWidth = 1.2;
        context.stroke();
      } else {
        context.globalAlpha = segment.state === 'running' ? glow : 1;
        context.fillStyle = fill(colors, segment.state);
        context.fill();
        context.globalAlpha = 1;
      }
    }

    if (this.span.live) {
      context.fillStyle = colors.accent;
      context.fillRect(Math.round(x(Date.now())), AXIS - 6, 1, height - AXIS + 6);
    }

    return this.span.live && this.segments.length <= BREATHING;
  }

  protected at(px: number, py: number): Segment | null {
    const lane = py < AXIS ? undefined : this.lanes[Math.floor((py - AXIS) / this.geometry.row)];

    if (lane === undefined) return null;
    const { from } = this.span;
    const to = this.end();
    const time = from + ((px - this.geometry.gutter) / this.geometry.plot) * (to - from);
    // Two pixels of slack either side, so a bar a few milliseconds wide can still be pointed at.
    const slack = (2 / this.geometry.plot) * (to - from);

    const under = this.segments.filter((segment) => segment.lane === lane.name && time >= segment.start - slack
      && time <= (segment.state === 'running' ? Date.now() : segment.end) + slack);

    return under.find((segment) => segment.task !== null) ?? under[0] ?? null;
  }
}
