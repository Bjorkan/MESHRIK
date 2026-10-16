import pytest


@pytest.mark.asyncio
async def test_restart_marks_only_pending_outgoing_as_unknown(test_db):
    from app.repository import messages as messages_repo
    from app.repository.messages import MessageRepository

    async with messages_repo.db.tx() as conn:
        for outgoing, status, content in [
            (1, "pending", "pending-outgoing"),
            (1, "confirmed", "confirmed-outgoing"),
            (0, "pending", "incoming-pending"),
        ]:
            await conn.execute(
                "INSERT INTO messages(type, conversation_key, text, outgoing, send_status, "
                "received_at) VALUES('PRIV', ?, ?, ?, ?, 1700000000)",
                ("a" * 64, content, outgoing, status),
            )
    assert await MessageRepository.recover_interrupted_outgoing_sends() == 1
    assert await MessageRepository.recover_interrupted_outgoing_sends() == 0
    async with messages_repo.db.readonly() as conn:
        async with conn.execute("SELECT text,send_status FROM messages") as cursor:
            rows = {row["text"]: row["send_status"] for row in await cursor.fetchall()}
    assert rows == {
        "pending-outgoing": "unknown",
        "confirmed-outgoing": "confirmed",
        "incoming-pending": "pending",
    }
