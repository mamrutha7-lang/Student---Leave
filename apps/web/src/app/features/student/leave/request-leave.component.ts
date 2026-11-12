/**
 * Request leave — the student's form. It goes to their mentor, or to the
 * placement office when they have none; the server decides which, and the
 * Send button says where (`/leaves/mine/approver`).
 *
 * ONE call (2026-11-12): `POST /leaves/student` carries the request and its
 * supporting document together, and the server saves both or neither. Medical
 * leave needs the document; Casual and On official duty may go without. The
 * file is copied into memory when it is picked (`readPickedFile`), so a phone
 * that loses access to it before Send cannot fail the upload halfway.
 *
 * The rules (which types, no overlapping dates, to-date not before
 * from-date) are the server's; the checks here only save a round trip, and a
 * refusal is shown in the server's own words.
 */

import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import {
  LeaveRoute,
  STUDENT_LEAVE_KINDS,
  StudentLeaveKind,
  documentRequired,
  leaveApi,
  leaveKindLabel,
  leaveTotalDays,
  submitStudentLeave,
} from '../../../core/leave';

export const DOCUMENT_REQUIRED_MESSAGE =
  'Medical leave needs a supporting document. Attach your medical certificate.';
import { UNREADABLE_FILE_MESSAGE, readPickedFile } from '../../../core/picked-file';

/** The same cap the server applies to one stored document (document_store.MAX_BYTES). */
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

@Component({
  selector: 'app-request-leave',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './request-leave.component.html',
  styleUrl: './leave.scss',
})
export class RequestLeaveComponent {
  private readonly router = inject(Router);

  readonly kinds = STUDENT_LEAVE_KINDS;
  readonly kindLabel = leaveKindLabel;

  readonly route = signal<LeaveRoute | null>(null);
  readonly kind = signal<StudentLeaveKind | ''>('');
  readonly fromDate = signal('');
  readonly toDate = signal('');
  readonly reason = signal('');
  readonly file = signal<File | null>(null);
  readonly sending = signal(false);
  readonly error = signal<string | null>(null);

  /** Set when Send was pressed on a medical request with no file, so the
   *  message sits on the document field itself. */
  readonly documentError = signal<string | null>(null);

  readonly totalDays = computed(() => leaveTotalDays(this.fromDate(), this.toDate()));
  readonly needsDocument = computed(() => documentRequired(this.kind()));
  readonly sendLabel = computed(() =>
    this.route()?.routed_to === 'OFFICE' ? 'Send to placement office' : 'Send to mentor',
  );
  readonly subtitle = computed(() =>
    this.route()?.routed_to === 'OFFICE'
      ? 'You have no mentor yet, so your request goes to the placement office'
      : 'Your request goes to your mentor',
  );

  constructor() {
    void this.loadRoute();
  }

  private async loadRoute(): Promise<void> {
    try {
      this.route.set(await leaveApi.myRoute());
    } catch {
      // The button falls back to "Send to mentor"; the server routes the
      // request correctly either way, so this read failing blocks nothing.
    }
  }

  value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;
  }

  setKind(event: Event): void {
    this.kind.set(this.value(event) as StudentLeaveKind | '');
    if (!this.needsDocument()) this.documentError.set(null);
  }

  async pickFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const picked = input.files?.[0] ?? null;
    input.value = '';
    if (!picked) return;
    this.error.set(null);
    if (picked.size > MAX_DOCUMENT_BYTES) {
      this.error.set('That file is larger than 10 MB. Choose a smaller PDF or photo.');
      return;
    }
    const copy = await readPickedFile(picked);
    if (copy === null) {
      this.error.set(UNREADABLE_FILE_MESSAGE);
      return;
    }
    this.file.set(copy);
    this.documentError.set(null);
  }

  removeFile(): void {
    this.file.set(null);
  }

  /** What is missing, in one sentence, or null when the form can be sent. */
  private problem(): string | null {
    if (!this.kind()) return 'Choose the type of leave.';
    if (!this.fromDate() || !this.toDate()) return 'Choose the first and last day of your leave.';
    if (this.toDate() < this.fromDate()) return 'The last day cannot be before the first day.';
    if (!this.reason().trim()) return 'Tell your mentor why you need leave.';
    if (this.needsDocument() && !this.file()) return DOCUMENT_REQUIRED_MESSAGE;
    return null;
  }

  async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.sending()) return;
    const problem = this.problem();
    if (problem) {
      this.error.set(problem);
      this.documentError.set(problem === DOCUMENT_REQUIRED_MESSAGE ? problem : null);
      if (problem === DOCUMENT_REQUIRED_MESSAGE) {
        document.getElementById('leave-document')?.focus();
      }
      return;
    }
    this.sending.set(true);
    this.error.set(null);
    this.documentError.set(null);
    try {
      // One call: the request and its document are saved together or not at
      // all, so a failure here means nothing was sent and the form is intact.
      await submitStudentLeave(
        {
          leave_kind: this.kind() as StudentLeaveKind,
          from_date: this.fromDate(),
          to_date: this.toDate(),
          reason: this.reason().trim(),
        },
        this.file(),
      );
      await this.router.navigate(['/student/leave'], {
        queryParams: { sent: this.route()?.routed_to ?? 'MENTOR' },
      });
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.sending.set(false);
    }
  }
}
