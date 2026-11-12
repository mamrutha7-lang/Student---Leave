import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';

import { DOCUMENT_REQUIRED_MESSAGE, RequestLeaveComponent } from './request-leave.component';

/**
 * Request leave (2026-11-12): medical leave is sent only with its supporting
 * document, and the request and the document travel in ONE call to
 * `POST /leaves/student`, so the server saves both or neither.
 */
const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);

function pickedFile(name: string): File {
  return {
    name,
    type: 'application/pdf',
    size: pdf.byteLength,
    lastModified: 1,
    arrayBuffer: () => Promise.resolve(pdf.buffer.slice(0)),
  } as unknown as File;
}

function picked(file: File): Event {
  return { target: { files: [file], value: 'C:\\fakepath\\' + file.name } } as unknown as Event;
}

function chose(value: string): Event {
  return { target: { value } } as unknown as Event;
}

const submitEvent = { preventDefault: () => undefined } as unknown as Event;

describe('Request leave · the supporting document', () => {
  const realFetch = globalThis.fetch;
  let posts: { url: string; body: FormData }[];

  async function form(): Promise<RequestLeaveComponent> {
    posts = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push({ url, body: init.body as FormData });
        return { ok: true, status: 201, json: async () => ({ id: 'L1', status: 'SUBMITTED' }) } as Response;
      }
      // "Who decides my leave": the mentor.
      return {
        ok: true,
        status: 200,
        json: async () => ({ name: 'S', usn: null, course: null, mentor_name: 'M', routed_to: 'MENTOR' }),
      } as Response;
    }) as typeof fetch;
    await TestBed.configureTestingModule({
      imports: [RequestLeaveComponent],
      providers: [provideRouter([])],
    }).compileComponents();
    const c = TestBed.createComponent(RequestLeaveComponent).componentInstance;
    vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    c.fromDate.set('2026-12-14');
    c.toDate.set('2026-12-15');
    c.reason.set('Fever, two days of rest.');
    return c;
  }

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('marks the document required only for medical leave', async () => {
    const c = await form();
    c.setKind(chose('MEDICAL'));
    expect(c.needsDocument()).toBe(true);
    c.setKind(chose('CASUAL'));
    expect(c.needsDocument()).toBe(false);
    c.setKind(chose('OOD'));
    expect(c.needsDocument()).toBe(false);
  });

  it('does not send medical leave without a document, and says so on the field', async () => {
    const c = await form();
    c.setKind(chose('MEDICAL'));
    await c.submit(submitEvent);

    expect(posts).toHaveLength(0);
    expect(c.error()).toBe(DOCUMENT_REQUIRED_MESSAGE);
    expect(c.documentError()).toBe(DOCUMENT_REQUIRED_MESSAGE);
  });

  it('clears the message once a document is chosen', async () => {
    const c = await form();
    c.setKind(chose('MEDICAL'));
    await c.submit(submitEvent);
    await c.pickFile(picked(pickedFile('certificate.pdf')));
    expect(c.documentError()).toBeNull();
  });

  it('sends medical leave and its document together, in one call', async () => {
    const c = await form();
    c.setKind(chose('MEDICAL'));
    await c.pickFile(picked(pickedFile('certificate.pdf')));
    await c.submit(submitEvent);

    expect(posts).toHaveLength(1);
    expect(posts[0].url).toMatch(/\/leaves\/student$/);
    expect(posts[0].body.get('leave_kind')).toBe('MEDICAL');
    expect((posts[0].body.get('file') as File).name).toBe('certificate.pdf');
    expect(c.error()).toBeNull();
  });

  it('sends casual leave with no document', async () => {
    const c = await form();
    c.setKind(chose('CASUAL'));
    await c.submit(submitEvent);

    expect(posts).toHaveLength(1);
    expect(posts[0].body.get('leave_kind')).toBe('CASUAL');
    expect(posts[0].body.has('file')).toBe(false);
  });
});
