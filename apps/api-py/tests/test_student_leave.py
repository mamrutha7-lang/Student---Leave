"""A student's leave goes to their mentor, and only their mentor decides it
(2026-11-05, the owner's decision).

What this module holds down:

1. A STUDENT WITH AN ACTIVE MENTOR: the mentor sees the request in
   `GET /leaves/mentees`, decides it through the ordinary `/decision`, and
   signs as MENTOR. Another mentor, the Main Admin and a delegate of the
   office are all refused with the 404 an invented id gets, and the office's
   queues do not list it.
2. A STUDENT WITH NO MENTOR: the request is the office's, exactly as before.
3. THE ROUTE FOLLOWS THE STUDENT. Moving a student to another mentor moves
   their pending request with them; it is read from `students.mentor_id`,
   never stored on the request.
4. THE STUDENT'S FORM: a leave type is required and is Medical, Casual or On
   official duty; two live requests for one day are refused; the student
   withdraws their own pending request; the supporting document reaches the
   mentor.
5. MEDICAL LEAVE AND ITS DOCUMENT (2026-11-12): a medical request is sent only
   with its document, through `POST /leaves/student`, which saves the two in
   one transaction — a refused file or a failed commit leaves no request and
   no bytes behind — and the last document on a pending medical request
   cannot be removed by anybody, the Main Admin included.
"""

from __future__ import annotations

import pytest
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from conftest import APPLICATION_CV, requires_db

from app import document_store
from app.db import SessionLocal
from app.models.leave import LeaveRequest
from app.models.leave_attachment import LeaveAttachment
from app.models.user import Mentor, Role, Student, User
from app.routers import leave_attachments

LEAVES = "/api/leaves"
STUDENT_DOOR = f"{LEAVES}/student"
APPROVE = {"decision": "APPROVE", "note": None}
MEDICAL_FORM = {
    "from_date": "2026-12-14",
    "to_date": "2026-12-15",
    "reason": "Fever, the doctor advised two days of rest.",
    "leave_kind": "MEDICAL",
}


def _student_id(user_id: str) -> str:
    with SessionLocal() as db:
        return db.scalar(select(Student.id).where(Student.user_id == user_id))


def _seat(student_user_id: str, mentor_user_id: str) -> None:
    """Make `mentor_user_id` this student's mentor, creating their group the
    first time, as Assign faculty does."""
    with SessionLocal() as db:
        group = db.scalar(select(Mentor).where(Mentor.user_id == mentor_user_id))
        if group is None:
            group = Mentor(user_id=mentor_user_id)
            db.add(group)
            db.flush()
        db.scalar(select(Student).where(Student.user_id == student_user_id)).mentor_id = group.id
        db.commit()


def _unseat(student_user_id: str) -> None:
    with SessionLocal() as db:
        db.scalar(select(Student).where(Student.user_id == student_user_id)).mentor_id = None
        db.commit()


def _submit(client, headers, **extra) -> dict:
    """A request through the JSON door. CASUAL by default: a student's MEDICAL
    request needs its document and goes through `_submit_medical`."""
    body = {
        "from_date": "2026-12-14",
        "to_date": "2026-12-15",
        "reason": "Family function out of town.",
        "leave_kind": "CASUAL",
    }
    body.update(extra)
    r = client.post(LEAVES, headers=headers, json=body)
    assert r.status_code == 201, r.text
    return r.json()


def _submit_medical(client, headers, **extra) -> dict:
    """A MEDICAL request and its certificate, in one call."""
    r = client.post(
        STUDENT_DOOR,
        headers=headers,
        data={**MEDICAL_FORM, **extra},
        files={"file": ("certificate.pdf", APPLICATION_CV, "application/pdf")},
    )
    assert r.status_code == 201, r.text
    return r.json()


def _counts(user_id: str) -> tuple[int, int]:
    """(leave requests, attachments) this account has."""
    with SessionLocal() as db:
        requests = db.scalar(
            select(func.count(LeaveRequest.id)).where(LeaveRequest.requester_user_id == user_id)
        )
        files = db.scalar(
            select(func.count(LeaveAttachment.id)).where(
                LeaveAttachment.uploaded_by_user_id == user_id
            )
        )
        return requests or 0, files or 0


def _attachments(leave_id: str) -> list[LeaveAttachment]:
    with SessionLocal() as db:
        return list(
            db.scalars(
                select(LeaveAttachment).where(LeaveAttachment.leave_request_id == leave_id)
            ).all()
        )


