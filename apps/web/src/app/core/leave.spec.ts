import { UPLOAD_DROPPED_MESSAGE } from './picked-file';
import {
  STUDENT_LEAVE_KINDS,
  documentRequired,
  initials,
  isPending,
  leaveDateRange,
  leaveKindLabel,
  leaveStatusLabel,
  leaveStatusTone,
  leaveTotalDays,
  studentLeaveForm,
  submitStudentLeave,
} from './leave';

describe('leave helpers', () => {
  it('offers students exactly the three types the server accepts, in order', () => {
    expect([...STUDENT_LEAVE_KINDS]).toEqual(['MEDICAL', 'CASUAL', 'OOD']);
    expect(STUDENT_LEAVE_KINDS.map(leaveKindLabel)).toEqual(['Medical', 'Casual', 'On official duty']);
    expect(leaveKindLabel(null)).toBe('Leave');
  });

  it('counts both ends of the span, across a month and a year', () => {
    expect(leaveTotalDays('2026-11-04', '2026-11-06')).toBe(3);
    expect(leaveTotalDays('2026-11-06', '2026-11-06')).toBe(1);
    expect(leaveTotalDays('2026-11-30', '2026-12-02')).toBe(3);
    expect(leaveTotalDays('2026-12-31', '2027-01-01')).toBe(2);
  });

  it('gives no count for a missing or backwards span', () => {
    expect(leaveTotalDays('', '2026-11-06')).toBe(0);
    expect(leaveTotalDays('2026-11-06', '2026-11-04')).toBe(0);
  });

  it('writes the dates the way the design does', () => {
    expect(leaveDateRange('2026-11-04', '2026-11-06')).toBe('04–06 Nov 2026');
    expect(leaveDateRange('2026-11-06', '2026-11-06')).toBe('06 Nov 2026');
    expect(leaveDateRange('2026-11-30', '2026-12-02')).toBe('30 Nov – 02 Dec 2026');
    expect(leaveDateRange('2026-12-28', '2027-01-02')).toBe('28 Dec 2026 – 02 Jan 2027');
  });

  it('names every status in words and pairs it with a tone', () => {
    expect(leaveStatusLabel('SUBMITTED')).toBe('Pending');
    expect(leaveStatusLabel('FIRST_APPROVED')).toBe('Pending');
    expect(leaveStatusLabel('CANCELLED')).toBe('Withdrawn');
    expect(leaveStatusTone('APPROVED')).toBe('good');
    expect(leaveStatusTone('SUBMITTED')).toBe('warn');
    expect(leaveStatusTone('REJECTED')).toBe('risk');
    expect(leaveStatusTone('CANCELLED')).toBe('neutral');
    expect(isPending('FIRST_APPROVED')).toBe(true);
    expect(isPending('APPROVED')).toBe(false);
  });

  it('makes two-letter initials', () => {
    expect(initials('Priya S')).toBe('PS');
    expect(initials('Asha Rao')).toBe('AR');
    expect(initials('Rakshita')).toBe('RA');
  });
});

describe('sending a student request with its document (2026-11-12)', () => {
  const realFetch = globalThis.fetch;
  const body = {
    leave_kind: 'MEDICAL' as const,
    from_date: '2026-12-14',
    to_date: '2026-12-15',
    reason: 'Fever',
  };
  const certificate = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'certificate.pdf', {
    type: 'application/pdf',
  });
  let calls: { url: string; init?: RequestInit }[];

  function answer(response: Partial<Response> | Error): void {
    calls = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (response instanceof Error) throw response;
      return response as Response;
    }) as typeof fetch;
  }

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('asks for a document for medical leave only', () => {
    expect(documentRequired('MEDICAL')).toBe(true);
    expect(documentRequired('CASUAL')).toBe(false);
    expect(documentRequired('OOD')).toBe(false);
    expect(documentRequired('')).toBe(false);
  });

  it('puts the four fields and the file in one form', () => {
    const form = studentLeaveForm(body, certificate);
    expect(form.get('leave_kind')).toBe('MEDICAL');
    expect(form.get('from_date')).toBe('2026-12-14');
    expect(form.get('to_date')).toBe('2026-12-15');
    expect(form.get('reason')).toBe('Fever');
    expect((form.get('file') as File).name).toBe('certificate.pdf');
    expect(studentLeaveForm({ ...body, leave_kind: 'CASUAL' }, null).has('file')).toBe(false);
  });

  it('sends the request and the document in ONE call', async () => {
    answer({ ok: true, status: 201, json: async () => ({ id: 'L1', status: 'SUBMITTED' }) });
    const created = await submitStudentLeave(body, certificate);
    expect(created.id).toBe('L1');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/leaves\/student$/);
    expect(calls[0].init?.method).toBe('POST');
    expect((calls[0].init?.body as FormData).get('file')).toBeInstanceOf(File);
  });

  it("shows the server's sentence when it refuses", async () => {
    answer({
      ok: false,
      status: 422,
      json: async () => ({ detail: 'Medical leave needs a supporting document.' }),
    });
    await expect(submitStudentLeave(body, null)).rejects.toThrow('Medical leave needs a supporting document.');
  });

  it('says the connection dropped, not "Failed to fetch"', async () => {
    answer(new TypeError('Failed to fetch'));
    await expect(submitStudentLeave(body, certificate)).rejects.toThrow(UPLOAD_DROPPED_MESSAGE);
  });
});
