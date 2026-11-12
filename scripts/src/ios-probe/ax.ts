// What a sim point read would report, from the DOM. `describe-ui --point` sees web content (IOS-CHECK.md → Reading the
// page): controls carry their accessible name in AXLabel, toggles their state in AXValue ("1"/"0"), static text its
// text in AXValue with an empty label, and an empty field its placeholder as its value. readPoint runs in the page and
// returns raw facts; toAx maps them, so the mapping is tested without a browser.

export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Facts {
  kind: 'field' | 'toggle' | 'button' | 'link' | 'text';
  multiline: boolean;
  name: string;
  value: string;
  placeholder: string;
  pressed: boolean;
  disabled: boolean;
  frame: Frame;
}
export interface AxEl {
  role: string;
  label: string;
  value: string;
  enabled: boolean;
  frame: Frame;
}

export function toAx(f: Facts): AxEl {
  const base = { enabled: !f.disabled, frame: f.frame };
  switch (f.kind) {
    case 'field':
      return {
        ...base,
        role: f.multiline ? 'AXTextArea' : 'AXTextField',
        label: f.name,
        value: f.value || f.placeholder,
      };
    case 'toggle':
      return { ...base, role: 'AXCheckBox', label: f.name, value: f.pressed ? '1' : '0' };
    case 'button':
      return { ...base, role: 'AXButton', label: f.name, value: '' };
    case 'link':
      return { ...base, role: 'AXLink', label: f.name, value: '' };
    case 'text':
      return { ...base, role: 'AXStaticText', label: '', value: f.value };
  }
}

// sim.sh → sim_match: label or value starts with `label` (case-insensitive, leading space ignored); role when given.
export function matches(e: AxEl | null, label: string, role?: string): boolean {
  if (!e?.role || (role && e.role !== role)) return false;
  const w = label.toLowerCase();
  return [e.label, e.value].some((s) => s.toLowerCase().replace(/^\s+/, '').startsWith(w));
}

// A control is what a stray tap or read-back would act on; static text isn't.
export const isControl = (e: AxEl | null): e is AxEl => !!e && e.role !== 'AXStaticText';

// What a miss names: the label, or the value when there is none (as sim.sh's `seen`).
export const seenAs = (e: AxEl | null): string =>
  e ? `${(e.label || e.value).slice(0, 24)} (${e.role})` : 'nothing';

// The DOM slice readPoint uses: scripts compiles without the DOM lib (it runs in node), and this module-scoped
// declaration keeps it so; readPoint itself only ever runs in the page.
interface DomNode {
  nodeType: number;
  textContent: string | null;
}
interface DomEl extends DomNode {
  tagName: string;
  childNodes: ArrayLike<DomNode> & Iterable<DomNode>;
  parentElement: DomEl | null;
  innerText: string;
  value?: string;
  type?: string;
  checked?: boolean;
  disabled?: boolean;
  labels?: ArrayLike<DomEl> | null;
  control?: DomEl | null;
  closest(sel: string): DomEl | null;
  matches(sel: string): boolean;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  getBoundingClientRect(): { x: number; y: number; width: number; height: number };
}
declare const document: {
  body: DomEl;
  elementFromPoint(x: number, y: number): DomEl | null;
  getElementById(id: string): DomEl | null;
};

// Runs in the page (serialised by the engine): the element a point read lands on, as Facts, or null for nothing.
export function readPoint([x, y]: [number, number]): Facts | null {
  const CONTROL =
    'button, a[href], textarea, input:not([type=hidden]), select, [role=button], [role=link], [role=checkbox], [role=switch], [role=radio], [role=textbox], [role=tab], [aria-pressed]';
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const at = document.elementFromPoint(x, y);
  if (!at) return null;
  // A label's text hit-tests as its control on iOS (the Reflection box was found at its label's row).
  const el = at.closest(CONTROL) ?? at.closest('label')?.control ?? null;
  const box = (e: DomEl) => {
    const r = e.getBoundingClientRect();
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  };
  if (!el) {
    // innermost element with its own text, walking up from the hit
    for (let e: DomEl | null = at; e && e !== document.body; e = e.parentElement) {
      const own = clean(
        [...e.childNodes]
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent)
          .join(' '),
      );
      if (own)
        return {
          kind: 'text',
          multiline: false,
          name: '',
          value: own,
          placeholder: '',
          pressed: false,
          disabled: false,
          frame: box(e),
        };
    }
    return null;
  }
  const byIds = (ids: string | null) =>
    clean(
      (ids ?? '')
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' '),
    );
  const field = el.matches('textarea, input, select, [role=textbox]');
  const labels = el.labels;
  const name =
    clean(el.getAttribute('aria-label')) ||
    byIds(el.getAttribute('aria-labelledby')) ||
    (labels && labels.length ? clean(labels[0]!.innerText) : '') ||
    (field ? '' : clean(el.innerText)) ||
    clean(el.getAttribute('title'));
  const toggle =
    el.hasAttribute('aria-pressed') ||
    /^(checkbox|switch|radio)$/.test(el.getAttribute('role') ?? '') ||
    (el.tagName === 'INPUT' && /^(checkbox|radio)$/.test(el.type ?? ''));
  const pressed =
    el.getAttribute('aria-pressed') === 'true' ||
    el.getAttribute('aria-checked') === 'true' ||
    (el.tagName === 'INPUT' && el.checked === true);
  const kind = toggle
    ? 'toggle'
    : field
      ? 'field'
      : el.matches('a[href], [role=link]')
        ? 'link'
        : 'button';
  return {
    kind,
    multiline: el.tagName === 'TEXTAREA',
    name,
    value: field ? clean(el.value) : '',
    placeholder: clean(el.getAttribute('placeholder')),
    pressed,
    disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
    frame: box(el),
  };
}