def _ids(response) -> set[str]:
    assert response.status_code == 200, response.text
    return {row["id"] for row in response.json()}


@pytest.fixture
def people(make_user):
    """A student, their mentor, another mentor (with a mentee of their own, so
    they hold `mentor.mentees`), and the Main Admin."""
    student = make_user("sl-stu", Role.STUDENT)
    mentor = make_user("sl-men", Role.MENTOR)
    other = make_user("sl-oth", Role.MENTOR)
    others_mentee = make_user("sl-om", Role.STUDENT)
    office = make_user("sl-adm", Role.ADMIN)
    _seat(student.user_id, mentor.user_id)
    _seat(others_mentee.user_id, other.user_id)
    yield {"student": student, "mentor": mentor, "other": other, "office": office}
    with SessionLocal() as db:
        # The bytes first: the rows cascade with their request, and a row is
        # the last pointer to its file.
        for name in db.scalars(
            select(LeaveAttachment.stored_name)
            .join(LeaveRequest, LeaveRequest.id == LeaveAttachment.leave_request_id)
            .where(LeaveRequest.requester_user_id.in_([student.user_id, others_mentee.user_id]))
        ).all():
            document_store.delete(name)
        db.execute(
            delete(LeaveRequest).where(
                LeaveRequest.requester_user_id.in_([student.user_id, others_mentee.user_id])
            )
        )
        db.commit()


@requires_db
def test_the_mentor_decides_their_mentees_leave_and_nobody_else_can(client, people):
    student, mentor, other, office = (
        people["student"], people["mentor"], people["other"], people["office"]
    )
    leave_id = _submit(client, student.headers)["id"]

    # The mentor's queue has it; the other mentor's and the office's do not.
    assert leave_id in _ids(client.get(f"{LEAVES}/mentees", headers=mentor.headers))
    assert leave_id not in _ids(client.get(f"{LEAVES}/mentees", headers=other.headers))
    assert leave_id not in _ids(client.get(f"{LEAVES}/pending", headers=office.headers))

    # Everybody but the mentor gets the answer an invented id gets.
    invented = client.post(f"{LEAVES}/no-such-leave/decision", headers=other.headers, json=APPROVE)
    for headers in (other.headers, office.headers):
        refused = client.post(f"{LEAVES}/{leave_id}/decision", headers=headers, json=APPROVE)
        assert refused.status_code == 404, refused.text
        assert refused.json() == invented.json()
    # Nor may the office change a decision on it, or read its paper.
    assert client.post(
        f"{LEAVES}/{leave_id}/change-decision",
        headers=office.headers,
        json={"action": "REVOKE", "reason": "testing"},
    ).status_code == 404
    assert client.get(f"{LEAVES}/{leave_id}/paper.pdf", headers=office.headers).status_code == 404

    done = client.post(f"{LEAVES}/{leave_id}/decision", headers=mentor.headers, json=APPROVE)
    assert done.status_code == 200, done.text
    assert done.json()["status"] == "APPROVED"
    assert done.json()["first_signed_as"] == "MENTOR"
    assert done.json()["director_name"] == "Voice Test sl-men"

    assert leave_id not in _ids(client.get(f"{LEAVES}/mentees", headers=mentor.headers))
    assert leave_id in _ids(
        client.get(f"{LEAVES}/mentees", params={"status": "APPROVED"}, headers=mentor.headers)
    )
    mine = client.get(f"{LEAVES}/mine", headers=student.headers).json()
    assert [row["status"] for row in mine if row["id"] == leave_id] == ["APPROVED"]


@requires_db
def test_the_mentor_rejects_with_a_reason_the_student_reads(client, people):
    """A rejection needs a reason (2026-11-06): none, or only spaces, is a 422
    and the request stays pending; with one, the student reads it on
    `/leaves/mine`."""
    student, mentor = people["student"], people["mentor"]
    leave_id = _submit(client, student.headers, leave_kind="CASUAL")["id"]
    url = f"{LEAVES}/{leave_id}/decision"

    for body in ({"decision": "REJECT"}, {"decision": "REJECT", "note": "   "}):
        refused = client.post(url, headers=mentor.headers, json=body)
        assert refused.status_code == 422, refused.text
        assert "reason" in refused.json()["detail"]
    assert leave_id in _ids(client.get(f"{LEAVES}/mentees", headers=mentor.headers))

    reason = "Internal exam on these dates; apply for the following week."
    r = client.post(url, headers=mentor.headers, json={"decision": "REJECT", "note": reason})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "REJECTED"
    mine = client.get(f"{LEAVES}/mine", headers=student.headers).json()
    assert [row["director_note"] for row in mine if row["id"] == leave_id] == [reason]

    # Deciding it again is still the "already decided" 409, note or not.
    again = client.post(url, headers=mentor.headers, json={"decision": "REJECT"})
    assert again.status_code == 409, again.text


