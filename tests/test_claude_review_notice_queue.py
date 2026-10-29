"""The daemon's Claude review queue asks the resident for its notice in the same write."""

from __future__ import annotations

import logging
import time
from typing import Any

import pytest

from codex_plugin_scanner.guard.daemon import hook_native_review_approval
from codex_plugin_scanner.guard.store_approval_facade import StoreApprovalsMixin


class _Request:
    config_path = "/work/space"
    source_scope = "project"

    def to_dict(self) -> dict[str, object]:
        return {"request_id": "req-1"}


class _Store(StoreApprovalsMixin):
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def _native_store_call(self, method: str, args: dict[str, Any]) -> str:
        self.calls.append((method, dict(args)))
        return "req-1"


class _KeyedStore:
    def __init__(self, material: object) -> None:
        self.material = material
        self.created: list[bool] = []

    def _policy_integrity_secret_material(self, *, create: bool) -> object:
        self.created.append(create)
        if isinstance(self.material, Exception):
            raise self.material
        return self.material


def test_a_claude_review_queues_with_its_notice_in_one_store_write() -> None:
    store = _RowStore({"request_id": "req-1", "row": {"request_id": "req-1"}})
    review = {"harness": "claude-code"}
    notice = {"review": review, "integrity_key_b64": "a2V5", "integrity_key_id": "kid"}
    assert store.queue_review_approval_request(_Request(), "now", claude_review=notice) == {"request_id": "req-1"}  # type: ignore[arg-type]
    # The key rides in the top-level args the request digest leaves out,
    # never inside the digested ``claude_review`` facts.
    ((method, args),) = store.calls
    assert method == "add_claude_approval_request"
    args.pop("cwd")
    assert args == {
        "request": {"request_id": "req-1"},
        "now": "now",
        "claude_review": review,
        "integrity_key_b64": "a2V5",
        "integrity_key_id": "kid",
        "return_row": True,
    }


def test_other_reviews_keep_the_plain_queue_write() -> None:
    store = _Store()
    store.add_approval_request(_Request(), "now")  # type: ignore[arg-type]
    assert store.calls == [
        ("add_approval_request", {"request": {"request_id": "req-1"}, "now": "now", "prompt_shown": None})
    ]


def test_the_notice_carries_the_review_facts_and_the_integrity_key() -> None:
    store = _KeyedStore((b"\x09" * 32, "bound-key"))
    review = hook_native_review_approval._claude_review_notice(
        store,
        "claude-code",
        {
            "session_id": "sess-1",
            "tool_name": "Bash",
            "cwd": "/work/space",
            "tool_input": {"command": "rm -rf build", "description": "x" * 4096},
        },
        {"reason": "Deletes files."},
        "rb-1",
        _Request(),  # type: ignore[arg-type]
        None,
    )
    assert store.created == [True]
    assert review == {
        "review": {
            "harness": "claude-code",
            # Only what the notice reads: the full hook payload stays out.
            "hook_payload": {"session_id": "sess-1", "tool_name": "Bash", "tool_input": {"command": "rm -rf build"}},
            "reason": "Deletes files.",
            "review_binding": "rb-1",
            "config_path": "/work/space",
            "source_scope": "project",
        },
        "integrity_key_b64": "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk",
        "integrity_key_id": "bound-key",
    }


def test_a_review_without_an_integrity_key_queues_without_a_notice() -> None:
    for store in (_KeyedStore((None, None)), _KeyedStore(OSError("locked")), object()):
        review = hook_native_review_approval._claude_review_notice(
            store,
            "claude-code",
            {},
            {},
            None,
            _Request(),  # type: ignore[arg-type]
            None,
        )
        assert review is None


def test_a_spent_hook_deadline_skips_the_notice_key_read() -> None:
    store = _KeyedStore((b"\x09" * 32, "bound-key"))
    review = hook_native_review_approval._claude_review_notice(
        store,
        "claude-code",
        {"session_id": "sess-1", "tool_name": "Bash"},
        {},
        None,
        _Request(),  # type: ignore[arg-type]
        time.monotonic(),
    )
    assert review is None
    assert store.created == []


def test_a_refused_combined_write_still_queues_the_review() -> None:
    calls: list[dict[str, object]] = []

    def persist(_request: object, _now: str, **kwargs: object) -> str:
        calls.append(kwargs)
        if kwargs:
            raise RuntimeError("native_guard_store_request_too_large")
        return "req-1"

    notice = {"review": {}, "integrity_key_b64": "a2V5", "integrity_key_id": "kid"}
    persisted = hook_native_review_approval._persist_review(persist, _Request(), "now", notice)  # type: ignore[arg-type]
    assert persisted == "req-1"
    assert calls == [{"claude_review": notice}, {}]


