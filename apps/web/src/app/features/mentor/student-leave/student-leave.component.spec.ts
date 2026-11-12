import { TestBed } from '@angular/core/testing';

import { MenteeLeaveRow } from '../../../core/leave';
import { StudentLeaveComponent } from './student-leave.component';

/**
 * Student leave requests (2026-11-12): rejecting needs a reason, and the
 * mentor confirms before the rejection is sent. Keep backs out with nothing
 * sent; editing the reason drops the confirmation.
 */
const row: MenteeLeaveRow = {
  id: 'L1',
  from_date: '2026-12-14',
  to_date: '2026-12-15',
  reason: 'Fever',
  status: 'SUBMITTED',
  leave_kind: 'MEDICAL',
  requester_name: 'Asha Rao',
  director_name: null,
  director_note: null,
  requester_usn: null,
  attachments: [],
};

describe('Student leave requests · rejecting', () => {
  const realFetch = globalThis.fetch;
  let decisions: { decision: string; note: string | null }[];

  async function screen(): Promise<StudentLeaveComponent> {
    decisions = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/decision')) {
        decisions.push(JSON.parse(String(init?.body)));
        return { ok: true, status: 200, json: async () => ({ ...row, status: 'REJECTED' }) } as Response;
      }
      return { ok: true, status: 200, json: async () => [row] } as Response;
    }) as typeof fetch;
    await TestBed.configureTestingModule({ imports: [StudentLeaveComponent] }).compileComponents();
    const c = TestBed.createComponent(StudentLeaveComponent).componentInstance;
    await c.load();
    return c;
  }

  /** Let the decision's promise chain settle. */
  const settle = () => new Promise((resolve) => setTimeout(resolve));

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('asks for a reason first, and sends nothing', async () => {
    const c = await screen();
    c.reject(row);

    expect(c.open()).toBe('L1');
    expect(c.noteError()).toContain('Give a reason');
    expect(c.confirmingReject()).toBeNull();
    expect(decisions).toHaveLength(0);
  });

  it('with a reason, asks to confirm instead of rejecting straight away', async () => {
    const c = await screen();
    c.toggle(row);
    c.setNote('Internal exam on these dates.');
    c.reject(row);

    expect(c.confirmingReject()).toBe('L1');
    expect(decisions).toHaveLength(0);
  });

  it('Keep backs out with nothing sent', async () => {
    const c = await screen();
    c.toggle(row);
    c.setNote('Internal exam on these dates.');
    c.reject(row);
    c.keepRequest();

    expect(c.confirmingReject()).toBeNull();
    expect(decisions).toHaveLength(0);
  });

  it('Confirm reject sends the rejection with the reason on screen', async () => {
    const c = await screen();
    c.toggle(row);
    c.setNote('Internal exam on these dates.');
    c.reject(row);
    c.confirmReject(row);
    await settle();

    expect(decisions).toEqual([{ decision: 'REJECT', note: 'Internal exam on these dates.' }]);
    expect(c.confirmingReject()).toBeNull();
  });

  it('editing the reason drops the confirmation', async () => {
    const c = await screen();
    c.toggle(row);
    c.setNote('Internal exam.');
    c.reject(row);
    c.setNote('Internal exam on these dates.');

    expect(c.confirmingReject()).toBeNull();
    expect(decisions).toHaveLength(0);
  });

  it('approving needs no confirmation', async () => {
    const c = await screen();
    c.approve(row);
    await settle();

    expect(decisions).toEqual([{ decision: 'APPROVE', note: null }]);
  });
});