@requires_db
def test_an_approval_note_is_optional_and_reaches_the_student(client, people):
    student, mentor = people["student"], people["mentor"]
    leave_id = _submit_medical(client, student.headers)["id"]
    note = "Bring the medical certificate when you return."
    r = client.post(
        f"{LEAVES}/{leave_id}/decision",
        headers=mentor.headers,
        json={"decision": "APPROVE", "note": note},
    )
    assert r.status_code == 200, r.text
    mine = client.get(f"{LEAVES}/mine", headers=student.headers).json()
    assert [row["director_note"] for row in mine if row["id"] == leave_id] == [note]


@requires_db
def test_a_student_with_no_mentor_goes_to_the_office(client, people):
    student, mentor, office = people["student"], people["mentor"], people["office"]
    _unseat(student.user_id)

    route = client.get(f"{LEAVES}/mine/approver", headers=student.headers)
    assert route.status_code == 200, route.text
    assert route.json()["routed_to"] == "OFFICE"
    assert route.json()["mentor_name"] is None

    leave_id = _submit(client, student.headers, leave_kind="OOD")["id"]
    assert leave_id in _ids(client.get(f"{LEAVES}/pending", headers=office.headers))
    # A mentor who mentors somebody else cannot reach it.
    other = people["other"]
    assert leave_id not in _ids(client.get(f"{LEAVES}/mentees", headers=other.headers))
    assert client.post(
        f"{LEAVES}/{leave_id}/decision", headers=other.headers, json=APPROVE
    ).status_code == 404
    # The former mentor now has no mentees, so the queue is not theirs at all.
    assert client.get(f"{LEAVES}/mentees", headers=mentor.headers).status_code == 403

    done = client.post(f"{LEAVES}/{leave_id}/decision", headers=office.headers, json=APPROVE)
    assert done.status_code == 200, done.text
    assert done.json()["first_signed_as"] == "MAIN_ADMIN"


@requires_db
def test_the_route_names_the_mentor_and_follows_a_reassignment(client, people):
    student, mentor, other = people["student"], people["mentor"], people["other"]
    route = client.get(f"{LEAVES}/mine/approver", headers=student.headers).json()
    assert route["routed_to"] == "MENTOR"
    assert route["mentor_name"] == "Voice Test sl-men"

    leave_id = _submit(client, student.headers)["id"]
    _seat(student.user_id, other.user_id)
    assert leave_id in _ids(client.get(f"{LEAVES}/mentees", headers=other.headers))
    # The former mentor has no mentee left, so they are refused at the door.
    assert client.post(
        f"{LEAVES}/{leave_id}/decision", headers=mentor.headers, json=APPROVE
    ).status_code == 403
    done = client.post(f"{LEAVES}/{leave_id}/decision", headers=other.headers, json=APPROVE)
    assert done.status_code == 200 and done.json()["first_signed_as"] == "MENTOR"


@requires_db
def test_a_disabled_mentor_hands_the_request_to_the_office(client, people):
    student, mentor, office = people["student"], people["mentor"], people["office"]
    leave_id = _submit(client, student.headers)["id"]
    with SessionLocal() as db:
        from datetime import datetime, timezone

        db.get(User, mentor.user_id).disabled_at = datetime.now(timezone.utc)
        db.commit()
    assert leave_id in _ids(client.get(f"{LEAVES}/pending", headers=office.headers))


@requires_db
def test_the_student_form_takes_three_types_and_no_overlap(client, people):
    headers = people["student"].headers
    for kind in ("PERMISSION", "LOP", None):
        r = client.post(
            LEAVES,
            headers=headers,
            json={"from_date": "2026-12-01", "to_date": "2026-12-01", "reason": "x", "leave_kind": kind},
        )
        assert r.status_code == 422, (kind, r.text)
        assert "Medical, Casual or On official duty" in r.text

    _submit(client, headers, from_date="2026-12-01", to_date="2026-12-03")
    clash = client.post(
        LEAVES,
        headers=headers,
        json={"from_date": "2026-12-03", "to_date": "2026-12-04", "reason": "x", "leave_kind": "CASUAL"},
    )
    assert clash.status_code == 422 and "overlaps" in clash.text


