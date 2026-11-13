import { describe, expect, it } from 'vitest';
import { isControl, matches, seenAs, toAx, type Facts } from './ax';

const frame = { x: 0, y: 0, w: 10, h: 10 };
const facts = (f: Partial<Facts>): Facts => ({
  kind: 'button',
  multiline: false,
  name: '',
  value: '',
  placeholder: '',
  pressed: false,
  disabled: false,
  frame,
  ...f,
});

describe('toAx', () => {
  it('maps a field: its name the label, its placeholder the value while empty', () => {
    expect(
      toAx(
        facts({
          kind: 'field',
          multiline: true,
          name: 'Capture log',
          placeholder: 'What happened?',
        }),
      ),
    ).toMatchObject({
      role: 'AXTextArea',
      label: 'Capture log',
      value: 'What happened?',
    });
    expect(
      toAx(facts({ kind: 'field', name: 'Search tasks', value: 'rewrit', placeholder: 'Search…' })),
    ).toMatchObject({
      role: 'AXTextField',
      value: 'rewrit',
    });
  });

  it('maps a toggle to a checkbox whose value is its state, static text to an unlabelled value', () => {
    expect(toAx(facts({ kind: 'toggle', name: 'private', pressed: true }))).toMatchObject({
      role: 'AXCheckBox',
      label: 'private',
      value: '1',
    });
    expect(toAx(facts({ kind: 'toggle', name: 'Log' })).value).toBe('0');
    expect(toAx(facts({ kind: 'text', value: 'vacuum' }))).toMatchObject({
      role: 'AXStaticText',
      label: '',
      value: 'vacuum',
    });
  });

  it('carries enabled and the role of buttons and links', () => {
    expect(toAx(facts({ kind: 'button', name: 'Save log', disabled: true }))).toMatchObject({
      role: 'AXButton',
      enabled: false,
    });
    expect(toAx(facts({ kind: 'link', name: 'Tasks' })).role).toBe('AXLink');
  });
});

describe('matches (sim.sh → sim_match)', () => {
  const bar = toAx(
    facts({ kind: 'field', multiline: true, name: 'Capture log', placeholder: 'What happened?' }),
  );
  it('takes a case-insensitive prefix of the label or the value', () => {
    expect(matches(bar, 'capture')).toBe(true);
    expect(matches(bar, 'What hap')).toBe(true);
    expect(matches(bar, 'log')).toBe(false);
  });
  it('ignores leading space and checks the role when given', () => {
    expect(
      matches(toAx(facts({ kind: 'text', value: '  vacuum' })), 'vacuum', 'AXStaticText'),
    ).toBe(true);
    expect(matches(bar, 'Capture', 'AXButton')).toBe(false);
    expect(matches(null, 'Capture')).toBe(false);
  });
});

describe('isControl and seenAs', () => {
  it('counts everything but static text as a control, and names what a point saw', () => {
    expect(isControl(toAx(facts({ kind: 'toggle', name: 'private' })))).toBe(true);
    expect(isControl(toAx(facts({ kind: 'text', value: 'x' })))).toBe(false);
    expect(seenAs(toAx(facts({ kind: 'toggle', name: 'private' })))).toBe('private (AXCheckBox)');
    expect(seenAs(null)).toBe('nothing');
  });
});
