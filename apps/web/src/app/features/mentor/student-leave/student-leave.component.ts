/**
 * Student leave requests — the mentor's queue of their mentees' leave
 * (2026-11-05).
 *
 * `GET /leaves/mentees?status=` lists only this mentor's own mentees, and
 * Approve / Reject go through the ordinary `/leaves/{id}/decision`; the
 * server is what keeps a mentor to their own mentees (and the Main Admin out
 * of a mentored student's request). The reason and any supporting document
 * open on the row, with a note to the student: required to reject (the
 * server refuses a blank one too), optional to approve (2026-11-06).
 *
 * REJECTING IS CONFIRMED (2026-11-12). With a reason typed, Reject does not
 * send anything: it turns the row's buttons into Keep / Confirm reject, the
 * same pattern My leave uses for Withdraw, and only Confirm records it.
 * Editing the reason, opening another row or switching tabs drops the
 * confirmation, so what is confirmed is always the reason on screen.
 */

import { Component, signal } from '@angular/core';

import {
  MenteeLeaveRow,
  MenteeQueueTab,
  initials,
  isPending,
  leaveApi,
  leaveDateRange,
  leaveDocumentUrl,
  leaveKindLabel,
  leaveStatusLabel,
  leaveStatusTone,
} from '../../../core/leave';

const TABS: { key: MenteeQueueTab; label: string }[] = [
  { key: 'PENDING', label: 'Pending' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'REJECTED', label: 'Rejected' },
];

@Component({
  selector: 'app-student-leave',
  standalone: true,
  templateUrl: './student-leave.component.html',
  styleUrl: './student-leave.component.scss',
})
export class StudentLeaveComponent {
  readonly tabs = TABS;
  readonly kindLabel = leaveKindLabel;
  readonly statusLabel = leaveStatusLabel;
  readonly statusTone = leaveStatusTone;
  readonly dateRange = leaveDateRange;
  readonly initials = initials;
  readonly isPending = isPending;
  readonly documentUrl = leaveDocumentUrl;

  readonly tab = signal<MenteeQueueTab>('PENDING');
  readonly rows = signal<MenteeLeaveRow[]>([]);
  /** How many are waiting, for the Pending tab's count. */
  readonly pendingCount = signal<number | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);
  /** The row being decided, so only its buttons wait. */
  readonly deciding = signal<string | null>(null);
  /** The row whose reason and documents are open. */
  readonly open = signal<string | null>(null);
  /** The note to the student on the open row. */
  readonly note = signal('');
  readonly noteError = signal<string | null>(null);
  /** The row waiting for "Confirm reject", or null. */
  readonly confirmingReject = signal<string | null>(null);

  constructor() {
    void this.load();
  }

  async show(tab: MenteeQueueTab): Promise<void> {
    if (tab === this.tab()) return;
    this.tab.set(tab);
    this.open.set(null);
    this.confirmingReject.set(null);
    this.notice.set(null);
    await this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const rows = await leaveApi.menteeQueue(this.tab());
      this.rows.set(rows);
      if (this.tab() === 'PENDING') this.pendingCount.set(rows.length);
      else if (this.pendingCount() === null) {
        this.pendingCount.set((await leaveApi.menteeQueue('PENDING')).length);
      }
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.loading.set(false);
    }
  }

  toggle(row: MenteeLeaveRow): void {
    this.open.update((id) => (id === row.id ? null : row.id));
    this.note.set('');
    this.noteError.set(null);
    this.confirmingReject.set(null);
  }

  /** The note box changed: clear its error, and any confirmation given for
   *  the reason it held before. */
  setNote(value: string): void {
    this.note.set(value);
    this.noteError.set(null);
    this.confirmingReject.set(null);
  }

  /** Reject needs a reason: with none typed, open the row at the note box.
   *  With one, ask for confirmation; `confirmReject` sends it. */
  reject(row: MenteeLeaveRow): void {
    const typed = this.open() === row.id ? this.note().trim() : '';
    if (typed) {
      this.noteError.set(null);
      this.confirmingReject.set(row.id);
      return;
    }
    this.confirmingReject.set(null);
    if (this.open() !== row.id) {
      this.open.set(row.id);
      this.note.set('');
    }
    this.noteError.set('Give a reason to reject this request. The student reads it.');
    setTimeout(() => document.getElementById(`leave-note-${row.id}`)?.focus());
  }

  /** "Confirm reject": send the rejection with the reason on screen. */
  confirmReject(row: MenteeLeaveRow): void {
    const typed = this.open() === row.id ? this.note().trim() : '';
    if (this.confirmingReject() !== row.id || !typed) {
      // The reason went away under the confirmation: ask for it again.
      this.reject(row);
      return;
    }
    void this.decide(row, 'REJECT', typed);
  }

  /** "Keep": back out of the confirmation; nothing was sent. */
  keepRequest(): void {
    this.confirmingReject.set(null);
  }

  approve(row: MenteeLeaveRow): void {
    this.confirmingReject.set(null);
    const typed = this.open() === row.id ? this.note().trim() : '';
    void this.decide(row, 'APPROVE', typed || null);
  }

  private async decide(row: MenteeLeaveRow, decision: 'APPROVE' | 'REJECT', note: string | null): Promise<void> {
    if (this.deciding()) return;
    this.deciding.set(row.id);
    this.error.set(null);
    this.notice.set(null);
    this.noteError.set(null);
    try {
      await leaveApi.decide(row.id, decision, note);
      this.open.set(null);
      this.note.set('');
      const verb = decision === 'APPROVE' ? 'approved' : 'rejected';
      this.notice.set(`${row.requester_name}'s ${leaveKindLabel(row.leave_kind).toLowerCase()} leave was ${verb}.`);
      this.pendingCount.set(null);
      await this.load();
    } catch (e) {
      // Another tab, or the student withdrawing it, can settle a row first:
      // the server's sentence says so, and the list is refreshed to match.
      this.error.set((e as Error).message);
      await this.load();
    } finally {
      this.deciding.set(null);
      this.confirmingReject.set(null);
    }
  }
}