class _RowStore(StoreApprovalsMixin):
    """A resident reply to a queue write that asks for the stored row back."""

    def __init__(self, reply: object) -> None:
        self.reply = reply
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.reads: list[str] = []

    def _native_store_call(self, method: str, args: dict[str, Any]) -> object:
        self.calls.append((method, dict(args)))
        return self.reply

    def get_approval_request(self, request_id: str, *, derive_scope: bool = True) -> dict[str, object]:
        self.reads.append(request_id)
        return {"request_id": request_id, "read": "separately"}


def test_a_review_is_queued_and_read_back_in_one_store_call() -> None:
    row = {"request_id": "req-1", "harness": "codex"}
    store = _RowStore({"request_id": "req-1", "row": row})
    assert store.queue_review_approval_request(_Request(), "now") == row  # type: ignore[arg-type]
    assert store.reads == []
    ((method, args),) = store.calls
    assert method == "add_approval_request"
    assert args["return_row"] is True
    assert "cwd" in args


def test_a_silent_review_reads_back_in_its_daemon_write() -> None:
    store = _RowStore({"request_id": "req-1", "event_error": None, "row": {"request_id": "req-1"}})
    assert store.queue_review_approval_request(_Request(), "now", silent=True) == {"request_id": "req-1"}  # type: ignore[arg-type]
    ((method, args),) = store.calls
    assert method == "add_silent_native_review_approval_request"
    assert (args["daemon"], args["return_row"]) == (True, True)
    assert store.reads == []


def test_a_row_the_write_did_not_read_back_is_read_separately() -> None:
    # An older resident answers the id alone; a failed read-back names its code.
    for reply in ("req-1", {"request_id": "req-1", "row_error": "native_guard_store_invalid"}):
        store = _RowStore(reply)
        assert store.queue_review_approval_request(_Request(), "now") == {"request_id": "req-1", "read": "separately"}  # type: ignore[arg-type]
        assert store.reads == ["req-1"]


class _UnreadableRowStore(_RowStore):
    def get_approval_request(self, request_id: str, *, derive_scope: bool = True) -> dict[str, object]:
        self.reads.append(request_id)
        raise ValueError("approval scope unavailable")


def test_a_failed_read_back_never_queues_the_review_again() -> None:
    # The Claude write committed; the hook's retry without the notice is for
    # a failed write only, so a failed separate read must not trigger it.
    store = _UnreadableRowStore({"request_id": "req-1", "row_error": "native_guard_store_invalid"})
    notice = {"review": {"harness": "claude-code"}, "integrity_key_b64": "a2V5", "integrity_key_id": "kid"}
    persist = store.queue_review_approval_request
    assert hook_native_review_approval._persist_review(persist, _Request(), "now", notice) is None  # type: ignore[arg-type]
    assert [method for method, _ in store.calls] == ["add_claude_approval_request"]
    assert store.reads == ["req-1"]


def test_an_unseeded_codex_live_wait_is_logged(caplog: pytest.LogCaptureFixture) -> None:
    # An older resident ignores the wait and answers the id alone.
    wait = {"process": {"pid": 1, "startToken": "t"}, "timeout_seconds": 120, "workspace": None}
    for reply in ("req-1", {"request_id": "req-1", "live_wait": "native_guard_store_invalid", "row": {}}):
        store = _RowStore(reply)
        caplog.clear()
        with caplog.at_level(logging.WARNING):
            store.queue_review_approval_request(_Request(), "now", codex_live_wait=wait)  # type: ignore[arg-type]
        assert "Codex live wait not resumable for req-1" in caplog.text, reply
    # A seeded wait, and a bridge that is no longer waiting, are expected.
    for live_wait in ("seeded", "not_live"):
        store = _RowStore({"request_id": "req-1", "live_wait": live_wait, "row": {}})
        caplog.clear()
        with caplog.at_level(logging.WARNING):
            store.queue_review_approval_request(_Request(), "now", codex_live_wait=wait)  # type: ignore[arg-type]
        assert "Codex live wait" not in caplog.text, live_wait


def test_a_queue_write_without_a_request_id_is_refused() -> None:
    from codex_plugin_scanner.guard.native_signal_projection import NativeSignalProjectionUnavailableError

    for reply in (None, "", {"row": {}}):
        store = _RowStore(reply)
        try:
            store.queue_review_approval_request(_Request(), "now")  # type: ignore[arg-type]
        except NativeSignalProjectionUnavailableError:
            continue
        raise AssertionError(reply)