@requires_db
def test_faculty_may_still_apply_without_the_student_rules(client, make_user):
    """The student rules are the student's: a faculty applicant still submits
    with no leave type, as the paper form allows."""
    faculty = make_user("sl-fac", Role.MENTOR)
    r = client.post(
        LEAVES,
        headers=faculty.headers,
        json={"from_date": "2026-12-20", "to_date": "2026-12-20", "reason": "Personal work."},
    )
    assert r.status_code == 201, r.text
    with SessionLocal() as db:
        db.execute(delete(LeaveRequest).where(LeaveRequest.id == r.json()["id"]))
        db.commit()


@requires_db
def test_the_student_withdraws_a_pending_request(client, people):
    student, mentor = people["student"], people["mentor"]
    leave_id = _submit(client, student.headers)["id"]
    r = client.post(f"{LEAVES}/{leave_id}/cancel", headers=student.headers)
    assert r.status_code == 200 and r.json()["status"] == "CANCELLED"
    assert leave_id not in _ids(client.get(f"{LEAVES}/mentees", headers=mentor.headers))


@requires_db
def test_the_supporting_document_reaches_the_mentor_and_nobody_else(client, people):
    student, mentor, other, office = (
        people["student"], people["mentor"], people["other"], people["office"]
    )
    leave_id = _submit_medical(client, student.headers)["id"]
    [attachment] = _attachments(leave_id)
    row = next(
        r for r in client.get(f"{LEAVES}/mentees", headers=mentor.headers).json()
        if r["id"] == leave_id
    )
    assert row["attachments"] == [{"id": attachment.id, "original_name": "certificate.pdf"}]
    assert row["requester_usn"] is None  # make_user's student has no USN
    url = f"{LEAVES}/{leave_id}/attachments/{attachment.id}/file"
    assert client.get(url, headers=mentor.headers).status_code == 200
    assert client.get(url, headers=other.headers).status_code == 404
    assert client.get(url, headers=office.headers).status_code == 404


# --------------------------------------------------------------------------- #
# 5. Medical leave and its document (2026-11-12)
# --------------------------------------------------------------------------- #


@requires_db
def test_medical_leave_is_refused_without_its_document_on_both_doors(client, people):
    student = people["student"]
    before = _counts(student.user_id)

    json_door = client.post(LEAVES, headers=student.headers, json=MEDICAL_FORM)
    assert json_door.status_code == 422, json_door.text
    assert "Medical leave needs a supporting document" in json_door.text

    no_file = client.post(STUDENT_DOOR, headers=student.headers, data=MEDICAL_FORM)
    assert no_file.status_code == 422, no_file.text
    assert "Medical leave needs a supporting document" in no_file.text

    assert _counts(student.user_id) == before


@requires_db
def test_medical_leave_and_its_document_are_saved_together(client, people):
    student = people["student"]
    created = _submit_medical(client, student.headers)
    assert created["status"] == "SUBMITTED" and created["leave_kind"] == "MEDICAL"
    [attachment] = _attachments(created["id"])
    assert attachment.original_name == "certificate.pdf"
    assert attachment.uploaded_by_user_id == student.user_id
    assert document_store.read_bytes(attachment.stored_name) == APPLICATION_CV


@requires_db
def test_casual_and_ood_leave_may_still_go_without_a_document(client, people):
    student = people["student"]
    r = client.post(
        STUDENT_DOOR,
        headers=student.headers,
        data={**MEDICAL_FORM, "leave_kind": "OOD"},
    )
    assert r.status_code == 201, r.text
    assert _attachments(r.json()["id"]) == []


@requires_db
def test_a_refused_document_leaves_no_request_behind(client, people):
    student = people["student"]
    before = _counts(student.user_id)
    r = client.post(
        STUDENT_DOOR,
        headers=student.headers,
        data=MEDICAL_FORM,
        files={"file": ("certificate.pdf", b"not really a pdf", "application/pdf")},
    )
    assert r.status_code == 422, r.text
    assert _counts(student.user_id) == before


