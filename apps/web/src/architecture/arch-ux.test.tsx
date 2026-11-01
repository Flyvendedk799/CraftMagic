// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FloorStack } from './FloorStack.js';
import { RoomSchedule } from './RoomSchedule.js';
import { Inspector } from './Inspector.js';
import { IssuesPanel } from './IssuesPanel.js';
import { TEMPLATES } from './templates.js';
import type { LayoutPlan, RoomItem } from './plan.js';
import { createPlan } from './plan.js';
import type { PlanIssue } from './validate.js';

afterEach(() => {
  cleanup();
});

describe('FloorStack UI/UX', () => {
  const samplePlan: LayoutPlan = {
    ...createPlan(),
    floors: [
      { id: 'f0', name: 'Ground', items: [{ kind: 'room', id: 'r1', label: 'Living', rect: { x: 0, z: 0, w: 10, d: 8 }, slab: true }] },
      { id: 'f1', name: 'Upper', height: 4, items: [] },
    ],
  };

  it('renders top-down storeys with navigation hint and shortcut key badge', () => {
    const onSelect = vi.fn();
    const onChange = vi.fn();
    const onShowBelow = vi.fn();

    render(
      <FloorStack
        plan={samplePlan}
        active={0}
        showBelow={true}
        onShowBelow={onShowBelow}
        onSelect={onSelect}
        onChange={onChange}
      />
    );

    expect(screen.getByText('Storeys (top down)')).toBeTruthy();
    expect(screen.getByText('[ ] keys')).toBeTruthy();

    // Renders Upper and Ground floors
    expect(screen.getByText('Upper')).toBeTruthy();
    expect(screen.getByText('Ground')).toBeTruthy();

    // Floor 1 has height 4 -> "4b" tag
    expect(screen.getByText('4b')).toBeTruthy();

    // Active floor card for Ground floor
    expect(screen.getByText('Storey 0 · Ground')).toBeTruthy();
  });

  it('allows selecting another storey', () => {
    const onSelect = vi.fn();
    render(
      <FloorStack
        plan={samplePlan}
        active={0}
        showBelow={false}
        onShowBelow={vi.fn()}
        onSelect={onSelect}
        onChange={vi.fn()}
      />
    );

    const upperButton = screen.getByText('Upper').closest('button');
    expect(upperButton).toBeTruthy();
    fireEvent.click(upperButton!);
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it('triggers floor rename and actions', () => {
    const onChange = vi.fn();
    render(
      <FloorStack
        plan={samplePlan}
        active={0}
        showBelow={false}
        onShowBelow={vi.fn()}
        onSelect={vi.fn()}
        onChange={onChange}
      />
    );

    const nameInput = screen.getByLabelText('Name') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Basement' } });
    expect(onChange).toHaveBeenCalled();

    const addBtn = screen.getByRole('button', { name: 'Add above' });
    fireEvent.click(addBtn);
    expect(onChange).toHaveBeenCalled();
  });

  it('toggles reference floor outline below', () => {
    const onShowBelow = vi.fn();
    render(
      <FloorStack
        plan={samplePlan}
        active={1}
        showBelow={false}
        onShowBelow={onShowBelow}
        onSelect={vi.fn()}
        onChange={vi.fn()}
      />
    );

    const checkbox = screen.getByRole('checkbox', { name: /Show storey below as reference/ });
    fireEvent.click(checkbox);
    expect(onShowBelow).toHaveBeenCalledWith(true);
  });
});

describe('RoomSchedule UI/UX', () => {
  const planWithRooms: LayoutPlan = {
    ...createPlan(),
    floors: [
      {
        id: 'f0',
        name: 'Ground',
        items: [
          { kind: 'room', id: 'r1', label: 'Great Hall', rect: { x: 0, z: 0, w: 10, d: 8 }, slab: true },
          { kind: 'room', id: 'r2', label: 'Pantry', rect: { x: 10, z: 0, w: 4, d: 4 }, slab: true },
        ],
      },
      {
        id: 'f1',
        name: 'Upper',
        items: [],
      },
    ],
  };

  it('renders room list with interior walkable dimensions and areas', () => {
    const onSelect = vi.fn();
    render(
      <RoomSchedule
        plan={planWithRooms}
        floorIndex={0}
        selectedId={'r1'}
        onSelect={onSelect}
      />
    );

    expect(screen.getByText('Great Hall')).toBeTruthy();
    expect(screen.getByText('Pantry')).toBeTruthy();

    // Interior dimensions (walls take 1 block on each side)
    // 10x8 room -> 8x6 inside = 48 blocks
    // 4x4 room -> 2x2 inside = 4 blocks
    expect(screen.getByText('8×6')).toBeTruthy();
    expect(screen.getByText('48 b')).toBeTruthy();
    expect(screen.getByText('2×2')).toBeTruthy();
    expect(screen.getByText('4 b')).toBeTruthy();

    // Totals
    expect(screen.getByText('This storey')).toBeTruthy();
    expect(screen.getAllByText('52 b').length).toBe(2);
    expect(screen.getByText('Whole building')).toBeTruthy();
  });

  it('renders clean empty state when storey has no rooms', () => {
    render(
      <RoomSchedule
        plan={planWithRooms}
        floorIndex={1}
        selectedId={null}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByText(/No rooms on this storey yet/)).toBeTruthy();
  });

  it('triggers onSelect when clicking a room row', () => {
    const onSelect = vi.fn();
    render(
      <RoomSchedule
        plan={planWithRooms}
        floorIndex={0}
        selectedId={null}
        onSelect={onSelect}
      />
    );

    fireEvent.click(screen.getByText('Pantry'));
    expect(onSelect).toHaveBeenCalledWith('r2');
  });
});

describe('Inspector UI/UX', () => {
  it('renders structured empty state when nothing is selected', () => {
    render(
      <Inspector
        plan={createPlan()}
        floorIndex={0}
        item={null}
        onChange={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onSendToFloor={vi.fn()}
      />
    );

    expect(screen.getByText('Nothing selected')).toBeTruthy();
    expect(screen.getByText(/Click any room, wall, door, or item/)).toBeTruthy();
    expect(screen.getByText(/Shortcuts:/)).toBeTruthy();
  });

  it('displays kind header, storey tag, and room stat banner when a room is selected', () => {
    const room: RoomItem = {
      kind: 'room',
      id: 'room-1',
      label: 'Solar',
      rect: { x: 2, z: 3, w: 12, d: 8 },
      slab: true,
    };
    const plan: LayoutPlan = {
      ...createPlan(),
      floors: [
        {
          id: 'f0',
          name: 'Ground',
          items: [room],
        },
      ],
    };

    render(
      <Inspector
        plan={plan}
        floorIndex={0}
        item={room}
        onChange={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onSendToFloor={vi.fn()}
      />
    );

    expect(screen.getAllByText('room').length).toBeGreaterThan(0);
    expect(screen.getByText('Ground')).toBeTruthy();
    expect(screen.getByText('Interior Area')).toBeTruthy();
    expect(screen.getByText('Walkable Floor')).toBeTruthy();
    // 12x8 -> interior is 10x6 = 60 blocks
    expect(screen.getByText('60 blocks')).toBeTruthy();
    expect(screen.getByText('10×6')).toBeTruthy();
  });
});

describe('IssuesPanel UI/UX', () => {
  it('renders clear status card when zero issues exist', () => {
    render(<IssuesPanel issues={[]} onGo={vi.fn()} />);

    expect(screen.getByText(/Every room can be walked to/)).toBeTruthy();
  });

  it('renders issue count badge, storey tag, jump affordance and triggers onGo', () => {
    const issues: PlanIssue[] = [
      {
        level: 'warning',
        code: 'no-door',
        message: 'No door into "Cellar"',
        floorIndex: 0,
        itemId: 'cellar-1',
      },
    ];
    const onGo = vi.fn();

    render(<IssuesPanel issues={issues} onGo={onGo} />);

    expect(screen.getByText('1 warning')).toBeTruthy();
    expect(screen.getByText('Click to jump to item')).toBeTruthy();
    expect(screen.getByText('No door into "Cellar"')).toBeTruthy();
    expect(screen.getByText(/Storey\s*0/)).toBeTruthy();
    expect(screen.getByText('→')).toBeTruthy();

    const button = screen.getByRole('button', { name: /No door into "Cellar"/ });
    fireEvent.click(button);
    expect(onGo).toHaveBeenCalledWith(issues[0]);
  });
});

describe('TEMPLATES UI structure', () => {
  it('ensures each template has a name, description, and valid build', () => {
    expect(TEMPLATES.length).toBeGreaterThan(0);
    for (const template of TEMPLATES) {
      expect(template.name.trim()).not.toBe('');
      expect(template.description.trim()).not.toBe('');
      const built = template.build();
      expect(built.floors.length).toBeGreaterThan(0);
      expect(built.kitId).toBeDefined();
    }
  });
});