@requires_db
def test_a_failed_commit_deletes_the_bytes_it_wrote(client, people, monkeypatch):
    """The file is on the volume before the commit; if the commit fails, the
    endpoint must delete it, or the volume holds a certificate nothing names."""
    student = people["student"]
    before = _counts(student.user_id)
    deleted: list[str] = []
    real_delete = leave_attachments.document_store_delete

    def record_delete(name: str) -> None:
        deleted.append(name)
        real_delete(name)

    def failing_commit(self) -> None:
        raise RuntimeError("database went away")

    monkeypatch.setattr(leave_attachments, "document_store_delete", record_delete)
    monkeypatch.setattr(Session, "commit", failing_commit)
    with pytest.raises(RuntimeError, match="database went away"):
        client.post(
            STUDENT_DOOR,
            headers=student.headers,
            data=MEDICAL_FORM,
            files={"file": ("certificate.pdf", APPLICATION_CV, "application/pdf")},
        )
    monkeypatch.undo()

    assert len(deleted) == 1
    with pytest.raises(FileNotFoundError):
        document_store.read_bytes(deleted[0])
    assert _counts(student.user_id) == before


@requires_db
def test_staff_do_not_use_the_student_door(client, people):
    r = client.post(
        STUDENT_DOOR,
        headers=people["mentor"].headers,
        data={**MEDICAL_FORM, "leave_kind": "CASUAL"},
    )
    assert r.status_code == 403, r.text


@requires_db
def test_the_document_stays_on_a_pending_medical_request(client, people):
    """Nobody removes the last document of a pending medical request: not the
    student who attached it, not the Main Admin. Once it is decided, it can go."""
    student, mentor, office = people["student"], people["mentor"], people["office"]
    _unseat(student.user_id)  # the office's request, so the Main Admin can reach it
    leave_id = _submit_medical(client, student.headers)["id"]
    [attachment] = _attachments(leave_id)
    url = f"{LEAVES}/{leave_id}/attachments/{attachment.id}"

    listed = client.get(f"{LEAVES}/{leave_id}/attachments", headers=student.headers).json()
    assert [a["can_delete"] for a in listed] == [False]
    for headers in (student.headers, office.headers):
        refused = client.delete(url, headers=headers)
        assert refused.status_code == 409, refused.text
        assert "must keep its supporting document" in refused.text
    assert len(_attachments(leave_id)) == 1

    decided = client.post(f"{LEAVES}/{leave_id}/decision", headers=office.headers, json=APPROVE)
    assert decided.status_code == 200, decided.text
    assert client.delete(url, headers=student.headers).status_code == 204


@requires_db
def test_an_extra_document_may_still_be_removed(client, people):
    student = people["student"]
    leave_id = _submit_medical(client, student.headers)["id"]
    extra = client.post(
        f"{LEAVES}/{leave_id}/attachments",
        headers=student.headers,
        files={"file": ("second-page.pdf", APPLICATION_CV, "application/pdf")},
    )
    assert extra.status_code == 201, extra.text
    gone = client.delete(
        f"{LEAVES}/{leave_id}/attachments/{extra.json()['id']}", headers=student.headers
    )
    assert gone.status_code == 204, gone.text
    [last] = _attachments(leave_id)
    assert client.delete(
        f"{LEAVES}/{leave_id}/attachments/{last.id}", headers=student.headers
    ).status_code == 409


@requires_db
def test_a_withdrawn_medical_request_lets_its_document_go(client, people):
    student = people["student"]
    leave_id = _submit_medical(client, student.headers)["id"]
    [attachment] = _attachments(leave_id)
    assert client.post(f"{LEAVES}/{leave_id}/cancel", headers=student.headers).status_code == 200
    assert client.delete(
        f"{LEAVES}/{leave_id}/attachments/{attachment.id}", headers=student.headers
    ).status_code == 204


@requires_db
def test_the_mentee_queue_needs_a_mentee(client, make_user, people):
    lone = make_user("sl-lone", Role.MENTOR)
    assert client.get(f"{LEAVES}/mentees", headers=lone.headers).status_code == 403
    assert client.get(f"{LEAVES}/mentees", headers=people["office"].headers).status_code == 403
    assert client.get(f"{LEAVES}/mentees", headers=people["student"].headers).status_code == 403
    # And without a mentee or a grant, the decision door is shut as before.
    assert client.post(
        f"{LEAVES}/no-such-leave/decision", headers=lone.headers, json=APPROVE
    ).status_code == 403
